import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SEARCH_WINDOW_MS, factOf, mergeTransactions, objectPath, otherActivity, parseAmountCents, parseTransactionSearchPage, reconcileLines, searchInstant, searchWindows, settled, targetKey, targetOf } from "../src/reconcile.ts";
import type { CaptureEventInput, LedgerLineInput, ObjectFact, ObjectTarget, PayPalTransaction, Reading } from "../src/reconcile.ts";

// The fixtures are sanitized sandbox answers, read with GET on the dates the test names in its comments.
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/paypal-reconcile/${name}`, import.meta.url), "utf8"));

const CAPTURE = "5JG93436967627628";
const REFUNDED_CAPTURE = "6JF13492HA714842D";
const RELEASED_CAPTURE = "20P48555BH2356736";
const REFUND = "88B878042R851314U";
const PAYOUT_ITEM = "9gOgdaF5wfRSLI3kq8V7Boe9yIED2EzXBOksl3cCejMKFr60SucjaQN58AOIYo0=";
const MERCHANT = "MERCHANT_SANDBOX";

const captureFact = (json: unknown) => factOf("CAPTURE", json);
const refundFact = (json: unknown) => factOf("REFUND", json);
const payoutFact = (json: unknown) => factOf("PAYOUT_ITEM", json);

function line(overrides: Partial<LedgerLineInput> & Pick<LedgerLineInput, "entryId" | "kind">): LedgerLineInput {
	return { jobId: "job_a", cents: 0, at: "2026-10-17T10:00:00Z", captureId: CAPTURE, processorCents: null, ...overrides };
}

function event(overrides: Partial<CaptureEventInput> & Pick<CaptureEventInput, "captureId">): CaptureEventInput {
	return { merchant: MERCHANT, refundId: null, payoutItemId: null, ...overrides };
}

const found = (fact: ObjectFact): Reading => ({ state: "FOUND", fact });
const captureTarget = (id: string): ObjectTarget => ({ kind: "CAPTURE", id, merchant: MERCHANT });

/** Runs one line against one object reading, and returns that line's row. */
function checkOne(entry: LedgerLineInput, events: readonly CaptureEventInput[], object: ObjectTarget, reading: Reading) {
	const result = reconcileLines([entry], events, new Map([[targetKey(object), reading]]));
	return { row: result.rows[0], counts: result.counts };
}

test("PayPal's decimal strings become signed integer cents exactly", () => {
	assert.equal(parseAmountCents("420.00"), 42000);
	assert.equal(parseAmountCents("-15.15"), -1515);
	assert.equal(parseAmountCents("0.5"), 50);
	assert.equal(parseAmountCents("7"), 700);
	assert.equal(parseAmountCents("-0.00"), 0);
	assert.equal(parseAmountCents("9007199254740991.00"), null, "beyond the safe integer range is unreadable");
	assert.equal(parseAmountCents("1.234"), null, "a fraction of a cent is unreadable");
	assert.equal(parseAmountCents("+1.00"), null);
	assert.equal(parseAmountCents("12.3.4"), null);
	assert.equal(parseAmountCents(12), null, "a number is not PayPal's string form");
});

test("the live capture 5JG93436967627628 (COMPLETED, read 2026-10-17) reads as 378.00 gross and a 10.28 processor fee", () => {
	assert.deepEqual(captureFact(fixture("capture-completed-with-fee.json")),
		{ kind: "CAPTURE", status: "COMPLETED", grossCents: 37800, processorFeeCents: 1028, currency: "USD", feeCurrency: "USD" });
});

test("the live refunded capture 6JF13492HA714842D keeps its 420.00 gross and the 15.15 fee PayPal retained", () => {
	assert.deepEqual(captureFact(fixture("capture-refunded-no-refund-id.json")),
		{ kind: "CAPTURE", status: "REFUNDED", grossCents: 42000, processorFeeCents: 1515, currency: "USD", feeCurrency: "USD" });
});

test("the live refund 88B878042R851314U reads as COMPLETED 420.00 USD", () => {
	assert.deepEqual(refundFact(fixture("refund-completed.json")), { kind: "REFUND", status: "COMPLETED", amountCents: 42000, currency: "USD" });
});

test("the live referenced payout item reads as SUCCESS 363.78 with payout transaction 51P63583VW950112R", () => {
	assert.deepEqual(payoutFact(fixture("referenced-payout-success.json")),
		{ kind: "PAYOUT_ITEM", status: "SUCCESS", amountCents: 36378, currency: "USD", payoutTransactionId: "51P63583VW950112R" });
});

test("PayPal's resource amounts are unsigned: a negative amount reads as its magnitude, the object's kind gives the direction", () => {
	assert.deepEqual(refundFact({ status: "COMPLETED", amount: { value: "-420.00", currency_code: "USD" } }),
		{ kind: "REFUND", status: "COMPLETED", amountCents: 42000, currency: "USD" });
});

test("a hold and its fee on the live capture are MATCHED: the fee leg checks the processor fee PayPal kept", () => {
	const events = [event({ captureId: CAPTURE })];
	const readings = new Map([[targetKey(captureTarget(CAPTURE)), found(captureFact(fixture("capture-completed-with-fee.json")))]]);
	const result = reconcileLines([
		line({ entryId: "job_a#0", kind: "HELD", cents: 37800 }),
		line({ entryId: "job_a#2", kind: "FEE", cents: 6000, processorCents: 1028 }),
	], events, readings);
	assert.deepEqual(result.rows.map(r => [r.entryId, r.leg, r.expectedCents, r.observedCents, r.status, r.reason]), [
		["job_a#0", "AMOUNT", 37800, 37800, "MATCHED", null],
		["job_a#2", "FEE", 1028, 1028, "MATCHED", null],
	]);
	assert.deepEqual(result.counts, { matched: 2, pending: 0, mismatched: 0, notChecked: 0 });
});

test("a released line is checked on its referenced payout item, and shows the payout transaction it moved money under", () => {
	const { row, counts } = checkOne(line({ entryId: "job_a#1", kind: "RELEASED", cents: 36378, captureId: RELEASED_CAPTURE }),
		[event({ captureId: RELEASED_CAPTURE, payoutItemId: PAYOUT_ITEM })],
		{ kind: "PAYOUT_ITEM", id: PAYOUT_ITEM, merchant: null },
		found(payoutFact(fixture("referenced-payout-success.json"))));
	assert.deepEqual([row?.status, row?.reason, row?.observedCents, row?.paypalStatus, row?.payoutTransactionId, row?.objectKind],
		["MATCHED", null, 36378, "SUCCESS", "51P63583VW950112R", "PAYOUT_ITEM"]);
	assert.deepEqual(counts, { matched: 1, pending: 0, mismatched: 0, notChecked: 0 });
});

test("a refund with its refund id is checked on the refund object, which the merchant's assertion reads", () => {
	const { row } = checkOne(line({ entryId: "job_b#1", kind: "REFUND", cents: 42000, captureId: REFUNDED_CAPTURE }),
		[event({ captureId: REFUNDED_CAPTURE, refundId: REFUND })],
		{ kind: "REFUND", id: REFUND, merchant: MERCHANT },
		found(refundFact(fixture("refund-completed.json"))));
	assert.deepEqual([row?.status, row?.observedCents, row?.objectKind, row?.objectId], ["MATCHED", 42000, "REFUND", REFUND]);
});

test("a refund with no refund id is matched on the capture it refunded, and the screen is told why", () => {
	const { row } = checkOne(line({ entryId: "job_b#1", kind: "REFUND", cents: 42000, captureId: REFUNDED_CAPTURE }),
		[event({ captureId: REFUNDED_CAPTURE, refundId: null })],
		captureTarget(REFUNDED_CAPTURE),
		found(captureFact(fixture("capture-refunded-no-refund-id.json"))));
	assert.deepEqual([row?.status, row?.reason, row?.note, row?.observedCents, row?.objectKind],
		["MATCHED", null, "Refund id not recorded, matched on the capture.", 42000, "CAPTURE"]);
});

test("a refund line on a capture still COMPLETED with no refund is a mismatch, never a match", () => {
	const { row } = checkOne(line({ entryId: "job_b#1", kind: "REFUND", cents: 37800 }),
		[event({ captureId: CAPTURE, refundId: null })],
		captureTarget(CAPTURE),
		found(captureFact(fixture("capture-completed-with-fee.json"))));
	assert.deepEqual([row?.status, row?.reason, row?.paypalStatus], ["MISMATCHED", "NOT_REFUNDED", "COMPLETED"]);
});

test("simulated: a ledger hold of 420.00 against the live 378.00 capture is MISMATCHED AMOUNT, with PayPal's amount shown", () => {
	const { row, counts } = checkOne(line({ entryId: "job_a#0", kind: "HELD", cents: 42000 }),
		[event({ captureId: CAPTURE })],
		captureTarget(CAPTURE),
		found(captureFact(fixture("capture-completed-with-fee.json"))));
	assert.deepEqual([row?.status, row?.reason, row?.expectedCents, row?.observedCents], ["MISMATCHED", "AMOUNT", 42000, 37800]);
	assert.deepEqual(counts, { matched: 0, pending: 0, mismatched: 1, notChecked: 0 });
});

test("PayPal's 404 for the object is MISMATCHED: PayPal has no such object", () => {
	const { row, counts } = checkOne(line({ entryId: "job_a#0", kind: "HELD", cents: 37800, at: "2026-10-17T10:00:00Z" }),
		[event({ captureId: CAPTURE })], captureTarget(CAPTURE), { state: "NOT_FOUND" });
	assert.deepEqual([row?.status, row?.reason, row?.note], ["MISMATCHED", "NOT_AT_PAYPAL", "PayPal has no such object."]);
	assert.deepEqual(counts, { matched: 0, pending: 0, mismatched: 1, notChecked: 0 });
});

test("a PayPal 5xx is NOT_CHECKED, never a mismatch", () => {
	const { row, counts } = checkOne(line({ entryId: "job_a#0", kind: "HELD", cents: 37800 }),
		[event({ captureId: CAPTURE })], captureTarget(CAPTURE), { state: "UNAVAILABLE", detail: "PayPal answered 503" });
	assert.deepEqual([row?.status, row?.reason], ["NOT_CHECKED", "PAYPAL_UNREADABLE"]);
	assert.deepEqual(counts, { matched: 0, pending: 0, mismatched: 0, notChecked: 1 });
});

test("a line past the refresh's read budget is NOT_CHECKED (not checked yet), never a mismatch", () => {
	const { row, counts } = checkOne(line({ entryId: "job_a#0", kind: "HELD", cents: 37800 }),
		[event({ captureId: CAPTURE })], captureTarget(CAPTURE), { state: "NOT_READ" });
	assert.deepEqual([row?.status, row?.reason], ["NOT_CHECKED", "NOT_READ_YET"]);
	assert.deepEqual(counts, { matched: 0, pending: 0, mismatched: 0, notChecked: 1 });
});

test("a payout PayPal reports as PENDING is PENDING_AT_PAYPAL at any age (synthetic: no pending item exists to read)", () => {
	const pendingItem = { ...(fixture("referenced-payout-success.json") as Record<string, unknown>), processing_state: { status: "PENDING" } };
	const { row, counts } = checkOne(line({ entryId: "job_a#1", kind: "RELEASED", cents: 36378, captureId: RELEASED_CAPTURE, at: "2026-09-01T10:00:00Z" }),
		[event({ captureId: RELEASED_CAPTURE, payoutItemId: PAYOUT_ITEM })],
		{ kind: "PAYOUT_ITEM", id: PAYOUT_ITEM, merchant: null },
		found(payoutFact(pendingItem)));
	assert.deepEqual([row?.status, row?.reason, row?.paypalStatus], ["PENDING_AT_PAYPAL", "PAYPAL_PENDING", "PENDING"]);
	assert.deepEqual(counts, { matched: 0, pending: 1, mismatched: 0, notChecked: 0 });
});

test("a capture PayPal reports as partially refunded is a STATUS mismatch (synthetic: the live capture is whole)", () => {
	const partial = { ...(fixture("capture-refunded-no-refund-id.json") as Record<string, unknown>), status: "PARTIALLY_REFUNDED" };
	const { row } = checkOne(line({ entryId: "job_b#1", kind: "REFUND", cents: 42000, captureId: REFUNDED_CAPTURE }),
		[event({ captureId: REFUNDED_CAPTURE, refundId: null })], captureTarget(REFUNDED_CAPTURE), found(captureFact(partial)));
	assert.deepEqual([row?.status, row?.reason], ["MISMATCHED", "STATUS"]);
});

test("a capture in another currency is a CURRENCY mismatch (synthetic: the live captures are USD)", () => {
	const euro = { ...(fixture("capture-completed-with-fee.json") as Record<string, unknown>), amount: { value: "378.00", currency_code: "EUR" } };
	const { row } = checkOne(line({ entryId: "job_a#0", kind: "HELD", cents: 37800 }),
		[event({ captureId: CAPTURE })], captureTarget(CAPTURE), found(captureFact(euro)));
	assert.deepEqual([row?.status, row?.reason], ["MISMATCHED", "CURRENCY"]);
});

test("a processor fee in another currency is a CURRENCY mismatch on a USD capture; the hold on that capture still matches (synthetic: the live fee is USD)", () => {
	const euroFee = { ...(fixture("capture-completed-with-fee.json") as Record<string, unknown>),
		seller_receivable_breakdown: { paypal_fee: { currency_code: "EUR", value: "10.28" } } };
	const events = [event({ captureId: CAPTURE })];
	const readings = new Map([[targetKey(captureTarget(CAPTURE)), found(captureFact(euroFee))]]);
	const result = reconcileLines([
		line({ entryId: "job_a#0", kind: "HELD", cents: 37800 }),
		line({ entryId: "job_a#2", kind: "FEE", cents: 6000, processorCents: 1028 }),
	], events, readings);
	assert.deepEqual(result.rows.map(r => [r.entryId, r.status, r.reason, r.note]), [
		["job_a#0", "MATCHED", null, null],
		["job_a#2", "MISMATCHED", "CURRENCY", "PayPal reports the processor fee in EUR."],
	]);
	assert.deepEqual(result.counts, { matched: 1, pending: 0, mismatched: 1, notChecked: 0 });
});

test("a released line that names no payout item is NOT_CHECKED with the reason, never a mismatch", () => {
	const result = reconcileLines([line({ entryId: "job_a#1", kind: "RELEASED", cents: 36378, captureId: RELEASED_CAPTURE })],
		[event({ captureId: RELEASED_CAPTURE, payoutItemId: null })], new Map());
	assert.deepEqual([result.rows[0]?.status, result.rows[0]?.reason, result.rows[0]?.note],
		["NOT_CHECKED", "NO_PAYPAL_ID", "no payout item id is recorded for this release"]);
	assert.deepEqual(result.counts, { matched: 0, pending: 0, mismatched: 0, notChecked: 1 });
});

test("targetOf names the object each kind of line is checked against", () => {
	const events = [event({ captureId: CAPTURE, refundId: REFUND, payoutItemId: null })];
	assert.deepEqual(targetOf(line({ entryId: "a", kind: "HELD", cents: 1 }), events[0]), { ok: true, object: captureTarget(CAPTURE) });
	assert.deepEqual(targetOf(line({ entryId: "a", kind: "FEE", cents: 1, processorCents: 1 }), events[0]), { ok: true, object: captureTarget(CAPTURE) });
	assert.deepEqual(targetOf(line({ entryId: "a", kind: "REFUND", cents: 1 }), events[0]),
		{ ok: true, object: { kind: "REFUND", id: REFUND, merchant: MERCHANT } });
	assert.deepEqual(targetOf(line({ entryId: "a", kind: "REFUND", cents: 1 }), event({ captureId: CAPTURE })),
		{ ok: true, object: captureTarget(CAPTURE) }, "a refund with no refund id reads the capture it refunded");
	assert.deepEqual(targetOf(line({ entryId: "a", kind: "HELD", cents: 1 }), undefined),
		{ ok: false, why: "no PayPal event is recorded for this capture" });
	assert.deepEqual(targetOf(line({ entryId: "a", kind: "HELD", cents: 1, captureId: null }), undefined),
		{ ok: false, why: "no capture id is recorded for this line" });
});

test("object paths encode the id: a payout item id ending in = is read as %3D", () => {
	assert.equal(objectPath({ kind: "PAYOUT_ITEM", id: PAYOUT_ITEM, merchant: null }),
		"/v1/payments/referenced-payouts-items/9gOgdaF5wfRSLI3kq8V7Boe9yIED2EzXBOksl3cCejMKFr60SucjaQN58AOIYo0%3D");
	assert.equal(objectPath({ kind: "CAPTURE", id: CAPTURE, merchant: MERCHANT }), "/v2/payments/captures/5JG93436967627628");
	assert.equal(objectPath({ kind: "REFUND", id: REFUND, merchant: MERCHANT }), "/v2/payments/refunds/88B878042R851314U");
});

test("only a settled object is cached; a pending one is read again next refresh", () => {
	assert.equal(settled(captureFact(fixture("capture-completed-with-fee.json"))), true);
	assert.equal(settled(refundFact(fixture("refund-completed.json"))), true);
	assert.equal(settled(payoutFact(fixture("referenced-payout-success.json"))), true);
	assert.equal(settled({ kind: "PAYOUT_ITEM", status: "PENDING", amountCents: 36378, currency: "USD", payoutTransactionId: null }), false);
	assert.equal(settled({ kind: "CAPTURE", status: "PENDING", grossCents: 37800, processorFeeCents: null, currency: "USD", feeCurrency: null }), false);
});

test("Transaction Search rows no checked object claims are other activity, and nothing else", () => {
	const claimed = new Set([CAPTURE]);
	const treasury: PayPalTransaction = { transactionId: "0GY91147YF6986614", eventCode: "T0001", initiatedAt: "2026-10-16T10:00:00Z", amountCents: -1515, feeCents: -25, currency: "USD" };
	const capture: PayPalTransaction = { transactionId: CAPTURE, eventCode: "T0006", initiatedAt: "2026-10-14T10:00:00Z", amountCents: 37800, feeCents: 0, currency: "USD" };
	assert.deepEqual(otherActivity([capture, treasury], claimed), [treasury]);
});

// ---- Transaction Search answers --------------------------------------------------------------

function row(id: string, value: string | undefined, extra: Record<string, unknown> = {}): unknown {
	return { transaction_info: { transaction_id: id, transaction_event_code: "T0001", transaction_initiation_date: "2026-10-16T10:00:00Z",
		transaction_amount: { currency_code: "USD", value }, ...extra } };
}

test("a Search row carries its signed amount and fee exactly, and a missing fee reads as zero", () => {
	const parsed = parseTransactionSearchPage({ transaction_details: [
		row("0GY91147YF6986614", "-15.15", { fee_amount: { currency_code: "USD", value: "-0.25" } }),
		row("PLAIN", "420.00"),
	], page: 1, total_pages: 1 });
	assert.deepEqual(parsed.transactions.map(t => [t.transactionId, t.amountCents, t.feeCents]), [["0GY91147YF6986614", -1515, -25], ["PLAIN", 42000, 0]]);
});

test("a page reports its place, and rows that repeat across pages count once", () => {
	const first = parseTransactionSearchPage({ transaction_details: [row("CAP-1", "420.00"), row("CAP-2", "100.00")], page: 1, total_pages: 2 });
	const second = parseTransactionSearchPage({ transaction_details: [row("CAP-2", "100.00"), row("CAP-3", "50.00")], page: 2, total_pages: 2 });
	assert.deepEqual([first.page, first.totalPages, second.page, second.totalPages], [1, 2, 2, 2]);
	assert.deepEqual(mergeTransactions([first.transactions, second.transactions]).map(t => t.transactionId), ["CAP-1", "CAP-2", "CAP-3"]);
});

test("a Search row without an id is counted unreadable, never listed", () => {
	const parsed = parseTransactionSearchPage({ transaction_details: [{ transaction_info: { transaction_amount: { currency_code: "USD", value: "420.00" } } }, row("CAP-1", "420.00")] });
	assert.equal(parsed.unreadable, 1);
	assert.deepEqual(parsed.transactions.map(t => t.transactionId), ["CAP-1"]);
});

test("Transaction Search windows never exceed 31 days and cover the whole span in order", () => {
	assert.equal(SEARCH_WINDOW_MS, 31 * 24 * 60 * 60 * 1000);
	const from = Date.parse("2026-10-01T00:00:00Z");
	const to = from + 70 * 24 * 60 * 60 * 1000;
	assert.deepEqual(searchWindows(from, to), [
		{ start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
		{ start: "2026-11-01T00:00:00Z", end: "2026-12-02T00:00:00Z" },
		{ start: "2026-12-02T00:00:00Z", end: "2026-12-10T00:00:00Z" },
	]);
	assert.equal(searchInstant(Date.parse("2026-10-01T00:00:00.250Z")), "2026-10-01T00:00:00Z");
	assert.deepEqual(searchWindows(from, from), [], "an empty span asks PayPal for nothing");
});
