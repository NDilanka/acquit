import assert from "node:assert/strict";
import test from "node:test";
import { PENDING_AT_PAYPAL_MS, SEARCH_WINDOW_MS, expectationsOf, mergeTransactions, parseAmountCents, parseTransactionSearchPage, reconcile, searchInstant, searchWindows } from "../src/reconcile.ts";
import type { LedgerExpectation, PayPalTransaction } from "../src/reconcile.ts";

const NOW = "2026-10-13T12:00:00Z";

function expectation(overrides: Partial<LedgerExpectation> & Pick<LedgerExpectation, "entryId">): LedgerExpectation {
	return { jobId: "job_a", kind: "HELD", at: "2026-10-13T11:00:00Z", paypalId: "CAP-1", leg: "AMOUNT", expectedCents: 42000, ...overrides };
}

function tx(overrides: Partial<PayPalTransaction> & Pick<PayPalTransaction, "transactionId">): PayPalTransaction {
	return { eventCode: "T0006", initiatedAt: "2026-10-13T11:00:00Z", amountCents: 42000, feeCents: 0, currency: "USD", ...overrides };
}

/** One Transaction Search page, as PayPal's JSON names its fields. */
function page(rows: readonly unknown[], current = 1, totalPages = 1): unknown {
	return { transaction_details: rows, page: current, total_pages: totalPages, total_items: rows.length };
}

function row(id: string, value: string | undefined, extra: Record<string, unknown> = {}): unknown {
	const info: Record<string, unknown> = {
		transaction_id: id, transaction_event_code: "T0006", transaction_initiation_date: "2026-10-13T11:00:00Z",
		transaction_amount: { currency_code: "USD", value },
		...extra,
	};
	return { transaction_info: info };
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
	assert.equal(parseAmountCents("-"), null);
	assert.equal(parseAmountCents("12.3.4"), null);
	assert.equal(parseAmountCents(12), null, "a number is not PayPal's string form");
});

test("a row PayPal agrees with on id, amount, and currency is MATCHED", () => {
	const result = reconcile([expectation({ entryId: "job_a#0" })], [tx({ transactionId: "CAP-1" })], NOW);
	assert.deepEqual(result.counts, { matched: 1, pending: 0, mismatched: 0, unknown: 0 });
	assert.deepEqual(result.rows[0], { ...expectation({ entryId: "job_a#0" }), status: "MATCHED", reason: null, observedCents: 42000 });
});

test("the 3-hour lag: 2h59m with no PayPal row is pending, 3h01m is mismatched, and exactly 3h is mismatched", () => {
	assert.equal(PENDING_AT_PAYPAL_MS, 3 * 60 * 60 * 1000);
	const result = reconcile([
		expectation({ entryId: "young", paypalId: "CAP-2", at: "2026-10-13T09:01:00Z" }),
		expectation({ entryId: "old", paypalId: "CAP-3", at: "2026-10-13T08:59:00Z" }),
		expectation({ entryId: "edge", paypalId: "CAP-4", at: "2026-10-13T09:00:00Z" }),
	], [], NOW);
	assert.deepEqual(result.rows.map(r => [r.entryId, r.status, r.reason]), [
		["young", "PENDING_AT_PAYPAL", null],
		["old", "MISMATCHED", "MISSING_AT_PAYPAL"],
		["edge", "MISMATCHED", "MISSING_AT_PAYPAL"],
	]);
	assert.deepEqual(result.counts, { matched: 0, pending: 1, mismatched: 2, unknown: 0 });
});

test("an amount PayPal shows differently is MISMATCHED at any age, never pending", () => {
	const result = reconcile([expectation({ entryId: "job_a#0", at: "2026-10-13T11:00:00Z" })], [tx({ transactionId: "CAP-1", amountCents: 41900 })], NOW);
	assert.deepEqual(result.rows[0], { ...expectation({ entryId: "job_a#0" }), status: "MISMATCHED", reason: "AMOUNT", observedCents: 41900 });
});

test("a currency PayPal shows differently is MISMATCHED CURRENCY; an unreadable amount is UNREADABLE_AMOUNT", () => {
	const result = reconcile([
		expectation({ entryId: "eur", paypalId: "CAP-6" }),
		expectation({ entryId: "bad", paypalId: "CAP-7" }),
	], [tx({ transactionId: "CAP-6", currency: "EUR" }), tx({ transactionId: "CAP-7", amountCents: null })], NOW);
	assert.deepEqual(result.rows.map(r => [r.entryId, r.status, r.reason, r.observedCents]), [
		["eur", "MISMATCHED", "CURRENCY", 42000],
		["bad", "MISMATCHED", "UNREADABLE_AMOUNT", null],
	]);
});

test("a line with no PayPal id is pending while young and NO_PAYPAL_ID once older than the window", () => {
	const result = reconcile([
		expectation({ entryId: "young-refund", kind: "REFUND", paypalId: null, at: "2026-10-13T11:30:00Z", expectedCents: -42000 }),
		expectation({ entryId: "old-refund", kind: "REFUND", paypalId: null, at: "2026-10-13T08:00:00Z", expectedCents: -42000 }),
	], [], NOW);
	assert.deepEqual(result.rows.map(r => [r.entryId, r.status, r.reason]), [
		["young-refund", "PENDING_AT_PAYPAL", null],
		["old-refund", "MISMATCHED", "NO_PAYPAL_ID"],
	]);
});

test("PayPal rows no ledger line claims are unknown at Acquit", () => {
	const stray = tx({ transactionId: "PAYOUT-STRAY", eventCode: "T0400", amountCents: -2500 });
	const result = reconcile([expectation({ entryId: "job_a#0" })], [tx({ transactionId: "CAP-1" }), stray], NOW);
	assert.deepEqual(result.counts, { matched: 1, pending: 0, mismatched: 0, unknown: 1 });
	assert.deepEqual(result.unknown, [stray]);
});

test("a refund is money out: PayPal's -420.00 matches -42000, and a flipped sign is an AMOUNT mismatch", () => {
	const refundExpectation = expectationsOf([{ entryId: "job_b#1", jobId: "job_b", kind: "REFUND", cents: 42000,
		at: "2026-10-13T11:00:00Z", captureId: "CAP-R", processorCents: null }], [{ captureId: "CAP-R", refundId: "REF-1", payoutItemId: null }]);
	assert.equal(refundExpectation[0]?.expectedCents, -42000);

	const signed = parseTransactionSearchPage(page([row("REF-1", "-420.00", { transaction_event_code: "T1106" })])).transactions;
	assert.equal(reconcile(refundExpectation, signed, NOW).rows[0]?.status, "MATCHED");

	const flipped = parseTransactionSearchPage(page([row("REF-1", "420.00", { transaction_event_code: "T1106" })])).transactions;
	const mismatch = reconcile(refundExpectation, flipped, NOW).rows[0];
	assert.equal(mismatch?.status, "MISMATCHED");
	assert.equal(mismatch?.reason, "AMOUNT");
	assert.equal(mismatch?.observedCents, 42000);
});

test("the fee leg checks the processor fee PayPal kept on the capture; no fee_amount reads as zero", () => {
	const lines = [
		{ entryId: "job_a#0", jobId: "job_a", kind: "HELD" as const, cents: 42000, at: "2026-10-13T11:00:00Z", captureId: "CAP-1", processorCents: null },
		{ entryId: "job_a#2", jobId: "job_a", kind: "FEE" as const, cents: 6000, at: "2026-10-13T11:30:00Z", captureId: "CAP-1", processorCents: 1515 },
	];
	const events = [{ captureId: "CAP-1", refundId: null, payoutItemId: null }];
	const withFee = parseTransactionSearchPage(page([row("CAP-1", "420.00", { fee_amount: { currency_code: "USD", value: "-15.15" } })])).transactions;
	const both = reconcile(expectationsOf(lines, events), withFee, NOW);
	assert.deepEqual(both.rows.map(r => [r.entryId, r.leg, r.expectedCents, r.status]), [
		["job_a#0", "AMOUNT", 42000, "MATCHED"],
		["job_a#2", "FEE", -1515, "MATCHED"],
	]);

	const noFee = parseTransactionSearchPage(page([row("CAP-1", "420.00")])).transactions;
	const feeMismatch = reconcile(expectationsOf(lines, events), noFee, NOW).rows[1];
	assert.equal(feeMismatch?.status, "MISMATCHED");
	assert.equal(feeMismatch?.reason, "AMOUNT", "the fee leg reports its own amount");
	assert.equal(feeMismatch?.observedCents, 0);
});

test("a paid job's lines map to the capture, the payout item, and the processor fee on the capture", () => {
	const lines = [
		{ entryId: "job_a#0", jobId: "job_a", kind: "HELD" as const, cents: 42000, at: "2026-10-13T11:00:00Z", captureId: "CAP-P", processorCents: null },
		{ entryId: "job_a#1", jobId: "job_a", kind: "RELEASED" as const, cents: 36000, at: "2026-10-13T11:30:00Z", captureId: "CAP-P", processorCents: null },
		{ entryId: "job_a#2", jobId: "job_a", kind: "FEE" as const, cents: 6000, at: "2026-10-13T11:30:00Z", captureId: "CAP-P", processorCents: 1515 },
	];
	const mapped = expectationsOf(lines, [{ captureId: "CAP-P", refundId: null, payoutItemId: "PAYOUT-ITEM-1" }])
		.map(e => [e.entryId, e.paypalId, e.leg, e.expectedCents]);
	assert.deepEqual(mapped, [
		["job_a#0", "CAP-P", "AMOUNT", 42000],
		["job_a#1", "PAYOUT-ITEM-1", "AMOUNT", -36000],
		["job_a#2", "CAP-P", "FEE", -1515],
	]);
});

test("a refund read back from its capture names no refund id, so it has no PayPal id to look up", () => {
	const [refund] = expectationsOf([{ entryId: "job_b#1", jobId: "job_b", kind: "REFUND", cents: 42000,
		at: "2026-10-13T11:00:00Z", captureId: "CAP-R", processorCents: null }], [{ captureId: "CAP-R", refundId: null, payoutItemId: null }]);
	assert.equal(refund?.paypalId, null);
});

test("Transaction Search windows never exceed 31 days and cover the whole span in order", () => {
	assert.equal(SEARCH_WINDOW_MS, 31 * 24 * 60 * 60 * 1000);
	const from = Date.parse("2026-10-01T00:00:00Z");
	const to = from + 70 * 24 * 60 * 60 * 1000;
	const windows = searchWindows(from, to);
	assert.deepEqual(windows, [
		{ start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
		{ start: "2026-11-01T00:00:00Z", end: "2026-12-02T00:00:00Z" },
		{ start: "2026-12-02T00:00:00Z", end: "2026-12-10T00:00:00Z" },
	]);
	for (const window of windows) assert.ok(Date.parse(window.end) - Date.parse(window.start) <= SEARCH_WINDOW_MS);
	assert.equal(searchInstant(Date.parse("2026-10-01T00:00:00.250Z")), "2026-10-01T00:00:00Z");
	assert.deepEqual(searchWindows(from, from), [], "an empty span asks PayPal for nothing");
});

test("a page reports its place, and rows that repeat across pages count once", () => {
	const first = parseTransactionSearchPage(page([row("CAP-1", "420.00"), row("CAP-2", "100.00")], 1, 2));
	const second = parseTransactionSearchPage(page([row("CAP-2", "100.00"), row("CAP-3", "50.00")], 2, 2));
	assert.deepEqual([first.page, first.totalPages, second.page, second.totalPages], [1, 2, 2, 2]);
	const merged = mergeTransactions([first.transactions, second.transactions]);
	assert.deepEqual(merged.map(t => t.transactionId), ["CAP-1", "CAP-2", "CAP-3"]);
});

test("a Transaction Search row without an id is counted unreadable, never matched", () => {
	const parsed = parseTransactionSearchPage(page([{ transaction_info: { transaction_amount: { currency_code: "USD", value: "420.00" } } }, row("CAP-1", "420.00")]));
	assert.equal(parsed.unreadable, 1);
	assert.deepEqual(parsed.transactions.map(t => t.transactionId), ["CAP-1"]);
});
