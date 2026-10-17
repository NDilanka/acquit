import assert from "node:assert/strict";
import test from "node:test";
import { FIGURE_IDS, figureCents, figureLines, isFigureId, ledgerEntryId, type FigureJob } from "../src/explain.ts";

const T1 = "2026-10-13T12:00:00.000Z";
const T2 = "2026-10-13T13:00:00.000Z";

// Three jobs: one paid, one still held in escrow, one refunded. Each book is stored in the order
// the ledger writes it: a hold first, then the release and fee, or the refund.
const LEDGER: readonly FigureJob[] = [
	{ jobId: "job_paid", escrow: "RELEASED", receipt: { id: "rcpt_paid" },
		lines: [{ kind: "HELD", cents: 10_000, at: T1 }, { kind: "RELEASED", cents: 9_000, at: T2 }, { kind: "FEE", cents: 1_000, at: T2 }] },
	{ jobId: "job_held", escrow: "HELD", receipt: null, lines: [{ kind: "HELD", cents: 5_000, at: T1 }] },
	{ jobId: "job_refunded", escrow: "REFUNDED", receipt: null, lines: [{ kind: "HELD", cents: 4_000, at: T1 }, { kind: "REFUND", cents: 4_000, at: T2 }] },
];

test("each figure's value is the sum of the lines it names, and the totals match a literal ledger", () => {
	const literal = { held: 5_000, released: 9_000, refunded: 4_000, fees: 1_000, "paid-by-clients": 10_000 };
	for (const id of FIGURE_IDS) {
		const explained = figureLines(LEDGER, id);
		assert.equal(explained.lines.reduce((sum, line) => sum + line.cents, 0), explained.totalCents, `${id}: its lines sum to its total`);
		assert.equal(explained.totalCents, literal[id], `${id}: the literal total`);
		assert.equal(figureCents(LEDGER, id), literal[id], `${id}: the total the dashboards read`);
	}
});

test("fees collected lists exactly the fee lines: no hold and no refund", () => {
	const fees = figureLines(LEDGER, "fees");
	assert.equal(fees.label, "Fees collected");
	assert.equal(fees.totalCents, 1_000);
	assert.deepEqual(fees.lines, [{ entryId: "job_paid#2", jobId: "job_paid", kind: "FEE", cents: 1_000, at: T2, receiptId: "rcpt_paid" }]);
});

test("a refunded job counts toward refunded, and never toward fees or released", () => {
	assert.deepEqual(figureLines(LEDGER, "refunded").lines, [
		{ entryId: "job_refunded#1", jobId: "job_refunded", kind: "REFUND", cents: 4_000, at: T2, receiptId: null },
	]);
	const elsewhere = [...figureLines(LEDGER, "fees").lines, ...figureLines(LEDGER, "released").lines];
	assert.equal(elsewhere.some(line => line.jobId === "job_refunded"), false, "no fee or release names the refunded job");
});

test("a hold counts as held only while its job is still in escrow", () => {
	assert.deepEqual(figureLines(LEDGER, "held").lines.map(line => line.entryId), ["job_held#0"]);
	assert.deepEqual(figureLines(LEDGER, "paid-by-clients").lines.map(line => line.entryId), ["job_paid#0"]);
});

test("released names the paid job's release line, with its receipt", () => {
	assert.deepEqual(figureLines(LEDGER, "released").lines, [
		{ entryId: "job_paid#1", jobId: "job_paid", kind: "RELEASED", cents: 9_000, at: T2, receiptId: "rcpt_paid" },
	]);
});

test("an empty ledger totals zero for every figure, and every id is recognised", () => {
	for (const id of FIGURE_IDS) {
		const empty = figureLines([], id);
		assert.equal(empty.totalCents, 0, `${id} is zero with no jobs`);
		assert.deepEqual(empty.lines, []);
		assert.equal(isFigureId(id), true);
	}
	assert.equal(isFigureId("verifier-pass-rate"), false, "a verifier rate is not a ledger figure");
	assert.equal(isFigureId(undefined), false);
});

test("a ledger line's id names its job and its position in the job's book", () => {
	assert.equal(ledgerEntryId("job_x", 2), "job_x#2");
});
