// `acquit run <job> [--instruction "..."] [--runner claude-code|command] [--command <script>]`.
//
// One delivery attempt, as the operator: ask the API for a work-repo credential, clone the job's
// fork, run the agent inside a container whose only route out is an allowlisting proxy, commit what
// the agent changed, and push that commit to the work repo the way `acquit submit` expects.
//
// The agent never sees git metadata: the job's git directory lives in the CLI's state location,
// outside the work tree the sandbox mounts, and an empty read-only tmpfs covers `/work/.git`. The
// shadow is re-made as an empty real directory immediately before every mount, so a symlink a
// previous run planted there can never move that mount onto its target. Every host-side git command
// names the state git directory and the work tree explicitly, never discovery, and runs under the
// hardened env and `-c` overrides in gitstate.ts.
//
// Secrets: the session token comes from the environment or stdin; the work-repo token lives in a
// 0600 file named by the constant 0700 askpass script in a mkdtemp directory removed on every exit;
// the provider key travels to the container only through the docker child's environment, named by
// `-e` with no value. No secret is ever an argv word, a printed line, or a log line.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CommitSha } from "../../core/src/ids.ts";
import type { JobProjection } from "../../core/src/job.ts";
import { boundedDetail } from "../../core/src/verifier.ts";
import { CliError, resolveToken } from "./client.ts";
import type { ApiClient, StoredLogin } from "./client.ts";
import { assertSafePushConfig, gitGuardArgs, hardenedGitEnv, recordedWorkTree, stateGitDir, stripGitEnv, writeWorkTreeMarker } from "./gitstate.ts";
import type { JobCheckout } from "./gitstate.ts";
import { pushError, submissionRef } from "./submit.ts";
import { childEnv, makeSecretDir, parseWorkRepo, workRepoUrl, writeAskpass } from "./workrepo.ts";

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
	readStdin: () => string = readTokenFromStdin, stored: () => StoredLogin | null = () => null): RunOptions {
	const login = stored();
	let jobId: string | null = null;
	let dir: string | null = null;
	let apiUrl = env.ACQUIT_API ?? login?.api ?? "http://127.0.0.1:4310";
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
	return { jobId, dir, apiUrl, token: resolveToken(tokenOnStdin ? readStdin().trim() || undefined : undefined, env,
		() => login?.token ?? null), instruction, runner, command, image, proxyImage: env.ACQUIT_RUNNER_PROXY_IMAGE?.trim() || image };
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

/** Every git command on a job's checkout names its state git directory and work tree explicitly:
 * discovery would follow the work tree's own .git, which the sandbox can write. */
function jobGitArgs(checkout: JobCheckout, env: NodeJS.ProcessEnv, args: readonly string[]): readonly string[] {
	return ["--git-dir", checkout.gitDir, "--work-tree", checkout.workTree, ...gitGuardArgs(env), ...args];
}

function checkoutGit(git: GitRun, checkout: JobCheckout, env: NodeJS.ProcessEnv, args: readonly string[]): GitResult {
	return git(jobGitArgs(checkout, env, args), env);
}

/** The identity the operator's own global config names, read before the hardened env hides it. */
export function globalGitIdentity(git: GitRun, env: NodeJS.ProcessEnv): { readonly name: string | null; readonly email: string | null } {
	const read = (key: string): string | null => {
		const result = git(["config", "--global", key], env);
		const value = result.status === 0 ? result.stdout.trim() : "";
		return value === "" || /[\r\n]/.test(value) ? null : value;
	};
	return { name: read("user.name"), email: read("user.email") };
}

/** The hardened env cannot see the operator's global config, so the identity the run's commit should
 * carry is copied into the CLI-owned state git directory. */
export function seedCommitIdentity(git: GitRun, checkout: JobCheckout, identity: { readonly name: string | null; readonly email: string | null },
	env: NodeJS.ProcessEnv): void {
	for (const [key, value] of [["user.name", identity.name], ["user.email", identity.email]] as const) {
		if (value === null || value === "") continue;
		git(jobGitArgs(checkout, env, ["config", key, value]), env);
	}
}

/** Replaces the `gitdir:` link `--separate-git-dir` writes with an empty directory. Host git never
 * reads the link (every command names the state git directory), and the sandbox mounts an empty
 * read-only tmpfs over `.git`, so no process can follow or write it. */
function hideWorkTreeGitLink(workTree: string, gitDir: string): void {
	const link = join(workTree, ".git");
	let text: string;
	try { text = readFileSync(link, "utf8"); } catch {
		throw new CliError("DIR_NOT_WORK_REPO", `${workTree}/.git is missing after the clone; refusing to use the checkout.`);
	}
	const target = /^gitdir:\s*(.+)$/i.exec(text.trim())?.[1];
	if (target === undefined || resolve(workTree, target) !== resolve(gitDir)) {
		throw new CliError("DIR_NOT_WORK_REPO", `${workTree}/.git does not point at the job's state git directory; refusing to touch it.`);
	}
	rmSync(link, { force: true });
	mkdirSync(link, { mode: 0o700 });
}

/**
 * Re-makes the work tree's `.git` as an empty real 0700 directory: the shadow the sandbox mounts an
 * empty read-only tmpfs over. The path belongs to the previous run's agent, which owns the work
 * tree, so it may be a symlink (runc would mount the shadow on the link's target inside the
 * container, masking it), a dangling symlink, a gitfile, a regular file, or a directory holding
 * files a later `git add -A` could pick up. `lstatSync` never follows a link: anything that is not a
 * real directory is unlinked by its own path, and a real directory is emptied entry by entry
 * (`rmSync` never follows a symlink entry), so whatever a link names is never touched.
 */
export function ensureEmptyWorkTreeGitShadow(workTree: string): void {
	const shadow = join(workTree, ".git");
	const entry = lstatSync(shadow, { throwIfNoEntry: false });
	if (entry === undefined) {
		mkdirSync(shadow, { recursive: true, mode: 0o700 });
	} else if (entry.isDirectory()) {
		for (const name of readdirSync(shadow)) rmSync(join(shadow, name), { recursive: true, force: true });
	} else {
		rmSync(shadow, { force: true });
		mkdirSync(shadow, { mode: 0o700 });
	}
	chmodSync(shadow, 0o700);
}

/**
 * Puts the job's checkout on the frozen commit with a clean working tree. The git directory lives in
 * the CLI's state location, outside the work tree, so the sandbox never sees git metadata. A fresh
 * path is cloned with `--separate-git-dir`; an existing path is only accepted when it is the one
 * work tree the state git directory records, so a run can never reset an unrelated checkout. An
 * older build's in-tree .git cannot be adopted: the operator passes a fresh --dir instead.
 */
export function prepareWorkRepo(git: GitRun, checkout: JobCheckout, url: string, frozen: CommitSha, env: NodeJS.ProcessEnv): void {
	const { gitDir, workTree } = checkout;
	if (existsSync(gitDir)) {
		const recorded = recordedWorkTree(gitDir);
		if (recorded === null) {
			throw new CliError("DIR_NOT_WORK_REPO", `The state git directory ${gitDir} has no recorded work tree; remove it and pass a fresh --dir.`);
		}
		if (resolve(recorded) !== resolve(workTree)) {
			// The checkout the state directory was cloned into is gone (a deleted temp root, a moved
			// machine copy): an empty path may be adopted, anything else is not this job's checkout.
			if (existsSync(recorded)) {
				throw new CliError("DIR_NOT_WORK_REPO", `${workTree} is not the checkout this job's state git directory belongs to (${recorded}). `
					+ "Pass --dir with that path, or remove the state git directory to clone afresh.");
			}
			if (existsSync(workTree) && readdirSync(workTree).length > 0) {
				throw new CliError("DIR_NOT_WORK_REPO", `${workTree} is not empty and is not this job's checkout. Pass --dir with an empty path.`);
			}
			writeWorkTreeMarker(gitDir, resolve(workTree));
		}
		const origin = checkoutGit(git, checkout, env, ["config", "--get", "remote.origin.url"]).stdout.trim();
		if (!sameRemote(origin, url)) {
			throw new CliError("DIR_NOT_WORK_REPO", `${gitDir} tracks ${safeEcho(origin || "(no origin)")}, not ${safeEcho(url)}. `
				+ "Remove the state git directory and pass a fresh --dir to clone afresh.");
		}
		const fetched = git(["--git-dir", gitDir, ...gitGuardArgs(env), "fetch", "--quiet", "--no-tags", "origin"], env);
		if (fetched.status !== 0) throw cloneError(url, fetched.stderr);
	} else if (existsSync(workTree) && readdirSync(workTree).length > 0) {
		throw new CliError("DIR_NOT_WORK_REPO", `${workTree} is not empty and no state git directory for this job exists. `
			+ "An older checkout's in-tree .git cannot be adopted; pass a fresh --dir (an empty path) instead.");
	} else {
		mkdirSync(dirname(gitDir), { recursive: true, mode: 0o700 });
		const cloned = git([...gitGuardArgs(env), "clone", "--quiet", "--template=", "--separate-git-dir", gitDir, url, workTree], env);
		if (cloned.status !== 0) throw cloneError(url, cloned.stderr);
		chmodSync(gitDir, 0o700);
		writeWorkTreeMarker(gitDir, resolve(workTree));
		hideWorkTreeGitLink(workTree, gitDir);
	}
	// A checkout whose work tree was deleted is recreated empty; the frozen commit repopulates it.
	if (!existsSync(workTree)) mkdirSync(workTree, { recursive: true, mode: 0o700 });
	if (checkoutGit(git, checkout, env, ["cat-file", "-e", `${frozen}^{commit}`]).status !== 0) {
		throw new CliError("FROZEN_COMMIT_MISSING", `The work repo does not carry the frozen commit ${frozen.slice(0, 7)}. `
			+ "Rerun in about 30 seconds after funding creates it.");
	}
	const checkedOut = checkoutGit(git, checkout, env, ["checkout", "--force", "--quiet", frozen]);
	if (checkedOut.status !== 0) throw new CliError("GIT_FAILED", `git checkout of the frozen commit failed. ${safeEcho(checkedOut.stderr)}`.trim());
	const cleaned = checkoutGit(git, checkout, env, ["clean", "-fdq"]);
	if (cleaned.status !== 0) throw new CliError("GIT_FAILED", `git clean failed. ${safeEcho(cleaned.stderr)}`.trim());
	// Never the clone's gitfile, never a link the mount could follow, and never a directory holding
	// files a later `git add -A` could pick up: the sandbox shadow is an empty real directory. The
	// check runs again immediately before every mount, on the path a previous run owned.
	ensureEmptyWorkTreeGitShadow(workTree);
}

/** Added lines per changed path against the frozen commit. A `to` commit compares the two committed
 * trees; without one the working tree is read, untracked files included. */
export function changedFiles(git: GitRun, checkout: JobCheckout, frozen: CommitSha, env: NodeJS.ProcessEnv, to?: string): readonly ChangedFile[] {
	const files = new Map<string, ChangedFile>();
	const tracked = runGit(git, jobGitArgs(checkout, env, ["diff", "--numstat", "--no-renames", "-z", frozen, ...(to === undefined ? ["--"] : [to])]), env);
	for (const record of tracked.stdout.split("\0")) {
		if (record === "") continue;
		const [added, deleted, ...rest] = record.split("\t");
		const path = rest.join("\t");
		if (!path) continue;
		const binary = added === "-" || deleted === "-";
		files.set(path, { path, added: binary ? 0 : Number(added) || 0, binary });
	}
	if (to === undefined) {
		const untracked = runGit(git, jobGitArgs(checkout, env, ["ls-files", "--others", "--exclude-standard", "-z"]), env);
		for (const path of untracked.stdout.split("\0")) {
			if (path === "") continue;
			const counted = countLines(readFileSync(join(checkout.workTree, path)));
			files.set(path, { path, ...counted });
		}
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

export function headOf(git: GitRun, checkout: JobCheckout, env: NodeJS.ProcessEnv): CommitSha {
	const head = runGit(git, jobGitArgs(checkout, env, ["rev-parse", "HEAD"]), env).stdout.trim();
	if (!/^[0-9a-f]{7,64}$/.test(head)) throw new CliError("GIT_FAILED", `git rev-parse HEAD answered ${head || "(nothing)"}.`);
	return head as CommitSha;
}

/** Commits the agent's tree with the operator's identity when the state git directory carries one,
 * and a runner identity otherwise, so a machine with no git user still produces the commit submit
 * needs. `git add -A` reads the work tree's .gitattributes, but a filter driver needs config the CLI
 * wrote none of and the hardened env hides every other source, so attributes alone run nothing. */
export function commitWork(git: GitRun, checkout: JobCheckout, message: string, env: NodeJS.ProcessEnv): CommitSha {
	runGit(git, jobGitArgs(checkout, env, ["add", "-A"]), env);
	const configured = git(jobGitArgs(checkout, env, ["config", "user.email"]), env).stdout.trim();
	const args = [...jobGitArgs(checkout, env, [])];
	if (configured === "") args.push("-c", "user.name=acquit-runner", "-c", "user.email=runner@acquit.local");
	args.push("commit", "--quiet", "-m", message);
	const committed = git(args, env);
	if (committed.status !== 0) throw new CliError("COMMIT_FAILED", `git commit failed. ${safeEcho(committed.stderr)}`.trim());
	return headOf(git, checkout, env);
}

/**
 * The commit this run pushes. Uncommitted work is folded into one commit on top of whatever the agent
 * committed, so what the changed-files count reads and what the push carries are the same tree. Null
 * means the checkout still sits on the frozen commit with a clean tree: there is nothing to push.
 */
export function submissionCommit(git: GitRun, checkout: JobCheckout, frozen: CommitSha, message: string, env: NodeJS.ProcessEnv): CommitSha | null {
	const head = headOf(git, checkout, env);
	const dirty = runGit(git, jobGitArgs(checkout, env, ["status", "--porcelain"]), env).stdout.trim() !== "";
	if (dirty) return commitWork(git, checkout, message, env);
	return head === frozen ? null : head;
}

/** The ref `acquit submit` pushes to: one commit-named ref, so the two commands can only agree. */
export function pushWork(git: GitRun, checkout: JobCheckout, url: string, commit: CommitSha, env: NodeJS.ProcessEnv): void {
	// The state git directory is never exposed to the agent, but a push is the one place the scoped
	// token meets config: refuse any key the CLI did not write before git can read it.
	assertSafePushConfig(git, checkout.gitDir, env);
	const pushed = git(jobGitArgs(checkout, env, ["push", "--quiet", url, `${commit}:${submissionRef(commit)}`]), env);
	if (pushed.status !== 0) throw pushError(url, pushed.stderr);
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

export type SandboxNames = { readonly runner: string; readonly proxy: string; readonly network: string; readonly egress: string };

/** Every object this run makes carries the job in its name, so nothing is left running unnamed. */
export function sandboxNames(jobId: string): SandboxNames {
	const base = `acquit-runner-${jobId}`;
	return { runner: base, proxy: `${base}-proxy`, network: `${base}-net`, egress: `${base}-egress` };
}

export function networkCreateArgs(network: string): readonly string[] {
	return ["network", "create", "--internal", network];
}

/** The proxy's own network: per run and not internal, so it has a route out, and with inter-container
 * communication off so nothing else on the host's bridges can reach the proxy's port. */
export function egressNetworkCreateArgs(egress: string): readonly string[] {
	return ["network", "create", "-o", "com.docker.network.bridge.enable_icc=false", egress];
}

/** The proxy is the one container with a route out: its own per-run egress network, plus the internal
 * network the runner joins. It never attaches to the shared bridge. */
export function proxyRunArgs(proxy: string, egress: string, image: string): readonly string[] {
	return ["run", "--detach", "--rm", "--name", proxy, "--network", egress, "--pull=never", image, "node", "/runner/proxy.mjs"];
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
	/** The value the runner container's ANTHROPIC_API_KEY gets, or null for the command runner. It is
	 * never an argv word: `-e ANTHROPIC_API_KEY` names it and the docker child's env carries it. */
	readonly providerKey: string | null;
	readonly instruction: string | null;
	readonly jobId: string;
	readonly uid: number | null;
	readonly gid: number | null;
};

/** The runner container: the internal network only, the proxy in its environment, the key by name. */
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
	if (plan.providerKey !== null) args.push("-e", "ANTHROPIC_API_KEY");
	args.push("--mount", `type=bind,source=${plan.dir},target=/work`);
	// The job's git directory is never inside the work tree; the shadow keeps even a stray `.git`
	// from being read or written by the agent, and stays read-only.
	args.push("--tmpfs", "/work/.git:ro");
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
	return [["rm", "--force", names.runner], ["rm", "--force", names.proxy],
		["network", "rm", names.network], ["network", "rm", names.egress]];
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

export type SignalGuardPorts = {
	readonly cleanup?: (names: SandboxNames) => void;
	readonly exit?: (code: number) => void;
	/** Runs first, before the sandbox cleanup: the secret directory goes even if docker hangs. */
	readonly onSignal?: () => void;
};

/** The handlers a signal runs before the process exits. Injectable so a test can drive them directly. */
export function signalGuard(names: SandboxNames, ports: SignalGuardPorts = {}): () => void {
	const cleanup = ports.cleanup ?? cleanupSync;
	const exit = ports.exit ?? ((code: number) => process.exit(code));
	const onInterrupt = () => { ports.onSignal?.(); cleanup(names); exit(130); };
	const onTerminate = () => { ports.onSignal?.(); cleanup(names); exit(143); };
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onTerminate);
	return () => { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); };
}

/** Starts the proxy and the runner, and removes both plus the networks on every exit path. The
 * work tree's `.git` shadow is re-made empty and real immediately before the runner mounts it. */
export async function runAgentInSandbox(plan: RunnerPlan, docker: DockerPort,
	onOutput?: (chunk: string, stream: "stdout" | "stderr") => void, env?: NodeJS.ProcessEnv): Promise<number | null> {
	const options = env === undefined ? {} : { env };
	// A setup command's output names the daemon's refusal; it is bounded and redacted before it is
	// quoted, and the cleanup below still runs.
	const setup = async (args: readonly string[], what: string): Promise<void> => {
		const output: string[] = [];
		const code = await docker.run(args, { ...options, onOutput: chunk => output.push(chunk) });
		if (code !== 0) {
			const detail = safeEcho(boundedDetail(output.join(" ").trim()));
			throw new CliError("SANDBOX_SETUP_FAILED", `${what} failed (docker exited ${code ?? "without a status"}).${detail ? ` ${detail}` : ""}`);
		}
	};
	try {
		// A previous run killed before its cleanup leaves names behind; the names are per job, so this
		// can only ever remove this job's own leftovers.
		await cleanupSandbox(docker, plan.names);
		await setup(networkCreateArgs(plan.names.network), "Creating the sandbox network");
		await setup(egressNetworkCreateArgs(plan.names.egress), "Creating the sandbox egress network");
		await setup(proxyRunArgs(plan.names.proxy, plan.names.egress, plan.proxyImage), "Starting the egress proxy");
		await setup(networkConnectArgs(plan.names.network, plan.names.proxy), "Attaching the proxy to the sandbox network");
		const runner = { ...options, ...(onOutput === undefined ? {} : { onOutput }) };
		if (plan.providerKey !== null) runner.env = { ...(env ?? process.env), ANTHROPIC_API_KEY: plan.providerKey };
		// The work tree's `.git` is a path a previous run's agent owned: re-make it an empty real
		// directory immediately before the runner mounts the read-only tmpfs over it, so a planted
		// symlink can never make runc mount the shadow on the link's target inside the container.
		// Every run -- fresh, adopted, or a rerun -- passes through here.
		ensureEmptyWorkTreeGitShadow(plan.dir);
		return await docker.run(runnerRunArgs(plan), runner);
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
	// The git directory stays in the CLI's state location: the sandbox only ever mounts `dir`.
	const checkout: JobCheckout = { gitDir: stateGitDir(view.id, env), workTree: dir };
	print(renderPreparing({ jobId: view.id, workRepo: credential.repository, image: options.image, frozenAt: frozen, reset }));

	const secret = (deps.makeSecretDir ?? makeSecretDir)();
	const names = sandboxNames(view.id);
	const child = childEnv(env);
	// The guard is installed before the first secret lands on disk, and it removes that directory
	// itself: a signal must not leave a credential behind while it cleans up the sandbox.
	const guard = signalGuard(names, { onSignal: () => secret.remove() });
	try {
		const askpass = writeAskpass(secret.path, credential.token);
		// The hardened env first, the CLI's own askpass last: nothing inherited survives into git.
		const gitEnv: NodeJS.ProcessEnv = { ...hardenedGitEnv(child), ...askpass.env };
		prepareWorkRepo(git, checkout, url, frozen, gitEnv);
		// The identity read is the one call that must see the operator's home; it still loses every
		// inherited GIT_* variable.
		seedCommitIdentity(git, checkout, globalGitIdentity(git, stripGitEnv(child)), gitEnv);
		const instruction = options.instruction ?? defaultInstruction(view);
		print(renderRunning(String(accepted.agent), runner, commandPath));
		const plan: RunnerPlan = { names, image: options.image, proxyImage: options.proxyImage, dir,
			// The script is mounted at /acquit/command.sh; the host path is only the mount source.
			argv: agentArgv(runner, instruction, commandPath === null ? null : "/acquit/command.sh"), commandPath,
			providerKey, instruction, jobId: view.id, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null };
		const started = now();
		const code = await runAgentInSandbox(plan, docker, (chunk, stream) => {
			if (stream === "stderr") process.stderr.write(chunk); else process.stdout.write(chunk);
		}, child);
		if (code !== 0) throw new CliError("AGENT_FAILED", `The agent exited ${code ?? "without a status"}.`);
		// One tree for both the count and the push: the agent's commits plus anything it left uncommitted.
		const pushed = submissionCommit(git, checkout, frozen, `Run ${view.id} with ${accepted.agent}`, gitEnv);
		if (pushed !== null) pushWork(git, checkout, url, pushed, gitEnv);
		const files = pushed === null ? [] : changedFiles(git, checkout, frozen, gitEnv, pushed);
		print(renderFinished(files, now() - started, view.id));
	} finally {
		guard();
		secret.remove();
	}
}
