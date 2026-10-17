import assert from "node:assert/strict";
import test from "node:test";
import type { FigureJob } from "../../../packages/core/src/explain.ts";
import type { ReconciledRow } from "../../../packages/core/src/reconcile.ts";
import { traceFigure, type TraceDeps } from "../src/figure-trace.ts";
import type { ReconciliationBody } from "../src/reconciliation.ts";

const T1 = "2026-10-13T12:00:00.000Z";
const T2 = "2026-10-13T13:00:00.000Z";
const NOW = "2026-10-13T14:00:00.000Z";

const LEDGER: readonly FigureJob[] = [
	{ jobId: "job_paid", escrow: "RELEASED", receipt: { id: "rcpt_paid" },
		lines: [{ kind: "HELD", cents: 10_000, at: T1 }, { kind: "RELEASED", cents: 9_000, at: T2 }, { kind: "FEE", cents: 1_000, at: T2 }] },
	{ jobId: "job_held", escrow: "HELD", receipt: null, lines: [{ kind: "HELD", cents: 5_000, at: T1 }] },
];

const row = (entryId: string, patch: Partial<ReconciledRow>): ReconciledRow => ({
	entryId, jobId: entryId.split("#")[0] ?? "", kind: "HELD", at: T1, leg: "AMOUNT", expectedCents: 0, objectKind: "CAPTURE",
	objectId: "CAP-x", status: "MATCHED", reason: null, note: null, observedCents: 0, paypalStatus: "COMPLETED", payoutTransactionId: null,
	...patch,
});

function body(rows: readonly ReconciledRow[]): ReconciliationBody {
	return { counts: { matched: 0, pending: 0, mismatched: 0, notChecked: 0 }, rows, checkedAt: NOW,
		objects: { read: 0, cached: 0, budget: 60 }, other: { state: "NOT_READ", reason: "SPAN_TOO_LONG" } };
}

const TABLES = { entries: [], events: [] };

function deps(patch: Partial<TraceDeps> = {}): TraceDeps {
	return { platformView: async () => LEDGER, platformTables: async () => TABLES, reconcile: async () => body([]), nowMs: () => Date.parse(NOW), ...patch };
}

test("each traced line takes its PayPal status from the reconciliation row for its entry id", async () => {
	const rows = [
		row("job_paid#0", { kind: "HELD", objectId: "CAP-paid", status: "MATCHED", observedCents: 10_000, note: "Matched on the capture." }),
		row("job_paid#1", { kind: "RELEASED", objectKind: "PAYOUT_ITEM", objectId: "PAYOUT-1", status: "PENDING_AT_PAYPAL", expectedCents: 9_000,
			observedCents: null, note: "PayPal reports the payout item as UNCLAIMED." }),
		row("job_paid#2", { kind: "FEE", leg: "FEE", objectId: "CAP-paid", status: "MISMATCHED", reason: "AMOUNT", expectedCents: 300, observedCents: 900,
			note: "The amounts differ." }),
		row("job_held#0", { jobId: "job_held", objectId: "CAP-held", status: "NOT_CHECKED", reason: "NOT_READ_YET", observedCents: null,
			note: "Not checked yet: this refresh's PayPal read budget is spent." }),
	];
	const trace = await traceFigure(deps({ reconcile: async () => body(rows) }), "released");
	assert.equal(trace.figure, "released");
	assert.equal(trace.label, "Released");
	assert.equal(trace.totalCents, 9_000);
	assert.deepEqual(trace.lines, [
		{ entryId: "job_paid#1", jobId: "job_paid", kind: "RELEASED", cents: 9_000, at: T2, receiptId: "rcpt_paid",
			paypal: { id: "PAYOUT-1", status: "PENDING_AT_PAYPAL", checkedCents: 9_000, observedCents: null, note: "PayPal reports the payout item as UNCLAIMED." } },
	]);

	const held = await traceFigure(deps({ reconcile: async () => body(rows) }), "held");
	assert.equal(held.totalCents, 5_000);
	assert.deepEqual(held.lines.map(line => [line.entryId, line.paypal.status, line.paypal.id, line.paypal.observedCents]),
		[["job_held#0", "NOT_CHECKED", "CAP-held", null]], "a line PayPal was not asked about says so, and keeps the object it names");

	const fees = await traceFigure(deps({ reconcile: async () => body(rows) }), "fees");
	assert.deepEqual(fees.lines[0]?.paypal, { id: "CAP-paid", status: "MISMATCHED", checkedCents: 300, observedCents: 900, note: "The amounts differ." },
		"a mismatch is shown as a mismatch, with what PayPal observed and the processor cents it was compared on");
});

test("the trace's total is the sum of its lines, and a held job's lines carry no receipt", async () => {
	const trace = await traceFigure(deps({ reconcile: async () => body([]) }), "held");
	assert.equal(trace.lines.reduce((sum, line) => sum + line.cents, 0), trace.totalCents);
	assert.equal(trace.lines[0]?.receiptId, null);
});

test("a line the read names no PayPal object for is NOT_CHECKED with no id, never MATCHED", async () => {
	const rows = [row("job_held#0", { objectId: null, status: "NOT_CHECKED", reason: "NO_PAYPAL_ID", observedCents: null,
		note: "no PayPal event is recorded for this capture", objectKind: null, paypalStatus: null })];
	const trace = await traceFigure(deps({ reconcile: async () => body(rows) }), "held");
	assert.deepEqual(trace.lines[0]?.paypal, { id: null, status: "NOT_CHECKED", checkedCents: 0, observedCents: null,
		note: "no PayPal event is recorded for this capture" });
});

test("without PayPal credentials every line is NOT_CHECKED with the reason, and none is MATCHED", async () => {
	const trace = await traceFigure(deps({ reconcile: null }), "fees");
	assert.deepEqual(trace.lines.map(line => line.paypal), [{ id: null, status: "NOT_CHECKED", checkedCents: null, observedCents: null,
		note: "PayPal is not configured on this deployment, so this line was not checked." }]);
});

test("a reconciliation that throws shows every line NOT_CHECKED with the reason, and none is MATCHED", async () => {
	const trace = await traceFigure(deps({ reconcile: async () => { throw new Error("socket hang up"); } }), "released");
	assert.deepEqual(trace.lines.map(line => line.paypal.status), ["NOT_CHECKED"]);
	assert.equal(trace.lines[0]?.paypal.note, "PayPal could not be read just now, so this line was not checked.");
});

test("a line the reconciliation did not return is NOT_CHECKED, never MATCHED", async () => {
	const trace = await traceFigure(deps({ reconcile: async () => body([row("job_other#0", {})]) }), "held");
	assert.deepEqual(trace.lines[0]?.paypal, { id: null, status: "NOT_CHECKED", checkedCents: null, observedCents: null, note: "This line is not in the PayPal read." });
});

test("a figure with no lines makes no PayPal read, because it has no PayPal object to check", async () => {
	let reads = 0;
	const trace = await traceFigure(deps({ platformView: async () => [], platformTables: async () => { reads++; return TABLES; },
		reconcile: async () => { reads++; return body([]); } }), "fees");
	assert.deepEqual(trace, { figure: "fees", label: "Fees collected", totalCents: 0, lines: [] });
	assert.equal(reads, 0);
});

test("the reconciliation reads the same tables and the same clock the dashboard card reads", async () => {
	const seen: { entries: number; nowMs: number }[] = [];
	const tables = { entries: [{ entryId: "job_held#0", jobId: "job_held", kind: "HELD" as const, cents: 5_000, at: T1, captureId: null, processorCents: null }], events: [] };
	await traceFigure(deps({ platformTables: async () => tables, reconcile: async (read, nowMs) => { seen.push({ entries: read.entries.length, nowMs }); return body([]); } }),
		"held");
	assert.deepEqual(seen, [{ entries: 1, nowMs: Date.parse(NOW) }]);
});
