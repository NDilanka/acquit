// The House's delivery runner: the series of steps one held House job walks from funded to
// submitted, with its own payee and its own receipts. One model per job -- the free tier model the
// mission ruled -- and one instruction: the CLI default plus the exact suffix from the mission.
// The runner is plain orchestration: every effect (the sandbox, git, the API submit) arrives as an
// injectable port, so the whole series is testable without Docker or a model call. The transport is a
// claude-code sandbox whose proxy allows one provider host: api.fireworks.ai (the default when
// FIREWORKS_API_KEY is configured), openrouter.ai when selected, or the droid path.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../../acquit-cli/src/client.ts";
import { checkoutGitArgs as locationGitArgs, hardenedGitEnv, stripGitEnv, withStateRootFallback, type JobCheckout } from "../../acquit-cli/src/gitstate.ts";
import { childEnv, makeSecretDir, workRepoUrl, writeAskpass } from "../../acquit-cli/src/workrepo.ts";
import {
	agentArgv, changedFiles, defaultInstruction, gitCli, globalGitIdentity, prepareWorkRepo, pushWork,
	runAgentInSandbox, sandboxNames, seedCommitIdentity, submissionCommit,
	type ChangedFile, type DockerPort, type GitRun, type RunnerPlan,
} from "../../acquit-cli/src/run.ts";
import { FIREWORKS_DEFAULT_MODEL, FIREWORKS_FALLBACK_MODEL } from "../../acquit-cli/src/operator.ts";
import { LIMIT_BODY, llmKey } from "../../core/src/llm.ts";
import { classifyDroidRun, DROID_MODEL, droidExecArgv, factoryApiKey, MODEL_PROVIDER_ENV, modelProvider, reserveModelCall } from "../../core/src/model.ts";
import type { ModelCallLog } from "../../core/src/model.ts";
import type { Actor } from "../../core/src/acquit.ts";
import type { CommitSha, JobId, OperatorId, VisitorId } from "../../core/src/ids.ts";
import type { JobRow, JobStatus } from "../../core/src/job.ts";
import { boundedDetail } from "../../core/src/verifier.ts";

/** The one model the House runs on the openrouter path, per the mission's original ruling: the free
 * tier stays free. The droid path pins glm-5.3-flash (`DROID_MODEL`), never this id. */
export const HOUSE_MODEL_OPENROUTER = "nvidia/nemotron-3-ultra-550b-a55b:free";

/** The deployment's own House operator, the one the seed creates. */
export const HOUSE_OPERATOR_ID = "house-tsfix";

/** The actor the House submits as: the deployment's own seeded operator, inside the job's tenant.
 * The House bids with the job's tenant, so its delivery submits in the same world it bid in; a
 * seeded job has none, and the tenant-less actor stays locked out of every visitor's job. */
export function houseActorFor(tenant: VisitorId | null): Actor {
	return { role: "OPERATOR", operatorId: HOUSE_OPERATOR_ID as OperatorId, tenant };
}

/** The exact suffix the mission ruled onto the CLI default instruction, byte for byte. */
export const HOUSE_INSTRUCTION_SUFFIX = "Fix the root cause, not only the example in the title. Identify the general rule the bug "
	+ "violates, find the standard or specification that defines it, and make the code correct for every case that rule covers, "
	+ "including cases the issue does not mention. Do not leave a case the rule defines on a guessed default. Do not edit tests.";

/** The instruction one House run gets: the CLI default instruction plus the ruled suffix. */
export function houseInstruction(defaultInstructionText: string): string {
	return `${defaultInstructionText} ${HOUSE_INSTRUCTION_SUFFIX}`;
}

/** The providers the House's coding agent runs under: droid (glm-5.3-flash), openrouter (the nemotron
 * :free id), and fireworks (Kimi, with GLM as its one fallback). */
export type HouseProvider = "droid" | "openrouter" | "fireworks";

/** The House's own provider selector. It is separate from the product switch, so the coding agent can
 * move to Fireworks while Ask and scoping keep their own path, and the other way round. */
export const HOUSE_PROVIDER_ENV = "ACQUIT_HOUSE_PROVIDER";

/** The House's provider. `ACQUIT_HOUSE_PROVIDER` names it outright. Without it, an explicit product
 * switch keeps its meaning for the House (`openrouter` and `droid` run as they always did, and an explicit
 * `fireworks` runs fireworks even without its key, so a missing key fails loudly). Unset, the House runs
 * on Fireworks when a Fireworks key is configured, and on droid when none is. */
export function houseProvider(env: NodeJS.ProcessEnv = process.env): HouseProvider {
	const named = env[HOUSE_PROVIDER_ENV]?.trim().toLowerCase();
	if (named !== undefined && named !== "") {
		if (named === "fireworks" || named === "droid" || named === "openrouter") return named;
		throw new Error(`${HOUSE_PROVIDER_ENV} must be fireworks, droid, or openrouter, not ${JSON.stringify(env[HOUSE_PROVIDER_ENV])}`);
	}
	const explicitSwitch = (env[MODEL_PROVIDER_ENV]?.trim() ?? "") !== "";
	const product = modelProvider(env);
	if (explicitSwitch && product !== "fireworks") return product;
	if (explicitSwitch || (env.FIREWORKS_API_KEY?.trim() ?? "") !== "") return "fireworks";
	return "droid";
}

/** The deployment's House mode: the model the provider names (Kimi on fireworks with GLM as the one
 * retry, droid's glm-5.3-flash, or the openrouter path's nemotron :free id), or the command runner for
 * the offline lanes under any provider. The mode comes from the environment, never from a request. */
export type HouseMode = { readonly runner: "model"; readonly provider: HouseProvider; readonly model: string; readonly fallbackModel?: string }
	| { readonly runner: "command"; readonly commandPath: string };

export function houseMode(env: NodeJS.ProcessEnv = process.env): HouseMode {
	const command = env.ACQUIT_HOUSE_COMMAND?.trim();
	if (command) return { runner: "command", commandPath: command };
	const provider = houseProvider(env);
	if (provider === "fireworks") {
		return { runner: "model", provider, model: FIREWORKS_DEFAULT_MODEL, fallbackModel: FIREWORKS_FALLBACK_MODEL };
	}
	return { runner: "model", provider, model: provider === "droid" ? DROID_MODEL : HOUSE_MODEL_OPENROUTER };
}

// ---- the delivery series -----------------------------------------------------------------------

export type HouseRunPlan =
	| { readonly runner: "model"; readonly jobId: JobId; readonly workDir: string; readonly model: string; readonly instruction: string }
	| { readonly runner: "command"; readonly jobId: JobId; readonly workDir: string; readonly commandPath: string };

/** A model run's outcome. A success carries what the run log records per call: the model id, the
 * provider's session id, and the Factory credits the provider reported, when it reported them. An
 * error carries the same when the provider's own answer did, plus its class: a rate or usage limit
 * is terminal (`RATE_LIMITED`), never retried, and stops the whole scan. */
export type HouseRunOutcome = {
	readonly ok: true;
	readonly sessionId?: string | null;
	readonly model?: string | null;
	readonly factoryCredits?: number | null;
} | { readonly ok: false; readonly reason: "PROVIDER_ERROR" | "RATE_LIMITED" | "RUN_FAILED"; readonly detail: string;
	readonly sessionId?: string | null;
	readonly model?: string | null;
	readonly factoryCredits?: number | null; };

export type HouseRunPort = (plan: HouseRunPlan) => Promise<HouseRunOutcome>;

/** What one successful run produced: the submission commit and its own diff, read from the same
 * checkout before it is cleaned up. The patch is the plain `git diff` text, bounded. */
export type HouseDelivery = {
	readonly commit: CommitSha;
	readonly files: readonly ChangedFile[];
	readonly patch: string;
};

export const PATCH_CHARS_MAX = 100_000;

/** A change the House refuses before anything is pushed: a credential appears in it, or the change cannot be
 * read for that check. The message names the refusal only; it never carries a value. */
export class ChangeRefusedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "ChangeRefusedError";
	}
}

export type HouseTarget = {
	readonly id: JobId;
	readonly title: string;
	/** The contract's repository, from which the work repo name is derived. */
	readonly repository: string;
	readonly frozenAt: CommitSha;
	/** The job row's own tenant, the only world this delivery's submit may act in. */
	readonly tenant: VisitorId | null;
};

/** One job's delivery state, outside the job row: the House is the only writer and the API only
 * reads it to decide whether this tick should start another series. */
export type HouseDeliveryState = {
	/** Run calls ever made for this job, model calls on the model path and command runs on the command path. */
	readonly calls: number;
	readonly submittedCommit: CommitSha | null;
	readonly submitAttempts: number;
	readonly prepareFailures: number;
	/** The model a provider error left for the job's one retry. It is persisted before that retry's reservation, so a
	 * refused reservation keeps the retry pending for the next tick. Null means the primary model. */
	readonly pendingModel: string | null;
};

/** The work-repo side of one series: the clone at the frozen commit, and the commit-and-push that
 * produces the submission commit with its diff (null when the run left the checkout clean). A change
 * that carries a credential, or cannot be read for that check, throws ChangeRefusedError before any push. */
export type HouseWorkPort = {
	readonly prepare: (job: HouseTarget) => Promise<{ readonly workDir: string }>;
	readonly finalize: (job: HouseTarget, workDir: string) => Promise<HouseDelivery | null>;
	readonly remove: (jobId: JobId) => void;
};

export type HouseDeliveryDeps = {
	/** The runner this deployment runs the House with: the model the provider names, or the command
	 * runner for lanes. `houseMode` resolves it from the environment. */
	readonly mode: HouseMode;
	readonly run: HouseRunPort;
	readonly work: HouseWorkPort;
	readonly readState: (jobId: JobId) => Promise<HouseDeliveryState>;
	readonly writeState: (jobId: JobId, state: HouseDeliveryState) => Promise<void>;
	/** The same Submit edge every operator uses: push and Submit, which starts the verifier. The
	 * delivery rides along the first time so the job's timeline can show the run's own diff. The
	 * target rides too, so the submit edge builds the actor from the job's own tenant. */
	readonly submit: (job: HouseTarget, commit: CommitSha, delivery?: HouseDelivery) => Promise<void>;
	/** The durable call log the shared minute/day budget reads, and every call appends to. */
	readonly callLog: ModelCallLog;
	/** The deployment's own clock, so the budget's rolling windows and record stamps are testable. */
	readonly now: () => string;
	readonly log: (line: string) => void;
};

export type DeliveryOutcome = "SUBMITTED" | "RESUBMITTED" | "CALLS_SPENT" | "NO_SUBMISSION" | "FAILED" | "RATE_LIMITED" | "BUDGET";

/** Hard bounds. Two calls per job ever -- the retry on a provider error is the second one -- and a
 * bounded re-submit loop so a flaky API can never spin. */
const MAX_CALLS = 2;
const MAX_SUBMITS = 10;
const MAX_PREPARE_FAILURES = 20;

/** Walks one held House job through the delivery series once. The tick calls it for every job the
 * scan picks; every step is bounded so a tick can never run away. */
export async function runHouseDelivery(deps: HouseDeliveryDeps, job: HouseTarget): Promise<DeliveryOutcome> {
	const state = { ...freshState(), ...await deps.readState(job.id) };

	// A series that already produced a commit only needs the Submit edge again: no clone, no model.
	if (state.submittedCommit !== null) {
		if (state.submitAttempts >= MAX_SUBMITS) {
			deps.log(`house: ${job.id} gave up re-submitting after ${state.submitAttempts} attempts`);
			return "FAILED";
		}
		// The attempt is persisted before the edge is called, so a crash or a transport failure can
		// never spin: every tick spends one bounded attempt. A denial still resolved -- the domain
		// heard the submit -- so it counts the same.
		await deps.writeState(job.id, { ...state, submitAttempts: state.submitAttempts + 1 });
		try {
			await deps.submit(job, state.submittedCommit);
		} catch (error) {
			deps.log(`house: ${job.id} submit did not land; the next tick retries (${boundedDetail(String(error))})`);
		}
		deps.log(`house: ${job.id} resubmitted ${state.submittedCommit.slice(0, 7)}`);
		return "RESUBMITTED";
	}

	// The calls cap is persisted before the first run of a series, so a crash still counts.
	if (state.calls >= MAX_CALLS) return "CALLS_SPENT";

	let prepared: { readonly workDir: string };
	try {
		prepared = await deps.work.prepare(job);
	} catch (error) {
		const prepareFailures = state.prepareFailures + 1;
		await deps.writeState(job.id, { ...state, prepareFailures });
		deps.log(`house: ${job.id} work repo not ready (${boundedDetail(String(error))})`
			+ (prepareFailures >= MAX_PREPARE_FAILURES ? " -- giving up" : ""));
		return "FAILED";
	}
	try {
		// The instruction is the CLI default plus the ruled suffix. The model is the provider's: the
		// primary for the first call, and the mode's fallback (or the primary again, on the droid and
		// openrouter paths) for the one retry.
		const instruction = houseInstruction(defaultInstruction({ title: job.title }));
		const planFor = (model: string): HouseRunPlan => deps.mode.runner === "model"
			? { runner: "model", jobId: job.id, workDir: prepared.workDir, model, instruction }
			: { runner: "command", jobId: job.id, workDir: prepared.workDir, commandPath: deps.mode.commandPath };
		const primaryModel = deps.mode.runner === "model" ? deps.mode.model : "";
		const retryModel = deps.mode.runner === "model" ? (deps.mode.fallbackModel ?? deps.mode.model) : "";

		// The shared budget is the deployment's, not the job's: a reservation is refused before the
		// job's own call count moves, and the START record precedes the run, so crashes, failures,
		// and retries all count. The command runner makes no model call, so it reserves none.
		const reserve = (model: string): Promise<{ ok: true } | { ok: false; reason: "BUDGET"; detail?: string }> => deps.mode.runner !== "model" ? Promise.resolve({ ok: true })
			: reserveModelCall(deps.callLog, { at: deps.now(), caller: "house", jobId: job.id, provider: deps.mode.provider, model });
		// Every invocation is recorded once it returns, before any retry decision: the END record
		// and one operator-readable line carrying the call's own model, session, credits, and outcome.
		const recordCall = async (outcome: HouseRunOutcome, call: number, model: string): Promise<void> => {
			if (deps.mode.runner !== "model") return;
			const outcomeName = outcome.ok ? "ok" : outcome.reason;
			await deps.callLog.append({
				at: deps.now(), caller: "house", jobId: job.id, provider: deps.mode.provider, model,
				phase: "END", outcome: outcomeName, sessionId: outcome.sessionId, factoryCredits: outcome.factoryCredits,
			});
			const parts = [
				`model ${model}`,
				outcome.sessionId == null ? null : `session ${outcome.sessionId}`,
				outcome.factoryCredits == null ? null : `credits ${outcome.factoryCredits}`,
			];
			deps.log(`house: ${job.id} model call ${call}: ${parts.filter(part => part !== null).join(", ")}, outcome ${outcomeName}`);
		};

		let calls = state.calls;
		// The model this tick's call runs on: the retry a provider error left pending, or the primary.
		const callModel = state.pendingModel !== null && state.pendingModel === retryModel ? retryModel : primaryModel;
		const reserved = await reserve(callModel);
		if (!reserved.ok) {
			deps.log(`house: ${job.id} call budget spent; the next tick retries${reserved.detail === undefined ? "" : ` (${reserved.detail})`}`);
			return "BUDGET";
		}
		calls += 1;
		await deps.writeState(job.id, { ...state, calls });
		let outcome = await deps.run(planFor(callModel));
		await recordCall(outcome, calls, callModel);
		// One retry, only on a provider error, only while the persisted cap allows it: the same model
		// again on droid and openrouter, the fallback model on fireworks. A rate or usage limit is the
		// exception the operator ruled: its own terminal class, no retry at all, and the scan stops.
		if (outcome.ok === false && outcome.reason === "PROVIDER_ERROR" && calls < MAX_CALLS) {
			// The retry is persisted as pending before its reservation: a refused reservation leaves it for the
			// next tick, which runs the same fallback model rather than the primary again.
			await deps.writeState(job.id, { ...state, calls, pendingModel: retryModel });
			const retried = await reserve(retryModel);
			if (!retried.ok) {
				deps.log(`house: ${job.id} run stopped: BUDGET on the retry; the job keeps its first call and the retry runs on the next tick${retried.detail === undefined ? "" : ` (${retried.detail})`}`);
				return "FAILED";
			}
			calls += 1;
			await deps.writeState(job.id, { ...state, calls, pendingModel: retryModel });
			if (retryModel !== primaryModel) deps.log(`house: ${job.id} retrying on the fallback model ${retryModel} after a provider error`);
			outcome = await deps.run(planFor(retryModel));
			await recordCall(outcome, calls, retryModel);
		}
		if (outcome.ok === false) {
			if (outcome.reason === "RATE_LIMITED") {
				deps.log(`house: ${job.id} run stopped: RATE_LIMITED ${boundedDetail(outcome.detail)}`);
				return "RATE_LIMITED";
			}
			deps.log(`house: ${job.id} run failed: ${outcome.reason} ${boundedDetail(outcome.detail)}`);
			return "FAILED";
		}
		// A refused change ends this series only: nothing was pushed, so nothing is submitted, and the
		// scan goes on with the other jobs.
		let delivery: HouseDelivery | null;
		try {
			delivery = await deps.work.finalize(job, prepared.workDir);
		} catch (error) {
			if (!(error instanceof ChangeRefusedError)) throw error;
			deps.log(`house: ${job.id} run failed: ${error.message}`);
			return "FAILED";
		}
		if (delivery === null) {
			deps.log(`house: ${job.id} produced no changes to submit`);
			return "NO_SUBMISSION";
		}
		// The commit is persisted before the submit, so a crash mid-submit lands on the re-submit
		// path with the commit in hand instead of a spent budget and nothing to show.
		await deps.writeState(job.id, { ...state, calls, submittedCommit: delivery.commit, submitAttempts: state.submitAttempts + 1 });
		try {
			await deps.submit(job, delivery.commit, delivery);
		} catch (error) {
			deps.log(`house: ${job.id} submit did not land; the next tick resubmits (${boundedDetail(String(error))})`);
		}
		deps.log(`house: ${job.id} submitted ${delivery.commit.slice(0, 7)} (${delivery.files.length} files changed)`);
		return "SUBMITTED";
	} finally {
		deps.work.remove(job.id);
	}
}

export function freshState(): HouseDeliveryState {
	return { calls: 0, submittedCommit: null, submitAttempts: 0, prepareFailures: 0, pendingModel: null };
}

// ---- the scan ----------------------------------------------------------------------------------

/** The narrow row facts the scan decides on, so the predicate needs no full JobRow fixture. */
export type HouseDeliverableFacts = {
	readonly status: JobStatus;
	readonly attemptsPhase: "READY" | "VERIFYING" | "REFUND_PENDING";
	/** Charged attempts ever. One charged attempt ends the deliveries whatever the verdict was. */
	readonly attemptsUsed: number;
	readonly lockedToOperator: string | null;
	readonly frozenAt: CommitSha | null;
};

/** Exactly the jobs the House may start a series on: its own held job, untouched by an attempt,
 * with a frozen commit to run against. Anything else is left to its operator or its verifier. */
export function isDeliverableHouseJob(facts: HouseDeliverableFacts, houseOperatorId: string = HOUSE_OPERATOR_ID): boolean {
	if (facts.status !== "IN_PROGRESS") return false;
	if (facts.attemptsPhase !== "READY") return false;
	if (facts.attemptsUsed !== 0) return false;
	if (facts.lockedToOperator !== houseOperatorId) return false;
	return facts.frozenAt !== null;
}

/** Reads the facts a row scan needs off a stored JobRow. */
export function houseFactsOf(row: JobRow): HouseDeliverableFacts {
	if (row.state.status !== "IN_PROGRESS") {
		return { status: row.state.status, attemptsPhase: "REFUND_PENDING", attemptsUsed: 0, lockedToOperator: null, frozenAt: null };
	}
	const work = row.state;
	return {
		status: "IN_PROGRESS",
		attemptsPhase: work.attempts.phase,
		attemptsUsed: work.attempts.history.length,
		lockedToOperator: work.escrow.payee.operator,
		frozenAt: row.contract.definitionOfDone?.frozenAt ?? null,
	};
}

// ---- the state store ---------------------------------------------------------------------------

const STATE_FILES_SAFE = /^job_[A-Za-z0-9_-]{4,80}$/;

/** The delivery states, one small JSON file per job under one directory. */
export function stateStore(dir: string): {
	readonly readState: (jobId: JobId) => Promise<HouseDeliveryState>;
	readonly writeState: (jobId: JobId, state: HouseDeliveryState) => Promise<void>;
} {
	return {
		async readState(jobId) {
			try {
				const raw = await readFile(join(dir, stateFile(jobId)), "utf8");
				const parsed = JSON.parse(raw) as Partial<HouseDeliveryState> | null;
				return {
					calls: Number.isInteger(parsed?.calls) && (parsed?.calls ?? 0) >= 0 ? parsed?.calls ?? 0 : 0,
					submittedCommit: typeof parsed?.submittedCommit === "string" ? parsed.submittedCommit : null,
					submitAttempts: Number.isInteger(parsed?.submitAttempts) && (parsed?.submitAttempts ?? 0) >= 0 ? parsed?.submitAttempts ?? 0 : 0,
					prepareFailures: Number.isInteger(parsed?.prepareFailures) && (parsed?.prepareFailures ?? 0) >= 0 ? parsed?.prepareFailures ?? 0 : 0,
					pendingModel: typeof parsed?.pendingModel === "string" && parsed.pendingModel !== "" ? parsed.pendingModel : null,
				};
			} catch {
				return freshState();
			}
		},
		async writeState(jobId, state) {
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, stateFile(jobId)), `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		},
	};
}

function stateFile(jobId: JobId): string {
	if (!STATE_FILES_SAFE.test(jobId)) throw new Error(`a job id cannot name a state file: ${JSON.stringify(jobId)}`);
	return `${jobId}.json`;
}

// ---- the model run -----------------------------------------------------------------------------

/** How much of the result line's own answer the classification reads: the same bound the Ask client reads. */
const RESULT_TEXT_LIMIT = 4096;

export function classifyModelRun(code: number | null, output: string): HouseRunOutcome {
	const result = parseClaudeResult(output);
	const statusCode = typeof result?.api_error_status === "number" ? result.api_error_status : null;
	const errorStatus = statusCode !== null && statusCode >= 400;
	if (result !== null && (result.is_error === true || errorStatus)) {
		const status = errorStatus ? ` ${statusCode}` : "";
		// A 429 is the free tier's own rate limit: terminal for the run, never retried, like a
		// Factory rate or usage limit is on the droid path. A 402 or 403 is a limit too when the
		// provider's own answer names one (a credit balance or a usage quota); any other 402 or 403
		// is a provider error. The answer is read here and never put in the detail.
		const answer = typeof result.result === "string" ? result.result.slice(0, RESULT_TEXT_LIMIT) : "";
		const limited = statusCode === 429 || ((statusCode === 402 || statusCode === 403) && LIMIT_BODY.test(answer));
		return { ok: false, reason: limited ? "RATE_LIMITED" : "PROVIDER_ERROR", detail: `the model answered${status}` };
	}
	// The result line itself says the run succeeded, whatever the exit status was.
	if (result !== null && result.is_error === false) return { ok: true };
	if (code === 0) return { ok: true };
	// A nonzero exit without an error result line is how a transport failure surfaces (ECONNRESET and
	// friends): a provider error, so the series gets its one retry.
	return { ok: false, reason: "PROVIDER_ERROR", detail: `the model run exited ${code ?? "without a status"}` };
}

type ClaudeResultLine = { readonly is_error?: unknown; readonly api_error_status?: unknown; readonly result?: unknown };

/** The last `{"type":"result",...}` line the claude CLI prints, or null. */
function parseClaudeResult(output: string): ClaudeResultLine | null {
	const lines = output.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (parsed !== null && typeof parsed === "object" && (parsed as { type?: unknown }).type === "result") {
				return parsed as ClaudeResultLine;
			}
		} catch { /* a non-JSON line; keep scanning back */ }
	}
	return null;
}

export type SandboxRunDeps = {
	readonly docker: DockerPort;
	readonly image: string;
	readonly proxyImage: string;
	readonly getKey: () => Promise<string | null>;
	readonly env?: NodeJS.ProcessEnv;
};

/** The command runner's lane mode, shared by every provider's port: no key, no provider, one
 * /bin/sh script in the same sandbox. */
async function commandPlanRun(deps: SandboxRunDeps, plan: Extract<HouseRunPlan, { readonly runner: "command" }>): Promise<HouseRunOutcome> {
	const built: RunnerPlan = {
		names: sandboxNames(plan.jobId), image: deps.image, proxyImage: deps.proxyImage, dir: plan.workDir,
		argv: agentArgv("command", "", "/acquit/command.sh"), commandPath: plan.commandPath, runner: "command",
		provider: "anthropic", providerKey: null, providerModel: null, instruction: null, jobId: plan.jobId,
		uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null,
	};
	const code = await runAgentInSandbox(built, deps.docker);
	return code === 0 ? { ok: true }
		: { ok: false, reason: "RUN_FAILED", detail: `the command exited ${code ?? "without a status"}` };
}

/** The droid run port: the same sandbox the CLI runs, with the proxy pointed at Factory's hosts and
 * the `droid exec` argv the shared droid client pins. The Factory key rides in-process -- the docker
 * child's environment, by variable name on the container -- never argv, never a log. */
export function droidRunPort(deps: SandboxRunDeps): HouseRunPort {
	const env = deps.env ?? process.env;
	return async plan => {
		if (plan.runner === "command") return commandPlanRun(deps, plan);
		const key = await deps.getKey();
		if (key === null || key === "" || /[\r\n]/.test(key)) {
			return { ok: false, reason: "RUN_FAILED", detail: "no usable Factory key" };
		}
		const built: RunnerPlan = {
			names: sandboxNames(plan.jobId), image: deps.image, proxyImage: deps.proxyImage, dir: plan.workDir,
			argv: droidExecArgv({ model: plan.model, workDir: "/work" }), commandPath: null, runner: "droid",
			provider: "droid", providerKey: key, providerModel: plan.model, instruction: plan.instruction,
			jobId: plan.jobId, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null,
		};
		try {
			const output: string[] = [];
			const code = await runAgentInSandbox(built, deps.docker, chunk => output.push(chunk), childEnv(env));
			const result = classifyDroidRun(code, output.join(""));
			// The model id the run log records is the one this port pinned on the argv.
			return result.ok ? { ok: true, sessionId: result.sessionId, model: plan.model, factoryCredits: result.factoryCredits } : result;
		} catch (error) {
			// A sandbox the daemon refused to build is not the provider's fault: no retry burns a call on it.
			if (error instanceof CliError && error.code === "SANDBOX_SETUP_FAILED") {
				return { ok: false, reason: "RUN_FAILED", detail: boundedDetail(error.message) };
			}
			throw error;
		}
	};
}

/** The claude-code run port the OpenRouter and Fireworks paths share: the same sandbox, the provider's
 * proxy host, and the key in the provider's own variable, by name only. The key is read in-process. */
function claudeCodeRunPort(deps: SandboxRunDeps, provider: "openrouter" | "fireworks", missingKey: string): HouseRunPort {
	const env = deps.env ?? process.env;
	return async plan => {
		if (plan.runner === "command") return commandPlanRun(deps, plan);
		const key = await deps.getKey();
		if (key === null || key === "" || /[\r\n]/.test(key)) {
			return { ok: false, reason: "RUN_FAILED", detail: missingKey };
		}
		const built: RunnerPlan = {
			names: sandboxNames(plan.jobId), image: deps.image, proxyImage: deps.proxyImage, dir: plan.workDir,
			argv: agentArgv("claude-code", plan.instruction, null, provider), commandPath: null, runner: "claude-code",
			provider, providerKey: key, providerModel: plan.model, instruction: plan.instruction,
			jobId: plan.jobId, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null,
		};
		try {
			const output: string[] = [];
			const code = await runAgentInSandbox(built, deps.docker, chunk => output.push(chunk), childEnv(env));
			return classifyModelRun(code, output.join(""));
		} catch (error) {
			// A sandbox the daemon refused to build is not the provider's fault: no retry burns a call on it.
			if (error instanceof CliError && error.code === "SANDBOX_SETUP_FAILED") {
				return { ok: false, reason: "RUN_FAILED", detail: boundedDetail(error.message) };
			}
			throw error;
		}
	};
}

/** The OpenRouter run port: the same sandbox, with the OpenRouter proxy path the M3 prototype
 * proved. The key comes from the session keyring, in-process like every provider key. */
export function sandboxRunPort(deps: SandboxRunDeps): HouseRunPort {
	return claudeCodeRunPort(deps, "openrouter", "no usable OpenRouter key in the keyring");
}

/** The Fireworks run port: the same sandbox on the Fireworks Messages base, with the bounded argv
 * `agentArgv` builds for it. The key is FIREWORKS_API_KEY, read in-process and passed by name only. */
export function fireworksRunPort(deps: SandboxRunDeps): HouseRunPort {
	return claudeCodeRunPort(deps, "fireworks", "no usable Fireworks key in FIREWORKS_API_KEY");
}

/** The deployment's run port: the House provider picks Fireworks (its key from FIREWORKS_API_KEY), droid
 * (the ruled default, its key from the environment or the laptop key file), or the OpenRouter path (its
 * key from the session keyring). Every path runs inside the same sandbox; the command runner keeps its
 * lane mode under any of them. A3 and A1 reuse the product switch and droid client from `core/src/model.ts`. */
export type HouseRunPortDeps = {
	readonly docker: DockerPort;
	readonly image: string;
	readonly proxyImage: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Overrides for tests; the real wiring reads the Factory key source, the Fireworks key, and the session keyring. */
	readonly droidKey?: () => Promise<string | null>;
	readonly fireworksKey?: () => Promise<string | null>;
	readonly openrouterKey?: () => Promise<string | null>;
};

export function houseRunPort(deps: HouseRunPortDeps): HouseRunPort {
	const env = deps.env ?? process.env;
	const provider = houseProvider(env);
	if (provider === "fireworks") {
		return fireworksRunPort({ ...deps, getKey: deps.fireworksKey ?? (async () => llmKey("fireworks", env)), env });
	}
	if (provider === "droid") return droidRunPort({ ...deps, getKey: deps.droidKey ?? (() => factoryApiKey(env)), env });
	return sandboxRunPort({ ...deps, getKey: deps.openrouterKey ?? (async () => keyringKey()), env });
}

/** The OpenRouter key from the session keyring, the way the M3 prototype read it: one `keyctl`
 * search, one `keyctl pipe`. Null when the keyring has nothing under the House's description. */
export function keyringKey(description = "acquit-root:openrouter-key"): string | null {
	try {
		// A session keyring that is not linked into the user keyring hides the key from the search.
		spawnSync("keyctl", ["link", "@u", "@s"], { encoding: "utf8" });
		spawnSync("keyctl", ["link", "@s", "@u"], { encoding: "utf8" });
		const search = spawnSync("keyctl", ["search", "@u", "user", description], { encoding: "utf8" });
		if (search.status !== 0) return null;
		const id = search.stdout.trim();
		if (!/^\d+$/.test(id)) return null;
		const pipe = spawnSync("keyctl", ["pipe", id], { encoding: "buffer", maxBuffer: 1 << 20 });
		if (pipe.status !== 0) return null;
		const key = pipe.stdout.toString("utf8").trim();
		return key === "" || /[\r\n]/.test(key) ? null : key;
	} catch {
		return null;
	}
}

// ---- the work repo -----------------------------------------------------------------------------

export type GitWorkDeps = {
	readonly stateRoot: string;
	readonly workRoot: string;
	/** Mints the one scoped token this job's push uses, the same mint the CLI's submit path uses. */
	readonly mint: (job: HouseTarget) => Promise<{ readonly repository: string; readonly token: string }>;
	readonly git?: GitRun;
	readonly env?: NodeJS.ProcessEnv;
	/** The credential values a change is checked against before it is pushed. Defaults to the House's own keys. */
	readonly credentialValues?: () => Promise<readonly string[]>;
};

type PreparedCheckout = {
	readonly checkout: JobCheckout;
	readonly url: string;
	readonly gitEnv: NodeJS.ProcessEnv;
	readonly askpassEnv: NodeJS.ProcessEnv;
	/** The secret directory the askpass script lives in. It must outlive prepare: the push that
	 * reads the script runs in finalize, one model run later. Every exit path sweeps it. */
	readonly secret: { readonly path: string; readonly remove: () => void };
	/** The explicit git args every command on this checkout names: the state git directory and work tree. */
	readonly checkoutGitArgs: (env: NodeJS.ProcessEnv, args: readonly string[]) => readonly string[];
};

/** The plain diff text, bounded: a fix diff is small, and a runaway one is truncated, never lost. */
function boundedPatch(result: { status: number | null; stdout: string; stderr: string }): string {
	if (result.status !== 0) return "";
	return result.stdout.length > PATCH_CHARS_MAX ? `${result.stdout.slice(0, PATCH_CHARS_MAX)}\n... (truncated)` : result.stdout;
}

/** The shapes of the keys the House's providers issue, for a key the House does not hold: the agent can
 * hold one other than the configured key. A Fireworks key is the `fw_` prefix and one token of at least 20
 * letters and digits that has at least two digits and both cases, bounded by non-identifier characters. So a
 * snake_case identifier, a placeholder, a short token, a camelCase name with fewer than two digits, or one
 * with no digit at all never matches. A configured key is refused by its exact value (assertNoCredential),
 * whatever its shape. The exact length and charset of a Fireworks key are not documented: this shape is a
 * heuristic for keys the House does not hold, not a guarantee. */
const KEY_SHAPES: readonly RegExp[] = [
	/(?<![A-Za-z0-9_])fw_(?=(?:[A-Za-z0-9]*[0-9]){2})(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{20,}(?![A-Za-z0-9_])/,
	/sk-or-v1-[A-Za-z0-9]{16,}/,
];

/** The credential values this process holds: a copy of any of them in a change is a leak, whichever
 * provider the run used. Read in process, never logged. */
async function houseCredentialValues(env: NodeJS.ProcessEnv = process.env): Promise<readonly string[]> {
	const values = [llmKey("fireworks", env), await factoryApiKey(env), keyringKey()];
	return values.filter((value): value is string => typeof value === "string" && value !== "");
}

/** Reads the whole change the push would publish, untruncated, and refuses it when a credential appears in
 * it. A diff the check cannot read is refused too: an unreadable change is never assumed clean. */
function assertNoCredential(git: GitRun, session: PreparedCheckout, frozen: CommitSha, commit: CommitSha,
	values: readonly string[]): void {
	const diff = git(session.checkoutGitArgs(session.gitEnv, ["diff", "--no-color", "--text", frozen, commit]), session.gitEnv);
	if (diff.status !== 0) throw new ChangeRefusedError("the change could not be read for the credential check; nothing was submitted");
	const leaked = values.some(value => diff.stdout.includes(value)) || KEY_SHAPES.some(shape => shape.test(diff.stdout));
	if (leaked) throw new ChangeRefusedError("a credential appeared in the change; nothing was submitted");
}

/** The real work port: the CLI's clone-at-frozen-commit and commit-and-push, driven by a scoped
 * token minted per series. The checkout's git directory lives outside the work tree, exactly as the
 * CLI keeps it, so the sandbox can never read it. */
export function gitWorkPort(deps: GitWorkDeps): HouseWorkPort {
	const git = deps.git ?? gitCli();
	const env = deps.env ?? process.env;
	const credentialValues = deps.credentialValues ?? (() => houseCredentialValues(env));
	const sessions = new Map<JobId, PreparedCheckout>();
	return {
		async prepare(job) {
			const credential = await deps.mint(job);
			const url = workRepoUrl(credential.repository);
			const checkout: JobCheckout = { gitDir: join(deps.stateRoot, `${job.id}.git`), workTree: join(deps.workRoot, job.id) };
			const secret = makeSecretDir();
			try {
				const askpass = writeAskpass(secret.path, credential.token);
				// ProtectHome hides the home directory on a hardened deployment, so the git state root
				// falls back under this port's own state dir when the default under the home is unwritable.
				const gitEnv = hardenedGitEnv(withStateRootFallback(childEnv(env), deps.stateRoot));
				prepareWorkRepo(git, checkout, url, job.frozenAt, gitEnv, askpass.env);
				seedCommitIdentity(git, checkout, globalGitIdentity(git, stripGitEnv(env)), gitEnv);
				const checkoutGitArgs = (callEnv: NodeJS.ProcessEnv, args: readonly string[]) => locationGitArgs(checkout, callEnv, args);
				// A re-prepare replaces the session: sweep the replaced secret so no token file outlives
				// the checkout it scoped.
				sessions.get(job.id)?.secret.remove();
				sessions.set(job.id, { checkout, url, gitEnv, askpassEnv: askpass.env, secret, checkoutGitArgs });
				return { workDir: checkout.workTree };
			} catch (error) {
				secret.remove();
				throw error;
			}
		},
		async finalize(job) {
			const session = sessions.get(job.id);
			if (session === undefined) throw new CliError("GIT_FAILED", `no prepared checkout for ${job.id}`);
			// The secret dies with the series, on every path: the push has run (or failed) by the time
			// finalize returns, and remove() cleans up the paths that never reach here.
			try {
				const commit = submissionCommit(git, session.checkout, job.frozenAt, `Run ${job.id} with ${HOUSE_OPERATOR_ID}`, session.gitEnv);
				if (commit === null) return null;
				// The change is checked before anything leaves the checkout: a credential in it is refused,
				// so neither the push, nor the diff record, nor the submit ever sees it.
				assertNoCredential(git, session, job.frozenAt, commit, await credentialValues());
				pushWork(git, session.checkout, session.url, commit, session.gitEnv, session.askpassEnv);
				// The diff the timeline shows is read from the same checkout before it is cleaned up, so it
				// is exactly the submitted tree's diff against the frozen commit.
				const files = changedFiles(git, session.checkout, job.frozenAt, session.gitEnv, commit);
				const patch = boundedPatch(git(session.checkoutGitArgs(session.gitEnv, ["diff", "--no-color", job.frozenAt, commit]), session.gitEnv));
				return { commit, files, patch };
			} finally {
				session.secret.remove();
			}
		},
		remove(jobId) {
			sessions.get(jobId)?.secret.remove();
			sessions.delete(jobId);
			for (const path of [join(deps.workRoot, jobId), join(deps.stateRoot, `${jobId}.git`)]) {
				try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
			}
		},
	};
}
