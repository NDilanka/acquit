// The morning report and the money-held view, read against literal rows. A refunded job's pass moves no
// verified count or grade, its rejection still does, and its capture id reaches only the locked operator.
// The rows go through a fresh in-memory store, so there is no PayPal call and no HTTP server.

import assert from "node:assert/strict";
import { test } from "node:test";
import { instant } from "../../../packages/core/src/ids.ts";
import type { OperatorId } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import { SqliteStore } from "../../../packages/core/src/store.ts";
import type { ObjectRead } from "../src/reconciliation.ts";
import { moneyHeldOf, morningReport } from "../src/specialists.ts";

const OPERATOR = "devon-ops" as OperatorId;
const RIVAL = "rival-ops" as OperatorId;
const AGENT = "ts-bugfixer";
const SHA = "c".repeat(40);
const DEADLINE = "2026-11-13T12:00:00.000Z";
const SINCE = instant("2026-11-10T08:00:00.000Z");
const NOW = instant("2026-11-10T12:30:00.000Z");
const BID_AT = "2026-11-10T09:00:00.000Z";
const CAPTURED_AT = "2026-11-10T10:00:00.000Z";
const REFUND_PASS_AT = "2026-11-10T10:30:00.000Z";
const REFUND_REJECT_AT = "2026-11-10T11:00:00.000Z";
const PAID_PASS_AT = "2026-11-10T11:30:00.000Z";
const REFUNDED_AT = "2026-11-10T12:00:00.000Z";

function bidOf(id: string, price: number) {
	return { id, operator: OPERATOR, handle: "devon-ops", kind: "INDEPENDENT", payee: "MERCHANT-PRIVATE-7", agent: AGENT,
		runner: "claude-code", price, eta: 48, pitch: "", placedAt: BID_AT, respondBy: "2026-11-11T09:00:00.000Z", status: "ACCEPTED" };
}

function lockedBid(bidId: string, price: number) {
	return { bidId, operator: OPERATOR, payee: "MERCHANT-PRIVATE-7", agent: AGENT, price, eta: 48 };
}

function pass(runId: string, at: string) {
	return { result: "VERIFIED", runId, sourceCommit: SHA, mergeCommit: SHA, pullRequest: 9,
		frozen: { expected: 8, passed: 8 }, hidden: { expected: 5, passed: 5 }, at };
}

function reject(runId: string, at: string) {
	return { result: "REJECTED", runId, sourceCommit: SHA, reasonsTruncated: 0,
		reasons: [{ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden-test"] }], at };
}

/** A refunded job: its pass came first, then a rejection, then the refund. Only the fields the reads use. */
function refundedRow(id: string): JobRow {
	return { id, version: 4, client: "maya-client", title: "Refunded fix", openedAt: BID_AT,
		contract: { budget: 40000, deliveryEndsAt: DEADLINE }, bids: [bidOf("bid_refund", 40000)],
		state: { status: "REFUNDED", payee: lockedBid("bid_refund", 40000),
			book: [{ kind: "HELD", cents: 40000, at: CAPTURED_AT }, { kind: "REFUND", cents: 40000, at: REFUNDED_AT }],
			refund: { refundId: "REFUND-R", captureId: "CAPTURE-R", refunded: 40000, retainedProcessorFee: 0, at: REFUNDED_AT },
			history: [{ ordinal: 1, verdict: pass("run_refund_pass", REFUND_PASS_AT) }, { ordinal: 2, verdict: reject("run_refund_fail", REFUND_REJECT_AT) }],
			treasury: [] } } as unknown as JobRow;
}

/** A paid job with one pass, the control: its pass still counts. */
function paidRow(id: string): JobRow {
	return { id, version: 4, client: "maya-client", title: "Paid fix", openedAt: BID_AT,
		contract: { budget: 36000, deliveryEndsAt: DEADLINE }, bids: [bidOf("bid_paid", 36000)],
		state: { status: "PAID", payee: lockedBid("bid_paid", 36000),
			book: [{ kind: "HELD", cents: 36000, at: CAPTURED_AT }, { kind: "RELEASED", cents: 36000, at: PAID_PASS_AT }],
			release: { payoutItemId: "PAYOUT-P", captureId: "CAPTURE-P", paid: 36000, at: PAID_PASS_AT },
			releaseAuthority: "CLIENT_APPROVAL",
			history: [{ ordinal: 1, verdict: pass("run_paid_pass", PAID_PASS_AT) }],
			merge: { phase: "MERGED", at: PAID_PASS_AT, sha: SHA },
			treasury: [] } } as unknown as JobRow;
}

/** A job holding escrow: IN_PROGRESS, locked to OPERATOR, with one capture. */
function escrowRow(id: string, captureId: string): JobRow {
	return { id, version: 3, client: "maya-client", title: "Held fix", openedAt: BID_AT,
		contract: { budget: 40000, deliveryEndsAt: DEADLINE }, bids: [bidOf("bid_held", 40000)],
		state: { status: "IN_PROGRESS",
			escrow: { payee: lockedBid("bid_held", 40000), capture: { orderId: "ORDER-H", captureId, payee: "MERCHANT-PRIVATE-7" },
				book: [{ kind: "HELD", cents: 40000, at: CAPTURED_AT }] } } } as unknown as JobRow;
}

const completedCapture: ObjectRead = async () => ({ state: "FOUND",
	fact: { kind: "CAPTURE", status: "COMPLETED", grossCents: 40000, processorFeeCents: 1515, currency: "USD", feeCurrency: "USD" } });

test("a refunded job's pass moves no verified count or grade, and its rejection still does", () => {
	const store = new SqliteStore(":memory:");
	try {
		store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, NULL)").run("job_refunded", 4, JSON.stringify(refundedRow("job_refunded")));
		store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, NULL)").run("job_paid", 4, JSON.stringify(paidRow("job_paid")));
		const report = morningReport(store.db, OPERATOR, SINCE, "maya-client/invoice-app");
		// The refund is still a win: the accepted bid was won.
		assert.deepEqual(report.wins.filter(entry => entry.jobId === "job_refunded"),
			[{ jobId: "job_refunded", agentId: AGENT, amountCents: 40000, at: CAPTURED_AT }]);
		// Only the paid job's pass is verified.
		assert.deepEqual(report.verified, [{ jobId: "job_paid", agentId: AGENT, runId: "run_paid_pass", at: PAID_PASS_AT }]);
		assert.deepEqual(report.rejected, [{ jobId: "job_refunded", agentId: AGENT, runId: "run_refund_fail", at: REFUND_REJECT_AT }]);
		// Grade changes: -10 for the refunded rejection, +5 for the paid pass, and nothing for the refunded pass.
		// Compared by time, so the result does not depend on the order rows come back in.
		const byTime = (a: { at: string }, b: { at: string }) => a.at.localeCompare(b.at);
		assert.deepEqual([...report.gradeChanges].sort(byTime), [
			{ agentId: AGENT, at: REFUND_REJECT_AT, delta: -10 },
			{ agentId: AGENT, at: PAID_PASS_AT, delta: 5 },
		].sort(byTime));
	} finally { store.close(); }
});

test("money held: the locked operator sees the capture, and another bidder sees only that money is held", async () => {
	const row = escrowRow("job_money_read", "CAPTURE-MONEY-READ");
	assert.deepEqual(await moneyHeldOf(row, OPERATOR, completedCapture, NOW),
		{ held: true, source: "PAYPAL_READ", captureId: "CAPTURE-MONEY-READ", captureStatus: "COMPLETED", checkedAt: NOW });
	assert.deepEqual(await moneyHeldOf(row, RIVAL, completedCapture, NOW),
		{ held: true, source: "PAYPAL_READ", captureId: null, captureStatus: null, checkedAt: NOW });
});

test("money held without a PayPal read: the escrow state answers, and the capture id stays with the locked operator", async () => {
	const row = escrowRow("job_money_state", "CAPTURE-MONEY-STATE");
	assert.deepEqual(await moneyHeldOf(row, OPERATOR, null, NOW),
		{ held: true, source: "ESCROW_STATE", captureId: "CAPTURE-MONEY-STATE", captureStatus: null, checkedAt: NOW });
	assert.deepEqual(await moneyHeldOf(row, RIVAL, null, NOW),
		{ held: true, source: "ESCROW_STATE", captureId: null, captureStatus: null, checkedAt: NOW });
});
