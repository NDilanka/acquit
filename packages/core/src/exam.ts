// The agent exam: the bid gate, the exam refusals, the derived record and grade, the sample catalog,
// and standing-order validation. Pure. The shell reads and writes rows (store.ts, specialists.ts).
// job.ts calls bidGate at PlaceBid. Nothing here touches storage, the network, or the verifier.

import { CODE_VERTICAL } from "./code-manifest.ts";
import type { Vertical } from "./code-manifest.ts";
import type { Instant } from "./ids.ts";
import type { AttemptRecord, JobRow, JobState, LockedBid } from "./job.ts";
import type { Acquittal, Agent } from "./operator.ts";

export const PRINT_VERTICAL = "print-fdm" as Vertical;
export const LASER_VERTICAL = "laser-cut" as Vertical;
export const TASKS: readonly Vertical[] = [CODE_VERTICAL, PRINT_VERTICAL, LASER_VERTICAL];
export const EXAM_LIMIT_PER_DAY = 3;
export const GRADE_START = 50;
export const GRADE_PER_VERIFIED = 5;
export const GRADE_PER_REJECTED = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isTask(value: unknown): value is Vertical {
	return TASKS.some(task => task === value);
}

/** The gate every bid passes except House's. placeHouseBid sends House through the same apply, so House is exempt in job.ts. */
export function bidGate(agent: Agent, vertical: Vertical): "WRONG_TASK" | "NOT_ACQUITTED" | null {
	if (agent.task !== vertical) return "WRONG_TASK";
	if (agent.acquittal === null) return "NOT_ACQUITTED";
	return null;
}

export type ExamRefusal = "ALREADY_ACQUITTED" | "EXAM_RUNNING" | "EXAM_LIMIT" | "TASK_NOT_EXAMINABLE";

/** The fields of an exam_runs row that the start guard reads. */
export type ExamStart = { readonly status: string; readonly startedAt: Instant };

/** The guard in front of POST /api/me/agents/:id/exam. Runs before any row is written. */
export function examRefusal(agent: Agent, runs: readonly ExamStart[], now: Instant): ExamRefusal | null {
	if (agent.task === LASER_VERTICAL) return "TASK_NOT_EXAMINABLE";
	if (agent.acquittal !== null) return "ALREADY_ACQUITTED";
	if (runs.some(run => run.status === "RUNNING" || run.status === "VERIFYING")) return "EXAM_RUNNING";
	const since = Date.parse(now) - DAY_MS;
	if (runs.filter(run => Date.parse(run.startedAt) >= since).length >= EXAM_LIMIT_PER_DAY) return "EXAM_LIMIT";
	return null;
}

export type AgentRecord = {
	readonly jobsTaken: number;
	readonly verified: number;
	readonly rejected: number;
	readonly earnedCents: number;
};

/** The escrow payee of a job that holds money. OPEN and CLOSED rows never held escrow. */
export function heldPayee(state: JobState): LockedBid | null {
	switch (state.status) {
		case "IN_PROGRESS":
		case "VERIFIED": return state.escrow.payee;
		case "PAID":
		case "REFUNDED": return state.payee;
		default: return null;
	}
}

/** The attempt history a job's state keeps: the attempts in flight, none once OPEN or CLOSED, the kept history after. */
export function attemptHistory(state: JobState): readonly AttemptRecord[] {
	if (state.status === "IN_PROGRESS") return state.attempts.history;
	if (state.status === "OPEN" || state.status === "CLOSED") return [];
	return state.history;
}

/** The time the capture that opened a job's escrow landed: the HELD line every held or settled book starts with. Null before any capture. */
export function captureAt(state: JobState): Instant | null {
	switch (state.status) {
		case "IN_PROGRESS":
		case "VERIFIED": return state.escrow.book[0].at;
		case "PAID":
		case "REFUNDED": return state.book[0].at;
		default: return null;
	}
}

/**
 * Derived on read from the jobs table, never stored. A job counts when its escrow payee names this agent.
 * Verified counts VERIFIED verdicts in the attempt history the job's state keeps, and a VERIFIED or PAID
 * job keeps its pass there, so each pass counts once. Rejected counts REJECTED attempts in that history.
 * Earned sums the release paid on PAID jobs, in cents.
 */
export function recordOf(agentId: string, rows: readonly JobRow[]): AgentRecord {
	let jobsTaken = 0;
	let verified = 0;
	let rejected = 0;
	let earnedCents = 0;
	for (const row of rows) {
		const payee = heldPayee(row.state);
		if (payee === null || payee.agent !== agentId) continue;
		jobsTaken += 1;
		const history = attemptHistory(row.state);
		verified += history.filter(entry => entry.verdict.result === "VERIFIED").length;
		rejected += history.filter(entry => entry.verdict.result === "REJECTED").length;
		if (row.state.status === "PAID") earnedCents += Number(row.state.release.paid);
	}
	return { jobsTaken, verified, rejected, earnedCents };
}

/** Null until the exam passes. Clamped once, at the end, so the value does not depend on event order. */
export function gradeOf(record: AgentRecord, acquittal: Acquittal | null): number | null {
	if (acquittal === null) return null;
	const raw = GRADE_START + GRADE_PER_VERIFIED * record.verified - GRADE_PER_REJECTED * record.rejected;
	return Math.min(100, Math.max(0, raw));
}

export type Sample = { readonly id: string; readonly name: string; readonly task: Vertical; readonly runner: Agent["runner"]; readonly blurb: string };

/** Acquit's own sample agents. Their prompts are Acquit's text, and they run on the Acquit VM. */
export const SAMPLES: readonly Sample[] = [
	{ id: "code-fixer", name: "Code fixer", task: CODE_VERTICAL, runner: "claude-code", blurb: "Fixes a failing TypeScript test on the practice repository. Takes the code exam." },
	{ id: "print-fdm", name: "FDM print tuner", task: PRINT_VERTICAL, runner: "simulated-fdm", blurb: "Qualifies a simulated FDM printer. Takes the print exam." },
	{ id: "laser-cut", name: "Laser cut designer", task: LASER_VERTICAL, runner: "simulated-laser", blurb: "Design only. Not examinable and cannot bid yet." },
];

export function sampleOf(id: string): Sample | null {
	return SAMPLES.find(sample => sample.id === id) ?? null;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

export type StandingOrders = {
	readonly priceFloorCents: number;
	readonly maxConcurrent: number;
	readonly autopilot: boolean;
	readonly runsOn: "owner" | "acquit";
	readonly preApprove: boolean;
	readonly preApproveCap: number;
};

const STANDING_ORDER_KEYS = ["priceFloorCents", "maxConcurrent", "autopilot", "runsOn", "preApprove", "preApproveCap"];

function bad<T>(detail: string): Parsed<T> {
	return { ok: false, detail };
}

/** Validates a PUT standing-orders body. preApproveCap is optional and defaults to 3. */
export function parseStandingOrders(body: unknown): Parsed<StandingOrders> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body must be a JSON object");
	const input = body as Record<string, unknown>;
	const extra = Object.keys(input).find(key => !STANDING_ORDER_KEYS.includes(key));
	if (extra !== undefined) return bad(`unknown field ${extra}`);
	const { priceFloorCents, maxConcurrent, autopilot, runsOn, preApprove } = input;
	const preApproveCap = input.preApproveCap ?? 3;
	if (typeof priceFloorCents !== "number" || !Number.isSafeInteger(priceFloorCents) || priceFloorCents < 0) return bad("priceFloorCents must be a whole number of cents, 0 or more");
	if (typeof maxConcurrent !== "number" || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 3) return bad("maxConcurrent must be 1 to 3");
	if (typeof autopilot !== "boolean") return bad("autopilot must be true or false");
	if (runsOn !== "owner" && runsOn !== "acquit") return bad("runsOn must be owner or acquit");
	if (typeof preApprove !== "boolean") return bad("preApprove must be true or false");
	if (typeof preApproveCap !== "number" || !Number.isSafeInteger(preApproveCap) || preApproveCap < 1 || preApproveCap > 3) return bad("preApproveCap must be 1 to 3");
	return { ok: true, value: { priceFloorCents, maxConcurrent, autopilot, runsOn, preApprove, preApproveCap } };
}

export type StandingOrdersRefusal = "NOT_ACQUITTED" | "RUNS_ON_NOT_ALLOWED";

/**
 * Autopilot needs an acquittal to bid on, and acquit hosting is for the plugged samples only: an owner's
 * own agent runs on the owner's machine. Checked before any standing-orders row is written.
 */
export function standingOrdersRefusal(agent: Agent, orders: StandingOrders): StandingOrdersRefusal | null {
	if (orders.autopilot && agent.acquittal === null) return "NOT_ACQUITTED";
	if (orders.runsOn === "acquit" && agent.sample === null) return "RUNS_ON_NOT_ALLOWED";
	return null;
}
