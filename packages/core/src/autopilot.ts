// The owner worker's decisions, with no I/O. `acquit autopilot` reads the standing orders, the job list,
// and its local record, asks decideTick what each job needs next, and performs each action with the bid,
// run, and submit code it already has. The rules for what to bid on, how many jobs run at once, when a
// job is finished, and when a submit may be pre-approved live here, so they are tested without a server.

/** A job's place in the owner's local record. DONE stays in the record, so the job is never bid on again. */
export type TrackedPhase = "BID" | "WON" | "RAN" | "REQUESTED" | "SUBMITTED" | "DONE";

/** One job in the local record. `commit` is the commit the worker produced and pinned for submit. */
export type TrackedJob = {
	readonly phase: TrackedPhase;
	readonly commit: string | null;
};

/** The job outcomes the record keeps. A job ends in exactly one of them. */
export type JobOutcome = "VERIFIED" | "REJECTED" | "BID_LOST" | "CLOSED" | "RUN_FAILED" | "SUBMIT_REFUSED";

/** The standing orders the tick reads. `runsOn` is `acquit` only for hosted samples. */
export type StandingOrders = {
	readonly autopilot: boolean;
	readonly runsOn: "owner" | "acquit";
	readonly priceFloorCents: number;
	readonly maxConcurrent: number;
};

/** The fields of a job, from the job list or one job view, that the tick reads. */
export type TickJob = {
	readonly id: string;
	readonly status: string;
	readonly vertical: string;
	readonly budgetCents: number;
	readonly bids: readonly { readonly operator: string; readonly agent: string; readonly status: string }[];
	readonly attempts: {
		readonly left: number;
		readonly history: readonly { readonly sourceCommit: string; readonly result: string }[];
	};
};

export type TickInput = {
	readonly operatorId: string;
	readonly agentId: string;
	/** The agent's task. A job is biddable only when its vertical equals this. */
	readonly task: string;
	readonly orders: StandingOrders;
	/** One entry per job id. A later entry with the same id replaces an earlier one. */
	readonly jobs: readonly TickJob[];
	readonly tracked: Readonly<Record<string, TrackedJob>>;
};

export type TickAction =
	| { readonly kind: "bid"; readonly jobId: string; readonly priceCents: number }
	| { readonly kind: "run"; readonly jobId: string; readonly reason: string }
	| { readonly kind: "submit"; readonly jobId: string }
	| { readonly kind: "finish"; readonly jobId: string; readonly outcome: JobOutcome; readonly reason: string };

export type TickDecision = {
	/** Set when the tick does nothing at all. The text is what the owner sees. */
	readonly stop: string | null;
	/** Progress on tracked jobs first, then new bids. */
	readonly actions: readonly TickAction[];
	/** Why no new bid was placed, when that is worth recording. */
	readonly note: string | null;
};

/** A submit may be pre-approved only under these conditions (decision D1). The cap is 1 to 3. */
export type PreApproval = {
	readonly autopilot: boolean;
	readonly preApprove: boolean;
	readonly cap: number;
	/** Pre-approved submits this agent made in the last 24 h, counted from the local record. */
	readonly approvedInWindow: number;
	/** True only when the job view's `fixtureMatched` is exactly `true`. */
	readonly fixtureMatched: boolean;
};

export type PreApprovalDecision = { readonly approved: true } | { readonly approved: false; readonly reason: string };

const TERMINAL_JOB_STATUSES: readonly string[] = ["VERIFIED", "PAID", "REFUNDED", "CLOSED"];

/**
 * What to do this tick. Every tracked job moves one step at most: bid to run, run to submit, submit to
 * verdict. A verdict of REJECTED sends the job back to run while the job has attempts left. A job that
 * finishes frees its slot in the same tick, so a new bid can take it.
 */
export function decideTick(input: TickInput): TickDecision {
	const { orders, operatorId, agentId } = input;
	if (!orders.autopilot) return { stop: "autopilot is off", actions: [], note: null };
	if (orders.runsOn === "acquit") return { stop: "hosted on Acquit", actions: [], note: null };

	const jobs = new Map(input.jobs.map(job => [job.id, job] as const));
	const actions: TickAction[] = [];
	let active = 0;
	for (const [jobId, record] of Object.entries(input.tracked)) {
		if (record.phase === "DONE") continue;
		const action = progress(jobId, record, jobs.get(jobId), { operatorId, agentId });
		if (action?.kind === "finish") actions.push(action);
		else {
			active += 1;
			if (action !== null) actions.push(action);
		}
	}

	const free = orders.maxConcurrent - active;
	if (free <= 0) return { stop: null, actions, note: `at max concurrent: ${active} of ${orders.maxConcurrent} active` };
	const candidates = [...jobs.values()].filter(job => biddable(job, input));
	if (candidates.length === 0) return { stop: null, actions, note: "no open job matches" };
	for (const job of candidates.slice(0, free)) actions.push({ kind: "bid", jobId: job.id, priceCents: orders.priceFloorCents });
	return { stop: null, actions, note: null };
}

/** Pre-approval (D1). Any refusal leaves the typed confirmation in place, and the reason goes in the record. */
export function decidePreApproval(input: PreApproval): PreApprovalDecision {
	if (!input.autopilot) return refuse("autopilot is off");
	if (!input.preApprove) return refuse("pre-approval is off");
	if (!Number.isInteger(input.cap) || input.cap < 1 || input.cap > 3) return refuse(`pre-approval cap ${input.cap} is outside 1-3`);
	if (input.approvedInWindow >= input.cap) return refuse(`daily cap reached: ${input.approvedInWindow} of ${input.cap} in 24 h`);
	if (!input.fixtureMatched) return refuse("job fixture is not matched");
	return { approved: true };
}

function refuse(reason: string): PreApprovalDecision {
	return { approved: false, reason };
}

function biddable(job: TickJob, input: TickInput): boolean {
	return job.status === "OPEN" && job.vertical === input.task && job.budgetCents >= input.orders.priceFloorCents
		&& !Object.hasOwn(input.tracked, job.id) && !job.bids.some(bid => bid.operator === input.operatorId);
}

/** Null means the job waits. Anything else is this tick's one step for the job. */
function progress(jobId: string, record: TrackedJob, job: TickJob | undefined, who: { operatorId: string; agentId: string }): TickAction | null {
	if (job === undefined) return finish(jobId, "CLOSED", "job is no longer listed");
	if (record.phase === "BID" || record.phase === "WON") return bidProgress(jobId, job, who);
	if (record.phase === "RAN" || record.phase === "REQUESTED") {
		return job.status === "IN_PROGRESS" ? { kind: "submit", jobId } : finish(jobId, "CLOSED", `job is ${job.status}`);
	}
	return submittedProgress(jobId, record, job);
}

function bidProgress(jobId: string, job: TickJob, who: { operatorId: string; agentId: string }): TickAction | null {
	const bid = job.bids.find(entry => entry.operator === who.operatorId);
	if (bid === undefined || bid.agent !== who.agentId) return finish(jobId, "BID_LOST", "no bid from this agent on the job");
	if (bid.status === "ACCEPTED") {
		return job.status === "IN_PROGRESS" ? { kind: "run", jobId, reason: "bid accepted" } : finish(jobId, "CLOSED", `job is ${job.status}`);
	}
	if (bid.status === "NOT_SELECTED" || bid.status === "RETURNED") return finish(jobId, "BID_LOST", `bid is ${bid.status}`);
	return TERMINAL_JOB_STATUSES.includes(job.status) ? finish(jobId, "CLOSED", `job is ${job.status}`) : null;
}

function submittedProgress(jobId: string, record: TrackedJob, job: TickJob): TickAction | null {
	const verdict = job.attempts.history.find(attempt => attempt.sourceCommit === record.commit);
	if (verdict?.result === "VERIFIED") return finish(jobId, "VERIFIED", "verifier passed the commit");
	if (verdict?.result === "REJECTED") {
		return job.attempts.left > 0
			? { kind: "run", jobId, reason: `attempt rejected, ${job.attempts.left} left` }
			: finish(jobId, "REJECTED", "attempt rejected, none left");
	}
	if (job.status === "IN_PROGRESS") return null;
	return finish(jobId, "CLOSED", `job is ${job.status} with no verdict for this commit`);
}

function finish(jobId: string, outcome: JobOutcome, reason: string): TickAction {
	return { kind: "finish", jobId, outcome, reason };
}
