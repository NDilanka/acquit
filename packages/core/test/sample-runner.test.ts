import assert from "node:assert/strict";
import test from "node:test";
import { SAMPLE_BID_WAIT_MS, SAMPLE_RUNS_PER_DAY, decideSampleTick, runsInWindow } from "../src/sample-runner.ts";
import type { SampleBid, SampleFacts, SampleJob, SampleRun } from "../src/sample-runner.ts";

const operator = "op_visitor";
const agent = "code-sample-visitor";
const now = "2026-11-11T12:00:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();
const floor = 1000;
const commit = "a".repeat(40);

function job(id: string, fields: Partial<SampleJob> = {}): SampleJob {
	return { id, status: "OPEN", vertical: "code", budgetCents: 5000, starter: true, fixtureMatched: true, attemptsPhase: null, bids: [], history: [], ...fields };
}

function bid(status: string, placedAt = minutesAgo(1), fields: Partial<SampleBid> = {}): SampleBid {
	return { operator: fields.operator ?? operator, agent: fields.agent ?? agent, status, placedAt };
}

function run(jobId: string, fields: Partial<SampleRun> = {}): SampleRun {
	return { jobId, agentId: agent, phase: "BID", placedAt: minutesAgo(1), commit: null, outcome: null, ...fields };
}

function facts(fields: Partial<SampleFacts> = {}): SampleFacts {
	return {
		enabled: true,
		now,
		operatorId: operator,
		hasFork: true,
		agent: { id: agent, task: "code", sample: true, acquitted: true },
		orders: { autopilot: true, runsOn: "acquit", priceFloorCents: floor },
		jobs: [job("job_a")],
		runs: [],
		globalActive: 0,
		...fields,
	};
}

test("the flag off stops the tick before any action", () => {
	const decision = decideSampleTick(facts({ enabled: false }));
	assert.equal(decision.status, "OFF");
	assert.equal(decision.reason, null);
	assert.deepEqual(decision.actions, []);
});

test("no standing orders refuses the run", () => {
	const decision = decideSampleTick(facts({ orders: null }));
	assert.equal(decision.status, "REFUSED");
	assert.equal(decision.reason, "NO_STANDING_ORDERS");
	assert.deepEqual(decision.actions, []);
});

test("autopilot off is idle, not refused", () => {
	const decision = decideSampleTick(facts({ orders: { autopilot: false, runsOn: "acquit", priceFloorCents: floor } }));
	assert.equal(decision.status, "IDLE");
	assert.equal(decision.reason, null);
	assert.deepEqual(decision.actions, []);
});

test("orders hosted on the owner's machine are not run here", () => {
	const decision = decideSampleTick(facts({ orders: { autopilot: true, runsOn: "owner", priceFloorCents: floor } }));
	assert.equal(decision.status, "IDLE");
	assert.equal(decision.note, "not hosted on Acquit");
	assert.deepEqual(decision.actions, []);
});

test("a plugged agent that is not a built-in sample is refused", () => {
	const decision = decideSampleTick(facts({ agent: { id: agent, task: "code", sample: false, acquitted: true } }));
	assert.equal(decision.status, "REFUSED");
	assert.equal(decision.reason, "NOT_A_SAMPLE");
	assert.deepEqual(decision.actions, []);
});

test("an agent that is not acquitted is refused before any bid", () => {
	const decision = decideSampleTick(facts({ agent: { id: agent, task: "code", sample: true, acquitted: false } }));
	assert.equal(decision.status, "REFUSED");
	assert.equal(decision.reason, "NO_ACQUITTAL");
	assert.deepEqual(decision.actions, []);
});

test("a visitor with no fork is refused, because a run never pushes upstream", () => {
	const decision = decideSampleTick(facts({ hasFork: false }));
	assert.equal(decision.status, "REFUSED");
	assert.equal(decision.reason, "NO_FORK");
	assert.deepEqual(decision.actions, []);
});

test("the daily limit refuses a new bid, counting runs by their bid time", () => {
	const runs = [run("job_1", { phase: "DONE", outcome: "VERIFIED", placedAt: minutesAgo(60) }),
		run("job_2", { phase: "DONE", outcome: "REJECTED", placedAt: minutesAgo(120) }),
		run("job_3", { phase: "DONE", outcome: "BID_LOST", placedAt: minutesAgo(180) })];
	assert.equal(SAMPLE_RUNS_PER_DAY, 3);
	const refused = decideSampleTick(facts({ runs }));
	assert.equal(refused.status, "REFUSED");
	assert.equal(refused.reason, "DAILY_LIMIT");
	assert.deepEqual(refused.actions, []);
});

test("a run placed more than 24 hours ago no longer counts toward the limit", () => {
	const runs = [run("job_1", { phase: "DONE", outcome: "VERIFIED", placedAt: minutesAgo(60) }),
		run("job_2", { phase: "DONE", outcome: "VERIFIED", placedAt: minutesAgo(120) }),
		run("job_3", { phase: "DONE", outcome: "VERIFIED", placedAt: minutesAgo(25 * 60) })];
	assert.equal(runsInWindow(runs, now), 2);
	const decision = decideSampleTick(facts({ runs }));
	assert.deepEqual(decision.actions, [{ kind: "bid", jobId: "job_a", priceCents: floor, etaHours: 48 }]);
});

test("bids once, at the price floor, on an open starter of the agent's task on the scripted fixture", () => {
	const decision = decideSampleTick(facts({
		jobs: [
			job("job_match"),
			job("job_other_task", { vertical: "print-fdm" }),
			job("job_other_fixture", { fixtureMatched: false }),
			job("job_low_budget", { budgetCents: floor - 1 }),
			job("job_not_starter", { starter: false }),
			job("job_closed", { status: "CLOSED" }),
			job("job_already_bid", { bids: [bid("PENDING")] }),
		],
	}));
	assert.equal(decision.status, "RUNNING");
	assert.equal(decision.reason, null);
	assert.deepEqual(decision.actions, [{ kind: "bid", jobId: "job_match", priceCents: floor, etaHours: 48 }]);
});

test("a job another agent of this visitor already ran is not bid on again", () => {
	const decision = decideSampleTick(facts({ runs: [run("job_a", { agentId: "other-agent", phase: "DONE", outcome: "VERIFIED" })] }));
	assert.equal(decision.status, "IDLE");
	assert.equal(decision.note, "no open starter on the matching fixture");
});

test("no candidate is idle, and never queued", () => {
	const decision = decideSampleTick(facts({ jobs: [job("job_closed", { status: "CLOSED" })], globalActive: 2 }));
	assert.equal(decision.status, "IDLE");
	assert.equal(decision.reason, null);
	assert.deepEqual(decision.actions, []);
});

test("a full global runner queues the visitor instead of bidding", () => {
	const decision = decideSampleTick(facts({ globalActive: 2 }));
	assert.equal(decision.status, "QUEUED");
	assert.equal(decision.reason, "WAITING_FOR_FREE_RUNNER");
	assert.deepEqual(decision.actions, []);
});

test("a visitor's run in flight blocks a new bid, whichever agent it is for", () => {
	const decision = decideSampleTick(facts({ runs: [run("job_1", { agentId: "other-agent", phase: "BID", placedAt: minutesAgo(1) })], globalActive: 1 }));
	assert.equal(decision.status, "RUNNING");
	assert.deepEqual(decision.actions, []);
});

test("a bid waiting for the House client to accept is left alone until the bid wait runs out", () => {
	const waiting = decideSampleTick(facts({ jobs: [job("job_a", { bids: [bid("PENDING", minutesAgo(2))] })], runs: [run("job_a")], globalActive: 1 }));
	assert.equal(waiting.status, "RUNNING");
	assert.deepEqual(waiting.actions, []);

	const timedOut = decideSampleTick(facts({
		jobs: [job("job_a", { bids: [bid("PENDING", minutesAgo(SAMPLE_BID_WAIT_MS / 60_000 + 1))] })],
		runs: [run("job_a", { placedAt: minutesAgo(SAMPLE_BID_WAIT_MS / 60_000 + 1) })],
		globalActive: 1,
	}));
	assert.deepEqual(timedOut.actions, [{ kind: "finish", jobId: "job_a", outcome: "BID_LOST", reason: "no accept within the bid wait" }]);
});

test("a chosen bid that is funding is never timed out, however old the bid is", () => {
	const decision = decideSampleTick(facts({
		jobs: [job("job_a", { bids: [bid("CHOSEN", minutesAgo(60))] })],
		runs: [run("job_a", { placedAt: minutesAgo(60) })],
		globalActive: 1,
	}));
	assert.deepEqual(decision.actions, []);
});

test("an accepted bid on a READY job pushes once", () => {
	const decision = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", bids: [bid("ACCEPTED")] })],
		runs: [run("job_a")],
		globalActive: 1,
	}));
	assert.deepEqual(decision.actions, [{ kind: "push", jobId: "job_a" }]);
});

test("an accepted bid whose attempt is still verifying waits", () => {
	const decision = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "VERIFYING", bids: [bid("ACCEPTED")] })],
		runs: [run("job_a")],
		globalActive: 1,
	}));
	assert.deepEqual(decision.actions, []);
});

test("a bid that was not selected, or returned, ends the run as BID_LOST", () => {
	for (const status of ["NOT_SELECTED", "RETURNED"]) {
		const decision = decideSampleTick(facts({ jobs: [job("job_a", { bids: [bid(status)] })], runs: [run("job_a")], globalActive: 1 }));
		assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_a", outcome: "BID_LOST", reason: `bid is ${status}` }]);
	}
});

test("a job that is no longer listed ends the run as CLOSED", () => {
	const decision = decideSampleTick(facts({ jobs: [], runs: [run("job_gone")], globalActive: 1 }));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_gone", outcome: "CLOSED", reason: "job is no longer listed" }]);
});

test("a pushed run submits its commit once the job is ready", () => {
	const decision = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", bids: [bid("ACCEPTED")] })],
		runs: [run("job_a", { phase: "RAN", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(decision.actions, [{ kind: "submit", jobId: "job_a", sourceCommit: commit }]);
});

test("a submitted run waits for its verdict while the attempt is verifying", () => {
	const decision = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "VERIFYING", bids: [bid("ACCEPTED")] })],
		runs: [run("job_a", { phase: "SUBMITTED", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(decision.actions, []);
});

test("the real verifier's verdict on the run's commit ends the run", () => {
	const verified = decideSampleTick(facts({
		jobs: [job("job_a", { status: "VERIFIED", bids: [bid("ACCEPTED")], history: [{ sourceCommit: commit, result: "VERIFIED" }] })],
		runs: [run("job_a", { phase: "SUBMITTED", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(verified.actions, [{ kind: "finish", jobId: "job_a", outcome: "VERIFIED", reason: "verifier passed the commit" }]);

	const rejected = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", bids: [bid("ACCEPTED")], history: [{ sourceCommit: commit, result: "REJECTED" }] })],
		runs: [run("job_a", { phase: "SUBMITTED", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(rejected.actions, [{ kind: "finish", jobId: "job_a", outcome: "REJECTED", reason: "verifier rejected the commit" }]);
});

test("a job that closed with no verdict for the run's commit ends the run as CLOSED", () => {
	const decision = decideSampleTick(facts({
		jobs: [job("job_a", { status: "REFUNDED", bids: [bid("ACCEPTED")] })],
		runs: [run("job_a", { phase: "RAN", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_a", outcome: "CLOSED", reason: "job is REFUNDED with no verdict for this commit" }]);
});

test("a finished run frees its slot in the same tick, so the next starter is bid on", () => {
	const decision = decideSampleTick(facts({
		jobs: [job("job_done", { status: "VERIFIED", bids: [bid("ACCEPTED")], history: [{ sourceCommit: commit, result: "VERIFIED" }] }), job("job_next")],
		runs: [run("job_done", { phase: "SUBMITTED", commit })],
		globalActive: 2,
	}));
	assert.equal(decision.status, "RUNNING");
	assert.deepEqual(decision.actions, [
		{ kind: "finish", jobId: "job_done", outcome: "VERIFIED", reason: "verifier passed the commit" },
		{ kind: "bid", jobId: "job_next", priceCents: floor, etaHours: 48 },
	]);
});

test("a run in DONE is never ticked again", () => {
	const decision = decideSampleTick(facts({
		jobs: [job("job_a", { status: "PAID", bids: [bid("ACCEPTED")] })],
		runs: [run("job_a", { phase: "DONE", outcome: "VERIFIED", commit })],
	}));
	assert.deepEqual(decision.actions, []);
});

test("the same facts give the same decision, so a restart mid-run repeats no step", () => {
	const input = facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", bids: [bid("ACCEPTED")] })],
		runs: [run("job_a", { phase: "RAN", commit })],
		globalActive: 1,
	});
	assert.deepEqual(decideSampleTick(input), decideSampleTick(input));
});
