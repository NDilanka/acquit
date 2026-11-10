// The hosted sample runner's decisions, with no I/O. The runner (apps/api/src/sample-runner.ts) reads a visitor's
// starter jobs, its built-in sample agent, its standing orders, and its own run records, asks decideSampleTick what
// each run needs next, and performs each action as the visitor's own operator: a bid, a scripted push, a submit.
// The House client accepts, funds and approves. The real verifier decides every submit. The rules for when a run may
// start, how many run at once, and when a run is finished live here, so they are tested without a server.

/** Runs one visitor may start in any 24 hours. */
export const SAMPLE_RUNS_PER_DAY = 3;
/** Runs one visitor may have in flight at once. */
export const SAMPLE_RUNS_IN_FLIGHT = 1;
/** Runs in flight across every visitor. A run past this waits in QUEUED. */
export const SAMPLE_RUNS_GLOBAL_IN_FLIGHT = 2;
/** How long a bid may wait for the House client to accept it before the run is given up. */
export const SAMPLE_BID_WAIT_MS = 10 * 60_000;
/** The delivery window the sample bid promises, in hours. */
export const SAMPLE_ETA_HOURS = 48;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a run is in the runner's own record. DONE stays in the record, so the job is never bid on again. */
export type SamplePhase = "BID" | "RAN" | "SUBMITTED" | "DONE";

/** How a run ended. A run ends in exactly one of them. */
export type SampleOutcome = "VERIFIED" | "REJECTED" | "BID_LOST" | "CLOSED";

/** One run the runner started, from its own record. `commit` is the commit the scripted push produced. */
export type SampleRun = {
	readonly jobId: string;
	readonly agentId: string;
	readonly phase: SamplePhase;
	/** When the bid was placed. A run counts toward the day's limit from here. */
	readonly placedAt: string;
	readonly commit: string | null;
	readonly outcome: SampleOutcome | null;
};

export type SampleBid = { readonly operator: string; readonly agent: string; readonly status: string; readonly placedAt: string };

/** The fields of a job, from the visitor's job list, that the tick reads. */
export type SampleJob = {
	readonly id: string;
	readonly status: string;
	readonly vertical: string;
	readonly budgetCents: number;
	/** The House client opened it. Only starter jobs are bid on. */
	readonly starter: boolean;
	/** The job's fixture is the scripted run's fixture, as the job view's `fixtureMatched` says. */
	readonly fixtureMatched: boolean;
	/** The attempts phase of an IN_PROGRESS job: READY, VERIFYING, or REFUND_PENDING. Null in every other state. */
	readonly attemptsPhase: string | null;
	readonly bids: readonly SampleBid[];
	readonly history: readonly { readonly sourceCommit: string; readonly result: string }[];
};

/** The built-in agent the runner acts for. `sample` is true only for an agent plugged from Acquit's own catalog. */
export type SampleAgent = { readonly id: string; readonly task: string; readonly sample: boolean; readonly acquitted: boolean };

/** The standing orders the tick reads. Only `acquit`-hosted orders reach this module. */
export type SampleOrders = { readonly autopilot: boolean; readonly runsOn: "owner" | "acquit"; readonly priceFloorCents: number };

export type SampleFacts = {
	readonly enabled: boolean;
	readonly now: string;
	readonly operatorId: string;
	/** The visitor has a fork to push to. A run never pushes to upstream. */
	readonly hasFork: boolean;
	readonly agent: SampleAgent;
	readonly orders: SampleOrders | null;
	/** The visitor's jobs. A later entry with the same id replaces an earlier one. */
	readonly jobs: readonly SampleJob[];
	/** Every run the runner recorded for this visitor, all agents, DONE ones included. */
	readonly runs: readonly SampleRun[];
	/** Runs in flight across every visitor, this visitor's included, as they stand before this tick. */
	readonly globalActive: number;
};

export type SampleAction =
	| { readonly kind: "bid"; readonly jobId: string; readonly priceCents: number; readonly etaHours: number }
	| { readonly kind: "push"; readonly jobId: string }
	| { readonly kind: "submit"; readonly jobId: string; readonly sourceCommit: string }
	| { readonly kind: "finish"; readonly jobId: string; readonly outcome: SampleOutcome; readonly reason: string };

/** The runner status the activity route shows. */
export type SampleStatus = "OFF" | "IDLE" | "QUEUED" | "RUNNING" | "REFUSED";

/** Why no run can start. The closed set the activity route shows. */
export type SampleRefusal = "NO_FORK" | "DAILY_LIMIT" | "NO_ACQUITTAL" | "NO_STANDING_ORDERS" | "NOT_A_SAMPLE";

export type SampleDecision = {
	readonly status: SampleStatus;
	/** The refusal for REFUSED, WAITING_FOR_FREE_RUNNER for QUEUED, and null for the other statuses. */
	readonly reason: SampleRefusal | "WAITING_FOR_FREE_RUNNER" | null;
	/** Progress on this agent's runs first, then at most one new bid. */
	readonly actions: readonly SampleAction[];
	/** Why nothing new started, for the log. Never shown as a status. */
	readonly note: string | null;
};

/** How many runs the visitor has started in the last 24 hours, counted by bid time. */
export function runsInWindow(runs: readonly SampleRun[], now: string): number {
	const since = Date.parse(now) - DAY_MS;
	return runs.filter(run => Date.parse(run.placedAt) >= since).length;
}

/**
 * What to do this tick for one hosted sample agent. The agent's own runs move one step at most: bid to push, push
 * to submit, submit to verdict. A run that finishes frees its slot in the same tick. A new bid starts only when the
 * visitor has no run in flight, the day's limit is not reached, and a global slot is free. Otherwise the status says
 * why the visitor waits or is refused, and the reason is one the owner can read.
 */
export function decideSampleTick(facts: SampleFacts): SampleDecision {
	if (!facts.enabled) return decision("OFF", null, [], null);
	const now = Date.parse(facts.now);
	const jobs = new Map(facts.jobs.map(job => [job.id, job] as const));
	const actions: SampleAction[] = [];
	for (const run of facts.runs) {
		if (run.agentId !== facts.agent.id || run.phase === "DONE") continue;
		const action = progress(run, jobs.get(run.jobId), facts, now);
		if (action !== null) actions.push(action);
	}
	const finishes = actions.filter(action => action.kind === "finish").length;
	const active = facts.runs.filter(run => run.phase !== "DONE").length - finishes;
	if (active >= SAMPLE_RUNS_IN_FLIGHT) return decision("RUNNING", null, actions, `${active} run in flight`);

	const orders = facts.orders;
	if (orders === null) return decision("REFUSED", "NO_STANDING_ORDERS", actions, null);
	if (!orders.autopilot) return decision("IDLE", null, actions, "autopilot is off");
	if (orders.runsOn !== "acquit") return decision("IDLE", null, actions, "not hosted on Acquit");
	if (!facts.agent.sample) return decision("REFUSED", "NOT_A_SAMPLE", actions, null);
	if (!facts.agent.acquitted) return decision("REFUSED", "NO_ACQUITTAL", actions, null);
	if (!facts.hasFork) return decision("REFUSED", "NO_FORK", actions, null);
	if (runsInWindow(facts.runs, facts.now) >= SAMPLE_RUNS_PER_DAY) return decision("REFUSED", "DAILY_LIMIT", actions, null);

	const candidates = facts.jobs.filter(job => biddable(job, facts, orders.priceFloorCents));
	if (candidates.length === 0) return decision("IDLE", null, actions, "no open starter on the matching fixture");
	if (facts.globalActive - finishes >= SAMPLE_RUNS_GLOBAL_IN_FLIGHT) {
		return decision("QUEUED", "WAITING_FOR_FREE_RUNNER", actions, "global runs in flight are full");
	}
	const job = candidates[0]!;
	actions.push({ kind: "bid", jobId: job.id, priceCents: orders.priceFloorCents, etaHours: SAMPLE_ETA_HOURS });
	return decision("RUNNING", null, actions, null);
}

function decision(status: SampleStatus, reason: SampleDecision["reason"], actions: readonly SampleAction[], note: string | null): SampleDecision {
	return { status, reason, actions, note };
}

/** A starter the runner may bid on: open, the agent's task, on the scripted fixture, budget at or above the floor, and not yet this operator's. */
function biddable(job: SampleJob, facts: SampleFacts, floorCents: number): boolean {
	return job.status === "OPEN" && job.starter && job.fixtureMatched && job.vertical === facts.agent.task
		&& job.budgetCents >= floorCents && !facts.runs.some(run => run.jobId === job.id)
		&& !job.bids.some(bid => bid.operator === facts.operatorId);
}

/** Null means the run waits. Anything else is this tick's one step for the run. */
function progress(run: SampleRun, job: SampleJob | undefined, facts: SampleFacts, now: number): SampleAction | null {
	if (job === undefined) return finish(run.jobId, "CLOSED", "job is no longer listed");
	return run.phase === "BID" ? bidProgress(run, job, facts, now) : submittedProgress(run, job);
}

function bidProgress(run: SampleRun, job: SampleJob, facts: SampleFacts, now: number): SampleAction | null {
	const bid = job.bids.find(entry => entry.operator === facts.operatorId);
	if (bid === undefined || bid.agent !== facts.agent.id) return finish(run.jobId, "BID_LOST", "no bid from this agent on the job");
	if (bid.status === "ACCEPTED") {
		if (job.status !== "IN_PROGRESS") return finish(run.jobId, "CLOSED", `job is ${job.status}`);
		return job.attemptsPhase === "READY" ? { kind: "push", jobId: run.jobId } : null;
	}
	if (bid.status === "NOT_SELECTED" || bid.status === "RETURNED") return finish(run.jobId, "BID_LOST", `bid is ${bid.status}`);
	if (job.status !== "OPEN") return finish(run.jobId, "CLOSED", `job is ${job.status}`);
	// CHOSEN means the House client accepted and the card checkout is open. Only a bid still PENDING can time out.
	if (bid.status === "PENDING" && now - Date.parse(bid.placedAt) > SAMPLE_BID_WAIT_MS) {
		return finish(run.jobId, "BID_LOST", "no accept within the bid wait");
	}
	return null;
}

function submittedProgress(run: SampleRun, job: SampleJob): SampleAction | null {
	if (run.commit === null) return finish(run.jobId, "CLOSED", "run has no commit");
	const verdict = job.history.find(entry => entry.sourceCommit === run.commit);
	if (verdict?.result === "VERIFIED") return finish(run.jobId, "VERIFIED", "verifier passed the commit");
	if (verdict?.result === "REJECTED") return finish(run.jobId, "REJECTED", "verifier rejected the commit");
	if (job.status !== "IN_PROGRESS") return finish(run.jobId, "CLOSED", `job is ${job.status} with no verdict for this commit`);
	return job.attemptsPhase === "READY" ? { kind: "submit", jobId: run.jobId, sourceCommit: run.commit } : null;
}

function finish(jobId: string, outcome: SampleOutcome, reason: string): SampleAction {
	return { kind: "finish", jobId, outcome, reason };
}
