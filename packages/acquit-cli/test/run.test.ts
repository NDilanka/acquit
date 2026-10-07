// `acquit run` renders docs/tutorial.md's blocks character for character, assembles a sandbox whose
// only route out is the allowlisting proxy, and never lets a token or a provider key reach argv.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommitSha, JobId, OperatorId } from "../../core/src/ids.ts";
import type { JobProjection } from "../../core/src/job.ts";
import { CliError } from "../src/client.ts";
import type { ApiClient } from "../src/client.ts";
import { runDiff } from "../src/diff.ts";
import { agentArgv, changedFiles, cleanupArgs, egressNetworkCreateArgs, ensureEmptyWorkTreeGitShadow, formatDuration, gitCli,
	globalGitIdentity, networkConnectArgs, networkCreateArgs, parseRunArgs, prepareWorkRepo, providerKeyFromEnv, proxyRunArgs, pushWork,
	renderFinished, renderPreparing, renderRunning, runAgentInSandbox, runnerRunArgs, runRun, sandboxNames, seedCommitIdentity, signalGuard,
	submissionCommit } from "../src/run.ts";
import type { DockerPort, GitRun, RunnerPlan, RunOptions, SandboxNames } from "../src/run.ts";
import { existingStateCheckout, hardenedGitEnv, recordedWorkTree, stateGitDir, gitGuardArgs, unsafeGitConfigKeys, writeWorkTreeMarker } from "../src/gitstate.ts";
import { makeSecretDir, secretGuard, writeAskpass } from "../src/workrepo.ts";

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
function fakeGit(answers: { numstat?: string; untracked?: string; head?: string } = {}): RecordingGit {
	const calls: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
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

const keyPort = (key: string | null) => ({ async getProviderKey() { return key; } });

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

test("the provider-key default reads ACQUIT_PROVIDER_KEY and answers null when it is absent", async () => {
	assert.equal(await providerKeyFromEnv({ ACQUIT_PROVIDER_KEY: keyCanary }).getProviderKey(), keyCanary);
	assert.equal(await providerKeyFromEnv({}).getProviderKey(), null);
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
		// Command-line config outranks any local config: hooks, fsmonitor, credentials, and ssh are all off.
		assert.deepEqual(gitGuardArgs({ XDG_STATE_HOME: root }), ["-c", `core.hooksPath=${join(root, "acquit", "hooks")}`,
			"-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.sshCommand="]);
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
		prepareWorkRepo(git, checkout, bare, frozen, process.env);
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
		prepareWorkRepo(git, checkout, bare, frozen, process.env);
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
		prepareWorkRepo(git, { gitDir: state, workTree: first }, bare, frozen, process.env);
		// While the recorded checkout lives, a different non-empty checkout is refused.
		const other = join(root, "other");
		mkdirSync(other);
		writeFileSync(join(other, "notes.txt"), "operator files\n");
		assert.throws(() => prepareWorkRepo(git, { gitDir: state, workTree: other }, bare, frozen, process.env),
			(error: CliError) => error.code === "DIR_NOT_WORK_REPO");
		// Once it is gone, an empty (or missing) --dir is adopted and the marker follows it.
		rmSync(first, { recursive: true, force: true });
		const fresh = join(root, "fresh");
		prepareWorkRepo(git, { gitDir: state, workTree: fresh }, bare, frozen, process.env);
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
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, process.env);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", process.env);
		assert.notEqual(commit, null);
		// A hook in the state gitdir never runs: core.hooksPath points at the CLI's empty directory.
		const canary = join(root, "hook-ran");
		mkdirSync(join(state, "hooks"), { recursive: true });
		writeFileSync(join(state, "hooks", "pre-push"), `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
		pushWork(git, checkout, bare, commit!, process.env);
		assert.equal(existsSync(canary), false);
		assert.equal(spawnSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/submissions/${commit}`]).status, 0);
		// A URL rewrite the CLI did not write refuses the push before git can read it.
		assert.equal(git(["--git-dir", state, "config", "--local", "url.https://evil.example/.insteadOf", bare]).status, 0);
		assert.throws(() => pushWork(git, checkout, bare, commit!, process.env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("url.https://evil.example/.insteadof"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a planted pushInsteadOf is refused, and the decoy it names never receives the push", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-pushinstead-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, process.env);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", process.env);
		assert.notEqual(commit, null);
		// A real rewrite to a real decoy: pushing to the bare path would land in the decoy instead.
		const decoy = join(root, "decoy.git");
		assert.equal(spawnSync("git", ["init", "--bare", "--quiet", decoy]).status, 0);
		assert.equal(git(["--git-dir", state, "config", "--local", `url.${decoy}.pushInsteadOf`, bare]).status, 0);
		assert.throws(() => pushWork(git, checkout, bare, commit!, process.env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("pushinsteadof"));
		assert.equal(spawnSync("git", ["--git-dir", decoy, "for-each-ref"], { encoding: "utf8" }).stdout.trim(), "");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a state gitdir remote URL off github is unsafe config; the clone's own origin and a github URL are not", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-remote-url-"));
	try {
		const { bare, frozen, git } = workRepoFixture(root);
		const state = stateGitDir("job_7Q2K", { XDG_STATE_HOME: join(root, "state-home") });
		const work = join(root, "work");
		const checkout = { gitDir: state, workTree: work };
		prepareWorkRepo(git, checkout, bare, frozen, process.env);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		const commit = submissionCommit(git, checkout, frozen, "fix", process.env);
		assert.notEqual(commit, null);
		// The clone's own origin is the fixture's local bare path: no host, so no host to steer to.
		assert.deepEqual(unsafeGitConfigKeys(git, state, process.env), []);
		// A remote the CLI did not write that names github.com is the shape the CLI itself writes.
		assert.equal(git(["--git-dir", state, "config", "--local", "remote.work.url", "https://github.com/acquit-forks/invoice-app-7q2k.git"]).status, 0);
		assert.deepEqual(unsafeGitConfigKeys(git, state, process.env), []);
		// Any other host could carry the scoped push somewhere the job's work repo is not.
		assert.equal(git(["--git-dir", state, "config", "--local", "remote.evil.url", "https://evil.example/invoice-app-7q2k.git"]).status, 0);
		assert.deepEqual(unsafeGitConfigKeys(git, state, process.env), ["remote.evil.url"]);
		assert.throws(() => pushWork(git, checkout, bare, commit!, process.env),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("remote.evil.url"));
	} finally { rmSync(root, { recursive: true, force: true }); }
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
	const proxy = proxyRunArgs(names.proxy, names.egress, "acquit/runner-node20");
	assert.deepEqual(proxy, ["run", "--detach", "--rm", "--name", names.proxy, "--network", names.egress, "--pull=never",
		"acquit/runner-node20", "node", "/runner/proxy.mjs"]);
	// The proxy never joins the default bridge, where unrelated containers could reach it.
	assert.equal(proxy.includes("bridge"), false);
	assert.deepEqual(cleanupArgs(names), [["rm", "--force", names.runner], ["rm", "--force", names.proxy],
		["network", "rm", names.network], ["network", "rm", names.egress]]);
});

test("the runner container gets the internal network, the proxy, and no secret in argv", () => {
	const names = sandboxNames("job_7Q2K");
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: "/tmp/acquit-run-work", argv: agentArgv("claude-code", "Fix the rounding.", null), commandPath: null,
		providerKey: keyCanary, instruction: "Fix the rounding.", jobId: "job_7Q2K", uid: 1002, gid: 1002 };
	const args = runnerRunArgs(plan);
	const proxy = `http://${names.proxy}:8888`;
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(args.includes(`${name}=${proxy}`), true, name);
	assert.equal(args.includes("NODE_USE_ENV_PROXY=1"), true);
	assert.equal(args.includes(names.network), true);
	assert.equal(args[args.indexOf("--network") + 1], names.network);
	assert.equal(args.includes("type=bind,source=/tmp/acquit-run-work,target=/work"), true);
	// The work tree is mounted, and an empty read-only tmpfs covers /work/.git: the agent never sees
	// the job's git directory even if something leaves a .git inside the work tree.
	const shadow = args.indexOf("--tmpfs");
	assert.equal(shadow > args.indexOf("--mount"), true, "the shadow must be mounted after the work tree");
	assert.equal(args[shadow + 1], "/work/.git:ro");
	assert.deepEqual(args.slice(args.indexOf("--exec")), ["--exec", "claude", "--print", "--dangerously-skip-permissions", "Fix the rounding."]);
	// The key is named, never valued, and never written to a file the container reads.
	assert.equal(args[args.indexOf("ANTHROPIC_API_KEY") - 1], "-e");
	assert.equal(args.includes("--env-file"), false);
	assert.equal(args.some(arg => arg.includes(keyCanary)), false);
	assert.equal(args.some(arg => arg.includes(tokenCanary)), false);
});

test("the command runner mounts its script read-only, runs it with sh, and names no provider key", () => {
	const names = sandboxNames("job_7Q2K");
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: "/tmp/acquit-run-work", argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: "/tmp/fix.sh",
		providerKey: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
	const args = runnerRunArgs(plan);
	assert.equal(args.includes("--env-file"), false);
	assert.equal(args.includes("ANTHROPIC_API_KEY"), false);
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
		providerKey: keyCanary, instruction: "Fix the rounding.", jobId: "job_7Q2K", uid: null, gid: null };
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
		providerKey: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
	assert.equal(await runAgentInSandbox(plan, docker), 0);
	const verbs = docker.calls.map(args => args.join(" "));
	assert.deepEqual(verbs, [
		`rm --force ${names.runner}`, `rm --force ${names.proxy}`, `network rm ${names.network}`, `network rm ${names.egress}`,
		`network create --internal ${names.network}`,
		`network create -o com.docker.network.bridge.enable_icc=false ${names.egress}`,
		`run --detach --rm --name ${names.proxy} --network ${names.egress} --pull=never acquit/runner-node20 node /runner/proxy.mjs`,
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
			assert.deepEqual(args.slice(args.indexOf("--tmpfs"), args.indexOf("--tmpfs") + 2), ["--tmpfs", "/work/.git:ro"]);
			assert.equal(lstatSync(join(work, ".git")).isDirectory(), true);
			assert.deepEqual(readdirSync(join(work, ".git")), []);
		} });
		const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
			dir: work, argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: null,
			providerKey: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
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
		providerKey: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
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
		providerKey: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
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
		await runRun(runOptions({ dir: work }), { client, providerKey: keyPort(keyCanary), docker, git: gitPort,
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
			assert.equal(call.env?.GIT_ASKPASS !== undefined, !identityRead);
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
		// The child git is real; only the work-repo URL the API names is redirected to the local bare repo.
		const gitPort: GitRun = (args, env) => {
			calls.push({ args: [...args], env });
			return git(args.map(arg => arg === github ? bare : arg), env);
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
		await runRun(runOptions({ dir: work, runner: "command", command }), { client: fakeClient({ job }), providerKey: keyPort(null),
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
		providerKey: keyPort(keyCanary), docker, git, print: () => {} }), (error: CliError) => error.code === "NOT_OWNER");
	assert.equal(docker.calls.length, 0);
	assert.equal(git.calls.length, 0);
});

test("claude-code without a provider key refuses by name and starts nothing", async () => {
	const docker = fakeDocker();
	const git = fakeGit();
	const client = fakeClient();
	await assert.rejects(runRun(runOptions({ dir: "/tmp" }), { client, providerKey: keyPort(null), docker, git, print: () => {} }),
		(error: CliError) => error.code === "PROVIDER_KEY_MISSING");
	assert.equal(docker.calls.length, 0);
	assert.equal(client.posts.length, 0);
});

test("a command runner whose script is missing refuses by name", async () => {
	const client = fakeClient();
	await assert.rejects(runRun(runOptions({ runner: "command", command: "/nonexistent/acquit-fix.sh" }),
		{ client, providerKey: keyPort(null), docker: fakeDocker(), git: fakeGit(), print: () => {} }),
		(error: CliError) => error.code === "COMMAND_MISSING");
	assert.equal(client.posts.length, 0);
});

test("run refuses an agent whose stored runner is not one this CLI runs", async () => {
	const job = jobView({ bids: { operators: [{ id: "bid_7Q2K", operator: "devon-ops" as OperatorId, handle: "devon-ops", label: "INDEPENDENT",
		price: 40000, eta: 48, agent: "ts-bugfixer", runner: "codex", pitch: "p", paidReceipts: 0, status: "ACCEPTED" }], house: null } });
	await assert.rejects(runRun(runOptions(), { client: fakeClient({ job }), providerKey: keyPort(null), docker: fakeDocker(), git: fakeGit(), print: () => {} }),
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
			// an empty read-only tmpfs covers /work/.git, and the real one stays in the state path.
			"if [ -z \"$(ls -A /work/.git 2>/dev/null)\" ]; then echo GITDIR_SHADOWED; else echo GITDIR_VISIBLE; ls -A /work/.git; fi",
			"touch /work/.git/planted 2>/dev/null && echo GITDIR_WRITABLE || echo GITDIR_READONLY",
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
			commandPath: script, providerKey: null, instruction: null, jobId: `smoke_${process.pid}`,
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
		// The sandbox sees an empty read-only shadow over the work tree's own .git, while the
		// checkout's git directory is outside the mount, in the state path.
		assert.match(text, /GITDIR_SHADOWED/);
		assert.match(text, /GITDIR_READONLY/);
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
			"if [ -z \"$(ls -A /work/.git 2>/dev/null)\" ]; then echo GITDIR_SHADOWED; else echo GITDIR_VISIBLE; ls -A /work/.git; fi",
			"touch /work/.git/planted 2>/dev/null && echo GITDIR_WRITABLE || echo GITDIR_READONLY",
			"",
		].join("\n"), { mode: 0o755 });
		const plantedOutput: string[] = [];
		const planted = await runAgentInSandbox({ ...plan, commandPath: plantedScript }, (await import("../src/run.ts")).dockerCli(),
			(chunk, stream) => plantedOutput.push(`${stream}: ${chunk}`));
		const plantedText = plantedOutput.join("");
		console.log(`[smoke] planted runner exit ${planted}\n${plantedText}`);
		assert.equal(planted, 0, plantedText);
		assert.match(plantedText, /ETCPASSWD_READABLE/);
		assert.match(plantedText, /GITDIR_SHADOWED/);
		assert.match(plantedText, /GITDIR_READONLY/);
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
