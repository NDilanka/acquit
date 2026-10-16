// The operator's escrow read: one row per hold the operator's release will pay, at the operator's net.
// A client's job, a refund in flight, and another operator's hold never appear.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobView } from "../../../packages/core/src/acquit.ts";
import { operatorEscrow } from "../src/escrow.ts";

function bid(operator: string, price: number) {
	return { id: `bid_${operator}`, operator, handle: operator, label: "INDEPENDENT", price, eta: 48, agent: "ts-bugfixer",
		runner: "codex", pitch: "One fix.", paidReceipts: 4, houseLine: null, status: "CHOSEN" };
}

function job(over: Record<string, unknown>): JobView {
	return { id: "job_a", title: "Fix rounding", status: "IN_PROGRESS", phase: "READY", checkoutPhase: null, budget: 50000,
		deliveryEndsAt: "2026-10-20T00:00:00.000Z", bids: { operators: [bid("op_devon", 40000)], house: null }, client: null,
		lockedTo: "op_devon", escrow: "HELD", ledger: [], attempts: { used: 0, left: 3, last: null, reasons: [] },
		...over } as unknown as JobView;
}

test("a held job pays the operator the net after the 10% operator fee", () => {
	// A 40000 bid: the client's gross is 42000 (5% fee on top), and the operator's net is 36000.
	assert.deepEqual(operatorEscrow([job({})], "op_devon"), [{ jobId: "job_a", cents: 36000 }]);
});

test("a house-locked job pays the House's net on its own bid", () => {
	const house = { ...bid("op_house", 25000), label: "HOUSE", handle: "house-tsfix" };
	const row = job({ id: "job_house", lockedTo: "op_house", bids: { operators: [], house } });
	assert.deepEqual(operatorEscrow([row], "op_house"), [{ jobId: "job_house", cents: 22500 }]);
});

test("a refund in flight, a refunded job, and another operator's hold are left out", () => {
	const refundPending = job({ id: "job_refunding", phase: "REFUND_PENDING" });
	const reviewRefund = job({ id: "job_review_refund", status: "VERIFIED", phase: "REFUND_PENDING" });
	const refunded = job({ id: "job_refunded", status: "REFUNDED", phase: "REFUNDED", escrow: "REFUNDED" });
	const others = job({ id: "job_other", lockedTo: "op_noa", bids: { operators: [bid("op_noa", 40000)], house: null } });
	assert.deepEqual(operatorEscrow([refundPending, reviewRefund, refunded, others], "op_devon"), []);
});

test("a checkout refund still in funding is not the operator's money", () => {
	// A capture that did not match its quote: OPEN, FUNDING, checkoutPhase REFUND_PENDING, the escrow still HELD.
	const captureMismatch = job({ id: "job_capture_mismatch", status: "OPEN", phase: "FUNDING", checkoutPhase: "REFUND_PENDING" });
	assert.deepEqual(operatorEscrow([captureMismatch], "op_devon"), []);
});

test("a job nobody holds for the operator contributes nothing", () => {
	const open = job({ id: "job_open", status: "OPEN", phase: "BIDDING", lockedTo: null, escrow: "NONE" });
	assert.deepEqual(operatorEscrow([open], "op_devon"), []);
});
