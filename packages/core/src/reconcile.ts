// Reconciles the platform ledger against PayPal Transaction Search. Pure: the route fetches the pages
// and hands them in, so every rule here is a fixture test. Money is integer cents, and PayPal's
// decimal strings are parsed exactly, never through floating point.

/** Transaction Search can trail the API by about three hours, so a younger row with no PayPal row is pending. */
export const PENDING_AT_PAYPAL_MS = 3 * 60 * 60 * 1000;
/** Transaction Search answers at most 31 days per request. */
export const SEARCH_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const USD = "USD";

export type ReconcileKind = "HELD" | "RELEASED" | "FEE" | "REFUND";
/** AMOUNT compares the transaction's own amount; FEE compares the fee PayPal took on it. */
export type ReconcileLeg = "AMOUNT" | "FEE";
export type ReconcileStatus = "MATCHED" | "PENDING_AT_PAYPAL" | "MISMATCHED";
export type MismatchReason = "AMOUNT" | "CURRENCY" | "UNREADABLE_AMOUNT" | "MISSING_AT_PAYPAL" | "NO_PAYPAL_ID";

/** One Transaction Search row, reduced to what matching reads. */
export type PayPalTransaction = {
	readonly transactionId: string;
	readonly eventCode: string;
	readonly initiatedAt: string;
	/** Signed cents, negative for money out. Null when PayPal's value cannot be read. */
	readonly amountCents: number | null;
	/** Signed cents of the fee on this row, negative when PayPal took it. Zero when PayPal sent no fee. Null when unreadable. */
	readonly feeCents: number | null;
	readonly currency: string;
};

/** A ledger line, with the PayPal id it should appear under and the signed cents PayPal should show for it. */
export type LedgerExpectation = {
	readonly entryId: string;
	readonly jobId: string;
	readonly kind: ReconcileKind;
	readonly at: string;
	readonly paypalId: string | null;
	readonly leg: ReconcileLeg;
	readonly expectedCents: number;
};

export type ReconciledRow = LedgerExpectation & {
	readonly status: ReconcileStatus;
	readonly reason: MismatchReason | null;
	readonly observedCents: number | null;
};

export type Reconciliation = {
	readonly counts: { readonly matched: number; readonly pending: number; readonly mismatched: number; readonly unknown: number };
	readonly rows: readonly ReconciledRow[];
	/** PayPal rows no ledger line claims: the UNKNOWN_AT_ACQUIT class. */
	readonly unknown: readonly PayPalTransaction[];
};

/** A platform ledger line, as the platform tables project it. */
export type LedgerLineInput = {
	readonly entryId: string;
	readonly jobId: string;
	readonly kind: ReconcileKind;
	readonly cents: number;
	readonly at: string;
	readonly captureId: string | null;
	readonly processorCents: number | null;
};

/** The PayPal objects one capture carries once it settles: the refund and the payout item, when there are any. */
export type CaptureEventInput = { readonly captureId: string; readonly refundId: string | null; readonly payoutItemId: string | null };

/**
 * Each ledger line's PayPal id and the amount PayPal should show. A hold is the capture, so its amount is
 * the gross. A release is the referenced payout item, shown as money out. A refund is its refund, also out.
 * A fee is the processor fee on the capture, which is the one part of the fee PayPal itself records; the
 * platform's own share has no PayPal row of its own and is not checked here.
 */
export function expectationsOf(lines: readonly LedgerLineInput[], events: readonly CaptureEventInput[]): LedgerExpectation[] {
	const byCapture = new Map(events.map(event => [event.captureId, event] as const));
	return lines.map((line): LedgerExpectation => {
		const event = line.captureId === null ? undefined : byCapture.get(line.captureId);
		const base = { entryId: line.entryId, jobId: line.jobId, kind: line.kind, at: line.at };
		switch (line.kind) {
			case "HELD": return { ...base, paypalId: line.captureId, leg: "AMOUNT", expectedCents: line.cents };
			case "RELEASED": return { ...base, paypalId: event?.payoutItemId ?? null, leg: "AMOUNT", expectedCents: -line.cents };
			case "REFUND": return { ...base, paypalId: event?.refundId ?? null, leg: "AMOUNT", expectedCents: -line.cents };
			case "FEE": return { ...base, paypalId: line.captureId, leg: "FEE", expectedCents: -(line.processorCents ?? 0) };
		}
	});
}

/**
 * Matches each ledger line to its PayPal rows. A row that agrees on id, amount, and currency is MATCHED.
 * Inside the lag window a line with no PayPal row is PENDING_AT_PAYPAL, and an amount or currency that
 * differs is MISMATCHED at any age. A line older than the window with no PayPal row is MISMATCHED.
 */
export function reconcile(expectations: readonly LedgerExpectation[], transactions: readonly PayPalTransaction[], now: string): Reconciliation {
	const nowMs = Date.parse(now);
	const byId = new Map<string, PayPalTransaction[]>();
	for (const tx of transactions) byId.set(tx.transactionId, [...(byId.get(tx.transactionId) ?? []), tx]);
	const claimed = new Set<string>();
	const counts = { matched: 0, pending: 0, mismatched: 0, unknown: 0 };
	const rows = expectations.map((expectation): ReconciledRow => {
		if (expectation.paypalId !== null) claimed.add(expectation.paypalId);
		const found = expectation.paypalId === null ? [] : byId.get(expectation.paypalId) ?? [];
		const young = nowMs - Date.parse(expectation.at) < PENDING_AT_PAYPAL_MS;
		const verdict = judge(expectation, found, young);
		if (verdict.status === "MATCHED") counts.matched++;
		else if (verdict.status === "PENDING_AT_PAYPAL") counts.pending++;
		else counts.mismatched++;
		return { ...expectation, ...verdict };
	});
	const unknown = transactions.filter(tx => !claimed.has(tx.transactionId));
	counts.unknown = unknown.length;
	return { counts, rows, unknown };
}

function judge(expectation: LedgerExpectation, found: readonly PayPalTransaction[], young: boolean):
	{ readonly status: ReconcileStatus; readonly reason: MismatchReason | null; readonly observedCents: number | null } {
	const pending = { status: "PENDING_AT_PAYPAL" as const, reason: null, observedCents: null };
	const mismatch = (reason: MismatchReason, observedCents: number | null) => ({ status: "MISMATCHED" as const, reason, observedCents });
	if (expectation.paypalId === null) return young ? pending : mismatch("NO_PAYPAL_ID", null);
	if (found.length === 0) return young ? pending : mismatch("MISSING_AT_PAYPAL", null);
	const observed = (tx: PayPalTransaction) => expectation.leg === "AMOUNT" ? tx.amountCents : tx.feeCents;
	if (found.some(tx => observed(tx) === expectation.expectedCents && tx.currency === USD)) {
		return { status: "MATCHED", reason: null, observedCents: expectation.expectedCents };
	}
	const sameAmount = found.find(tx => observed(tx) === expectation.expectedCents);
	if (sameAmount) return mismatch("CURRENCY", expectation.expectedCents);
	const readable = found.find(tx => observed(tx) !== null);
	if (readable === undefined) return mismatch("UNREADABLE_AMOUNT", null);
	return mismatch(readable.currency === USD ? "AMOUNT" : "CURRENCY", observed(readable) ?? null);
}

// ---- PayPal's Transaction Search answers --------------------------------------------------------

const AMOUNT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** PayPal's decimal string as signed integer cents, exactly. Null for anything else, including a bare sign or a third decimal. */
export function parseAmountCents(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = AMOUNT.exec(value);
	if (match === null) return null;
	const cents = BigInt(match[2] ?? "0") * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
	if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	const magnitude = Number(cents);
	return match[1] === "-" && magnitude !== 0 ? -magnitude : magnitude;
}

export type TransactionPage = {
	readonly transactions: readonly PayPalTransaction[];
	/** Rows PayPal sent without an id, which no line can match. */
	readonly unreadable: number;
	readonly page: number;
	readonly totalPages: number;
};

/** One page of `GET /v1/reporting/transactions`, reduced to the rows matching reads. A missing fee is zero. */
export function parseTransactionSearchPage(json: unknown): TransactionPage {
	const body = record(json);
	const details = Array.isArray(body.transaction_details) ? body.transaction_details : [];
	let unreadable = 0;
	const transactions: PayPalTransaction[] = [];
	for (const detail of details) {
		const info = record(record(detail).transaction_info);
		const transactionId = text(info.transaction_id);
		if (transactionId === "") { unreadable++; continue; }
		const amount = record(info.transaction_amount);
		const feeCents = info.fee_amount === undefined || info.fee_amount === null ? 0 : parseAmountCents(record(info.fee_amount).value);
		transactions.push({ transactionId, eventCode: text(info.transaction_event_code), initiatedAt: text(info.transaction_initiation_date),
			amountCents: parseAmountCents(amount.value), feeCents, currency: text(amount.currency_code) });
	}
	return { transactions, unreadable, page: positiveInteger(body.page), totalPages: positiveInteger(body.total_pages) };
}

/** Rows that appear in two windows or two pages are one transaction. */
export function mergeTransactions(batches: readonly (readonly PayPalTransaction[])[]): PayPalTransaction[] {
	const seen = new Map<string, PayPalTransaction>();
	for (const tx of batches.flat()) {
		const key = [tx.transactionId, tx.eventCode, tx.initiatedAt, tx.amountCents, tx.feeCents, tx.currency].join("|");
		if (!seen.has(key)) seen.set(key, tx);
	}
	return [...seen.values()];
}

/** Consecutive windows covering [fromMs, toMs), each at most 31 days. Neighbours share an edge, which mergeTransactions absorbs. */
export function searchWindows(fromMs: number, toMs: number): { readonly start: string; readonly end: string }[] {
	const windows: { readonly start: string; readonly end: string }[] = [];
	let start = fromMs;
	while (start < toMs) {
		const end = Math.min(start + SEARCH_WINDOW_MS, toMs);
		windows.push({ start: searchInstant(start), end: searchInstant(end) });
		start = end;
	}
	return windows;
}

/** An ISO instant without milliseconds, the form PayPal's date parameters take. */
export function searchInstant(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function positiveInteger(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}
