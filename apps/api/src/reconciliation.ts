// The platform reconciliation's server side. Each ledger line is checked against the PayPal object that owns it,
// read live: a capture or refund under the merchant's assertion (PayPal refuses the platform token for those), a
// referenced payout item under the platform token. Object reads are cached by how settled they are and by the
// authority they were read under, capped per refresh, and every PayPal GET the service makes shares one concurrency
// cap, so a dashboard refresh does not reach PayPal per line and open tabs do not multiply the load. Transaction Search
// is read for the platform account only, a few pages at most, and its rows are shown as other activity.

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
/** Transaction Search pages one refresh reads for other activity. It is context, not reconciliation, so the read stays small. */
export const OTHER_ACTIVITY_PAGE_CAP = 4;
/** PayPal object reads one refresh may make. A line past the budget reads "not checked yet", never a mismatch. */
export const OBJECT_READ_BUDGET = 60;
/** PayPal GETs in flight at once, across every refresh the service runs. */
export const OBJECT_READ_CONCURRENCY = 4;
/** How long a settled reading is reused. A capture can still be refunded, so it is held for less time than a refund or payout. */
export const OBJECT_TTL_MS = { CAPTURE: 5 * 60_000, REFUND: 60 * 60_000, PAYOUT_ITEM: 60 * 60_000 } as const;

const PAGE_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

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
		readonly count: number; readonly unreadable: number; readonly truncated: boolean; readonly sample: readonly PayPalTransaction[] }
	| { readonly state: "NOT_READ"; readonly reason: "SPAN_TOO_LONG" | "PAYPAL_UNREADABLE" };

export type ReconciliationBody = Reconciliation & {
	/** When this refresh read PayPal. */
	readonly checkedAt: string;
	/** PayPal object GETs this refresh made, the ones answered from the cache or a read in flight, and the budget it ran under. */
	readonly objects: { readonly read: number; readonly cached: number; readonly budget: number };
	readonly other: OtherActivity;
};

/** One object in the cache: its reading once it has settled, and null while the read is still in flight. */
type CachedObject = { readonly reading: Promise<Reading>; readonly value: Reading | null; readonly expiresAt: number };
type Fetched = { readonly transactions: readonly PayPalTransaction[]; readonly unreadable: number; readonly truncated: boolean };

/** At most `slots` calls run at once. One limiter serves every refresh a service runs, so simultaneous refreshes share the cap. */
function limiter(slots: number): <T>(run: () => Promise<T>) => Promise<T> {
	let free = slots;
	const waiting: (() => void)[] = [];
	return async <T>(run: () => Promise<T>): Promise<T> => {
		if (free > 0) free--;
		else await new Promise<void>(resolve => waiting.push(resolve));
		try {
			return await run();
		} finally {
			// A finished call hands its slot straight to the next waiter, so the count never dips while work is queued.
			const next = waiting.shift();
			if (next) next(); else free++;
		}
	};
}

/**
 * Refreshes do not overlap. A refresh that arrives while one runs waits for it, and every refresh that arrives meanwhile
 * shares one queued run, which reads the most recent request's ledger. The route wraps the service with this.
 */
export function coalesced<A extends unknown[], T>(run: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	let waiting: { args: A; result: Promise<T> } | null = null;
	return (...args: A): Promise<T> => {
		if (waiting !== null) {
			waiting.args = args;
			return waiting.result;
		}
		const turn: { args: A; result: Promise<T> } = {
			args,
			result: tail.then(() => {
				if (waiting === turn) waiting = null;
				return run(...turn.args);
			}),
		};
		waiting = turn;
		tail = turn.result.catch(() => undefined);
		return turn.result;
	};
}

/**
 * A capture a refund line names with no refund id shows REFUNDED only once the refund has landed on it. Any other
 * status is an older reading, so the line reads the capture again rather than judging the refund against it.
 */
function beyondCache(reading: Reading, expectsRefund: boolean): boolean {
	return expectsRefund && reading.state === "FOUND" && reading.fact.kind === "CAPTURE" && reading.fact.status !== "REFUNDED";
}

/**
 * The reconciliation read. Every object a line names is read once, and that read is shared: a read another refresh has
 * in flight is joined, and a settled reading is reused while it still answers the line that names it. Past the budget a
 * line is not checked yet. Transaction Search is read for the span of the ledger and shown as other activity; a failed
 * or over-long search never hides the checked lines.
 */
export function reconciliationService(deps: { readonly fetchPage: TransactionFetch; readonly readObject: ObjectRead },
	options: { readonly budget?: number; readonly concurrency?: number; readonly searchCacheMs?: number } = {}) {
	const budget = options.budget ?? OBJECT_READ_BUDGET;
	const searchCacheMs = options.searchCacheMs ?? RECONCILE_CACHE_MS;
	const limit = limiter(options.concurrency ?? OBJECT_READ_CONCURRENCY);
	const objects = new Map<string, CachedObject>();
	/** Where the next refresh starts its object reads, so a target that keeps failing cannot starve the ones after it. */
	let cursor = 0;
	let search: { readonly fromMs: number; readonly startedMs: number; readonly result: Promise<Fetched> } | null = null;

	/** One object GET, made visible to other refreshes at once. Its reading is kept only while it is settled. */
	function startRead(key: string, target: ObjectTarget, nowMs: number): Promise<Reading> {
		const reading = limit(() => deps.readObject(target)).catch((): Reading => ({ state: "UNAVAILABLE", detail: "the read did not complete" }));
		const entry: CachedObject = { reading, value: null, expiresAt: Number.POSITIVE_INFINITY };
		objects.set(key, entry);
		return reading.then(value => {
			if (objects.get(key) === entry) {
				const ttl = value.state === "FOUND" && settled(value.fact) ? OBJECT_TTL_MS[target.kind] : 0;
				if (ttl > 0) objects.set(key, { reading, value, expiresAt: nowMs + ttl });
				else objects.delete(key);
			}
			return value;
		});
	}

	async function fetchSpan(fromMs: number, toMs: number): Promise<Fetched> {
		const batches: PayPalTransaction[][] = [];
		let unreadable = 0;
		let pages = 0;
		for (const window of searchWindows(fromMs, toMs)) {
			for (let current = 1; ; current++) {
				if (pages === OTHER_ACTIVITY_PAGE_CAP) return { transactions: mergeTransactions(batches), unreadable, truncated: true };
				pages++;
				const parsed = parseTransactionSearchPage(await limit(() => deps.fetchPage(window.start, window.end, current)));
				batches.push([...parsed.transactions]);
				unreadable += parsed.unreadable;
				if (parsed.page >= parsed.totalPages) break;
			}
		}
		return { transactions: mergeTransactions(batches), unreadable, truncated: false };
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
			cached: live !== null, count: rows.length, unreadable: fetched.unreadable, truncated: fetched.truncated, sample: rows.slice(0, 10) };
	}

	return async function reconcileLedger(tables: LedgerTables, nowMs: number): Promise<ReconciliationBody> {
		const byCapture = new Map(tables.events.map(event => [event.captureId, event] as const));
		const targets = new Map<string, ObjectTarget>();
		const refundExpected = new Set<string>();
		for (const line of tables.entries) {
			const target = targetOf(line, line.captureId === null ? undefined : byCapture.get(line.captureId));
			if (!target.ok) continue;
			const key = targetKey(target.object);
			if (!targets.has(key)) targets.set(key, target.object);
			if (line.kind === "REFUND" && target.object.kind === "CAPTURE") refundExpected.add(key);
		}
		for (const [key, entry] of objects) if (nowMs >= entry.expiresAt) objects.delete(key);

		const pairs = [...targets];
		const indexed = [...pairs.entries()];
		const start = pairs.length === 0 ? 0 : cursor % pairs.length;
		const rotated = [...indexed.slice(start), ...indexed.slice(0, start)];
		const readings = new Map<string, Reading>();
		const settling: Promise<void>[] = [];
		const counts = { read: 0, cached: 0 };
		let budgetLeft = budget;
		let lastRead = -1;

		/** One GET for an object, if this refresh still has budget for one. A newer read already in flight is joined instead. */
		const readFresh = (key: string, target: ObjectTarget, joined: Promise<Reading>): Promise<Reading> => {
			const newer = objects.get(key);
			if (newer !== undefined && newer.value === null && newer.reading !== joined) {
				counts.cached++;
				return newer.reading;
			}
			if (budgetLeft === 0) return Promise.resolve({ state: "NOT_READ" });
			budgetLeft--;
			counts.read++;
			return startRead(key, target, nowMs);
		};

		for (const [index, [key, target]] of rotated) {
			const expectsRefund = refundExpected.has(key);
			const cached = objects.get(key);
			if (cached !== undefined && cached.value === null) {
				// Another refresh is reading this object now: share that read, and read again only if it cannot answer this line.
				settling.push(cached.reading.then(async value => {
					if (beyondCache(value, expectsRefund)) readings.set(key, await readFresh(key, target, cached.reading));
					else { counts.cached++; readings.set(key, value); }
				}));
				continue;
			}
			if (cached !== undefined && cached.value !== null && !beyondCache(cached.value, expectsRefund)) {
				counts.cached++;
				readings.set(key, cached.value);
				continue;
			}
			if (budgetLeft === 0) { readings.set(key, { state: "NOT_READ" }); continue; }
			budgetLeft--;
			counts.read++;
			lastRead = index;
			settling.push(startRead(key, target, nowMs).then(value => { readings.set(key, value); }));
		}
		if (lastRead >= 0) cursor = (lastRead + 1) % pairs.length;
		await Promise.all(settling);

		const claimed = new Set<string>();
		for (const target of targets.values()) claimed.add(target.id);
		for (const reading of readings.values()) {
			if (reading.state === "FOUND" && reading.fact.kind === "PAYOUT_ITEM" && reading.fact.payoutTransactionId !== null) claimed.add(reading.fact.payoutTransactionId);
		}

		const checked = reconcileLines(tables.entries, tables.events, readings);
		const other = await readOther(tables, nowMs, claimed);
		return { ...checked, checkedAt: searchInstant(nowMs), objects: { read: counts.read, cached: counts.cached, budget }, other };
	};
}
