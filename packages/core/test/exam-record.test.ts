// The derived record and grade. A verified attempt counts once, whatever state the job has reached since:
// the pass sits in the job's attempt history, and the record reads that history only.

import assert from "node:assert/strict";
import test from "node:test";
import { gradeOf, recordOf } from "../src/exam.ts";
import type { JobRow } from "../src/job.ts";
import { instant } from "../src/ids.ts";
import type { Acquittal } from "../src/operator.ts";

const passed = { ordinal: 1, verdict: { result: "VERIFIED" } };
const rejected = { ordinal: 1, verdict: { result: "REJECTED" } };
const acquittal: Acquittal = { examId: "exam_test", at: instant("2026-11-10T12:00:00Z") };

function payee(agent: string) {
	return { operator: "devon-ops", payee: "sandbox-seller", agent, price: 4000, eta: 48 };
}

function row(state: Record<string, unknown>): JobRow {
	return { id: "job_test", state } as unknown as JobRow;
}

test("a verified job counts its pass once, and the grade rises by one step", () => {
	const rows = [row({ status: "VERIFIED", escrow: { payee: payee("ts-bugfixer") }, history: [passed], passed, runsStarted: 1 })];
	const record = recordOf("ts-bugfixer", rows);
	assert.deepEqual(record, { jobsTaken: 1, verified: 1, rejected: 0, earnedCents: 0 });
	assert.equal(gradeOf(record, acquittal), 55);
});

test("a rejected attempt before a pass counts once each", () => {
	const rows = [row({ status: "VERIFIED", escrow: { payee: payee("ts-bugfixer") }, history: [rejected, passed], passed, runsStarted: 2 })];
	const record = recordOf("ts-bugfixer", rows);
	assert.deepEqual(record, { jobsTaken: 1, verified: 1, rejected: 1, earnedCents: 0 });
	assert.equal(gradeOf(record, acquittal), 45);
});

test("a paid job counts its pass once and its release as earned", () => {
	const rows = [row({ status: "PAID", payee: payee("ts-bugfixer"), release: { paid: 3600 }, history: [passed] })];
	assert.deepEqual(recordOf("ts-bugfixer", rows), { jobsTaken: 1, verified: 1, rejected: 0, earnedCents: 3600 });
});

test("a refunded job keeps its rejections and no earnings", () => {
	const rows = [row({ status: "REFUNDED", payee: payee("ts-bugfixer"), history: [rejected] })];
	assert.deepEqual(recordOf("ts-bugfixer", rows), { jobsTaken: 1, verified: 0, rejected: 1, earnedCents: 0 });
});

test("a refunded job's passes do not count toward the record or the grade, and its rejections still do", () => {
	const rows = [row({ status: "REFUNDED", payee: payee("ts-bugfixer"), history: [passed, rejected] })];
	const record = recordOf("ts-bugfixer", rows);
	assert.deepEqual(record, { jobsTaken: 1, verified: 0, rejected: 1, earnedCents: 0 });
	assert.equal(gradeOf(record, acquittal), 40);
});

test("an in-progress job counts the attempts judged so far", () => {
	const rows = [row({ status: "IN_PROGRESS", escrow: { payee: payee("ts-bugfixer") },
		attempts: { phase: "READY", history: [rejected], runsStarted: 1 } })];
	assert.deepEqual(recordOf("ts-bugfixer", rows), { jobsTaken: 1, verified: 0, rejected: 1, earnedCents: 0 });
});

test("a job another agent won does not count, and an open job counts nothing", () => {
	const rows = [
		row({ status: "VERIFIED", escrow: { payee: payee("other-agent") }, history: [passed], passed, runsStarted: 1 }),
		row({ status: "OPEN", phase: "BIDDING", bids: [] }),
	];
	assert.deepEqual(recordOf("ts-bugfixer", rows), { jobsTaken: 0, verified: 0, rejected: 0, earnedCents: 0 });
});
