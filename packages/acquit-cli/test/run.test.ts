// `acquit run` renders docs/tutorial.md's blocks character for character, assembles a sandbox whose
// only route out is the allowlisting proxy, and never lets a token or a provider key reach argv.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommitSha, JobId, OperatorId } from "../../core/src/ids.ts";
import type { JobProjection } from "../../core/src/job.ts";
import { CliError } from "../src/client.ts";
import type { ApiClient } from "../src/client.ts";
import { agentArgv, changedFiles, cleanupArgs, egressNetworkCreateArgs, formatDuration, gitCli, networkConnectArgs,
	networkCreateArgs, parseRunArgs, prepareWorkRepo, providerKeyFromEnv, proxyRunArgs, renderFinished, renderPreparing, renderRunning,
	runAgentInSandbox, runnerRunArgs, runRun, sandboxNames, signalGuard, submissionCommit } from "../src/run.ts";
import type { DockerPort, GitRun, RunnerPlan, RunOptions, SandboxNames } from "../src/run.ts";
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

/** A git port that answers the handful of read commands run.ts makes and records every call. */
function fakeGit(answers: { numstat?: string; untracked?: string; head?: string } = {}): RecordingGit {
	const calls: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
	const run: GitRun = (args, env) => {
		calls.push({ args: [...args], env });
		const line = args.join(" ");
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
	codeOn?: (args: readonly string[]) => number | null | undefined; output?: string } = {}): RecordingDocker {
	const calls: string[][] = [];
	const envs: (NodeJS.ProcessEnv | undefined)[] = [];
	const run: DockerPort["run"] = async (args, runOptions) => {
		calls.push([...args]);
		envs.push(runOptions?.env);
		if (options.failOn?.(args) === true) throw new CliError("DOCKER_UNAVAILABLE", "docker could not start");
		const forced = options.codeOn?.(args);
		if (forced !== undefined) {
			if (options.output !== undefined) runOptions?.onOutput?.(options.output, "stderr");
			return forced;
		}
		return args[0] === "run" && !args.includes("--detach") ? options.code ?? 0 : 0;
	};
	return { run, calls, envs };
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
		assert.deepEqual(changedFiles(git, root, base), [
			{ path: "src/new.ts", added: 2, binary: false },
			{ path: "tests/totals.test.ts", added: 1, binary: false },
		]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dirty directory that is not the work repo is refused by name", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-dir-"));
	try {
		writeFileSync(join(root, "notes.txt"), "not a repository\n");
		assert.throws(() => prepareWorkRepo(gitCli(), root, "https://github.com/acquit-forks/invoice-app-7Q2K.git", frozen, process.env),
			(error: CliError) => error.code === "DIR_NOT_EMPTY");
		const repo = join(root, "other");
		mkdirSync(repo);
		const git = gitCli();
		assert.equal(git(["-C", repo, "init", "--quiet"]).status, 0);
		assert.equal(git(["-C", repo, "remote", "add", "origin", "https://github.com/someone/other.git"]).status, 0);
		assert.throws(() => prepareWorkRepo(git, repo, "https://github.com/acquit-forks/invoice-app-7Q2K.git", frozen, process.env),
			(error: CliError) => error.code === "DIR_NOT_WORK_REPO");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparing a matching clone fetches the frozen commit and resets the tree", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-prepare-"));
	try {
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
		const frozenCommit = at(seed, ["rev-parse", "HEAD"]);
		at(seed, ["push", "--quiet", bare, `HEAD:refs/heads/main`]);
		const clone = join(root, "clone");
		assert.equal(spawnSync("git", ["clone", "--quiet", bare, clone]).status, 0);
		writeFileSync(join(clone, "money.ts"), "const DECIMALS = 3;\n");
		writeFileSync(join(clone, "junk.txt"), "untracked\n");
		prepareWorkRepo(git, clone, bare, frozenCommit as CommitSha, process.env);
		assert.equal(at(clone, ["rev-parse", "HEAD"]), frozenCommit);
		assert.equal(existsSync(join(clone, "junk.txt")), false);
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

test("the provider key rides only in the docker child's environment, never argv or a file", async () => {
	const names = sandboxNames("job_7Q2K");
	const docker = fakeDocker();
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: "/tmp/acquit-run-work", argv: agentArgv("claude-code", "Fix the rounding.", null), commandPath: null,
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

test("the askpass script holds no token and the token file is 0600 and removed with its directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-run-askpass-"));
	try {
		const askpass = writeAskpass(dir, tokenCanary);
		assert.equal(statSync(askpass.tokenFile).mode & 0o777, 0o600);
		assert.equal(statSync(askpass.script).mode & 0o777, 0o700);
		assert.equal(readFileSync(askpass.tokenFile, "utf8"), `${tokenCanary}\n`);
		assert.equal(readFileSync(askpass.script, "utf8").includes(tokenCanary), false);
		assert.equal(Object.values(askpass.env).some(value => String(value).includes(tokenCanary)), false);
		assert.equal(askpass.env.GIT_ASKPASS, askpass.script);
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

test("the sandbox creates its egress network, starts the proxy on it, and removes every object", async () => {
	const docker = fakeDocker();
	const names = sandboxNames("job_7Q2K");
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: "/tmp/acquit-run-work", argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: "/tmp/fix.sh",
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

test("a failed runner start still removes the containers and both networks", async () => {
	const names = sandboxNames("job_7Q2K");
	const docker = fakeDocker({ failOn: args => args[0] === "run" && args.includes("--rm") });
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: "/tmp/acquit-run-work", argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: "/tmp/fix.sh",
		providerKey: null, instruction: null, jobId: "job_7Q2K", uid: null, gid: null };
	await assert.rejects(runAgentInSandbox(plan, docker), (error: CliError) => error.code === "DOCKER_UNAVAILABLE");
	const verbs = docker.calls.map(args => args.join(" "));
	assert.equal(verbs.at(-4), `rm --force ${names.runner}`);
	assert.equal(verbs.at(-3), `rm --force ${names.proxy}`);
	assert.equal(verbs.at(-2), `network rm ${names.network}`);
	assert.equal(verbs.at(-1), `network rm ${names.egress}`);
});

test("a failed sandbox setup refuses by name, bounds the docker output, and still cleans up", async () => {
	const names = sandboxNames("job_7Q2K");
	const docker = fakeDocker({ codeOn: args => args[0] === "network" && args[1] === "create" ? 125 : undefined,
		output: `Error response from daemon: pull access denied for ${tokenCanary}@example.invalid/runner\n`.repeat(20) });
	const plan: RunnerPlan = { names, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		dir: "/tmp/acquit-run-work", argv: agentArgv("command", "ignored", "/acquit/command.sh"), commandPath: "/tmp/fix.sh",
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
	try {
		const git = fakeGit({ numstat: "1\t0\ttests/totals.test.ts\0", head: "c".repeat(40) });
		const docker = fakeDocker();
		const printed: string[] = [];
		const client = fakeClient();
		const times = [0, 308_000];
		let tokenFileSeen: string | null = null;
		let tokenFileMode = 0;
		const gitPort: GitRun = (args, env) => {
			if (args[0] === "clone" && env?.ACQUIT_RUN_TOKEN_FILE !== undefined) {
				tokenFileSeen = readFileSync(env.ACQUIT_RUN_TOKEN_FILE, "utf8").trim();
				tokenFileMode = statSync(env.ACQUIT_RUN_TOKEN_FILE).mode & 0o777;
			}
			return git(args, env);
		};
		await runRun(runOptions({ dir: work }), { client, providerKey: keyPort(keyCanary), docker, git: gitPort,
			print: line => printed.push(line), now: () => times.shift() ?? 308_000,
			env: { PATH: process.env.PATH, ACQUIT_TOKEN: "session-canary", ACQUIT_PROVIDER_KEY: keyCanary } });
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
		const gitLines = git.calls.map(call => call.args.join(" "));
		assert.equal(gitLines.some(line => line.includes("push") && line.includes("refs/heads/submissions/")), true, gitLines.join(" | "));
		// What is counted is the commit that was pushed, not the working tree that was left behind.
		const head = "c".repeat(40);
		assert.equal(gitLines.some(line => line.includes("diff --numstat") && line.includes(head)), true, gitLines.join(" | "));
		// Neither the session token nor the provider key rides in a git or setup child's environment.
		for (const call of git.calls) {
			assert.equal(call.env?.ACQUIT_TOKEN, undefined);
			assert.equal(call.env?.ACQUIT_PROVIDER_KEY, undefined);
			assert.equal(call.env?.ANTHROPIC_API_KEY, undefined);
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
	} finally { rmSync(work, { recursive: true, force: true }); }
});

test("the submission folds uncommitted work onto the agent's own commit", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-run-submission-"));
	try {
		const git = gitCli();
		const at = (args: readonly string[]) => {
			const result = git(["-C", root, ...args]);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		at(["init", "--quiet"]);
		at(["config", "user.email", "fixture@example.invalid"]);
		at(["config", "user.name", "fixture"]);
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		at(["add", "-A"]);
		at(["commit", "--quiet", "-m", "frozen"]);
		const frozen = at(["rev-parse", "HEAD"]) as CommitSha;
		// The agent commits one file and leaves another uncommitted: both must reach the pushed commit.
		writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
		at(["add", "-A"]);
		at(["commit", "--quiet", "-m", "agent"]);
		writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
		const pushed = submissionCommit(git, root, frozen, "Run job_7Q2K with ts-bugfixer", process.env);
		assert.notEqual(pushed, null);
		assert.notEqual(pushed, frozen);
		// The pushed commit's tree carries both the agent's own commit and the file it left uncommitted.
		assert.deepEqual(at(["ls-tree", "-r", "--name-only", pushed as string]).split("\n").sort(), ["a.ts", "b.ts"]);
		assert.deepEqual(changedFiles(git, root, frozen, pushed as string), [
			{ path: "a.ts", added: 1, binary: false },
			{ path: "b.ts", added: 1, binary: false },
		]);
		assert.equal(at(["status", "--porcelain"]), "");
		// Nothing changed since the fold, so the same commit is what a second run pushes; a checkout
		// left on the frozen commit has nothing to push at all.
		assert.equal(submissionCommit(git, root, frozen, "again", process.env), pushed);
		at(["reset", "--hard", "--quiet", frozen]);
		assert.equal(submissionCommit(git, root, frozen, "again", process.env), null);
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

test("live docker smoke: example.com is refused, registry.npmjs.org succeeds, and the edit is counted",
	{ skip: process.env.ACQUIT_DOCKER_TEST !== "1" }, async () => {
	const image = process.env.ACQUIT_RUNNER_IMAGE ?? "acquit/runner-node20";
	const probe = spawnSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 30_000 });
	assert.equal(probe.status, 0, `Build the runner image first: docker build -t ${image} packages/runner`);
	const root = mkdtempSync(join(tmpdir(), "acquit-run-smoke-"));
	const script = join(tmpdir(), `acquit-smoke-${process.pid}.sh`);
	try {
		const git = gitCli();
		const at = (args: readonly string[]) => {
			const result = git(["-C", root, ...args]);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		at(["init", "--quiet"]);
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
		assert.deepEqual(changedFiles(git, root, base), [{ path: "tests/totals.test.ts", added: 1, binary: false }]);
		// The run's own cleanup leaves no container or network behind.
		const containers = spawnSync("docker", ["ps", "-a", "--filter", `name=${names.runner}`, "--format", "{{.Names}}"], { encoding: "utf8" });
		const networks = spawnSync("docker", ["network", "ls", "--filter", `name=${names.runner}`, "--format", "{{.Name}}"], { encoding: "utf8" });
		assert.equal(containers.stdout.trim(), "", containers.stdout);
		assert.equal(networks.stdout.trim(), "", networks.stdout);
	} finally {
		rmSync(script, { force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
