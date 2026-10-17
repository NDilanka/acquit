// The judge scenarios: five named paths through one run visitor's job, driven on the server. Each step acts
// through acquit.execute as the run visitor's own client or operator, waits on the verifier and PayPal the
// way the job row reports them, and records its own timing. The run lives on the server, so a closed tab
// does not stop it. A run is retained only once its job exists, and the store keeps a bounded number.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Acquit, Actor, CommandOutcome, UserCommand } from "./acquit.ts";
import type { OutboxRan } from "./effects.ts";
import { hours, instant } from "./ids.ts";
import type { AgentId, BidId, ClientId, CommitSha, Instant, JobId, OperatorId, StaffId, VisitorId } from "./ids.ts";
import type { AttemptRecord, JobRow, JobStatus } from "./job.ts";
import { shiftJobClock } from "./job-clock.ts";
import { usd } from "./ledger.ts";
import { reasonCode } from "./score-card.ts";
import { arbiterOwns, openedJobOf, stepKey } from "./scenario-binding.ts";
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
	github: "GitHub work repository",
	server: "Server record (no outside call)",
} as const;
export type ScenarioLabel = (typeof SCENARIO_LABELS)[keyof typeof SCENARIO_LABELS];

/**
 * The label a settle step carries, from what its tick ran for the job. PayPal work wins, so a tick that ran both
 * names PayPal, and the outcome names every effect. An effect that reached nobody outside is a server record. An
 * alert is one too: it goes to the process log, and the API wires no alert sink.
 */
export function settleLabelOf(ran: readonly OutboxRan[]): ScenarioLabel {
	const reached = new Set(ran.map(effect => effect.reach));
	if (reached.has("PAYPAL")) return SCENARIO_LABELS.paypal;
	if (reached.has("VERIFIER")) return SCENARIO_LABELS.verifier;
	if (reached.has("GITHUB")) return SCENARIO_LABELS.github;
	return SCENARIO_LABELS.server;
}

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

/** The end state each scenario must reach to be DONE. Any other end is FAILED, with the observed end recorded. */
export const EXPECTED_END_STATES: Readonly<Record<ScenarioName, ScenarioEndState>> = {
	"verified-and-paid": { jobStatus: "PAID", reason: "CLIENT_APPROVAL" },
	"hidden-test-fail": { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" },
	"test-tamper": { jobStatus: "IN_PROGRESS", reason: "PROTECTED_PATH_MODIFIED" },
	"dispute-arbiter": { jobStatus: "PAID", reason: "ARBITER_UPHELD" },
	"deadline-refund": { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" },
};

/** What a submit step records for the verifier's verdict: VERIFIED, or REJECTED with the job's rejection reason. */
export type SubmitVerdict = "VERIFIED" | `REJECTED ${string}`;

/** The scenarios whose chain submits a tree. deadline-refund never submits, so it names no verdict. */
export type SubmittingScenario = Exclude<ScenarioName, "deadline-refund">;

/**
 * The verdict each submitting scenario's submit needs. A different verdict stops the run at submit, with
 * FAILED VERDICT_UNEXPECTED, and no later step runs. The REJECTED reasons are the end states EXPECTED_END_STATES names.
 */
export const EXPECTED_SUBMIT_VERDICTS: Readonly<Record<SubmittingScenario, SubmitVerdict>> = {
	"verified-and-paid": "VERIFIED",
	"hidden-test-fail": "REJECTED TESTS_FAILED:hidden",
	"test-tamper": "REJECTED PROTECTED_PATH_MODIFIED",
	"dispute-arbiter": "VERIFIED",
};

export type ScenarioRun = {
	readonly id: string;
	readonly name: ScenarioName;
	/** The signed-in visitor that started the run. Only that visitor may read it. */
	readonly requesterId: string;
	/** The run's own visitor: the client and operator its job's steps act as. */
	readonly visitorId: string;
	readonly jobId: string;
	readonly steps: readonly ScenarioStep[];
	readonly state: "RUNNING" | "DONE" | "FAILED";
	readonly endState: ScenarioEndState | null;
	/** Why the run stopped short of its end state: RESTARTED when a restart ended it. Null for every other stop. */
	readonly failure: "RESTARTED" | null;
};

/** A scripted agent's tree, named by its score card corpus entry. The workspace writes that entry's files. */
export type ScriptedTree = "honest-reference-table" | "cheat-hardcode-visible-values" | "cheat-edit-frozen-test";

/** Puts a scripted tree in the job's work repo and returns the commit the agent submits. */
export type ScenarioWorkspace = { push(jobId: JobId, tree: ScriptedTree): Promise<CommitSha> };

export type ScenarioVisitor = { readonly id: VisitorId; readonly clientHandle: string; readonly operatorHandle: string; readonly repository: string | null };

/** How many runs one requester keeps, how many it may have RUNNING at once, and how many the store keeps in all. */
export const SCENARIO_RUNS_PER_REQUESTER = 10;
export const SCENARIO_RUNNING_PER_REQUESTER = 5;
export const SCENARIO_RUNS_TOTAL = 500;
export type RunBounds = { readonly perRequester: number; readonly running: number; readonly total: number };
const DEFAULT_BOUNDS: RunBounds = { perRequester: SCENARIO_RUNS_PER_REQUESTER, running: SCENARIO_RUNNING_PER_REQUESTER, total: SCENARIO_RUNS_TOTAL };

export type RunAdmissionRefusal = "SCENARIO_RUNNING_LIMIT" | "SCENARIO_STORE_FULL";
/** One start's place in the store, from admission until the run is committed or the start is abandoned. */
export type RunSlot = { commit(run: ScenarioRun): void; release(): void };
export type RunAdmission = { readonly kind: "ADMITTED"; readonly slot: RunSlot } | { readonly kind: "REFUSED"; readonly code: RunAdmissionRefusal };

export type ScenarioRuns = {
	/** Reserves a place for one start, or refuses it by name. Nothing is retained until the slot commits. */
	admit(requesterId: string): RunAdmission;
	/**
	 * Writes the progress of a committed run. A run the store did not commit is refused, and so is one whose name,
	 * requester, visitor, or job differs from the committed run: a record cannot take over another run's job.
	 */
	save(run: ScenarioRun): void;
	get(id: string): ScenarioRun | undefined;
	size(): number;
};

/**
 * The run store. A start is admitted while its requester has fewer than `running` runs in flight and the
 * store has room. A full requester or store evicts its oldest finished run. A running run is never evicted,
 * so an admitted start always finds its place. With a database the committed snapshots are written through
 * to it at each progress, so they survive a reopen. A run RUNNING when the store opens was cut off by a
 * restart: it is marked FAILED with failure RESTARTED, and its scripted steps are never resumed.
 */
export function boundedRuns(bounds: RunBounds = DEFAULT_BOUNDS, db?: DatabaseSync): ScenarioRuns {
	// The store keeps its own copies and hands out copies only, so no caller's object is ever the committed record.
	const runs = new Map<string, ScenarioRun>();
	const copyOf = (run: ScenarioRun): ScenarioRun => structuredClone(run);
	const admitted = new Map<string, number>();
	let admittedTotal = 0;
	const records = db === undefined ? null : runRecords(db);
	records?.reconcile();
	for (const loaded of records?.load() ?? []) {
		const run: ScenarioRun = loaded.state === "RUNNING" ? { ...loaded, state: "FAILED", failure: "RESTARTED" } : loaded;
		if (run !== loaded) records?.write(run);
		runs.set(run.id, run);
	}
	const admittedOf = (requesterId: string): number => admitted.get(requesterId) ?? 0;
	// Eviction drops the snapshot only. The cleanup journal keeps the run's obligations until its repositories are gone.
	const evictOldestFinished = (among: (run: ScenarioRun) => boolean): boolean => {
		for (const run of runs.values()) {
			if (run.state === "RUNNING" || !among(run)) continue;
			runs.delete(run.id);
			records?.remove(run.id);
			return true;
		}
		return false;
	};
	// The snapshot and the journal commit first. Memory takes the run only once they have, so a failed write publishes nothing.
	const keep = (run: ScenarioRun): void => { records?.write(run); runs.set(run.id, copyOf(run)); };
	return {
		admit(requesterId) {
			const own = [...runs.values()].filter(run => run.requesterId === requesterId);
			const running = own.filter(run => run.state === "RUNNING").length + admittedOf(requesterId);
			if (running >= bounds.running) return { kind: "REFUSED", code: "SCENARIO_RUNNING_LIMIT" };
			if (own.length + admittedOf(requesterId) >= bounds.perRequester) evictOldestFinished(run => run.requesterId === requesterId);

			if (runs.size + admittedTotal >= bounds.total && !evictOldestFinished(() => true)) return { kind: "REFUSED", code: "SCENARIO_STORE_FULL" };
			admitted.set(requesterId, admittedOf(requesterId) + 1);
			admittedTotal++;
			let open = true;
			const close = () => {
				if (!open) return;
				open = false;
				admitted.set(requesterId, admittedOf(requesterId) - 1);
				admittedTotal--;
			};
			return { kind: "ADMITTED", slot: { commit: run => { try { keep(run); } finally { close(); } }, release: close } };
		},
		save(run) {
			const committed = runs.get(run.id);
			if (committed === undefined || committed.name !== run.name || committed.requesterId !== run.requesterId
				|| committed.visitorId !== run.visitorId || committed.jobId !== run.jobId) {
				throw new Error(`Not a committed scenario run, or its identity changed: ${run.id}`);
			}
			// A finished run is final: a snapshot that says RUNNING again is refused, the same as the database does.
			if (committed.state !== "RUNNING" && run.state === "RUNNING") throw new Error(`A finished scenario run cannot resume: ${run.id}`);
			keep(run);
		},
		get: id => { const run = runs.get(id); return run === undefined ? undefined : copyOf(run); },
		size: () => runs.size,
	};
}

/**
 * The tables the run store writes through. `scenario_runs` holds one bounded snapshot per run, in insertion
 * order by rowid, so the oldest finished run is the first one the load returns. `scenario_cleanup` holds one
 * journal row per committed run, written with the snapshot and never removed by eviction. Its `finished_at` is
 * the wall-clock moment the run first left RUNNING: the scenario sweep's TTL counts from it.
 */
function runRecords(db: DatabaseSync): { reconcile(): void; load(): ScenarioRun[]; write(run: ScenarioRun): void; remove(id: string): void } {
	// Snapshot and journal commit together or not at all: a crash between the two statements cannot leave a finished
	// snapshot whose journal is unfinished.
	const transaction = (work: () => void): void => {
		db.exec("BEGIN IMMEDIATE");
		try { work(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
	};
	return {
		// A finished run whose journal is missing or unfinished (a write from before the commit was atomic) is stamped
		// now, but only where its own OpenJob receipt proves the job it names. Anything unproven is left alone.
		reconcile: () => transaction(() => {
			const orphaned = db.prepare(`SELECT r.id, r.visitor_id, r.job_id FROM scenario_runs r
				LEFT JOIN scenario_cleanup k ON k.run_id = r.id
				WHERE r.state <> 'RUNNING' AND (k.run_id IS NULL OR k.finished_at IS NULL)`).all();
			for (const row of orphaned) {
				const id = String(row.id);
				const visitorId = String(row.visitor_id);
				const jobId = String(row.job_id);
				if (openedJobOf(db, { id, visitorId }) !== jobId) continue;
				db.prepare(`INSERT INTO scenario_cleanup (run_id, visitor_id, job_id, finished_at) VALUES (?, ?, ?, ?)
					ON CONFLICT(run_id) DO UPDATE SET finished_at = COALESCE(scenario_cleanup.finished_at, excluded.finished_at)`)
					.run(id, visitorId, jobId, new Date().toISOString());
			}
		}),
		load: () => db.prepare("SELECT snapshot FROM scenario_runs ORDER BY rowid").all()
			.map(row => JSON.parse(String(row.snapshot)) as ScenarioRun),
		write: run => transaction(() => {
			const finishedAt = run.state === "RUNNING" ? null : new Date().toISOString();
			db.prepare(`INSERT INTO scenario_runs (id, requester_id, visitor_id, job_id, name, state, snapshot)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET state = excluded.state, snapshot = excluded.snapshot`)
				.run(run.id, run.requesterId, run.visitorId, run.jobId, run.name, run.state, JSON.stringify(run));
			db.prepare(`INSERT INTO scenario_cleanup (run_id, visitor_id, job_id, finished_at) VALUES (?, ?, ?, ?)
				ON CONFLICT(run_id) DO UPDATE SET finished_at = COALESCE(scenario_cleanup.finished_at, excluded.finished_at)`)
				.run(run.id, run.visitorId, run.jobId, finishedAt);
		}),
		remove: id => { db.prepare("DELETE FROM scenario_runs WHERE id = ?").run(id); },
	};
}

export type ScenarioDeps = {
	readonly acquit: Acquit;
	readonly store: Pick<SqliteStore, "readJob" | "db">;
	readonly workspace: ScenarioWorkspace;
	readonly runs: ScenarioRuns;
	/** The job clock. Deadlines are set from it. */
	readonly now: () => Instant;
	/** The repository and issue the job opens on: the run visitor's fork, or the fixture's own repository. */
	readonly repository: string;
	readonly issueNumber: number;
	/** Called once the job exists, for a deployment that sets per-job state the open does not carry. */
	readonly onOpened?: (jobId: JobId) => void;
	readonly pollMs?: number;
	readonly waitMs?: number;
};

/** A refusal the start answers by name. The code is a closed scenario code, a cap code, or the core's own denial reason. */
export class ScenarioRefused extends Error {
	readonly code: string;
	constructor(code: string, detail: string = code) { super(detail); this.name = "ScenarioRefused"; this.code = code; }
}

const DAY_MS = 86_400_000;
const PRICE = usd("400.00");

type Context = { jobId?: JobId; bidId?: BidId; sourceCommit?: CommitSha; mergeCommit?: CommitSha; observedEnd?: ScenarioEndState };
type ChainStep = { readonly name: string; readonly actor: ScenarioActor; readonly label: ScenarioLabel; readonly run: (ctx: Context) => Promise<string> };

/**
 * The closed code of a failed step's error, or null when the error carries none. A step's own message is never kept,
 * because a provider's text can carry a token. Only a code shaped like the refusal names is kept.
 */
function closedCodeOf(error: unknown): string | null {
	if (error instanceof ScenarioRefused) return error.code;
	const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : null;
}

/** The text an uncoded failure logs: one line, cut short, with the usual shapes of a credential masked. */
function logTextOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
		.replace(/\bBearer\s+\S+/gi, "Bearer ***")
		.replace(/\b([\w-]*(?:token|secret|password|credential|auth|key)[\w-]*)(\s*[=:]\s*)\S+/gi, "$1$2***")
		.replace(/\s+/g, " ")
		.slice(0, 300);
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
 * The scenario-only arbiter verdict: UPHOLD on a job the named run opened as dispute-arbiter. The run must be
 * RUNNING, of that scenario, and its own committed OpenJob receipt must name this job. A snapshot that names the
 * job is not enough, so a forged or restarted record is refused by name before the ARBITER actor is used. Only
 * the scenario's own chain calls it, and no HTTP route does.
 */
export async function arbiterVerdictForRun(deps: ScenarioDeps, runId: string, jobId: JobId): Promise<void> {
	if (!arbiterOwns(deps.store.db, { id: runId, jobId })) throw new ScenarioRefused("SCENARIO_ARBITER_NOT_OWNED");
	const outcome = await deps.acquit.execute({ role: "ARBITER", staffId: "staff-arbiter" as StaffId }, stepKey(runId, "arbiter-verdict"),
		{ type: "ResolveDispute", jobId, verdict: "UPHOLD", note: "Scripted arbiter verdict: the delivered fix stands." });
	if (outcome.kind === "DENIED") throw new ScenarioRefused(outcome.reason, `ResolveDispute refused: ${outcome.reason}`);
}

/**
 * Starts one scenario on one run visitor, holding the slot the store admitted for it. The open is the
 * first step. It runs before anything is retained, so a refused open releases the slot and leaves no run
 * behind. Once the job exists the run is committed to the slot and the rest of the chain continues in
 * `finished`. The run is DONE only when it reaches its scenario's expected end state.
 */
export async function startScenario(deps: ScenarioDeps, name: ScenarioName, visitor: ScenarioVisitor, requesterId: string, slot: RunSlot): Promise<StartedScenario> {
	const runId = `scn_${randomUUID()}`;
	const pollMs = deps.pollMs ?? 25;
	const waitMs = deps.waitMs ?? 120_000;
	const ctx: Context = {};
	const steps: ScenarioStep[] = [];
	let current: ScenarioRun | null = null;
	const publish = (patch: Partial<ScenarioRun>) => {
		current = { ...current!, ...patch, steps: [...steps] };
		deps.runs.save(current);
	};

	const client: Actor = { role: "CLIENT", clientId: visitor.clientHandle as ClientId, tenant: visitor.id as VisitorId,
		...(visitor.repository ? { repository: visitor.repository } : {}) };
	const operator: Actor = { role: "OPERATOR", operatorId: visitor.operatorHandle as OperatorId, tenant: visitor.id as VisitorId };

	const send = async (actor: Actor, stepName: string, command: UserCommand): Promise<Extract<CommandOutcome, { kind: "COMMITTED" | "REPLAY" }>> => {
		for (let attempt = 0; ; attempt++) {
			const outcome = await deps.acquit.execute(actor, stepKey(runId, stepName), command);
			if (outcome.kind === "DENIED") {
				if (outcome.reason === "BUSY" && attempt < 3) continue;
				throw new ScenarioRefused(outcome.reason, `${command.type} refused: ${outcome.reason}`);
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
			if (Date.now() > deadline) throw new ScenarioRefused("SCENARIO_TIMED_OUT", `timed out waiting for ${what}`);
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
		if (outcome.result.kind !== "JOB") throw new ScenarioRefused("SCENARIO_OPEN_FAILED");
		ctx.jobId = outcome.result.job.id;
		deps.onOpened?.(ctx.jobId);
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
	// A verdict other than the scenario's own stops the run here, with the job's end recorded as observed. Otherwise the
	// chain would go on to approve a fix the verifier refused.
	const submit = (name: SubmittingScenario): ChainStep => ({ name: "submit", actor: "OPERATOR", label: SCENARIO_LABELS.verifier, run: async () => {
		const before = historyOf(await rowOf()).length;
		await send(operator, "submit", { type: "Submit", jobId: ctx.jobId!, sourceCommit: ctx.sourceCommit! });
		const row = await waitFor(settled => settled.state.status === "VERIFIED" ||
			(settled.state.status === "IN_PROGRESS" && settled.state.attempts.phase === "READY" && historyOf(settled).length > before), "the verifier verdict");
		const verdict: SubmitVerdict = row.state.status === "VERIFIED" ? "VERIFIED" : `REJECTED ${lastRejectionReason(row)}`;
		const expected = EXPECTED_SUBMIT_VERDICTS[name];
		if (verdict !== expected) {
			ctx.observedEnd = endStateOf(row);
			throw new ScenarioRefused("VERDICT_UNEXPECTED", `submit returned ${verdict}, and ${name} needs ${expected}`);
		}
		if (row.state.status === "VERIFIED") ctx.mergeCommit = row.state.passed.verdict.mergeCommit;
		return verdict;
	} });
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
		await arbiterVerdictForRun(deps, runId, ctx.jobId!);
		return "ARBITER_UPHELD";
	} };
	const release: ChainStep = { name: "release", actor: "SYSTEM", label: SCENARIO_LABELS.paypal, run: async () => {
		await waitFor(row => row.state.status === "PAID", "the release to pay the operator");
		return "PAID";
	} };
	// A shift that loses its compare-and-set re-reads the row and goes again, three times at most, as the
	// web's clock button does (withJobChangedRetry in apps/web/src/demo.ts).
	const advanceClock: ChainStep = { name: "advance-clock", actor: "CLIENT", label: SCENARIO_LABELS.clock, run: async () => {
		for (let attempt = 1; ; attempt++) {
			if (shiftJobClock(deps.store.db, ctx.jobId!, 2 * DAY_MS) !== null) return "advanced 2 days";
			if (attempt >= 3) throw new ScenarioRefused("JOB_CHANGED", "the job clock did not move");
		}
	} };
	const refund: ChainStep = { name: "refund", actor: "SYSTEM", label: SCENARIO_LABELS.paypal, run: async () => {
		await waitFor(row => row.state.status === "REFUNDED", "the refund to settle");
		return "REFUNDED";
	} };
	const chains: Record<ScenarioName, readonly ChainStep[]> = {
		"verified-and-paid": [open(7), bid, accept, push("honest-reference-table"), submit("verified-and-paid"), approve],
		"hidden-test-fail": [open(7), bid, accept, push("cheat-hardcode-visible-values"), submit("hidden-test-fail")],
		"test-tamper": [open(7), bid, accept, push("cheat-edit-frozen-test"), submit("test-tamper")],
		"dispute-arbiter": [open(7), bid, accept, push("honest-reference-table"), submit("dispute-arbiter"), dispute, arbiter, release],
		"deadline-refund": [open(1), bid, accept, advanceClock, refund],
	};
	const [opening, ...rest] = chains[name];

	// The outcome a failed step records: its closed code, or STEP_FAILED with its message logged once, masked, with the run and step.
	const outcomeOfFailure = (stepName: string, error: unknown): string => {
		const code = closedCodeOf(error);
		if (code === null) console.error(`scenario run ${runId} step ${stepName} failed: ${logTextOf(error)}`);
		return `FAILED ${code ?? "STEP_FAILED"}`;
	};
	// Runs one step and records it. A throw is recorded as FAILED and returned, so the caller decides.
	const record = async (step: ChainStep): Promise<{ readonly thrown: unknown } | null> => {
		const startedAt = new Date().toISOString();
		let outcome: string;
		let failure: { readonly thrown: unknown } | null = null;
		try {
			outcome = await step.run(ctx);
		} catch (error) {
			failure = { thrown: error };
			outcome = outcomeOfFailure(step.name, error);
		}
		const endedAt = new Date().toISOString();
		steps.push({ name: step.name, actor: step.actor, startedAt, endedAt, ms: Date.parse(endedAt) - Date.parse(startedAt),
			outcome: outcome.slice(0, 300), label: step.label });
		return failure;
	};
	// The tick after a step settles what the step caused, and PayPal's release or refund can run inside it. The tick is
	// recorded as a settle step only when it ran an outbox effect for this run's job, and the label is what that effect
	// reached. A tick that ran nothing for the job is the step's own bookkeeping, so its time joins the step before it.
	// A tick that throws is a settle step with its coded outcome, and it ends the run.
	const settle = async (): Promise<{ readonly thrown: unknown } | null> => {
		const startedAt = new Date().toISOString();
		let ran: readonly OutboxRan[];
		try {
			ran = (await deps.acquit.tick()).ran.filter(effect => effect.jobId === ctx.jobId);
		} catch (error) {
			const endedAt = new Date().toISOString();
			steps.push({ name: "settle", actor: "SYSTEM", startedAt, endedAt, ms: Date.parse(endedAt) - Date.parse(startedAt),
				outcome: outcomeOfFailure("settle", error).slice(0, 300), label: SCENARIO_LABELS.paypal });
			return { thrown: error };
		}
		const endedAt = new Date().toISOString();
		if (ran.length === 0) {
			const previous = steps.at(-1)!;
			steps[steps.length - 1] = { ...previous, endedAt, ms: Date.parse(endedAt) - Date.parse(previous.startedAt) };
			return null;
		}
		steps.push({ name: "settle", actor: "SYSTEM", startedAt, endedAt, ms: Date.parse(endedAt) - Date.parse(startedAt),
			outcome: `SETTLED ${ran.map(effect => effect.kind).join(", ")}`.slice(0, 300), label: settleLabelOf(ran) });
		return null;
	};

	const opened = await record(opening);
	if (opened !== null) { slot.release(); throw opened.thrown; }
	current = { id: runId, name, requesterId, visitorId: visitor.id, jobId: ctx.jobId!, steps: [...steps], state: "RUNNING", endState: null, failure: null };
	slot.commit(current);

	const runChain = async (): Promise<ScenarioRun> => {
		for (const step of rest) {
			if (await record(step) !== null) { publish({ state: "FAILED", endState: ctx.observedEnd ?? null }); return current!; }
			publish({});
			if (await settle() !== null) { publish({ state: "FAILED", endState: ctx.observedEnd ?? null }); return current!; }
			publish({});
		}
		const endState = endStateOf(await rowOf());
		const expected = EXPECTED_END_STATES[name];
		const matches = endState.jobStatus === expected.jobStatus && endState.reason === expected.reason;
		publish({ state: matches ? "DONE" : "FAILED", endState });
		return current!;
	};
	// Outside a step there is only the progress written between steps and the final read. If one of those fails, the
	// failure is kept as a record-run step, so the run still names what stopped it.
	const finished = runChain().catch(error => {
		const startedAt = steps.at(-1)?.endedAt ?? new Date().toISOString();
		const endedAt = new Date().toISOString();
		steps.push({ name: "record-run", actor: "SYSTEM", startedAt, endedAt, ms: Date.parse(endedAt) - Date.parse(startedAt),
			outcome: outcomeOfFailure("record-run", error).slice(0, 300), label: SCENARIO_LABELS.server });
		publish({ state: "FAILED" });
		return current!;
	});
	return { run: current!, finished };
}
