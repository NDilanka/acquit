// The platform reconciliation's server side: Transaction Search for the ledger's span, read a page at a
// time through the toolkit-backed reader the Ask ledger already uses, cached for a minute so a dashboard
// refresh does not reach PayPal every time, then reconciled against the ledger by the core's pure function.

import { paypalReader } from "../../../packages/mcp/src/paypal.ts";
import type { PaypalReader } from "../../../packages/mcp/src/paypal.ts";
import { PENDING_AT_PAYPAL_MS, expectationsOf, mergeTransactions, parseTransactionSearchPage, reconcile, searchInstant, searchWindows } from "../../../packages/core/src/reconcile.ts";
import type { CaptureEventInput, LedgerLineInput, PayPalTransaction, Reconciliation } from "../../../packages/core/src/reconcile.ts";

/** One GET of Transaction Search: a 1-based page of one window. */
export type TransactionFetch = (start: string, end: string, page: number) => Promise<unknown>;

export const RECONCILE_CACHE_MS = 60_000;
/** About two years. A longer span is refused whole, because a ledger line outside what was read would look missing. */
export const RECONCILE_MAX_WINDOWS = 24;
const PAGE_SIZE = 500;
/** A bounded walk: 50 pages of 500 rows per window, never a loop. */
const MAX_PAGES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export class ReconcileSpanError extends Error {}
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

export type LedgerTables = {
	readonly entries: readonly LedgerLineInput[];
	readonly events: readonly CaptureEventInput[];
};

export type ReconciliationBody = Reconciliation & {
	readonly from: string;
	readonly to: string;
	/** When PayPal's rows were read. A cached read is at most the cache's age old. */
	readonly fetchedAt: string;
	readonly cached: boolean;
	readonly transactions: number;
	readonly unreadable: number;
	readonly pendingWindowHours: number;
};

type Fetched = { readonly transactions: readonly PayPalTransaction[]; readonly unreadable: number };

/**
 * The reconciliation read. The span runs from the earliest ledger line's day (or the last 31 days when the
 * ledger is empty) to now. One fetch serves every request inside the cache's age, so the reads for one span
 * are shared, including concurrent ones. A failed read is never cached.
 */
export function reconciliationService(fetchPage: TransactionFetch, ttlMs: number = RECONCILE_CACHE_MS) {
	let cache: { readonly fromMs: number; readonly startedMs: number; readonly result: Promise<Fetched> } | null = null;

	async function fetchSpan(fromMs: number, toMs: number): Promise<Fetched> {
		const batches: PayPalTransaction[][] = [];
		let unreadable = 0;
		for (const window of searchWindows(fromMs, toMs)) {
			for (let current = 1; ; current++) {
				if (current > MAX_PAGES) throw new ReconcileReadError("Transaction Search page limit reached");
				const parsed = parseTransactionSearchPage(await fetchPage(window.start, window.end, current));
				batches.push([...parsed.transactions]);
				unreadable += parsed.unreadable;
				if (parsed.page >= parsed.totalPages) break;
			}
		}
		return { transactions: mergeTransactions(batches), unreadable };
	}

	return async function reconcileLedger(tables: LedgerTables, nowMs: number): Promise<ReconciliationBody> {
		const stamps = tables.entries.map(entry => Date.parse(entry.at)).filter(Number.isFinite);
		const earliest = stamps.length === 0 ? nowMs - 31 * DAY_MS : stamps.reduce((min, stamp) => Math.min(min, stamp));
		const fromMs = Math.floor(earliest / DAY_MS) * DAY_MS;
		if (searchWindows(fromMs, nowMs).length > RECONCILE_MAX_WINDOWS) throw new ReconcileSpanError("the ledger spans more windows than the reconciliation reads");

		const live = cache !== null && cache.fromMs === fromMs && nowMs >= cache.startedMs && nowMs - cache.startedMs < ttlMs ? cache : null;
		const entry = live ?? { fromMs, startedMs: nowMs, result: fetchSpan(fromMs, nowMs) };
		if (live === null) {
			cache = entry;
			entry.result.catch(() => { if (cache === entry) cache = null; });
		}
		const fetched = await entry.result;
		const result = reconcile(expectationsOf(tables.entries, tables.events), fetched.transactions, searchInstant(nowMs));
		return { ...result, from: searchInstant(fromMs), to: searchInstant(nowMs), fetchedAt: searchInstant(entry.startedMs),
			cached: live !== null, transactions: fetched.transactions.length, unreadable: fetched.unreadable,
			pendingWindowHours: PENDING_AT_PAYPAL_MS / HOUR_MS };
	};
}
