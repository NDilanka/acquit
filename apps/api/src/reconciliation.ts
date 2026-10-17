// The platform reconciliation's server side. Each ledger line is checked against the PayPal object that owns it, read
// live: a capture or refund under the merchant's assertion (PayPal refuses the platform token for those), a referenced
// payout item under the platform token. Object reads are cached by how settled they are, capped per refresh, and run a
// few at a time, so a dashboard refresh does not reach PayPal per line. Transaction Search is read for the platform
// account only, and its rows are shown as other activity.

import { paypalReader, PayPalHttpError } from "../../../packages/mcp/src/paypal.ts";
import type { PaypalReader } from "../../../packages/mcp/src/paypal.ts";
import { authAssertion } from "../../../packages/core/src/paypal.ts";
import type { MerchantId } from "../../../packages/core/src/ids.ts";
import { factOf, mergeTransactions, objectPath, otherActivity, parseTransactionSearchPage, reconcileLines, searchInstant, searchWindows, settled, targetKey, targetOf } from "../../../packages/core/src/reconcile.ts";
import type { CaptureEventInput, LedgerLineInput, ObjectTarget, PayPalTransaction, Reading, Reconciliation } from "../../../packages/core/src/reconcile.ts";

/** One GET of Transaction Search: a 1-based page of one window. */
export type TransactionFetch = (start: string, end: string, page: number) => Promise<unknown>;
/** One GET of one PayPal object. Resolves FOUND, NOT_FOUND, or UNAVAILABLE; it never rejects. */
export type ObjectRead = (target: ObjectTarget) => Promise<Reading>;

/** Transaction Search, the other-activity read, is reused for this long. */
export const RECONCILE_CACHE_MS = 60_000;
/** About two years. A longer span skips the other-activity read, which is then shown as not read. */
export const RECONCILE_MAX_WINDOWS = 24;
/** PayPal object GETs one refresh may make. A line past the budget reads "not checked yet", never a mismatch. */
export const OBJECT_READ_BUDGET = 60;
/** Object GETs in flight at once. */
export const OBJECT_READ_CONCURRENCY = 4;
/** How long a settled reading is reused. A capture can still be refunded, so it is held for less time than a refund or payout. */
export const OBJECT_TTL_MS = { CAPTURE: 5 * 60_000, REFUND: 60 * 60_000, PAYOUT_ITEM: 60 * 60_000 } as const;

const PAGE_SIZE = 500;
/** A bounded walk: 50 pages of 500 rows per window, never a loop. */
const MAX_PAGES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ReconcileReadError extends Error {}

/** The deployment's Transaction Search reader: the same toolkit-backed reader the Ask ledger and the payout tool read through. */
export function paypalTransactionFetch(config: { readonly clientId: string; readonly clientSecret: string }, fetchImpl: typeof fetch = fetch): TransactionFetch {
	let reader: Promise<PaypalReader> | null = null;
	return async (start, end, page) => {
		reader ??= paypalReader({ ...config, sandbox: true }, fetchImpl);
		const query = new URLSearchParams({ start_date: start, end_date: end, page_size: String(PAGE_SIZE), page: String(page) });
		return (await reader).get(`/v1/reporting/transactions?${query.toString()}`);
	};
}

/**
 * The deployment's object reader: one GET per object. A capture or refund is read under its merchant's assertion, the
 * way the core reads captures and refunds; a payout item is read under the platform token. Only the status leaves
 * this function on a refusal, because PayPal's refusal text can name an account.
 */
export function paypalObjectRead(config: { readonly clientId: string; readonly clientSecret: string }, fetchImpl: typeof fetch = fetch): ObjectRead {
	let reader: Promise<PaypalReader> | null = null;
	return async target => {
		reader ??= paypalReader({ ...config, sandbox: true }, fetchImpl);
		const assertion = target.merchant === null ? undefined : authAssertion(config.clientId, target.merchant as MerchantId);
		try {
			const body = await (await reader).get(objectPath(target), assertion);
			return { state: "FOUND", fact: factOf(target.kind, body) };
		} catch (error) {
			if (error instanceof PayPalHttpError && error.status === 404) return { state: "NOT_FOUND" };
			if (error instanceof PayPalHttpError) return { state: "UNAVAILABLE", detail: `PayPal answered ${error.status}` };
			return { state: "UNAVAILABLE", detail: "the read did not complete" };
		}
	};
}

export type LedgerTables = {
	readonly entries: readonly LedgerLineInput[];
	readonly events: readonly CaptureEventInput[];
};

export type OtherActivity =
	| { readonly state: "READ"; readonly from: string; readonly to: string; readonly fetchedAt: string; readonly cached: boolean;
		readonly count: number; readonly unreadable: number; readonly sample: readonly PayPalTransaction[] }
	| { readonly state: "NOT_READ"; readonly reason: "SPAN_TOO_LONG" | "PAYPAL_UNREADABLE" };

export type ReconciliationBody = Reconciliation & {
	/** When this refresh read PayPal. */
	readonly checkedAt: string;
	/** PayPal object GETs this refresh made, the ones answered from the cache, and the budget it ran under. */
	readonly objects: { readonly read: number; readonly cached: number; readonly budget: number };
	readonly other: OtherActivity;
};

type Fetched = { readonly transactions: readonly PayPalTransaction[]; readonly unreadable: number };
type CachedObject = { readonly reading: Promise<Reading>; readonly expiresAt: number };

/**
 * The reconciliation read. Every object a line names is read once per refresh, shared by concurrent refreshes, and
 * reused from the cache while its reading is settled and fresh. Past the budget a line is not checked yet. Transaction
 * Search is read for the span of the ledger and shown as other activity; a failed or over-long search never hides the
 * checked lines.
 */
export function reconciliationService(deps: { readonly fetchPage: TransactionFetch; readonly readObject: ObjectRead },
	options: { readonly budget?: number; readonly concurrency?: number; readonly searchCacheMs?: number } = {}) {
	const budget = options.budget ?? OBJECT_READ_BUDGET;
	const concurrency = options.concurrency ?? OBJECT_READ_CONCURRENCY;
	const searchCacheMs = options.searchCacheMs ?? RECONCILE_CACHE_MS;
	const objects = new Map<string, CachedObject>();
	let search: { readonly fromMs: number; readonly startedMs: number; readonly result: Promise<Fetched> } | null = null;

	/** One object GET. Its reading is cached only while it is settled; a pending or failed one is read again next time. */
	function startObject(key: string, target: ObjectTarget, nowMs: number): Promise<Reading> {
		const reading = deps.readObject(target).catch((): Reading => ({ state: "UNAVAILABLE", detail: "the read did not complete" }));
		objects.set(key, { reading, expiresAt: Number.POSITIVE_INFINITY });
		return reading.then(value => {
			const ttl = value.state === "FOUND" && settled(value.fact) ? OBJECT_TTL_MS[target.kind] : 0;
			if (ttl > 0) objects.set(key, { reading: Promise.resolve(value), expiresAt: nowMs + ttl });
			else objects.delete(key);
			return value;
		});
	}

	async function fetchSpan(fromMs: number, toMs: number): Promise<Fetched> {
		const batches: PayPalTransaction[][] = [];
		let unreadable = 0;
		for (const window of searchWindows(fromMs, toMs)) {
			for (let current = 1; ; current++) {
				if (current > MAX_PAGES) throw new ReconcileReadError("Transaction Search page limit reached");
				const parsed = parseTransactionSearchPage(await deps.fetchPage(window.start, window.end, current));
				batches.push([...parsed.transactions]);
				unreadable += parsed.unreadable;
				if (parsed.page >= parsed.totalPages) break;
			}
		}
		return { transactions: mergeTransactions(batches), unreadable };
	}

	async function readOther(tables: LedgerTables, nowMs: number, claimed: ReadonlySet<string>): Promise<OtherActivity> {
		const stamps = tables.entries.map(entry => Date.parse(entry.at)).filter(Number.isFinite);
		const earliest = stamps.length === 0 ? nowMs - 31 * DAY_MS : stamps.reduce((min, stamp) => Math.min(min, stamp));
		const fromMs = Math.floor(earliest / DAY_MS) * DAY_MS;
		if (searchWindows(fromMs, nowMs).length > RECONCILE_MAX_WINDOWS) return { state: "NOT_READ", reason: "SPAN_TOO_LONG" };

		const live = search !== null && search.fromMs === fromMs && nowMs >= search.startedMs && nowMs - search.startedMs < searchCacheMs ? search : null;
		const entry = live ?? { fromMs, startedMs: nowMs, result: fetchSpan(fromMs, nowMs) };
		if (live === null) {
			search = entry;
			entry.result.catch(() => { if (search === entry) search = null; });
		}
		let fetched: Fetched;
		try {
			fetched = await entry.result;
		} catch {
			return { state: "NOT_READ", reason: "PAYPAL_UNREADABLE" };
		}
		const rows = otherActivity(fetched.transactions, claimed);
		return { state: "READ", from: searchInstant(fromMs), to: searchInstant(nowMs), fetchedAt: searchInstant(entry.startedMs),
			cached: live !== null, count: rows.length, unreadable: fetched.unreadable, sample: rows.slice(0, 10) };
	}

	return async function reconcileLedger(tables: LedgerTables, nowMs: number): Promise<ReconciliationBody> {
		const byCapture = new Map(tables.events.map(event => [event.captureId, event] as const));
		const targets = new Map<string, ObjectTarget>();
		for (const line of tables.entries) {
			const target = targetOf(line, line.captureId === null ? undefined : byCapture.get(line.captureId));
			if (target.ok && !targets.has(targetKey(target.object))) targets.set(targetKey(target.object), target.object);
		}
		for (const [key, entry] of objects) if (nowMs >= entry.expiresAt) objects.delete(key);

		const readings = new Map<string, Reading>();
		const waiting: [string, Promise<Reading>][] = [];
		const toRead: [string, ObjectTarget][] = [];
		let budgetLeft = budget;
		let cached = 0;
		for (const [key, target] of targets) {
			const entry = objects.get(key);
			if (entry !== undefined && nowMs < entry.expiresAt) { cached++; waiting.push([key, entry.reading]); }
			else if (budgetLeft > 0) { budgetLeft--; toRead.push([key, target]); }
			else readings.set(key, { state: "NOT_READ" });
		}
		for (let i = 0; i < toRead.length; i += concurrency) {
			const batch = toRead.slice(i, i + concurrency);
			const done = await Promise.all(batch.map(async ([key, target]) => [key, await startObject(key, target, nowMs)] as const));
			for (const [key, reading] of done) readings.set(key, reading);
		}
		for (const [key, reading] of waiting) readings.set(key, await reading);

		const claimed = new Set<string>();
		for (const target of targets.values()) claimed.add(target.id);
		for (const reading of readings.values()) {
			if (reading.state === "FOUND" && reading.fact.kind === "PAYOUT_ITEM" && reading.fact.payoutTransactionId !== null) claimed.add(reading.fact.payoutTransactionId);
		}

		const checked = reconcileLines(tables.entries, tables.events, readings);
		const other = await readOther(tables, nowMs, claimed);
		return { ...checked, checkedAt: searchInstant(nowMs), objects: { read: toRead.length, cached, budget }, other };
	};
}
