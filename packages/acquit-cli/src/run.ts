// `acquit run <job> [--instruction "..."] [--runner claude-code|command] [--command <script>]`.
//
// One delivery attempt, as the operator: ask the API for a work-repo credential, clone the job's
// fork, run the agent inside a container whose only route out is an allowlisting proxy, commit what
// the agent changed, and push that commit to the work repo the way `acquit submit` expects.
//
// Secrets: the session token comes from the environment or stdin; the work-repo token lives in a
// 0600 file read by a constant 0700 askpass script in a mkdtemp directory removed on every exit; the
// provider key travels to the container only in a 0600 env file. No secret is ever an argv word, a
// printed line, or a log line.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommitSha } from "../../core/src/ids.ts";
import type { JobProjection } from "../../core/src/job.ts";
import { boundedDetail } from "../../core/src/verifier.ts";
import { CliError, resolveToken } from "./client.ts";
import type { ApiClient } from "./client.ts";
import { pushError, submissionRef } from "./submit.ts";

/** The image the tutorial names. The sandbox is the image plus the internal network and the proxy. */
export const DEFAULT_RUNNER_IMAGE = "acquit/runner-node20";
/** The one port the proxy listens on inside the sandbox network. */
const PROXY_PORT = 8888;

export type RunnerKind = "claude-code" | "command";

export type RunOptions = {
	readonly jobId: string;
	/** The clone to run in. Null selects `./<work repo name>` under the working directory. */
	readonly dir: string | null;
	readonly apiUrl: string;
	readonly token: string;
	readonly instruction: string | null;
	/** Null takes the accepted bid's stored runner. */
	readonly runner: RunnerKind | null;
	readonly command: string | null;
	readonly image: string;
	readonly proxyImage: string;
};

function readTokenFromStdin(): string {
	try { return readFileSync(0, "utf8"); } catch { return ""; }
}

export function parseRunArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env,
	readStdin: () => string = readTokenFromStdin): RunOptions {
	let jobId: string | null = null;
	let dir: string | null = null;
	let apiUrl = env.ACQUIT_API ?? "http://127.0.0.1:4310";
	let instruction: string | null = null;
	let runner: RunnerKind | null = null;
	let command: string | null = null;
	let tokenOnStdin = false;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new CliError("USAGE", `${flag} needs a value.`);
			return next;
		};
		if (flag === "--instruction") instruction = value();
		else if (flag === "--runner") {
			const selected = value();
			if (selected !== "claude-code" && selected !== "command") {
				throw new CliError("USAGE", `--runner takes claude-code or command, not ${selected}.`);
			}
			runner = selected;
		}
		else if (flag === "--command") command = value();
		else if (flag === "--dir") dir = value();
		else if (flag === "--api") apiUrl = value();
		else if (flag === "--token") {
			// A token on the command line is readable from the process table for the life of the
			// command. The value is never echoed: it is not a token this process will use.
			if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
				throw new CliError("TOKEN_ON_ARGV", "The session token is visible to every user who can read the process table. "
					+ "Pipe it to `acquit run <job> --token` or set ACQUIT_TOKEN.");
			}
			tokenOnStdin = true;
		}
		else if (flag.startsWith("--")) throw new CliError("USAGE", `Unknown flag ${flag}.`);
		else if (jobId === null) jobId = flag;
		else throw new CliError("USAGE", `Unexpected argument ${flag}.`);
	}
	if (jobId === null) {
		throw new CliError("USAGE", "Usage: acquit run <job> [--instruction \"...\"] [--runner claude-code|command] "
			+ "[--command <script>] [--dir <path>] [--api <url>] [--token]");
	}
	if (runner === "claude-code" && command !== null) throw new CliError("USAGE", "--command runs the command runner; drop --runner claude-code or the flag.");
	if (runner === "command" && command === null) throw new CliError("USAGE", "--runner command needs --command <script>.");
	if (command !== null && runner === null) runner = "command";
	const image = env.ACQUIT_RUNNER_IMAGE?.trim() || DEFAULT_RUNNER_IMAGE;
	return { jobId, dir, apiUrl, token: resolveToken(tokenOnStdin ? readStdin().trim() || undefined : undefined, env),
		instruction, runner, command, image, proxyImage: env.ACQUIT_RUNNER_PROXY_IMAGE?.trim() || image };
}

// ---- the provider-key seam --------------------------------------------------------------------

/**
 * The key seam the CLI injects. The root wires the OS keychain here when the branches combine; the
 * env default is the unit-test and development path, so a run never reaches for a file on its own.
 */
export interface ProviderKeyPort {
	getProviderKey(): Promise<string | null>;
}

export function providerKeyFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderKeyPort {
	return { async getProviderKey() { return env.ACQUIT_PROVIDER_KEY?.trim() || null; } };
}

// ---- output rendering -------------------------------------------------------------------------

export type RunStart = {
	readonly jobId: string;
	readonly workRepo: string;
	readonly image: string;
	readonly frozenAt: CommitSha;
	/** A re-run resets the fork to the frozen commit, and the tutorial's block says so. */
	readonly reset: boolean;
};

/** The block docs/tutorial.md prints before the agent starts. A fresh run names the scoped token and
 * the container's network; a re-run names the reset the fork gets instead. */
export function renderPreparing(start: RunStart): string {
	const lines = [`Preparing sandbox for ${start.jobId}`];
	lines.push(start.reset
		? `\tFork: ${start.workRepo} (reset to frozen commit ${start.frozenAt.slice(0, 7)})`
		: `\tFork: ${start.workRepo} (scoped token, expires with the job)`);
	if (!start.reset) lines.push(`\tContainer: ${start.image} (network: package registry and your model provider only)`);
	return lines.join("\n");
}

export function renderRunning(agent: string, runner: RunnerKind, command: string | null): string {
	return runner === "claude-code"
		? `Running ${agent} with your Anthropic key`
		: `Running ${agent} with the command runner: ${command ?? ""}`;
}

export type ChangedFile = { readonly path: string; readonly added: number; readonly binary: boolean };

/** The block docs/tutorial.md prints when the agent is done, one line per changed file. */
export function renderFinished(files: readonly ChangedFile[], durationMs: number, jobId: string): string {
	const lines = [`Agent finished in ${formatDuration(durationMs)}`];
	if (files.length === 0) lines.push("\tChanged files: none");
	else for (const file of files) lines.push(`\tChanged files: ${file.path} (${file.binary ? "binary" : file.added === 1 ? "1 line" : `${file.added} lines`})`);
	lines.push(`\tReview the diff: acquit diff ${jobId}`);
	return lines.join("\n");
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// ---- git --------------------------------------------------------------------------------------

export type GitResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };
export type GitRun = (args: readonly string[], env?: NodeJS.ProcessEnv) => GitResult;

export function gitCli(): GitRun {
	return (args, env) => {
		const result = spawnSync("git", [...args], { encoding: "utf8", timeout: 300_000, env: env ?? process.env });
		return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
}

function runGit(git: GitRun, args: readonly string[], env?: NodeJS.ProcessEnv): GitResult {
	const result = git(args, env);
	if (result.status !== 0) throw new CliError("GIT_FAILED", `git ${args.find(arg => !arg.startsWith("-")) ?? ""} failed. ${safeEcho(result.stderr)}`.trim());
	return result;
}

function safeEcho(text: string): string {
	return boundedDetail(text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s]*@/g, "$1").trim());
}

/** The environment a child gets: the operator's, minus the two secrets this CLI itself holds. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child = { ...env };
	delete child.ACQUIT_TOKEN;
	delete child.ACQUIT_PROVIDER_KEY;
	return child;
}

/** The refusal a clone or fetch of a work repo funding has not created yet produces. */
export function cloneError(url: string, stderr: string | null): CliError {
	const detail = safeEcho((stderr ?? "").trim().split("\n").slice(-3).join(" "));
	if (/Repository not found/i.test(detail)) {
		return new CliError("WORK_REPO_NOT_READY", `The work repository ${safeEcho(url)} is not visible. It is created shortly after funding, `
			+ "so rerun this command in about 30 seconds.");
	}
	return new CliError("CLONE_FAILED", `git clone of ${safeEcho(url)} failed. ${detail}`.trim());
}

/** One remote spelling per repository, so a clone the operator already has is recognized. */
function sameRemote(left: string, right: string): boolean {
	const normalize = (value: string) => value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
	return normalize(left) === normalize(right);
}

/**
 * Puts `dir` on the frozen commit with a clean working tree. A fresh path is cloned; an existing
 * work tree must already track the work repo, so a run can never reset an unrelated checkout.
 */
export function prepareWorkRepo(git: GitRun, dir: string, url: string, frozen: CommitSha, env: NodeJS.ProcessEnv): void {
	const missing = !existsSync(dir);
	if (missing || readdirSync(dir).length === 0) {
		const cloned = git(["clone", "--quiet", url, dir], env);
		if (cloned.status !== 0) throw cloneError(url, cloned.stderr);
	} else {
		const inside = git(["-C", dir, "rev-parse", "--is-inside-work-tree"], env);
		if (inside.status !== 0 || inside.stdout.trim() !== "true") {
			throw new CliError("DIR_NOT_EMPTY", `${dir} is not empty and is not a git work tree. `
				+ "Pass --dir with an empty path, or with a clone of the job's work repo.");
		}
		const origin = git(["-C", dir, "remote", "get-url", "origin"], env).stdout.trim();
		if (!sameRemote(origin, url)) {
			throw new CliError("DIR_NOT_WORK_REPO", `${dir} tracks ${safeEcho(origin || "(no origin)")}, not ${safeEcho(url)}. `
				+ "Pass --dir with a clone of the job's work repo.");
		}
		const fetched = git(["-C", dir, "fetch", "--quiet", "--no-tags", "origin"], env);
		if (fetched.status !== 0) throw cloneError(url, fetched.stderr);
	}
	if (git(["-C", dir, "cat-file", "-e", `${frozen}^{commit}`], env).status !== 0) {
		throw new CliError("FROZEN_COMMIT_MISSING", `The work repo does not carry the frozen commit ${frozen.slice(0, 7)}. `
			+ "Rerun in about 30 seconds after funding creates it.");
	}
	const checkedOut = git(["-C", dir, "checkout", "--force", "--quiet", frozen], env);
	if (checkedOut.status !== 0) throw new CliError("GIT_FAILED", `git checkout of the frozen commit failed. ${safeEcho(checkedOut.stderr)}`.trim());
	const cleaned = git(["-C", dir, "clean", "-fdq"], env);
	if (cleaned.status !== 0) throw new CliError("GIT_FAILED", `git clean failed. ${safeEcho(cleaned.stderr)}`.trim());
}

/** Added lines per changed path against the frozen commit, untracked files included. */
export function changedFiles(git: GitRun, dir: string, frozen: CommitSha): readonly ChangedFile[] {
	const files = new Map<string, ChangedFile>();
	const tracked = runGit(git, ["-C", dir, "diff", "--numstat", "--no-renames", "-z", frozen, "--"]);
	for (const record of tracked.stdout.split("\0")) {
		if (record === "") continue;
		const [added, deleted, ...rest] = record.split("\t");
		const path = rest.join("\t");
		if (!path) continue;
		const binary = added === "-" || deleted === "-";
		files.set(path, { path, added: binary ? 0 : Number(added) || 0, binary });
	}
	const untracked = runGit(git, ["-C", dir, "ls-files", "--others", "--exclude-standard", "-z"]);
	for (const path of untracked.stdout.split("\0")) {
		if (path === "") continue;
		const counted = countLines(readFileSync(join(dir, path)));
		files.set(path, { path, ...counted });
	}
	return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function countLines(buffer: Buffer): { added: number; binary: boolean } {
	if (buffer.includes(0)) return { added: 0, binary: true };
	const text = buffer.toString("utf8");
	if (text === "") return { added: 0, binary: false };
	const lines = text.split("\n");
	return { added: lines.length - (lines.at(-1) === "" ? 1 : 0), binary: false };
}

export function headOf(git: GitRun, dir: string, env: NodeJS.ProcessEnv): CommitSha {
	const head = runGit(git, ["-C", dir, "rev-parse", "HEAD"], env).stdout.trim();
	if (!/^[0-9a-f]{7,64}$/.test(head)) throw new CliError("GIT_FAILED", `git rev-parse HEAD answered ${head || "(nothing)"}.`);
	return head as CommitSha;
}

/** Commits the agent's tree with the operator's identity when one is configured, and a runner
 * identity otherwise, so a machine with no git user still produces the commit submit needs. */
export function commitWork(git: GitRun, dir: string, message: string, env: NodeJS.ProcessEnv): CommitSha {
	runGit(git, ["-C", dir, "add", "-A"], env);
	const configured = git(["-C", dir, "config", "user.email"], env).stdout.trim();
	const args = ["-C", dir];
	if (configured === "") args.push("-c", "user.name=acquit-runner", "-c", "user.email=runner@acquit.local");
	args.push("commit", "--quiet", "-m", message);
	const committed = git(args, env);
	if (committed.status !== 0) throw new CliError("COMMIT_FAILED", `git commit failed. ${safeEcho(committed.stderr)}`.trim());
	return headOf(git, dir, env);
}

/** The ref `acquit submit` pushes to: one commit-named ref, so the two commands can only agree. */
export function pushWork(git: GitRun, dir: string, url: string, commit: CommitSha, env: NodeJS.ProcessEnv): void {
	const pushed = git(["-C", dir, "push", "--quiet", url, `${commit}:${submissionRef(commit)}`], env);
	if (pushed.status !== 0) throw pushError(url, pushed.stderr);
}

// ---- the credential files ---------------------------------------------------------------------

/** A mkdtemp directory that holds the two secret files for one run and is removed on every exit. */
export function makeSecretDir(): { readonly path: string; readonly remove: () => void } {
	const path = mkdtempSync(join(tmpdir(), "acquit-run-"));
	return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

const ASKPASS_SCRIPT = `#!/bin/sh
# The token is read from the 0600 file the environment names; this script holds no secret.
case "$1" in
	*[Uu]sername*) printf '%s\\n' x-access-token ;;
	*) cat "$ACQUIT_RUN_TOKEN_FILE" ;;
esac
`;

/** The git credential for one run: a constant 0700 askpass script plus the 0600 token file it reads. */
export function writeAskpass(dir: string, token: string): { readonly env: NodeJS.ProcessEnv; readonly script: string; readonly tokenFile: string } {
	const tokenFile = join(dir, "token");
	const script = join(dir, "askpass.sh");
	writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
	chmodSync(tokenFile, 0o600);
	writeFileSync(script, ASKPASS_SCRIPT, { mode: 0o700 });
	chmodSync(script, 0o700);
	return { tokenFile, script, env: { ACQUIT_RUN_TOKEN_FILE: tokenFile, GIT_ASKPASS: script,
		GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } };
}

/** The provider key as a 0600 env file, the only shape it takes on disk and the only way it enters
 * the container. The value never becomes an argv word. */
export function writeProviderEnvFile(dir: string, key: string): string {
	const path = join(dir, "provider.env");
	writeFileSync(path, `ANTHROPIC_API_KEY=${key}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

// ---- the sandbox ------------------------------------------------------------------------------

export type DockerRunOptions = {
	readonly env?: NodeJS.ProcessEnv;
	readonly onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
};
export type DockerPort = { run(args: readonly string[], options?: DockerRunOptions): Promise<number | null> };

export function dockerCli(): DockerPort {
	return {
		run(args, options = {}) {
			return new Promise<number | null>((resolveRun, rejectRun) => {
				const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"], env: options.env });
				child.stdout?.on("data", (chunk: Buffer) => options.onOutput?.(chunk.toString("utf8"), "stdout"));
				child.stderr?.on("data", (chunk: Buffer) => options.onOutput?.(chunk.toString("utf8"), "stderr"));
				child.once("error", (error: Error) => rejectRun(new CliError("DOCKER_UNAVAILABLE", `docker could not start: ${error.message}`)));
				child.once("close", (code: number | null) => resolveRun(code));
			});
		},
	};
}

export type SandboxNames = { readonly runner: string; readonly proxy: string; readonly network: string };

/** Every object this run makes carries the job in its name, so nothing is left running unnamed. */
export function sandboxNames(jobId: string): SandboxNames {
	const base = `acquit-runner-${jobId}`;
	return { runner: base, proxy: `${base}-proxy`, network: `${base}-net` };
}

export function networkCreateArgs(network: string): readonly string[] {
	return ["network", "create", "--internal", network];
}

/** The proxy is the one container with a route out: the default bridge, plus the internal network. */
export function proxyRunArgs(proxy: string, network: string, image: string): readonly string[] {
	return ["run", "--detach", "--rm", "--name", proxy, "--network", "bridge", "--pull=never", image, "node", "/runner/proxy.mjs"];
}

export function networkConnectArgs(network: string, proxy: string): readonly string[] {
	return ["network", "connect", network, proxy];
}

export type RunnerPlan = {
	readonly names: SandboxNames;
	readonly image: string;
	readonly proxyImage: string;
	readonly dir: string;
	/** The agent command, executed by /runner/run.mjs inside the container. */
	readonly argv: readonly string[];
	readonly commandPath: string | null;
	readonly providerEnvFile: string | null;
	readonly instruction: string | null;
	readonly jobId: string;
	readonly uid: number | null;
	readonly gid: number | null;
};

/** The runner container: the internal network only, the proxy in its environment, the key in a file. */
export function runnerRunArgs(plan: RunnerPlan): readonly string[] {
	mountSafe("work tree", plan.dir);
	if (plan.commandPath !== null) mountSafe("command script", plan.commandPath);
	const proxy = `http://${plan.names.proxy}:${PROXY_PORT}`;
	const args = ["run", "--rm", "--name", plan.names.runner, "--network", plan.names.network, "--pull=never"];
	if (plan.uid !== null && plan.gid !== null) args.push("--user", `${plan.uid}:${plan.gid}`);
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) args.push("-e", `${name}=${proxy}`);
	// Node 24's global fetch honors the proxy variables only when this is set.
	args.push("-e", "NODE_USE_ENV_PROXY=1", "-e", "HOME=/tmp", "-e", `ACQUIT_JOB=${plan.jobId}`);
	if (plan.instruction !== null) args.push("-e", `ACQUIT_INSTRUCTION=${plan.instruction}`);
	if (plan.providerEnvFile !== null) args.push("--env-file", plan.providerEnvFile);
	args.push("--mount", `type=bind,source=${plan.dir},target=/work`);
	if (plan.commandPath !== null) args.push("--mount", `type=bind,source=${plan.commandPath},target=/acquit/command.sh,readonly`);
	args.push("--workdir", "/work", plan.image, "node", "/runner/run.mjs", "--exec", ...plan.argv);
	return args;
}

/** A comma is the one character that adds a field to a `--mount` value. A path is not a field list. */
function mountSafe(what: string, path: string): void {
	if (path.includes(",")) throw new CliError("MOUNT_PATH_UNSAFE", `The ${what} path cannot be a Docker mount source: ${JSON.stringify(path)}`);
}

/** The agent command the container executes. Unit-tested here; run.mjs only starts it. */
export function agentArgv(runner: RunnerKind, instruction: string, commandPath: string | null): readonly string[] {
	return runner === "claude-code"
		// The container is the boundary: the clone is a throwaway fork and the network is the proxy.
		? ["claude", "--print", "--dangerously-skip-permissions", instruction]
		: ["/bin/sh", commandPath ?? "/acquit/command.sh"];
}

export function cleanupArgs(names: SandboxNames): readonly (readonly string[])[] {
	return [["rm", "--force", names.runner], ["rm", "--force", names.proxy], ["network", "rm", names.network]];
}

/** Best effort, in the one order that cannot leave a container attached to a removed network. */
export async function cleanupSandbox(docker: DockerPort, names: SandboxNames): Promise<void> {
	for (const args of cleanupArgs(names)) {
		try { await docker.run(args); } catch { /* the object was never made, or the daemon is gone */ }
	}
}

/** The synchronous cleanup a signal handler can run before the process exits. */
export function cleanupSync(names: SandboxNames): void {
	for (const args of cleanupArgs(names)) {
		try { spawnSync("docker", [...args], { encoding: "utf8", timeout: 15_000 }); } catch { /* best effort */ }
	}
}

function signalGuard(names: SandboxNames): () => void {
	const onInterrupt = () => { cleanupSync(names); process.exit(130); };
	const onTerminate = () => { cleanupSync(names); process.exit(143); };
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onTerminate);
	return () => { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); };
}

/** Starts the proxy and the runner, and removes both plus the network on every exit path. */
export async function runAgentInSandbox(plan: RunnerPlan, docker: DockerPort,
	onOutput?: (chunk: string, stream: "stdout" | "stderr") => void, env?: NodeJS.ProcessEnv): Promise<number | null> {
	const options = env === undefined ? {} : { env };
	try {
		// A previous run killed before its cleanup leaves names behind; the names are per job, so this
		// can only ever remove this job's own leftovers.
		await cleanupSandbox(docker, plan.names);
		await docker.run(networkCreateArgs(plan.names.network), options);
		await docker.run(proxyRunArgs(plan.names.proxy, plan.names.network, plan.proxyImage), options);
		await docker.run(networkConnectArgs(plan.names.network, plan.names.proxy), options);
		return await docker.run(runnerRunArgs(plan), { ...options, ...(onOutput === undefined ? {} : { onOutput }) });
	} finally {
		await cleanupSandbox(docker, plan.names);
	}
}

// ---- the command ------------------------------------------------------------------------------

async function jobView(client: ApiClient, jobId: string): Promise<JobProjection> {
	const body = await client.get(`/api/jobs/${encodeURIComponent(jobId)}`);
	const record = body && typeof body === "object" ? body as { job?: JobProjection } : {};
	if (!record.job) throw new CliError("NOT_FOUND", `Job ${jobId} is not readable with this token.`);
	return record.job;
}

async function operatorId(client: ApiClient): Promise<string> {
	const body = await client.get("/api/me/operator");
	const record = body && typeof body === "object" ? body as { operator?: { id?: unknown } } : {};
	const id = record.operator?.id;
	if (typeof id !== "string" || id === "") throw new CliError("OPERATOR_REQUIRED", "This session is not an operator. Run `acquit login` as an operator account.");
	return id;
}

/** The credential the API mints for this job's work repo. Neither value is ever printed. */
export function parseWorkRepo(body: unknown): { readonly repository: string; readonly token: string } {
	const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
	const repository = typeof record.repository === "string" ? record.repository : "";
	const token = typeof record.token === "string" ? record.token : "";
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || token === "" || /[\r\n]/.test(token)) {
		throw new CliError("WORK_REPO_TOKEN_MISSING", "The API answered without a usable work repo credential for this job.");
	}
	return { repository, token };
}

function workRepoUrl(repository: string): string {
	return `https://github.com/${repository}.git`;
}

function resolveCommand(path: string): string {
	const absolute = resolve(path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) {
		throw new CliError("COMMAND_MISSING", `--command names no script file: ${path}.`);
	}
	return absolute;
}

/** What the claude-code runner works on when the operator gave no instruction. */
export function defaultInstruction(view: Pick<JobProjection, "title">): string {
	return `Fix the issue "${view.title}" in this repository. Read the code first, change files under src/ only, and run the tests before you finish.`;
}

export type RunDeps = {
	readonly client: ApiClient;
	readonly providerKey: ProviderKeyPort;
	readonly docker?: DockerPort;
	readonly git?: GitRun;
	readonly print?: (line: string) => void;
	readonly now?: () => number;
	readonly env?: NodeJS.ProcessEnv;
	readonly makeSecretDir?: () => { readonly path: string; readonly remove: () => void };
};

export async function runRun(options: RunOptions, deps: RunDeps): Promise<void> {
	const print = deps.print ?? ((line: string) => console.log(line));
	const git = deps.git ?? gitCli();
	const docker = deps.docker ?? dockerCli();
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;

	const view = await jobView(deps.client, options.jobId);
	const accepted = view.bids.operators.find(bid => bid.status === "ACCEPTED") ?? null;
	if (accepted === null) {
		throw new CliError("NOT_CLAIMED", `Job ${view.id} has no accepted bid yet. The client chooses an operator before the job can run.`);
	}
	const operator = await operatorId(deps.client);
	if (view.lockedTo === null || view.lockedTo !== operator) {
		throw new CliError("NOT_OWNER", `Run refused: ${view.id} is locked to ${view.lockedTo ?? "another operator"}.`);
	}
	if (view.contract === null) throw new CliError("CONTRACT_NOT_FROZEN", `Job ${view.id} has no frozen contract; nothing can run.`);
	const runner = options.runner ?? (accepted.runner === "claude-code" ? "claude-code" : null);
	if (runner === null) {
		throw new CliError("RUNNER_UNSUPPORTED", `Agent ${accepted.agent} runs with ${accepted.runner}; this CLI runs claude-code or command. `
			+ "Pass --runner command --command <script>.");
	}
	const commandPath = runner === "command" ? resolveCommand(options.command ?? "") : null;
	let providerKey: string | null = null;
	if (runner === "claude-code") {
		providerKey = await deps.providerKey.getProviderKey();
		if (providerKey === null || providerKey === "") {
			throw new CliError("PROVIDER_KEY_MISSING", "No model provider key. Run `acquit operator init` to store one in your OS keychain.");
		}
		if (/[\r\n]/.test(providerKey)) throw new CliError("PROVIDER_KEY_INVALID", "The stored provider key is not a single line.");
	}
	const credential = parseWorkRepo((await deps.client.post(`/api/jobs/${encodeURIComponent(view.id)}/work-repo-token`, {})).body);
	const dir = resolve(options.dir ?? join(process.cwd(), credential.repository.split("/").at(-1) ?? view.id));
	const url = workRepoUrl(credential.repository);
	const frozen = view.contract.frozenAt;
	const reset = view.attempts.used > 0;
	print(renderPreparing({ jobId: view.id, workRepo: credential.repository, image: options.image, frozenAt: frozen, reset }));

	const secret = (deps.makeSecretDir ?? makeSecretDir)();
	const names = sandboxNames(view.id);
	const child = childEnv(env);
	try {
		const askpass = writeAskpass(secret.path, credential.token);
		const gitEnv: NodeJS.ProcessEnv = { ...child, ...askpass.env };
		prepareWorkRepo(git, dir, url, frozen, gitEnv);
		const instruction = options.instruction ?? defaultInstruction(view);
		print(renderRunning(String(accepted.agent), runner, commandPath));
		const plan: RunnerPlan = { names, image: options.image, proxyImage: options.proxyImage, dir,
			// The script is mounted at /acquit/command.sh; the host path is only the mount source.
			argv: agentArgv(runner, instruction, commandPath === null ? null : "/acquit/command.sh"), commandPath,
			providerEnvFile: providerKey === null ? null : writeProviderEnvFile(secret.path, providerKey),
			instruction, jobId: view.id, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null };
		const started = now();
		const guard = signalGuard(names);
		let code: number | null;
		try {
			code = await runAgentInSandbox(plan, docker, (chunk, stream) => {
				if (stream === "stderr") process.stderr.write(chunk); else process.stdout.write(chunk);
			}, child);
		} finally { guard(); }
		if (code !== 0) throw new CliError("AGENT_FAILED", `The agent exited ${code ?? "without a status"}.`);
		const files = changedFiles(git, dir, frozen);
		const head = headOf(git, dir, gitEnv);
		if (head === frozen) {
			// The agent left its work uncommitted; one commit carries it to the submission ref.
			if (files.length > 0) pushWork(git, dir, url, commitWork(git, dir, `Run ${view.id} with ${accepted.agent}`, gitEnv), gitEnv);
		} else {
			// The agent committed its own work; push that commit unchanged.
			pushWork(git, dir, url, head, gitEnv);
		}
		print(renderFinished(files, now() - started, view.id));
	} finally {
		secret.remove();
	}
}
