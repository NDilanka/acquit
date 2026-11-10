import assert from "node:assert/strict";
import test from "node:test";
import { SAMPLE_RUNS_PER_DAY, decideSampleTick, isTransientBidRefusal, runsInWindow } from "../src/sample-runner.ts";
import type { SampleBid, SampleFacts, SampleJob, SampleRun } from "../src/sample-runner.ts";
import { commercialSplit, usd } from "../src/ledger.ts";
import { quote } from "../src/paypal.ts";
import type { Bps, ProcessorFeeModel } from "../src/paypal.ts";

const operator = "op_visitor";
const agent = "code-sample-visitor";
const now = "2026-11-11T12:00:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();
const floor = 1000;
const commit = "a".repeat(40);
/** The deployment's fee model, as config.ts sets it. */
const feeModel: ProcessorFeeModel = { version: "sandbox-349bps-plus-49-v1", rateBps: 349 as Bps, fixed: usd("0.49") };

function job(id: string, fields: Partial<SampleJob> = {}): SampleJob {
	return { id, status: "OPEN", vertical: "code", budgetCents: 5000, starter: true, fixtureMatched: true, attemptsPhase: null, attemptsRunsStarted: null, bids: [], history: [], ...fields };
}

/** A bid whose House respond-by time is well after `now`, unless the test sets one. */
const farRespondBy = "2026-11-20T12:00:00.000Z";

function bid(status: string, placedAt = minutesAgo(1), fields: Partial<SampleBid> = {}): SampleBid {
	return { operator: fields.operator ?? operator, agent: fields.agent ?? agent, status, placedAt, respondBy: fields.respondBy ?? farRespondBy };
}

function run(jobId: string, fields: Partial<SampleRun> = {}): SampleRun {
	return { jobId, agentId: agent, phase: "BID", placedAt: minutesAgo(1), commit: null, outcome: null, closedReason: null, ...fields };
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
		feeModel,
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

test("a bid the House refused for good holds new bids for 24 hours, and counts toward no limit", () => {
	const runs = [run("job_denied", { phase: "DONE", outcome: "BID_DENIED", placedAt: minutesAgo(60) })];
	assert.equal(runsInWindow(runs, now), 0);
	const decision = decideSampleTick(facts({ jobs: [job("job_denied"), job("job_a")], runs }));
	assert.equal(decision.status, "REFUSED");
	assert.equal(decision.reason, "BID_DENIED");
	assert.deepEqual(decision.actions, []);
});

test("the hold for a refused bid ends 24 hours after the bid, and the refused job is never bid on again", () => {
	const runs = [run("job_denied", { phase: "DONE", outcome: "BID_DENIED", placedAt: minutesAgo(25 * 60) })];
	const decision = decideSampleTick(facts({ jobs: [job("job_denied"), job("job_a")], runs }));
	assert.equal(decision.status, "RUNNING");
	assert.deepEqual(decision.actions, [{ kind: "bid", jobId: "job_a", priceCents: floor, etaHours: 48 }]);
});

test("only a refusal that clears by itself is transient; a refusal of the job itself is for good", () => {
	for (const reason of ["BUSY", "INSUFFICIENT_CREDITS", "WRONG_STATE", "ONBOARDING_REQUIRED", "NOT_ACQUITTED"]) {
		assert.equal(isTransientBidRefusal(reason), true, `${reason} clears by itself`);
	}
	for (const reason of ["NOT_OWNER", "NOT_FOUND", "WRONG_TASK", "DEADLINE_PASSED", "PRICE_OVER_BUDGET", "ALREADY_BID", "HOUSE_ALREADY_BID"]) {
		assert.equal(isTransientBidRefusal(reason), false, `${reason} stays refused`);
	}
	// A transient refusal stores no run, so no hold applies and the same starter is bid on again once the retry window passes.
	const decision = decideSampleTick(facts({ jobs: [job("job_denied"), job("job_a")], runs: [] }));
	assert.equal(decision.status, "RUNNING");
	assert.deepEqual(decision.actions, [{ kind: "bid", jobId: "job_denied", priceCents: floor, etaHours: 48 }]);
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

test("a price floor the House cannot fund is refused before any bid, and is never IDLE", () => {
	// AcceptBid quotes the bid price with the fee model and throws when the fee does not fit. No bid goes out at one.
	for (const priceFloorCents of [0, 1, 429]) {
		const decision = decideSampleTick(facts({ orders: { autopilot: true, runsOn: "acquit", priceFloorCents } }));
		assert.equal(decision.status, "REFUSED", `floor ${priceFloorCents}`);
		assert.equal(decision.reason, "PRICE_CANNOT_CARRY_FEE", `floor ${priceFloorCents}`);
		assert.deepEqual(decision.actions, [], `floor ${priceFloorCents}`);
	}
	const noStarters = decideSampleTick(facts({ jobs: [], orders: { autopilot: true, runsOn: "acquit", priceFloorCents: 1 } }));
	assert.equal(noStarters.reason, "PRICE_CANNOT_CARRY_FEE");
});

test("the floor is refused exactly where the House's own quote fails, and bid where it passes", () => {
	assert.throws(() => quote(commercialSplit(usd("4.29")), feeModel), /Price cannot carry processing fee/);
	assert.doesNotThrow(() => quote(commercialSplit(usd("4.30")), feeModel));

	const refused = decideSampleTick(facts({ orders: { autopilot: true, runsOn: "acquit", priceFloorCents: 429 } }));
	assert.equal(refused.reason, "PRICE_CANNOT_CARRY_FEE");
	const funded = decideSampleTick(facts({ orders: { autopilot: true, runsOn: "acquit", priceFloorCents: 430 } }));
	assert.deepEqual(funded.actions, [{ kind: "bid", jobId: "job_a", priceCents: 430, etaHours: 48 }]);
});

test("a broken fee model is not read as an unfundable price, so it throws out of the tick", () => {
	const broken: ProcessorFeeModel = { version: "broken", rateBps: -1 as Bps, fixed: usd("0.49") };
	assert.throws(() => decideSampleTick(facts({ feeModel: broken })), /Invalid fee model/);
});

test("an unfundable floor does not stop a run already in flight, which keeps its own price", () => {
	const decision = decideSampleTick(facts({
		orders: { autopilot: true, runsOn: "acquit", priceFloorCents: 1 },
		jobs: [job("job_a", { bids: [bid("PENDING")] })],
		runs: [run("job_a")],
		globalActive: 1,
	}));
	assert.equal(decision.status, "RUNNING");
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

test("a PENDING bid is left alone until the House's respond-by time, then it is lost", () => {
	const respondBy = "2026-11-11T18:00:00.000Z";
	const pending = [bid("PENDING", minutesAgo(60 * 3), { respondBy })];

	// Placed an hour ago, still ahead of its respond-by time: the run waits, however old the bid is.
	const waiting = decideSampleTick(facts({ jobs: [job("job_a", { bids: pending })], runs: [run("job_a")], globalActive: 1 }));
	assert.equal(waiting.status, "RUNNING");
	assert.deepEqual(waiting.actions, []);

	// At the respond-by time the House returns the bid, so the run closes as lost.
	const atDeadline = decideSampleTick(facts({ now: respondBy, jobs: [job("job_a", { bids: pending })], runs: [run("job_a")], globalActive: 1 }));
	assert.deepEqual(atDeadline.actions, [{ kind: "finish", jobId: "job_a", outcome: "BID_LOST", reason: "no answer by the bid's respond-by time" }]);
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
	assert.deepEqual(decision.actions, [{ kind: "submit", jobId: "job_a", sourceCommit: commit, run: 1 }]);
});

test("each submit names the verifier run it starts, so a retry after a run with no verdict is a new request", () => {
	const retry = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", attemptsRunsStarted: 1, bids: [bid("ACCEPTED")] })],
		runs: [run("job_a", { phase: "SUBMITTED", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(retry.actions, [{ kind: "submit", jobId: "job_a", sourceCommit: commit, run: 2 }]);
});

test("a run closes once its verifier runs have all ended with no verdict", () => {
	const lastRetry = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", attemptsRunsStarted: 2, bids: [bid("ACCEPTED")] })],
		runs: [run("job_a", { phase: "SUBMITTED", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(lastRetry.actions, [{ kind: "submit", jobId: "job_a", sourceCommit: commit, run: 3 }]);

	const exhausted = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", attemptsRunsStarted: 3, bids: [bid("ACCEPTED")] })],
		runs: [run("job_a", { phase: "SUBMITTED", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(exhausted.actions, [{ kind: "finish", jobId: "job_a", outcome: "CLOSED", reason: "verifier gave no verdict in 3 runs" }]);
});

test("a run that closes while the House holds the money stops delivery, and nothing new is bid in that tick", () => {
	const exhausted = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", attemptsRunsStarted: 3, bids: [bid("ACCEPTED")] }), job("job_next")],
		runs: [run("job_a", { phase: "SUBMITTED", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(exhausted.actions, [{ kind: "finish", jobId: "job_a", outcome: "CLOSED", reason: "verifier gave no verdict in 3 runs" }]);
	assert.equal(exhausted.status, "REFUSED");
	assert.equal(exhausted.reason, "DELIVERY_STOPPED");
});

test("a closed run whose job still holds the money keeps refusing with DELIVERY_STOPPED, even with autopilot off", () => {
	const closed = run("job_a", { phase: "DONE", outcome: "CLOSED", commit, closedReason: "verifier gave no verdict in 3 runs" });
	const held = job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", attemptsRunsStarted: 3, bids: [bid("ACCEPTED")] });
	const delivering = decideSampleTick(facts({ jobs: [held, job("job_next")], runs: [closed] }));
	assert.deepEqual(delivering.actions, []);
	assert.equal(delivering.status, "REFUSED");
	assert.equal(delivering.reason, "DELIVERY_STOPPED");

	const paused = decideSampleTick(facts({
		orders: { autopilot: false, runsOn: "acquit", priceFloorCents: floor },
		jobs: [held, job("job_next")],
		runs: [closed],
	}));
	assert.deepEqual(paused.actions, []);
	assert.equal(paused.status, "REFUSED");
	assert.equal(paused.reason, "DELIVERY_STOPPED");
});

test("the runner bids again once the House no longer holds the closed job's money", () => {
	const closed = run("job_a", { phase: "DONE", outcome: "CLOSED", commit, closedReason: "verifier gave no verdict in 3 runs" });
	const refunded = decideSampleTick(facts({ jobs: [job("job_a", { status: "REFUNDED", bids: [bid("ACCEPTED")] }), job("job_next")], runs: [closed] }));
	assert.equal(refunded.status, "RUNNING");
	assert.deepEqual(refunded.actions, [{ kind: "bid", jobId: "job_next", priceCents: floor, etaHours: 48 }]);
});

test("a verdict that arrives after failed verifier runs still ends the run as the verdict says", () => {
	const decision = decideSampleTick(facts({
		jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", attemptsRunsStarted: 3, bids: [bid("ACCEPTED")], history: [{ sourceCommit: commit, result: "VERIFIED" }] })],
		runs: [run("job_a", { phase: "SUBMITTED", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_a", outcome: "VERIFIED", reason: "verifier passed the commit" }]);
});

test("a run that is waiting on consent pushes and submits nothing, and keeps the reason it waits", () => {
	const lost: [SampleFacts["orders"], SampleFacts["agent"], boolean, string][] = [
		[{ autopilot: false, runsOn: "acquit", priceFloorCents: floor }, facts().agent, true, "AUTOPILOT_OFF"],
		[{ autopilot: true, runsOn: "owner", priceFloorCents: floor }, facts().agent, true, "NOT_HOSTED"],
		[null, facts().agent, true, "NO_STANDING_ORDERS"],
		[{ autopilot: true, runsOn: "acquit", priceFloorCents: floor }, { ...facts().agent, acquitted: false }, true, "NO_ACQUITTAL"],
		[{ autopilot: true, runsOn: "acquit", priceFloorCents: floor }, facts().agent, false, "NO_FORK"],
	];
	for (const [orders, agent, hasFork, reason] of lost) {
		const pushReady = facts({
			orders, agent, hasFork,
			jobs: [job("job_a", { status: "IN_PROGRESS", attemptsPhase: "READY", bids: [bid("ACCEPTED")] })],
			runs: [run("job_a", { phase: "BID" })],
			globalActive: 1,
		});
		const paused = decideSampleTick(pushReady);
		assert.deepEqual(paused.actions, [], reason);
		assert.equal(paused.status, "REFUSED", reason);
		assert.equal(paused.reason, reason);

		const submitReady = decideSampleTick({ ...pushReady, runs: [run("job_a", { phase: "RAN", commit })] });
		assert.deepEqual(submitReady.actions, [], reason);
		assert.equal(submitReady.reason, reason);
	}
});

test("a paused run still records its verdict, but bids nothing new", () => {
	const decision = decideSampleTick(facts({
		orders: { autopilot: false, runsOn: "acquit", priceFloorCents: floor },
		jobs: [job("job_done", { status: "VERIFIED", bids: [bid("ACCEPTED")], history: [{ sourceCommit: commit, result: "VERIFIED" }] }), job("job_next")],
		runs: [run("job_done", { phase: "SUBMITTED", commit })],
		globalActive: 1,
	}));
	assert.deepEqual(decision.actions, [{ kind: "finish", jobId: "job_done", outcome: "VERIFIED", reason: "verifier passed the commit" }]);
	assert.equal(decision.status, "IDLE");
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
