// Reconciles the platform ledger against PayPal. Each ledger line is checked against the PayPal object that owns it,
// read live: the capture a hold and a fee sit on, the refund a refund line names, the referenced payout item a release
// names. Pure: the route reads each object and hands the readings in, so every rule here is a fixture test. Money is
// integer cents, and PayPal's decimal strings are parsed exactly, never through floating point.
//
// Transaction Search is the platform account's own reporting. Escrow captures, refunds, and releases are on each
// operator's merchant account, which Search does not show, so its rows are other activity, never evidence.

/** Transaction Search answers at most 31 days per request. */
export const SEARCH_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const USD = "USD";
/** Capture states that mean the capture was taken, whatever refunds came after. */
const CAPTURED = ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"];
/** Referenced payout item states PayPal reports while the money has not moved yet. */
const PENDING_PAYOUT = ["CREATED", "PENDING", "ONHOLD", "UNCLAIMED"];

export type ReconcileKind = "HELD" | "RELEASED" | "FEE" | "REFUND";
/** AMOUNT compares the object's own amount; FEE compares the processor fee PayPal kept on the capture. */
export type ReconcileLeg = "AMOUNT" | "FEE";
export type ReconcileStatus = "MATCHED" | "PENDING_AT_PAYPAL" | "MISMATCHED" | "NOT_CHECKED";
export type ObjectKind = "CAPTURE" | "REFUND" | "PAYOUT_ITEM";
/**
 * One code per cause. NOT_CHECKED causes are never mismatches: the read did not complete or names no object.
 * PAYPAL_PENDING is the only pending cause, and it means PayPal itself reports the object as pending.
 */
export type ReconcileReason =
	| "NOT_AT_PAYPAL" | "AMOUNT" | "CURRENCY" | "STATUS" | "NOT_REFUNDED"
	| "PAYPAL_PENDING"
	| "NO_PAYPAL_ID" | "PAYPAL_UNREADABLE" | "NOT_READ_YET" | "UNREADABLE_AMOUNT" | "NO_STATUS";

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

/** The PayPal ids one capture carries: the merchant that owns it, and the refund and payout item when there are any. */
export type CaptureEventInput = { readonly captureId: string; readonly merchant: string; readonly refundId: string | null; readonly payoutItemId: string | null };

/** One PayPal object to read. `merchant` names the assertion a merchant's capture or refund needs; null for the platform token. */
export type ObjectTarget = { readonly kind: ObjectKind; readonly id: string; readonly merchant: string | null };

export type LineTarget = { readonly ok: true; readonly object: ObjectTarget } | { readonly ok: false; readonly why: string };

/** The fields a reconcile reads from one object. PayPal's amounts are unsigned: the kind of object gives the direction. */
export type ObjectFact =
	| { readonly kind: "CAPTURE"; readonly status: string; readonly grossCents: number | null; readonly processorFeeCents: number | null; readonly currency: string | null }
	| { readonly kind: "REFUND"; readonly status: string; readonly amountCents: number | null; readonly currency: string | null }
	| { readonly kind: "PAYOUT_ITEM"; readonly status: string; readonly amountCents: number | null; readonly currency: string | null; readonly payoutTransactionId: string | null };

/** What one read of an object returned. NOT_READ is the refresh's budget running out before the object was asked for. */
export type Reading =
	| { readonly state: "FOUND"; readonly fact: ObjectFact }
	| { readonly state: "NOT_FOUND" }
	| { readonly state: "UNAVAILABLE"; readonly detail: string }
	| { readonly state: "NOT_READ" };

export type ReconciledRow = {
	readonly entryId: string;
	readonly jobId: string;
	readonly kind: ReconcileKind;
	readonly at: string;
	readonly leg: ReconcileLeg;
	/** The ledger's own cents: the processor fee for a FEE line. Null when the line names none. */
	readonly expectedCents: number | null;
	readonly objectKind: ObjectKind | null;
	readonly objectId: string | null;
	readonly status: ReconcileStatus;
	readonly reason: ReconcileReason | null;
	/** A sentence for the screen: what was matched, or what PayPal said. Null when there is nothing to add. */
	readonly note: string | null;
	readonly observedCents: number | null;
	/** PayPal's own status word for the object, when it answered one. */
	readonly paypalStatus: string | null;
	/** The payout transaction a released item moved money under, which Transaction Search keys on. */
	readonly payoutTransactionId: string | null;
};

export type Reconciliation = {
	readonly counts: { readonly matched: number; readonly pending: number; readonly mismatched: number; readonly notChecked: number };
	readonly rows: readonly ReconciledRow[];
};

/**
 * The object a ledger line is checked against. A hold and its fee read the capture; a release reads its referenced
 * payout item; a refund reads its refund, or the capture it refunded when no refund id was recorded.
 */
export function targetOf(line: LedgerLineInput, event: CaptureEventInput | undefined): LineTarget {
	if (line.kind === "RELEASED") {
		const itemId = event?.payoutItemId ?? null;
		return itemId === null ? none("no payout item id is recorded for this release") : { ok: true, object: { kind: "PAYOUT_ITEM", id: itemId, merchant: null } };
	}
	if (line.captureId === null) return none("no capture id is recorded for this line");
	if (event === undefined) return none("no PayPal event is recorded for this capture");
	if (line.kind === "REFUND" && event.refundId !== null) return { ok: true, object: { kind: "REFUND", id: event.refundId, merchant: event.merchant } };
	return { ok: true, object: { kind: "CAPTURE", id: line.captureId, merchant: event.merchant } };
}

const none = (why: string): LineTarget => ({ ok: false, why });

/** One key per object, so a capture a hold and a fee both name is read once. */
export function targetKey(target: ObjectTarget): string {
	return `${target.kind}:${target.id}`;
}

/** The path PayPal serves one object on. */
export function objectPath(target: ObjectTarget): string {
	const id = encodeURIComponent(target.id);
	switch (target.kind) {
		case "CAPTURE": return `/v2/payments/captures/${id}`;
		case "REFUND": return `/v2/payments/refunds/${id}`;
		case "PAYOUT_ITEM": return `/v1/payments/referenced-payouts-items/${id}`;
	}
}

/** Whether a reading is in a state the object can be cached from. Anything still moving is read again next time. */
export function settled(fact: ObjectFact): boolean {
	switch (fact.kind) {
		case "CAPTURE": return CAPTURED.includes(fact.status);
		case "REFUND": return fact.status === "COMPLETED";
		case "PAYOUT_ITEM": return fact.status === "SUCCESS";
	}
}

/** The fields a reconcile reads from one PayPal object's JSON. Never throws: a missing field reads as null. */
export function factOf(kind: ObjectKind, json: unknown): ObjectFact {
	const body = record(json);
	if (kind === "CAPTURE") {
		const amount = money(body.amount);
		const status = text(body.status);
		return { kind, status, grossCents: amount.cents, processorFeeCents: money(record(body.seller_receivable_breakdown).paypal_fee).cents, currency: amount.currency };
	}
	if (kind === "REFUND") {
		const amount = money(body.amount);
		return { kind, status: text(body.status), amountCents: amount.cents, currency: amount.currency };
	}
	const paid = money(body.payout_amount);
	return { kind, status: text(record(body.processing_state).status), amountCents: paid.cents, currency: paid.currency,
		payoutTransactionId: text(body.payout_transaction_id) || null };
}

/** The verdict for one line. Each class carries only the fields that class needs. */
type Verdict = Pick<ReconciledRow, "status" | "reason" | "note" | "observedCents" | "paypalStatus" | "payoutTransactionId">;

/** Matches each ledger line to the PayPal object it is checked against, using that object's reading. */
export function reconcileLines(lines: readonly LedgerLineInput[], events: readonly CaptureEventInput[], readings: ReadonlyMap<string, Reading>): Reconciliation {
	const byCapture = new Map(events.map(event => [event.captureId, event] as const));
	const counts = { matched: 0, pending: 0, mismatched: 0, notChecked: 0 };
	const rows = lines.map((line): ReconciledRow => {
		const event = line.captureId === null ? undefined : byCapture.get(line.captureId);
		const target = targetOf(line, event);
		const reading = target.ok ? readings.get(targetKey(target.object)) ?? { state: "NOT_READ" as const } : null;
		const verdict = judge(line, target, reading);
		if (verdict.status === "MATCHED") counts.matched++;
		else if (verdict.status === "PENDING_AT_PAYPAL") counts.pending++;
		else if (verdict.status === "MISMATCHED") counts.mismatched++;
		else counts.notChecked++;
		return { entryId: line.entryId, jobId: line.jobId, kind: line.kind, at: line.at, leg: line.kind === "FEE" ? "FEE" : "AMOUNT",
			expectedCents: expectedOf(line), objectKind: target.ok ? target.object.kind : null, objectId: target.ok ? target.object.id : null, ...verdict };
	});
	return { counts, rows };
}

/** The magnitude the line should show: the processor fee for a FEE line, the line's cents otherwise. */
function expectedOf(line: LedgerLineInput): number | null {
	return line.kind === "FEE" ? line.processorCents : line.cents;
}

function judge(line: LedgerLineInput, target: LineTarget, reading: Reading | null): Verdict {
	if (!target.ok || reading === null) return notChecked("NO_PAYPAL_ID", target.ok ? "The read did not run." : target.why);
	switch (reading.state) {
		case "NOT_READ": return notChecked("NOT_READ_YET", "Not checked yet: this refresh's PayPal read budget is spent.");
		case "UNAVAILABLE": return notChecked("PAYPAL_UNREADABLE", `PayPal could not be read (${reading.detail}).`);
		case "NOT_FOUND": return mismatched("NOT_AT_PAYPAL", "PayPal has no such object.");
		case "FOUND": return judgeFact(line, reading.fact);
	}
}

function judgeFact(line: LedgerLineInput, fact: ObjectFact): Verdict {
	const expected = expectedOf(line);
	if (expected === null) return notChecked("UNREADABLE_AMOUNT", "The ledger line names no processor fee.");
	if (fact.status === "") return notChecked("NO_STATUS", "PayPal answered without a status.");
	if (fact.kind === "CAPTURE") return line.kind === "REFUND" ? judgeCaptureRefund(fact, expected) : judgeCapture(line, fact, expected);
	if (fact.kind === "REFUND") return judgeRefund(fact, expected);
	return judgePayout(fact, expected);
}

/** A hold or a fee: the capture was taken at the held gross, and PayPal kept the processor fee the ledger recorded. */
function judgeCapture(line: LedgerLineInput, fact: Extract<ObjectFact, { kind: "CAPTURE" }>, expected: number): Verdict {
	if (fact.status === "PENDING") return pending("PayPal reports the capture as PENDING.", fact.status);
	if (!CAPTURED.includes(fact.status)) return mismatched("STATUS", `PayPal reports the capture as ${fact.status}.`, fact.status);
	if (fact.currency !== USD) return mismatched("CURRENCY", `PayPal reports the capture in ${fact.currency ?? "no currency"}.`, fact.status);
	const observed = line.kind === "FEE" ? fact.processorFeeCents : fact.grossCents;
	if (observed === null) return notChecked("UNREADABLE_AMOUNT", "PayPal's amount cannot be read.", fact.status);
	return observed === expected ? matched(observed, fact.status, null) : mismatched("AMOUNT", "The amounts differ.", fact.status, observed);
}

/**
 * A refund line with no refund id: the capture it refunded is the only PayPal object left to read. A full refund
 * shows on it as REFUNDED at the refunded gross. A capture still COMPLETED has no refund on it at all.
 */
function judgeCaptureRefund(fact: Extract<ObjectFact, { kind: "CAPTURE" }>, expected: number): Verdict {
	if (fact.status === "PENDING") return pending("PayPal reports the capture as PENDING.", fact.status);
	if (fact.currency !== USD) return mismatched("CURRENCY", `PayPal reports the capture in ${fact.currency ?? "no currency"}.`, fact.status);
	if (fact.status === "REFUNDED") {
		if (fact.grossCents === null) return notChecked("UNREADABLE_AMOUNT", "PayPal's amount cannot be read.", fact.status);
		return fact.grossCents === expected
			? matched(fact.grossCents, fact.status, "Refund id not recorded, matched on the capture.")
			: mismatched("AMOUNT", "The refunded amount differs from the capture's gross.", fact.status, fact.grossCents);
	}
	if (fact.status === "COMPLETED") return mismatched("NOT_REFUNDED", "PayPal shows no refund on the capture.", fact.status);
	if (fact.status === "PARTIALLY_REFUNDED") return mismatched("STATUS", "PayPal reports the capture as partially refunded.", fact.status);
	return mismatched("STATUS", `PayPal reports the capture as ${fact.status}.`, fact.status);
}

function judgeRefund(fact: Extract<ObjectFact, { kind: "REFUND" }>, expected: number): Verdict {
	if (fact.status === "PENDING") return pending("PayPal reports the refund as PENDING.", fact.status);
	if (fact.status !== "COMPLETED") return mismatched("STATUS", `PayPal reports the refund as ${fact.status}.`, fact.status);
	if (fact.currency !== USD) return mismatched("CURRENCY", `PayPal reports the refund in ${fact.currency ?? "no currency"}.`, fact.status);
	if (fact.amountCents === null) return notChecked("UNREADABLE_AMOUNT", "PayPal's amount cannot be read.", fact.status);
	return fact.amountCents === expected ? matched(fact.amountCents, fact.status, null) : mismatched("AMOUNT", "The amounts differ.", fact.status, fact.amountCents);
}

function judgePayout(fact: Extract<ObjectFact, { kind: "PAYOUT_ITEM" }>, expected: number): Verdict {
	if (PENDING_PAYOUT.includes(fact.status)) return { ...pending(`PayPal reports the payout item as ${fact.status}.`, fact.status), payoutTransactionId: fact.payoutTransactionId };
	if (fact.status !== "SUCCESS") return { ...mismatched("STATUS", `PayPal reports the payout item as ${fact.status}.`, fact.status), payoutTransactionId: fact.payoutTransactionId };
	if (fact.currency !== USD) return { ...mismatched("CURRENCY", `PayPal reports the payout in ${fact.currency ?? "no currency"}.`, fact.status), payoutTransactionId: fact.payoutTransactionId };
	if (fact.amountCents === null) return { ...notChecked("UNREADABLE_AMOUNT", "PayPal's amount cannot be read.", fact.status), payoutTransactionId: fact.payoutTransactionId };
	const verdict = fact.amountCents === expected ? matched(fact.amountCents, fact.status, null) : mismatched("AMOUNT", "The amounts differ.", fact.status, fact.amountCents);
	return { ...verdict, payoutTransactionId: fact.payoutTransactionId };
}

const matched = (observedCents: number, paypalStatus: string, note: string | null): Verdict =>
	({ status: "MATCHED", reason: null, note, observedCents, paypalStatus, payoutTransactionId: null });
const pending = (note: string, paypalStatus: string): Verdict =>
	({ status: "PENDING_AT_PAYPAL", reason: "PAYPAL_PENDING", note, observedCents: null, paypalStatus, payoutTransactionId: null });
const mismatched = (reason: ReconcileReason, note: string, paypalStatus: string | null = null, observedCents: number | null = null): Verdict =>
	({ status: "MISMATCHED", reason, note, observedCents, paypalStatus, payoutTransactionId: null });
const notChecked = (reason: ReconcileReason, note: string, paypalStatus: string | null = null): Verdict =>
	({ status: "NOT_CHECKED", reason, note, observedCents: null, paypalStatus, payoutTransactionId: null });

/** Platform-account rows no checked object claims. They are other activity, shown as such, never as a mismatch. */
export function otherActivity(transactions: readonly PayPalTransaction[], claimed: ReadonlySet<string>): PayPalTransaction[] {
	return transactions.filter(tx => !claimed.has(tx.transactionId));
}

// ---- PayPal's amounts and Transaction Search answers --------------------------------------------

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

/** One Transaction Search row, reduced to what other activity shows. */
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

export type TransactionPage = {
	readonly transactions: readonly PayPalTransaction[];
	/** Rows PayPal sent without an id, which no line can match. */
	readonly unreadable: number;
	readonly page: number;
	readonly totalPages: number;
};

/** One page of `GET /v1/reporting/transactions`, reduced to the rows other activity shows. A missing fee is zero. */
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

/** A resource's amount as unsigned cents. PayPal's resource amounts are unsigned: the object's kind gives the direction. */
function money(value: unknown): { readonly cents: number | null; readonly currency: string | null } {
	const amount = record(value);
	const cents = parseAmountCents(amount.value);
	return { cents: cents === null ? null : Math.abs(cents), currency: typeof amount.currency_code === "string" ? amount.currency_code : null };
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
