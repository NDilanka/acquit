// The labelled simulated code exam, as pure values: the run a start writes, the run it settles to, the acquittal it
// leaves, and the start guard in front of it. The HTTP path is covered by apps/api/test/specialists-exam.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { examRefusal, gradeOf, recordOf, settledSimulated, simulatedAcquittal, startedRun } from "../src/exam.ts";
import { instant } from "../src/ids.ts";
import type { Agent } from "../src/operator.ts";

const NOW = instant("2026-11-10T12:00:00Z");
const LATER = instant("2026-11-10T12:00:05Z");
const HOUR_MS = 60 * 60 * 1000;

function agent(overrides: Record<string, unknown> = {}): Agent {
	return { id: "exam-fixer", owner: "devon-ops", name: "exam-fixer", task: "code", acquittal: null, ...overrides } as unknown as Agent;
}

function ago(ms: number) {
	return instant(new Date(Date.parse(NOW) - ms).toISOString());
}

test("a simulated start writes a RUNNING run with no counts and the simulated label", () => {
	assert.deepEqual(startedRun("exam_a", agent(), NOW), { id: "exam_a", agentId: "exam-fixer", task: "code", status: "RUNNING",
		visible: null, hidden: null, reasons: [], startedAt: NOW, endedAt: null, simulated: true });
});

test("a simulated run settles PASSED on the example fixture's counts, with no reasons", () => {
	const settled = settledSimulated(startedRun("exam_a", agent(), NOW), LATER);
	assert.equal(settled.id, "exam_a");
	assert.equal(settled.status, "PASSED");
	assert.deepEqual(settled.visible, { passed: 48, total: 48 });
	assert.deepEqual(settled.hidden, { passed: 8, total: 8 });
	assert.deepEqual(settled.reasons, []);
	assert.equal(settled.endedAt, LATER);
	assert.equal(settled.simulated, true);
});

test("the simulated acquittal names the run and carries simulated true", () => {
	const settled = settledSimulated(startedRun("exam_a", agent(), NOW), LATER);
	assert.deepEqual(simulatedAcquittal(settled, LATER), { examId: "exam_a", at: LATER, simulated: true });
});

test("the start guard refuses a laser-cut agent, an acquitted agent, a running exam, and a fourth start in a day", () => {
	assert.equal(examRefusal(agent({ task: "laser-cut" }), [], NOW), "TASK_NOT_EXAMINABLE");
	assert.equal(examRefusal(agent({ acquittal: { examId: "seed", at: NOW } }), [], NOW), "ALREADY_ACQUITTED");
	assert.equal(examRefusal(agent(), [{ status: "RUNNING", startedAt: NOW }], NOW), "EXAM_RUNNING");
	assert.equal(examRefusal(agent(), [{ status: "VERIFYING", startedAt: NOW }], NOW), "EXAM_RUNNING");
	const threeInDay = [ago(HOUR_MS), ago(2 * HOUR_MS), ago(3 * HOUR_MS)].map(startedAt => ({ status: "FAILED", startedAt }));
	assert.equal(examRefusal(agent(), threeInDay, NOW), "EXAM_LIMIT");
	const twoInDay = [ago(HOUR_MS), ago(2 * HOUR_MS), ago(25 * HOUR_MS)].map(startedAt => ({ status: "FAILED", startedAt }));
	assert.equal(examRefusal(agent(), twoInDay, NOW), null);
	assert.equal(examRefusal(agent(), [], NOW), null);
});

test("a simulated acquittal starts the grade at 50 and the record reads no jobs", () => {
	const acquittal = simulatedAcquittal(settledSimulated(startedRun("exam_a", agent(), NOW), LATER), LATER);
	const record = recordOf("exam-fixer", []);
	assert.deepEqual(record, { jobsTaken: 0, verified: 0, rejected: 0, earnedCents: 0 });
	assert.equal(gradeOf(record, acquittal), 50);
});
