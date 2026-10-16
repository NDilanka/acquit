// The judge scenarios: five named paths through one visitor's job, driven on the server. Each step acts
// through acquit.execute as the visitor's own client or operator, waits on the verifier and PayPal the
// way the job row reports them, and records its own timing. The run lives on the server, so a closed
// tab does not stop it.

import { createHash, randomUUID } from "node:crypto";
import type { Acquit, Actor, CommandOutcome, UserCommand } from "./acquit.ts";
import { hours, instant, parseRequestKey } from "./ids.ts";
import type { AgentId, BidId, ClientId, CommitSha, Instant, JobId, OperatorId, RequestKey, StaffId, VisitorId } from "./ids.ts";
import type { AttemptRecord, JobRow, JobStatus } from "./job.ts";
import { shiftJobClock } from "./job-clock.ts";
import { usd } from "./ledger.ts";
import { reasonCode } from "./score-card.ts";
import type { SqliteStore } from "./store.ts";

export const SCENARIO_NAMES = ["verified-and-paid", "hidden-test-fail", "test-tamper", "dispute-arbiter", "deadline-refund"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];
export function isScenarioName(value: string): value is ScenarioName {
	return (SCENARIO_NAMES as readonly string[]).includes(value);
}

export const SCENARIO_LABELS = {
	scripted: "Scripted agent (Simulated)",
	clock: "Simulated time for this job",
	verifier: "Real verifier run",
	paypal: "PayPal sandbox",
} as const;
export type ScenarioLabel = (typeof SCENARIO_LABELS)[keyof typeof SCENARIO_LABELS];

export type ScenarioActor = "CLIENT" | "OPERATOR" | "ARBITER" | "SYSTEM";

export type ScenarioStep = {
	readonly name: string;
	readonly actor: ScenarioActor;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly ms: number;
	readonly outcome: string;
	readonly label: ScenarioLabel;
};

/** The job's status when the run stops, and the literal reason that status was reached for. */
export type ScenarioEndState = { readonly jobStatus: JobStatus; readonly reason: string | null };

export type ScenarioRun = {
	readonly id: string;
	readonly name: ScenarioName;
	readonly visitorId: string;
	readonly jobId: string;
	readonly steps: readonly ScenarioStep[];
	readonly state: "RUNNING" | "DONE" | "FAILED";
	readonly endState: ScenarioEndState | null;
};

/** A scripted agent's tree, named by its score card corpus entry. The workspace writes that entry's files. */
export type ScriptedTree = "honest-reference-table" | "cheat-hardcode-visible-values" | "cheat-edit-frozen-test";

/** Puts a scripted tree in the job's work repo and returns the commit the agent submits. */
export type ScenarioWorkspace = { push(jobId: JobId, tree: ScriptedTree): Promise<CommitSha> };

export type ScenarioVisitor = { readonly id: VisitorId; readonly clientHandle: string; readonly operatorHandle: string; readonly repository: string | null };

export type ScenarioRuns = { save(run: ScenarioRun): void; get(id: string): ScenarioRun | undefined };

export function memoryRuns(): ScenarioRuns {
	const runs = new Map<string, ScenarioRun>();
	return { save: run => { runs.set(run.id, run); }, get: id => runs.get(id) };
}

export class ScenarioRefused extends Error {
	readonly code: "DEV_DISABLED";
	constructor(code: "DEV_DISABLED") { super(code); this.code = code; }
}

export type ScenarioDeps = {
	readonly acquit: Acquit;
	readonly store: Pick<SqliteStore, "readJob" | "db">;
	readonly workspace: ScenarioWorkspace;
	readonly runs: ScenarioRuns;
	/** The job clock. Deadlines are set from it, and the arbiter path is only open while it is development. */
	readonly now: () => Instant;
	readonly devEnabled: boolean;
	/** The fixture the visitor's job opens on. */
	readonly repository: string;
	readonly issueNumber: number;
	/** Called once the job exists, for a deployment that sets per-job state the open does not carry. */
	readonly onOpened?: (jobId: JobId) => void;
	readonly pollMs?: number;
	readonly waitMs?: number;
};

const DAY_MS = 86_400_000;
const PRICE = usd("400.00");

type Context = { jobId?: JobId; bidId?: BidId; sourceCommit?: CommitSha; mergeCommit?: CommitSha };
type ChainStep = { readonly name: string; readonly actor: ScenarioActor; readonly label: ScenarioLabel; readonly run: (ctx: Context) => Promise<string> };

/** A request key derived from the run and the step, so a resent step is the same request. */
function stepKey(runId: string, step: string): RequestKey {
	const hex = createHash("sha256").update(`${runId}:${step}`).digest("hex");
	return parseRequestKey(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}

/** The attempts a job has settled, read from wherever its state keeps them. */
function historyOf(row: JobRow): readonly AttemptRecord[] {
	const state = row.state;
	if (state.status === "IN_PROGRESS") return state.attempts.history;
	if ("history" in state) return state.history;
	return [];
}

function lastRejectionReason(row: JobRow): string | null {
	for (let index = historyOf(row).length - 1; index >= 0; index--) {
		const record = historyOf(row)[index];
		if (record.verdict.result === "REJECTED") return reasonCode(record.verdict.reasons[0]);
	}
	return null;
}

function endStateOf(row: JobRow): ScenarioEndState {
	const state = row.state;
	if (state.status === "PAID") return { jobStatus: "PAID", reason: state.releaseAuthority };
	if (state.status === "REFUNDED") return { jobStatus: "REFUNDED", reason: state.reason };
	return { jobStatus: state.status, reason: lastRejectionReason(row) };
}

export type StartedScenario = { readonly run: ScenarioRun; readonly finished: Promise<ScenarioRun> };

/**
 * Starts one scenario for one visitor. Resolves once the job exists, with the run as it stands; the
 * rest of the chain continues in `finished`. A refused start throws ScenarioRefused before any step.
 */
export async function startScenario(deps: ScenarioDeps, name: ScenarioName, visitor: ScenarioVisitor): Promise<StartedScenario> {
	if (name === "dispute-arbiter" && !deps.devEnabled) throw new ScenarioRefused("DEV_DISABLED");
	const runId = `scn_${randomUUID()}`;
	const pollMs = deps.pollMs ?? 25;
	const waitMs = deps.waitMs ?? 120_000;
	const ctx: Context = {};
	const steps: ScenarioStep[] = [];
	let current: ScenarioRun = { id: runId, name, visitorId: visitor.id, jobId: "", steps, state: "RUNNING", endState: null };
	const publish = (patch: Partial<ScenarioRun>) => {
		current = { ...current, ...patch, steps: [...steps] };
		deps.runs.save(current);
	};
	publish({});

	const client: Actor = { role: "CLIENT", clientId: visitor.clientHandle as ClientId, tenant: visitor.id as VisitorId,
		...(visitor.repository ? { repository: visitor.repository } : {}) };
	const operator: Actor = { role: "OPERATOR", operatorId: visitor.operatorHandle as OperatorId, tenant: visitor.id as VisitorId };

	const send = async (actor: Actor, stepName: string, command: UserCommand): Promise<Extract<CommandOutcome, { kind: "COMMITTED" | "REPLAY" }>> => {
		for (let attempt = 0; ; attempt++) {
			const outcome = await deps.acquit.execute(actor, stepKey(runId, stepName), command);
			if (outcome.kind === "DENIED") {
				if (outcome.reason === "BUSY" && attempt < 3) continue;
				throw new Error(`${command.type} refused: ${outcome.reason}`);
			}
			return outcome;
		}
	};
	const waitFor = async (predicate: (row: JobRow) => boolean, what: string): Promise<JobRow> => {
		const deadline = Date.now() + waitMs;
		for (;;) {
			await deps.acquit.tick();
			const row = await deps.store.readJob(ctx.jobId!);
			if (row && predicate(row)) return row;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise(resolve => setTimeout(resolve, pollMs));
		}
	};
	const rowOf = async (): Promise<JobRow> => {
		const row = await deps.store.readJob(ctx.jobId!);
		if (!row) throw new Error("the job is missing");
		return row;
	};
	const deliveryEndsAt = (days: number): Instant => instant(new Date(Date.parse(deps.now()) + days * DAY_MS).toISOString());

	const open = (days: number): ChainStep => ({ name: "open-job", actor: "CLIENT", label: SCENARIO_LABELS.scripted, run: async () => {
		const outcome = await send(client, "open-job", { type: "OpenJob", repository: deps.repository, issueNumber: deps.issueNumber,
			budget: PRICE, deliveryEndsAt: deliveryEndsAt(days) });
		if (outcome.result.kind !== "JOB") throw new Error("the open did not return a job");
		ctx.jobId = outcome.result.job.id;
		deps.onOpened?.(ctx.jobId);
		publish({ jobId: ctx.jobId });
		return `opened ${ctx.jobId}`;
	} });
	const bid: ChainStep = { name: "place-bid", actor: "OPERATOR", label: SCENARIO_LABELS.scripted, run: async () => {
		const outcome = await send(operator, "place-bid", { type: "PlaceBid", jobId: ctx.jobId!, price: PRICE, eta: hours(48),
			agent: `${visitor.operatorHandle}-agent` as AgentId, pitch: "Scripted operator bid" });
		if (outcome.result.kind !== "BID") throw new Error("the bid did not return a bid");
		ctx.bidId = outcome.result.bid;
		return `bid ${ctx.bidId}`;
	} };
	const accept: ChainStep = { name: "accept-and-fund", actor: "CLIENT", label: SCENARIO_LABELS.paypal, run: async () => {
		await send(client, "accept-and-fund", { type: "AcceptBid", jobId: ctx.jobId!, bidId: ctx.bidId! });
		await waitFor(row => row.state.status === "IN_PROGRESS" && row.state.attempts.phase === "READY", "the escrow to hold");
		return "HELD";
	} };
	const push = (tree: ScriptedTree): ChainStep => ({ name: `push-${tree}`, actor: "OPERATOR", label: SCENARIO_LABELS.scripted, run: async () => {
		ctx.sourceCommit = await deps.workspace.push(ctx.jobId!, tree);
		return `pushed ${tree}`;
	} });
	const submit: ChainStep = { name: "submit", actor: "OPERATOR", label: SCENARIO_LABELS.verifier, run: async () => {
		const before = historyOf(await rowOf()).length;
		await send(operator, "submit", { type: "Submit", jobId: ctx.jobId!, sourceCommit: ctx.sourceCommit! });
		const row = await waitFor(settled => settled.state.status === "VERIFIED" ||
			(settled.state.status === "IN_PROGRESS" && settled.state.attempts.phase === "READY" && historyOf(settled).length > before), "the verifier verdict");
		if (row.state.status === "VERIFIED") {
			ctx.mergeCommit = row.state.passed.verdict.mergeCommit;
			return "VERIFIED";
		}
		return `REJECTED ${lastRejectionReason(row)}`;
	} };
	const approve: ChainStep = { name: "approve", actor: "CLIENT", label: SCENARIO_LABELS.paypal, run: async () => {
		await send(client, "approve", { type: "Approve", jobId: ctx.jobId!, mergeCommit: ctx.mergeCommit! });
		await waitFor(row => row.state.status === "PAID", "the release to pay the operator");
		return "PAID";
	} };
	const dispute: ChainStep = { name: "dispute", actor: "CLIENT", label: SCENARIO_LABELS.scripted, run: async () => {
		await send(client, "dispute", { type: "Dispute", jobId: ctx.jobId!, mergeCommit: ctx.mergeCommit!,
			reason: "Scripted dispute: the delivered fix does not meet the frozen contract." });
		return "DISPUTED";
	} };
	const arbiter: ChainStep = { name: "arbiter-verdict", actor: "ARBITER", label: SCENARIO_LABELS.scripted, run: async () => {
		const outcome = await deps.acquit.execute({ role: "ARBITER", staffId: "staff-arbiter" as StaffId }, stepKey(runId, "arbiter-verdict"),
			{ type: "ResolveDispute", jobId: ctx.jobId!, verdict: "UPHOLD", note: "Scripted arbiter verdict: the delivered fix stands." });
		if (outcome.kind === "DENIED") throw new Error(`ResolveDispute refused: ${outcome.reason}`);
		return "ARBITER_UPHELD";
	} };
	const release: ChainStep = { name: "release", actor: "SYSTEM", label: SCENARIO_LABELS.paypal, run: async () => {
		await waitFor(row => row.state.status === "PAID", "the release to pay the operator");
		return "PAID";
	} };
	const advanceClock: ChainStep = { name: "advance-clock", actor: "CLIENT", label: SCENARIO_LABELS.clock, run: async () => {
		if (shiftJobClock(deps.store.db, ctx.jobId!, 2 * DAY_MS) === null) throw new Error("the job clock did not move");
		return "advanced 2 days";
	} };
	const refund: ChainStep = { name: "refund", actor: "SYSTEM", label: SCENARIO_LABELS.paypal, run: async () => {
		await waitFor(row => row.state.status === "REFUNDED", "the refund to settle");
		return "REFUNDED";
	} };

	const chains: Record<ScenarioName, readonly ChainStep[]> = {
		"verified-and-paid": [open(7), bid, accept, push("honest-reference-table"), submit, approve],
		"hidden-test-fail": [open(7), bid, accept, push("cheat-hardcode-visible-values"), submit],
		"test-tamper": [open(7), bid, accept, push("cheat-edit-frozen-test"), submit],
		"dispute-arbiter": [open(7), bid, accept, push("honest-reference-table"), submit, dispute, arbiter, release],
		"deadline-refund": [open(1), bid, accept, advanceClock, refund],
	};
	const chain = chains[name];

	// The caller gets the run once the job exists: the open is the first step, and the rest runs after the reply.
	let announce!: () => void;
	const opened = new Promise<void>(resolve => { announce = resolve; });
	const runChain = async (): Promise<ScenarioRun> => {
		for (const step of chain) {
			const startedAt = new Date().toISOString();
			let outcome: string;
			try {
				outcome = await step.run(ctx);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				const endedAt = new Date().toISOString();
				steps.push({ name: step.name, actor: step.actor, startedAt, endedAt, ms: Date.parse(endedAt) - Date.parse(startedAt),
					outcome: `FAILED ${detail}`.slice(0, 300), label: step.label });
				publish({ state: "FAILED" });
				announce();
				return current;
			}
			const endedAt = new Date().toISOString();
			steps.push({ name: step.name, actor: step.actor, startedAt, endedAt, ms: Date.parse(endedAt) - Date.parse(startedAt),
				outcome, label: step.label });
			publish({});
			await deps.acquit.tick();
			announce();
		}
		const row = await rowOf();
		publish({ state: "DONE", endState: endStateOf(row) });
		return current;
	};
	// A chain that dies outside its own steps (a tick, the final read) still ends the run as FAILED, so
	// `finished` never rejects and no caller is left holding an unhandled rejection.
	const finished = runChain().catch(() => { publish({ state: "FAILED" }); return current; }).finally(() => announce());
	await opened;
	return { run: current, finished };
}
