// The House's delivery runner: the series of steps one held House job walks from funded to
// submitted, with its own payee and its own receipts. One model per job -- the free tier model the
// mission ruled -- and one instruction: the CLI default plus the exact suffix from the mission.
// The runner is plain orchestration: every effect (the sandbox, git, the API submit) arrives as an
// injectable port, so the whole series is testable without Docker or a model call. The transport is
// the same OpenRouter path the M3 prototype proved: a claude-code sandbox whose proxy allows
// openrouter.ai alone.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../../acquit-cli/src/client.ts";
import { hardenedGitEnv, stripGitEnv, type JobCheckout } from "../../acquit-cli/src/gitstate.ts";
import { childEnv, makeSecretDir, workRepoUrl, writeAskpass } from "../../acquit-cli/src/workrepo.ts";
import {
	agentArgv, defaultInstruction, gitCli, globalGitIdentity, prepareWorkRepo, pushWork,
	runAgentInSandbox, sandboxNames, seedCommitIdentity, submissionCommit,
	type DockerPort, type GitRun, type RunnerPlan,
} from "../../acquit-cli/src/run.ts";
import type { CommitSha, JobId } from "../../core/src/ids.ts";
import type { JobRow, JobStatus } from "../../core/src/job.ts";
import { boundedDetail } from "../../core/src/verifier.ts";

/** The one model the House runs, per the mission's ruling: the free tier stays free. */
export const HOUSE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

/** The deployment's own House operator, the one the seed creates. */
export const HOUSE_OPERATOR_ID = "house-tsfix";

/** The exact suffix the mission ruled onto the CLI default instruction, byte for byte. */
export const HOUSE_INSTRUCTION_SUFFIX = "Fix the root cause, not only the example in the title. Identify the general rule the bug "
	+ "violates, find the standard or specification that defines it, and make the code correct for every case that rule covers, "
	+ "including cases the issue does not mention. Do not leave a case the rule defines on a guessed default. Do not edit tests.";

/** The instruction one House run gets: the CLI default instruction plus the ruled suffix. */
export function houseInstruction(defaultInstructionText: string): string {
	return `${defaultInstructionText} ${HOUSE_INSTRUCTION_SUFFIX}`;
}

// ---- the delivery series -----------------------------------------------------------------------

export type HouseRunPlan =
	| { readonly runner: "model"; readonly jobId: JobId; readonly workDir: string; readonly model: string; readonly instruction: string }
	| { readonly runner: "command"; readonly jobId: JobId; readonly workDir: string; readonly commandPath: string };

export type HouseRunOutcome = { readonly ok: true }
	| { readonly ok: false; readonly reason: "PROVIDER_ERROR" | "RUN_FAILED"; readonly detail: string };

export type HouseRunPort = (plan: HouseRunPlan) => Promise<HouseRunOutcome>;

export type HouseTarget = {
	readonly id: JobId;
	readonly title: string;
	/** The contract's repository, from which the work repo name is derived. */
	readonly repository: string;
	readonly frozenAt: CommitSha;
};

/** One job's delivery state, outside the job row: the House is the only writer and the API only
 * reads it to decide whether this tick should start another series. */
export type HouseDeliveryState = {
	/** Run calls ever made for this job, model calls on the model path and command runs on the command path. */
	readonly calls: number;
	readonly submittedCommit: CommitSha | null;
	readonly submitAttempts: number;
	readonly prepareFailures: number;
};

/** The work-repo side of one series: the clone at the frozen commit, and the commit-and-push that
 * produces the submission commit (null when the run left the checkout clean). */
export type HouseWorkPort = {
	readonly prepare: (job: HouseTarget) => Promise<{ readonly workDir: string }>;
	readonly finalize: (job: HouseTarget, workDir: string) => Promise<CommitSha | null>;
	readonly remove: (jobId: JobId) => void;
};

export type HouseDeliveryDeps = {
	/** The runner this deployment runs the House with: the ruled model, or the command runner for lanes. */
	readonly mode: { readonly runner: "model" } | { readonly runner: "command"; readonly commandPath: string };
	readonly run: HouseRunPort;
	readonly work: HouseWorkPort;
	readonly readState: (jobId: JobId) => Promise<HouseDeliveryState>;
	readonly writeState: (jobId: JobId, state: HouseDeliveryState) => Promise<void>;
	/** The same Submit edge every operator uses: push and Submit, which starts the verifier. */
	readonly submit: (jobId: JobId, commit: CommitSha) => Promise<void>;
	readonly log: (line: string) => void;
};

export type DeliveryOutcome = "SUBMITTED" | "RESUBMITTED" | "CALLS_SPENT" | "NO_SUBMISSION" | "FAILED";

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
			await deps.submit(job.id, state.submittedCommit);
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
		// The instruction is the CLI default plus the ruled suffix, and the model is the ruled one.
		const plan: HouseRunPlan = deps.mode.runner === "model"
			? { runner: "model", jobId: job.id, workDir: prepared.workDir, model: HOUSE_MODEL,
				instruction: houseInstruction(defaultInstruction({ title: job.title })) }
			: { runner: "command", jobId: job.id, workDir: prepared.workDir, commandPath: deps.mode.commandPath };

		let calls = state.calls + 1;
		await deps.writeState(job.id, { ...state, calls });
		let outcome = await deps.run(plan);
		// One retry, only on a provider error, only while the persisted cap allows it: a 429 on the
		// free tier is the same single retry, never a loop.
		if (outcome.ok === false && outcome.reason === "PROVIDER_ERROR" && calls < MAX_CALLS) {
			calls += 1;
			await deps.writeState(job.id, { ...state, calls });
			outcome = await deps.run(plan);
		}
		if (outcome.ok === false) {
			deps.log(`house: ${job.id} run failed: ${outcome.reason} ${boundedDetail(outcome.detail)}`);
			return "FAILED";
		}
		const commit = await deps.work.finalize(job, prepared.workDir);
		if (commit === null) {
			deps.log(`house: ${job.id} produced no changes to submit`);
			return "NO_SUBMISSION";
		}
		// The commit is persisted before the submit, so a crash mid-submit lands on the re-submit
		// path with the commit in hand instead of a spent budget and nothing to show.
		await deps.writeState(job.id, { ...state, calls, submittedCommit: commit, submitAttempts: state.submitAttempts + 1 });
		try {
			await deps.submit(job.id, commit);
		} catch (error) {
			deps.log(`house: ${job.id} submit did not land; the next tick resubmits (${boundedDetail(String(error))})`);
		}
		deps.log(`house: ${job.id} submitted ${commit.slice(0, 7)}`);
		return "SUBMITTED";
	} finally {
		deps.work.remove(job.id);
	}
}

export function freshState(): HouseDeliveryState {
	return { calls: 0, submittedCommit: null, submitAttempts: 0, prepareFailures: 0 };
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

const STATE_FILES_SAFE = /^[0-9a-fA-F-]{8,64}$/;

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

export function classifyModelRun(code: number | null, output: string): HouseRunOutcome {
	const result = parseClaudeResult(output);
	const errorStatus = typeof result?.api_error_status === "number" && result.api_error_status >= 400;
	if (result !== null && (result.is_error === true || errorStatus)) {
		const status = errorStatus ? ` ${result.api_error_status}` : "";
		return { ok: false, reason: "PROVIDER_ERROR", detail: `the model answered${status}` };
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

/** The real run port: the same sandbox the CLI runs, with the OpenRouter proxy path M3 proved.
 * The command runner keeps its lane mode: no key, no provider, one /bin/sh script. */
export function sandboxRunPort(deps: SandboxRunDeps): HouseRunPort {
	const env = deps.env ?? process.env;
	return async plan => {
		const names = sandboxNames(plan.jobId);
		if (plan.runner === "command") {
			const built: RunnerPlan = {
				names, image: deps.image, proxyImage: deps.proxyImage, dir: plan.workDir,
				argv: agentArgv("command", "", "/acquit/command.sh"), commandPath: plan.commandPath, runner: "command",
				provider: "anthropic", providerKey: null, providerModel: null, instruction: null, jobId: plan.jobId,
				uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null,
			};
			const code = await runAgentInSandbox(built, deps.docker);
			return code === 0 ? { ok: true }
				: { ok: false, reason: "RUN_FAILED", detail: `the command exited ${code ?? "without a status"}` };
		}
		const key = await deps.getKey();
		if (key === null || key === "" || /[\r\n]/.test(key)) {
			return { ok: false, reason: "RUN_FAILED", detail: "no usable OpenRouter key in the keyring" };
		}
		const built: RunnerPlan = {
			names, image: deps.image, proxyImage: deps.proxyImage, dir: plan.workDir,
			argv: agentArgv("claude-code", plan.instruction, null), commandPath: null, runner: "claude-code",
			provider: "openrouter", providerKey: key, providerModel: plan.model, instruction: plan.instruction,
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
};

type PreparedCheckout = {
	readonly checkout: JobCheckout;
	readonly url: string;
	readonly gitEnv: NodeJS.ProcessEnv;
	readonly askpassEnv: NodeJS.ProcessEnv;
};

/** The real work port: the CLI's clone-at-frozen-commit and commit-and-push, driven by a scoped
 * token minted per series. The checkout's git directory lives outside the work tree, exactly as the
 * CLI keeps it, so the sandbox can never read it. */
export function gitWorkPort(deps: GitWorkDeps): HouseWorkPort {
	const git = deps.git ?? gitCli();
	const env = deps.env ?? process.env;
	const sessions = new Map<JobId, PreparedCheckout>();
	return {
		async prepare(job) {
			const credential = await deps.mint(job);
			const url = workRepoUrl(credential.repository);
			const checkout: JobCheckout = { gitDir: join(deps.stateRoot, `${job.id}.git`), workTree: join(deps.workRoot, job.id) };
			const secret = makeSecretDir();
			try {
				const askpass = writeAskpass(secret.path, credential.token);
				const gitEnv = hardenedGitEnv(childEnv(env));
				prepareWorkRepo(git, checkout, url, job.frozenAt, gitEnv, askpass.env);
				seedCommitIdentity(git, checkout, globalGitIdentity(git, stripGitEnv(env)), gitEnv);
				sessions.set(job.id, { checkout, url, gitEnv, askpassEnv: askpass.env });
				return { workDir: checkout.workTree };
			} finally {
				secret.remove();
			}
		},
		async finalize(job) {
			const session = sessions.get(job.id);
			if (session === undefined) throw new CliError("GIT_FAILED", `no prepared checkout for ${job.id}`);
			const commit = submissionCommit(git, session.checkout, job.frozenAt, `Run ${job.id} with ${HOUSE_OPERATOR_ID}`, session.gitEnv);
			if (commit !== null) pushWork(git, session.checkout, session.url, commit, session.gitEnv, session.askpassEnv);
			return commit;
		},
		remove(jobId) {
			sessions.delete(jobId);
			for (const path of [join(deps.workRoot, jobId), join(deps.stateRoot, `${jobId}.git`)]) {
				try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
			}
		},
	};
}
