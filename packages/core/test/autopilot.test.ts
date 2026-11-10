import assert from "node:assert/strict";
import test from "node:test";
import { decidePreApproval, decideTick } from "../src/autopilot.ts";
import type { StandingOrders, TickInput, TickJob, TrackedJob } from "../src/autopilot.ts";

const operator = "op_owner";
const agent = "agent-code";
const commit = "a".repeat(40);
const standing: StandingOrders = { autopilot: true, runsOn: "owner", priceFloorCents: 1000, maxConcurrent: 2 };

function job(id: string, fields: Partial<TickJob> = {}): TickJob {
	return { id, status: "OPEN", vertical: "code", budgetCents: 5000, bids: [], attempts: { left: 3, history: [] }, ...fields };
}

function bid(status: string, fields: { agent?: string; operator?: string } = {}) {
	return { operator: fields.operator ?? operator, agent: fields.agent ?? agent, status };
}

function input(jobs: readonly TickJob[], tracked: Record<string, TrackedJob> = {}, orders: Partial<StandingOrders> = {}): TickInput {
	return { operatorId: operator, agentId: agent, task: "code", orders: { ...standing, ...orders }, jobs, tracked };
}

test("autopilot off stops the tick before any action", () => {
	const decision = decideTick(input([job("job_a")], {}, { autopilot: false }));
	assert.equal(decision.stop, "autopilot is off");
	assert.deepEqual(decision.actions, []);
});

test("an acquit-hosted agent is not run by the owner worker", () => {
	const decision = decideTick(input([job("job_a")], {}, { runsOn: "acquit" }));
	assert.equal(decision.stop, "hosted on Acquit");
	assert.deepEqual(decision.actions, []);
});

test("bids only on open jobs of the agent's task, budget at or above the floor, with no bid from this operator", () => {
	const decision = decideTick(input([
		job("job_match"),
		job("job_other_task", { vertical: "print-fdm" }),
		job("job_low_budget", { budgetCents: 999 }),
		job("job_closed", { status: "CLOSED" }),
		job("job_already_bid", { bids: [bid("PENDING")] }),
		job("job_match_two"),
	]));
	assert.deepEqual(decision.actions, [
		{ kind: "bid", jobId: "job_match", priceCents: 1000 },
		{ kind: "bid", jobId: "job_match_two", priceCents: 1000 },
	]);
});

test("a job bid on by another operator's agent is still biddable by this operator", () => {
	const decision = decideTick(input([job("job_taken", { bids: [bid("PENDING", { operator: "op_other", agent: "agent-x" })] })]));
	assert.deepEqual(decision.actions, [{ kind: "bid", jobId: "job_taken", priceCents: 1000 }]);
});

test("new bids are capped at the free slots", () => {
	const decision = decideTick(input([job("job_a"), job("job_b"), job("job_c")], {}, { maxConcurrent: 1 }));
	assert.deepEqual(decision.actions, [{ kind: "bid", jobId: "job_a", priceCents: 1000 }]);
});

test("a tracked job is never bid on again, and a finished one does not count as active", () => {
	const decision = decideTick(input([job("job_done")], { job_done: { phase: "DONE", commit: null } }, { maxConcurrent: 1 }));
	assert.deepEqual(decision.actions, []);
	assert.equal(decision.note, "no open job matches");
});

test("active jobs count against max concurrent, and skip bidding at the limit", () => {
	const running = job("job_run", { status: "IN_PROGRESS", bids: [bid("ACCEPTED")] });
	const decision = decideTick(input([running, job("job_new")], { job_run: { phase: "RAN", commit } }, { maxConcurrent: 1 }));
	assert.deepEqual(decision.actions, [{ kind: "submit", jobId: "job_run" }]);
	assert.equal(decision.note, "at max concurrent: 1 of 1 active");
});

test("a job that finishes this tick frees its slot for a new bid in the same tick", () => {
	const verified = job("job_done", {
		status: "IN_PROGRESS", bids: [bid("ACCEPTED")],
		attempts: { left: 2, history: [{ sourceCommit: commit, result: "VERIFIED" }] },
	});
	const decision = decideTick(input([verified, job("job_next")], { job_done: { phase: "SUBMITTED", commit } }, { maxConcurrent: 1 }));
	assert.deepEqual(decision.actions, [
		{ kind: "finish", jobId: "job_done", outcome: "VERIFIED", reason: "verifier passed the commit" },
		{ kind: "bid", jobId: "job_next", priceCents: 1000 },
	]);
});

test("an accepted bid on an in-progress job runs it", () => {
	const decision = decideTick(input([job("job_won", { status: "IN_PROGRESS", bids: [bid("ACCEPTED")] })], { job_won: { phase: "BID", commit: null } }));
	assert.deepEqual(decision.actions, [{ kind: "run", jobId: "job_won", reason: "bid accepted" }]);
});

test("an accepted bid from another agent of the operator does not run this agent's job", () => {
	const decision = decideTick(input([job("job_x", { status: "IN_PROGRESS", bids: [bid("ACCEPTED", { agent: "agent-other" })] })], { job_x: { phase: "BID", commit: null } }));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_x", outcome: "BID_LOST", reason: "no bid from this agent on the job" }]);
});

test("a bid that is not selected or returned ends the job as lost", () => {
	for (const status of ["NOT_SELECTED", "RETURNED"]) {
		const decision = decideTick(input([job("job_lost", { bids: [bid(status)] })], { job_lost: { phase: "BID", commit: null } }));
		assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_lost", outcome: "BID_LOST", reason: `bid is ${status}` }]);
	}
});

test("a pending bid waits, and the job still counts as active", () => {
	const decision = decideTick(input([job("job_wait", { bids: [bid("PENDING")] }), job("job_new")], { job_wait: { phase: "BID", commit: null } }, { maxConcurrent: 2 }));
	assert.deepEqual(decision.actions, [{ kind: "bid", jobId: "job_new", priceCents: 1000 }]);
});

test("an accepted bid on a job that is no longer in progress is closed, not run", () => {
	const decision = decideTick(input([job("job_paid", { status: "PAID", bids: [bid("ACCEPTED")] })], { job_paid: { phase: "WON", commit: null } }));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_paid", outcome: "CLOSED", reason: "job is PAID" }]);
});

test("a run that is done submits, and a request that is waiting submits again", () => {
	for (const phase of ["RAN", "REQUESTED"] as const) {
		const decision = decideTick(input([job("job_s", { status: "IN_PROGRESS", bids: [bid("ACCEPTED")] })], { job_s: { phase, commit } }));
		assert.deepEqual(decision.actions, [{ kind: "submit", jobId: "job_s" }]);
	}
});

test("a rejected attempt with attempts left runs the job again", () => {
	const job_r = job("job_r", {
		status: "IN_PROGRESS", bids: [bid("ACCEPTED")],
		attempts: { left: 2, history: [{ sourceCommit: commit, result: "REJECTED" }] },
	});
	const decision = decideTick(input([job_r], { job_r: { phase: "SUBMITTED", commit } }));
	assert.deepEqual(decision.actions, [{ kind: "run", jobId: "job_r", reason: "attempt rejected, 2 left" }]);
});

test("a rejected attempt with no attempts left finishes the job", () => {
	const job_r = job("job_r", {
		status: "IN_PROGRESS", bids: [bid("ACCEPTED")],
		attempts: { left: 0, history: [{ sourceCommit: commit, result: "REJECTED" }] },
	});
	const decision = decideTick(input([job_r], { job_r: { phase: "SUBMITTED", commit } }));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_r", outcome: "REJECTED", reason: "attempt rejected, none left" }]);
});

test("a submitted commit waits while the job is in progress, and a verdict on another commit does not count", () => {
	const other = "b".repeat(40);
	const waiting = job("job_w", {
		status: "IN_PROGRESS", bids: [bid("ACCEPTED")],
		attempts: { left: 2, history: [{ sourceCommit: other, result: "REJECTED" }] },
	});
	const decision = decideTick(input([waiting], { job_w: { phase: "SUBMITTED", commit } }));
	assert.deepEqual(decision.actions, []);
	assert.equal(decision.stop, null);
});

test("a submitted commit on a settled job with no verdict for it is closed", () => {
	const decision = decideTick(input([job("job_p", { status: "PAID", bids: [bid("ACCEPTED")] })], { job_p: { phase: "SUBMITTED", commit } }));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_p", outcome: "CLOSED", reason: "job is PAID with no verdict for this commit" }]);
});

test("a submitted commit whose VERIFIED verdict is kept on a paid job finishes VERIFIED", () => {
	const paid = job("job_p", { status: "PAID", bids: [bid("ACCEPTED")], attempts: { left: 2, history: [{ sourceCommit: commit, result: "VERIFIED" }] } });
	const decision = decideTick(input([paid], { job_p: { phase: "SUBMITTED", commit } }));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_p", outcome: "VERIFIED", reason: "verifier passed the commit" }]);
});

test("a verdict for another commit on a paid job does not finish the submitted commit", () => {
	const paid = job("job_p", { status: "PAID", bids: [bid("ACCEPTED")], attempts: { left: 2, history: [{ sourceCommit: "b".repeat(40), result: "VERIFIED" }] } });
	const decision = decideTick(input([paid], { job_p: { phase: "SUBMITTED", commit } }));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_p", outcome: "CLOSED", reason: "job is PAID with no verdict for this commit" }]);
});

test("a tracked job missing from the list is closed", () => {
	const decision = decideTick(input([], { job_gone: { phase: "BID", commit: null } }));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_gone", outcome: "CLOSED", reason: "job is no longer listed" }]);
});

test("a later entry for the same job id replaces the earlier one", () => {
	const stale = job("job_dup");
	const fresh = job("job_dup", { status: "IN_PROGRESS", bids: [bid("ACCEPTED")] });
	const decision = decideTick(input([stale, fresh], { job_dup: { phase: "BID", commit: null } }));
	assert.deepEqual(decision.actions, [{ kind: "run", jobId: "job_dup", reason: "bid accepted" }]);
});

test("pre-approval needs autopilot, the pre-approve flag, a fixture match, and room under the cap", () => {
	const ready = { autopilot: true, preApprove: true, cap: 3, approvedInWindow: 2, fixtureMatched: true };
	assert.deepEqual(decidePreApproval(ready), { approved: true });
	assert.deepEqual(decidePreApproval({ ...ready, autopilot: false }), { approved: false, reason: "autopilot is off" });
	assert.deepEqual(decidePreApproval({ ...ready, preApprove: false }), { approved: false, reason: "pre-approval is off" });
	assert.deepEqual(decidePreApproval({ ...ready, fixtureMatched: false }), { approved: false, reason: "job fixture is not matched" });
});

test("pre-approval stops at the daily cap, and the cap is 1 to 3", () => {
	const ready = { autopilot: true, preApprove: true, cap: 3, approvedInWindow: 3, fixtureMatched: true };
	assert.deepEqual(decidePreApproval(ready), { approved: false, reason: "daily cap reached: 3 of 3 in 24 h" });
	assert.deepEqual(decidePreApproval({ ...ready, cap: 1, approvedInWindow: 0 }), { approved: true });
	assert.deepEqual(decidePreApproval({ ...ready, cap: 1, approvedInWindow: 1 }), { approved: false, reason: "daily cap reached: 1 of 1 in 24 h" });
	for (const cap of [0, 4, 1.5]) {
		assert.equal(decidePreApproval({ ...ready, cap }).approved, false);
	}
});
