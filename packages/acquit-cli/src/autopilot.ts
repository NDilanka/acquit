// `acquit autopilot` runs one agent unattended under its standing orders. Each tick reads the orders and
// the job list, asks decideTick what each job needs next, and performs that step with the bid, run, and
// submit code the other commands already use. The local record keeps each job's phase, so a restart picks
// up where it stopped. This process never reads PayPal credentials: held money is checked through the API.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decidePreApproval, decideTick } from "../../core/src/autopilot.ts";
import type { JobOutcome, StandingOrders, TickAction, TickJob, TrackedPhase } from "../../core/src/autopilot.ts";
import { apiFlag, CliError, resolveToken } from "./client.ts";
import type { ApiClient, StoredLogin } from "./client.ts";
import { runBid } from "./bid.ts";
import { writeConfirmation } from "./confirm.ts";
import { stateRoot } from "./gitstate.ts";
import type { ProviderPort } from "./operator.ts";
import { DEFAULT_RUNNER_IMAGE, runRun } from "./run.ts";
import type { RunDeps } from "./run.ts";
import { claimConfirmation, clearRequest, confirmationDir, readRequest, writeRequest } from "./rendezvous.ts";
import { localHead, pushHead, runSubmit } from "./submit.ts";
import type { SubmitDeps } from "./submit.ts";

const DEFAULT_EVERY_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BID_ETA_HOURS = 48;
const BID_PITCH = "Autopilot bid at the price floor";
const DEFAULT_TASK = "code";
const WORK_FOLDER = "acquit-autopilot";
const SUBMIT_WAIT_SECONDS = 30;
const SUBMIT_POLL_MS = 5_000;
const USAGE = "Usage: acquit autopilot <agent> [--once] [--every 15s] [--prompt <file>] [--dir <folder>] [--api <url>]";

export type AutopilotOptions = {
	readonly apiUrl: string;
	readonly token: string;
	readonly agent: string;
	readonly once: boolean;
	readonly everyMs: number;
	readonly promptPath: string | null;
	/** The folder that holds one clone per job. Null selects `acquit-autopilot` under the working directory. */
	readonly workRoot: string | null;
};

/** The seams the tests replace. Each default is the command the owner runs by hand. */
export type AutopilotActions = {
	readonly bid: typeof runBid;
	readonly run: typeof runRun;
	readonly submit: typeof runSubmit;
	readonly head: SubmitDeps["head"];
	readonly push: SubmitDeps["push"];
};

export type AutopilotDeps = {
	readonly client: ApiClient;
	readonly provider: ProviderPort;
	readonly env: NodeJS.ProcessEnv;
	readonly write: (text: string) => void;
	readonly readFile?: (path: string) => string;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly actions?: Partial<AutopilotActions>;
};

export type HeldCheck = {
	readonly held: boolean;
	/** `paypal` when PayPal's read decided (money-held source PAYPAL_READ), `acquit` otherwise. */
	readonly source: "paypal" | "acquit";
	readonly reason: string;
};

export function parseAutopilotArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env,
	stored: () => StoredLogin | null = () => null): AutopilotOptions {
	const { apiUrl, rest } = apiFlag(argv, env);
	let agent: string | null = null;
	let once = false;
	let everyMs = DEFAULT_EVERY_MS;
	let promptPath: string | null = null;
	let workRoot: string | null = null;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		const value = () => {
			const next = rest[++index];
			if (next === undefined) throw new CliError("USAGE", `${arg} needs a value.`);
			return next;
		};
		if (arg === "--once") once = true;
		else if (arg === "--every") everyMs = parseEvery(value());
		else if (arg === "--prompt") promptPath = value();
		else if (arg === "--dir") workRoot = value();
		else if (arg.startsWith("--")) throw new CliError("USAGE", `Unknown flag ${arg}.`);
		else if (agent === null) agent = arg;
		else throw new CliError("USAGE", `Unexpected argument ${arg}.`);
	}
	if (agent === null) throw new CliError("USAGE", USAGE);
	return { apiUrl, token: resolveToken(undefined, env, () => stored()?.token ?? null), agent, once, everyMs, promptPath, workRoot };
}

function parseEvery(text: string): number {
	const match = /^(\d+)s?$/.exec(text);
	const seconds = match ? Number(match[1]) : Number.NaN;
	if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
		throw new CliError("USAGE", "--every takes 5s to 3600s, for example 15s.");
	}
	return seconds * 1000;
}

// ---- the API's shapes, as far as the worker reads them ----------------------------------------

type OperatorBody = {
	readonly operator: { readonly id: string; readonly handle: string };
	readonly agents: readonly { readonly id: string; readonly name: string; readonly runner: string; readonly task?: string }[];
};

type StandingOrdersBody = {
	readonly priceFloorCents: number;
	readonly maxConcurrent: number;
	readonly autopilot: boolean | number;
	readonly runsOn: string;
	readonly preApprove: boolean | number;
	readonly preApproveCap: number;
};

type BidBody = { readonly operator: string; readonly agent: string; readonly status: string };

type JobBody = {
	readonly id: string;
	readonly status: string;
	readonly vertical: string;
	readonly budget: number | string;
	readonly lockedTo: string | null;
	readonly fixtureMatched?: unknown;
	readonly bids: { readonly operators: readonly BidBody[] };
	readonly attempts: {
		readonly left: number;
		readonly history: readonly { readonly sourceCommit: string; readonly result: string }[];
	};
};

// ---- the local record -------------------------------------------------------------------------

type JobEntry = { phase: TrackedPhase; commit: string | null; note: string };

type AgentState = {
	jobs: Record<string, JobEntry>;
	/** When each pre-approved submit was made. Only the last 24 hours count against the cap. */
	preApprovals: string[];
	lastNote: string | null;
};

type Orders = {
	readonly core: StandingOrders;
	readonly preApprove: boolean;
	readonly preApproveCap: number;
};

type Worker = {
	readonly options: AutopilotOptions;
	readonly client: ApiClient;
	readonly provider: ProviderPort;
	readonly env: NodeJS.ProcessEnv;
	readonly now: () => number;
	readonly say: (line: string) => void;
	readonly actions: AutopilotActions;
	readonly operatorId: string;
	readonly agent: { readonly id: string; readonly name: string; readonly task: string };
	readonly stateFile: string;
	readonly recordFile: string;
	readonly confirmDir: string;
	readonly workRoot: string;
	readonly prompt: string | null;
	readonly image: string;
	readonly proxyImage: string;
	state: AgentState;
};

type TickResult = { readonly stop: string | null; readonly failed: boolean };

export async function runAutopilot(options: AutopilotOptions, deps: AutopilotDeps): Promise<number> {
	const env = deps.env;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? (ms => new Promise<void>(finish => setTimeout(finish, ms)));
	const readFile = deps.readFile ?? (path => readFileSync(path, "utf8"));
	const me = await deps.client.get("/api/me/operator") as OperatorBody;
	const agent = me.agents.find(entry => entry.name === options.agent || entry.id === options.agent);
	if (agent === undefined) throw new CliError("AGENT_NOT_FOUND", `No agent named ${options.agent} belongs to this operator.`);
	if (agent.runner !== "claude-code") {
		throw new CliError("RUNNER_UNSUPPORTED", `Autopilot runs claude-code agents only, and ${agent.name} is ${agent.runner}.`);
	}
	const stateDir = join(stateRoot(env), "autopilot", agent.name.replace(/[^A-Za-z0-9._-]/g, "_"));
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const stateFile = join(stateDir, "state.json");
	const image = env.ACQUIT_RUNNER_IMAGE?.trim() || DEFAULT_RUNNER_IMAGE;
	const worker: Worker = {
		options,
		client: deps.client,
		provider: deps.provider,
		env,
		now,
		say: line => deps.write(`${line}\n`),
		actions: { bid: runBid, run: runRun, submit: runSubmit, head: localHead, push: pushHead, ...deps.actions },
		operatorId: me.operator.id,
		agent: { id: agent.id, name: agent.name, task: agent.task ?? DEFAULT_TASK },
		stateFile,
		recordFile: join(stateDir, "record.jsonl"),
		confirmDir: confirmationDir(env),
		workRoot: resolve(options.workRoot ?? join(process.cwd(), WORK_FOLDER)),
		prompt: options.promptPath === null ? null : readFile(options.promptPath),
		image,
		proxyImage: env.ACQUIT_RUNNER_PROXY_IMAGE?.trim() || image,
		state: loadState(stateFile),
	};
	for (;;) {
		let result: TickResult = { stop: null, failed: false };
		try {
			result = await tick(worker);
		} catch (error) {
			// A dropped connection ends a one-off tick with its error, and a looping worker tries again.
			if (options.once || !(error instanceof CliError) || error.code !== "API_UNREACHABLE") throw error;
			worker.say("acquit: cannot reach the API; trying again on the next tick.");
		}
		if (result.stop !== null) {
			worker.say(`Autopilot stopped: ${result.stop}.`);
			return result.failed ? 1 : 0;
		}
		if (options.once) return 0;
		await sleep(options.everyMs);
	}
}

async function tick(worker: Worker): Promise<TickResult> {
	const orders = await readOrders(worker);
	if (orders === null) {
		return { stop: `no standing orders for ${worker.agent.name}; set them on the standing-orders screen`, failed: true };
	}
	const jobs = await readJobs(worker);
	const decision = decideTick({
		operatorId: worker.operatorId,
		agentId: worker.agent.name,
		task: worker.agent.task,
		orders: orders.core,
		jobs: [...jobs.values()].map(tickJob),
		tracked: worker.state.jobs,
	});
	if (decision.stop !== null) return { stop: decision.stop, failed: false };
	noteOnce(worker, decision.note);
	for (const action of decision.actions) await perform(worker, action, jobs, orders);
	return { stop: null, failed: false };
}

async function readOrders(worker: Worker): Promise<Orders | null> {
	let body: { readonly standingOrders?: StandingOrdersBody | null };
	try {
		body = await worker.client.get(`/api/me/agents/${encodeURIComponent(worker.agent.id)}/standing-orders`) as typeof body;
	} catch (error) {
		if (error instanceof CliError && error.code === "NOT_FOUND") return null;
		throw error;
	}
	const orders = body.standingOrders ?? null;
	if (orders === null) return null;
	return {
		core: {
			autopilot: flag(orders.autopilot),
			runsOn: orders.runsOn === "acquit" ? "acquit" : "owner",
			priceFloorCents: orders.priceFloorCents,
			maxConcurrent: orders.maxConcurrent,
		},
		preApprove: flag(orders.preApprove),
		preApproveCap: orders.preApproveCap,
	};
}

/** The job list, plus one view for each tracked job the list no longer carries. A tracked job that
 * is gone from the server is left out, which decideTick reads as closed. */
async function readJobs(worker: Worker): Promise<Map<string, JobBody>> {
	const listed = await worker.client.get("/api/jobs") as { readonly jobs: readonly JobBody[] };
	const jobs = new Map<string, JobBody>();
	for (const job of listed.jobs) jobs.set(job.id, job);
	for (const id of Object.keys(worker.state.jobs)) {
		if (worker.state.jobs[id]?.phase === "DONE") continue;
		try {
			const body = await worker.client.get(`/api/jobs/${encodeURIComponent(id)}`) as { readonly job: JobBody };
			jobs.set(id, body.job);
		} catch (error) {
			if (!(error instanceof CliError) || error.code !== "NOT_FOUND") throw error;
			jobs.delete(id);
		}
	}
	return jobs;
}

function tickJob(job: JobBody): TickJob {
	return {
		id: job.id,
		status: job.status,
		vertical: job.vertical,
		budgetCents: Number(job.budget),
		bids: job.bids.operators.map(bid => ({ operator: bid.operator, agent: bid.agent, status: bid.status })),
		attempts: {
			left: job.attempts.left,
			history: job.attempts.history.map(item => ({ sourceCommit: item.sourceCommit, result: item.result })),
		},
	};
}

async function perform(worker: Worker, action: TickAction, jobs: ReadonlyMap<string, JobBody>, orders: Orders): Promise<void> {
	const job = jobs.get(action.jobId);
	try {
		if (action.kind === "finish") finishJob(worker, action.jobId, action.outcome, action.reason);
		else if (action.kind === "bid") await placeBid(worker, action.jobId, action.priceCents);
		else if (job === undefined) return;
		else if (action.kind === "run") await runJob(worker, job);
		else await submitJob(worker, job, orders);
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
		if (error.code === "API_UNREACHABLE") {
			worker.say(`Job ${action.jobId}: cannot reach the API; trying again on the next tick.`);
			return;
		}
		markDone(worker, action.jobId, `${error.code}: ${error.message}`);
		worker.say(`Job ${action.jobId} stopped: ${error.code}. ${error.message}`);
	}
}

async function placeBid(worker: Worker, jobId: string, priceCents: number): Promise<void> {
	let text: string;
	try {
		text = await worker.actions.bid({
			apiUrl: worker.options.apiUrl,
			token: worker.options.token,
			jobId,
			price: priceCents,
			etaHours: BID_ETA_HOURS,
			agent: worker.agent.name,
			pitch: BID_PITCH,
		}, { client: worker.client });
	} catch (error) {
		// The bid may have landed before a crash cost the local record. The tick reads the bid next and sorts it out.
		if (!(error instanceof CliError) || error.code !== "ALREADY_BID") throw error;
		setPhase(worker, jobId, "BID", null, "bid already on the job");
		return;
	}
	setPhase(worker, jobId, "BID", null, `bid at ${priceCents} cents`);
	record(worker, "bid", { jobId, note: `${priceCents} cents` });
	worker.say(text);
}

async function runJob(worker: Worker, job: JobBody): Promise<void> {
	const accepted = job.bids.operators.find(bid => bid.status === "ACCEPTED");
	if (accepted === undefined || accepted.agent !== worker.agent.name) {
		markDone(worker, job.id, "the accepted bid is not this agent's");
		return;
	}
	const held = await confirmHeld(worker, job);
	const entry = worker.state.jobs[job.id];
	if (!held.held) {
		setPhase(worker, job.id, entry.phase, entry.commit, `not run: ${held.reason} (source ${held.source})`);
		return;
	}
	const dir = dirFor(worker, job.id);
	mkdirSync(worker.workRoot, { recursive: true, mode: 0o700 });
	await worker.actions.run({
		jobId: job.id,
		dir,
		apiUrl: worker.options.apiUrl,
		token: worker.options.token,
		instruction: worker.prompt,
		runner: "claude-code",
		command: null,
		image: worker.image,
		proxyImage: worker.proxyImage,
	}, { client: worker.client, provider: worker.provider, env: worker.env, print: line => worker.say(line) } satisfies RunDeps);
	setPhase(worker, job.id, "RAN", null, "ran in the sandbox");
	record(worker, "run", { jobId: job.id, note: `held by ${held.source}` });
}

/** The hard gate before any work: the job is in progress and locked to this operator. When the
 * money-held endpoint exists, PayPal's answer decides. When it does not (404), the lock check decides. */
async function confirmHeld(worker: Worker, job: JobBody): Promise<HeldCheck> {
	if (job.status !== "IN_PROGRESS" || job.lockedTo !== worker.operatorId) {
		return { held: false, source: "acquit", reason: "the job is not in progress for this operator" };
	}
	try {
		const body = await worker.client.get(`/api/me/jobs/${encodeURIComponent(job.id)}/money-held`) as { readonly held?: unknown; readonly source?: unknown };
		// The server answers PAYPAL_READ when it read PayPal, and ESCROW_STATE when it could not.
		const source = body.source === "PAYPAL_READ" ? "paypal" : "acquit";
		if (body.held !== true) {
			return { held: false, source, reason: source === "paypal" ? "PayPal says the money is not held" : "the escrow state says the money is not held" };
		}
		return { held: true, source, reason: source === "paypal" ? "PayPal says the money is held" : "the escrow state says the money is held" };
	} catch (error) {
		if (error instanceof CliError && error.code === "NOT_FOUND") {
			return { held: true, source: "acquit", reason: "the job is locked to this operator" };
		}
		throw error;
	}
}

/** The submit handshake (decision D1). The commit is pinned and a request is written before anything
 * else. A pre-approved submit writes its own confirmation only when every condition in decidePreApproval
 * holds. Otherwise the owner confirms by typing `acquit confirm-submit`. The Submit command waits
 * for the claimed confirmation, so the worker never submits a commit nobody confirmed. */
async function submitJob(worker: Worker, job: JobBody, orders: Orders): Promise<void> {
	const id = job.id;
	const dir = dirFor(worker, id);
	const current = worker.state.jobs[id];
	if (current.phase === "REQUESTED" && readRequest(worker.confirmDir, id) === null) {
		setPhase(worker, id, "RAN", null, "the request was cleared; asking again");
	}
	if (worker.state.jobs[id].phase === "RAN" || worker.state.jobs[id].commit === null) {
		const commit = worker.actions.head(dir, id, worker.env);
		const nowMs = worker.now();
		const requestedAt = new Date(nowMs).toISOString();
		writeRequest(worker.confirmDir, { jobId: id, commit, requestedAt });
		setPhase(worker, id, "REQUESTED", commit, "waiting for confirmation");
		const decision = decidePreApproval({
			autopilot: orders.core.autopilot,
			preApprove: orders.preApprove,
			cap: orders.preApproveCap,
			approvedInWindow: approvedInWindow(worker.state, nowMs),
			fixtureMatched: job.fixtureMatched === true,
		});
		if (decision.approved) {
			writeConfirmation(worker.confirmDir, { jobId: id, commit, confirmedAt: requestedAt });
			worker.state.preApprovals = worker.state.preApprovals.filter(at => nowMs - Date.parse(at) < DAY_MS).concat(requestedAt);
			saveState(worker);
			record(worker, "pre-approved", { jobId: id, commit, note: `${worker.state.preApprovals.length} in the last 24 hours` });
			worker.say(`Pre-approved submit for job ${id} at ${commit.slice(0, 12)}.`);
		} else {
			const note = `waiting for your confirmation (${decision.reason})`;
			setPhase(worker, id, "REQUESTED", commit, note);
			worker.say(`Submit for job ${id} waits for you: run acquit confirm-submit ${id}.`);
		}
	}
	const pending = worker.state.jobs[id];
	let confirmation: ReturnType<typeof claimConfirmation>;
	try {
		confirmation = claimConfirmation(worker.confirmDir, id);
	} catch (error) {
		clearRequest(worker.confirmDir, id);
		setPhase(worker, id, "RAN", null, `confirmation unreadable (${error instanceof Error ? error.message : "unknown"})`);
		return;
	}
	if (confirmation === null) return;
	clearRequest(worker.confirmDir, id);
	if (confirmation.commit !== pending.commit) {
		setPhase(worker, id, "RAN", null, "the confirmation was for another commit");
		return;
	}
	const commit = confirmation.commit;
	try {
		const text = await worker.actions.submit({
			jobId: id,
			dir,
			remote: null,
			apiUrl: worker.options.apiUrl,
			token: worker.options.token,
			timeoutSeconds: SUBMIT_WAIT_SECONDS,
			pollMs: SUBMIT_POLL_MS,
		}, { client: worker.client, head: () => commit, push: worker.actions.push, env: worker.env });
		setPhase(worker, id, "SUBMITTED", commit, "submitted");
		worker.say(text);
	} catch (error) {
		// The Submit command was posted before the wait began. The next tick reads the verdict from the job.
		if (error instanceof CliError && error.code === "VERIFIER_TIMEOUT") {
			setPhase(worker, id, "SUBMITTED", commit, "submitted; verdict pending");
			return;
		}
		throw error;
	}
}

function finishJob(worker: Worker, jobId: string, outcome: JobOutcome, reason: string): void {
	markDone(worker, jobId, `${outcome}: ${reason}`);
	worker.say(`Job ${jobId} finished: ${outcome}, ${reason}.`);
}

function markDone(worker: Worker, jobId: string, note: string): void {
	const entry = worker.state.jobs[jobId];
	setPhase(worker, jobId, "DONE", entry?.commit ?? null, note);
}

function setPhase(worker: Worker, jobId: string, phase: TrackedPhase, commit: string | null, note: string): void {
	const before: JobEntry | undefined = worker.state.jobs[jobId];
	worker.state.jobs[jobId] = { phase, commit, note };
	saveState(worker);
	if (before === undefined || before.phase !== phase || before.note !== note) {
		record(worker, "phase", { jobId, phase, commit, note });
	}
}

function noteOnce(worker: Worker, note: string | null): void {
	if (note === worker.state.lastNote) return;
	worker.state.lastNote = note;
	saveState(worker);
	if (note !== null) {
		worker.say(note);
		record(worker, "note", { note });
	}
}

function dirFor(worker: Worker, jobId: string): string {
	return join(worker.workRoot, jobId);
}

function approvedInWindow(state: AgentState, nowMs: number): number {
	return state.preApprovals.filter(at => nowMs - Date.parse(at) < DAY_MS).length;
}

function flag(value: unknown): boolean {
	return value === true || value === 1;
}

function loadState(file: string): AgentState {
	if (!existsSync(file)) return { jobs: {}, preApprovals: [], lastNote: null };
	let parsed: Partial<AgentState>;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AgentState>;
	} catch {
		throw new CliError("STATE_CORRUPT", `The autopilot state at ${file} is not valid JSON. Move it aside to start fresh.`);
	}
	return { jobs: parsed.jobs ?? {}, preApprovals: parsed.preApprovals ?? [], lastNote: parsed.lastNote ?? null };
}

/** Written after every change, through a temporary file, so a crash never leaves a half-written record. */
function saveState(worker: Worker): void {
	const temporary = `${worker.stateFile}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(worker.state, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, worker.stateFile);
}

function record(worker: Worker, event: string,
	fields: { readonly jobId?: string; readonly phase?: TrackedPhase; readonly commit?: string | null; readonly note?: string }): void {
	const line = { at: new Date(worker.now()).toISOString(), event, ...fields };
	appendFileSync(worker.recordFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

