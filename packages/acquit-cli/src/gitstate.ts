// The CLI-owned state location for a job's git directory, and the hardening every host-side git
// invocation on a job's checkout gets. `acquit run` keeps the git directory outside the work tree
// the sandbox mounts, so the agent never sees git metadata; host git always names the state git
// directory and the work tree explicitly, never discovery, and never reads config the CLI did not
// write. The state location is `$XDG_STATE_HOME/acquit/work/<jobId>.git` (falling back to
// `~/.local/state/acquit/work/<jobId>.git`, and `%LOCALAPPDATA%\acquit\work\<jobId>.git` on
// Windows), created mode 0700.

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "./client.ts";

/** The one job checkout host git works on: the state git directory plus the work tree it was cloned into. */
export type JobCheckout = { readonly gitDir: string; readonly workTree: string };

/** A git invocation the hardening helpers drive; run.ts's GitRun and submit.ts's probe both fit. */
export type GitProbe = (args: readonly string[], env?: NodeJS.ProcessEnv) =>
	{ readonly status: number | null; readonly stdout: string; readonly stderr: string };

/** The record inside a state git directory naming the one work tree it was cloned into. */
const WORK_TREE_MARKER = "acquit-worktree";

/** The user's state root: XDG state, the home fallback, or the Windows local app data. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME?.trim() || homedir();
	if (process.platform === "win32") return join(env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "acquit");
	return join(env.XDG_STATE_HOME?.trim() || join(home, ".local", "state"), "acquit");
}

/** `<state>/work/<jobId>.git`: the job's git directory, outside every work tree the sandbox mounts. */
export function stateGitDir(jobId: string, env: NodeJS.ProcessEnv = process.env): string {
	if (!/^[A-Za-z0-9_.-]+$/.test(jobId)) throw new CliError("USAGE", `Unsupported job id ${JSON.stringify(jobId)}.`);
	return join(stateRoot(env), "work", `${jobId}.git`);
}

/** The state root, created mode 0700. Everything the CLI owns for a job lives under it. */
export function ensureStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	const root = stateRoot(env);
	mkdirSync(join(root, "work"), { recursive: true, mode: 0o700 });
	return root;
}

/** An empty file the CLI owns, used as GIT_CONFIG_GLOBAL so no user or machine config is read. */
function emptyGlobalConfig(root: string): string {
	const path = join(root, "gitconfig");
	writeFileSync(path, "", { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

/** An empty directory the CLI owns, used as core.hooksPath so no hook on a job's checkout can run. */
function emptyHooksDir(root: string): string {
	const path = join(root, "hooks");
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}

/**
 * The environment with every inherited GIT_* and SSH_ASKPASS removed, nothing else changed. Used
 * where a read must still find the operator's own home, like the global identity `acquit run` copies
 * into the state git directory; everything else on a job's checkout gets `hardenedGitEnv` instead.
 */
export function stripGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		const upper = key.toUpperCase();
		if (upper === "SSH_ASKPASS" || upper.startsWith("GIT_")) continue;
		child[key] = value;
	}
	return child;
}

/**
 * The environment every host-side git invocation on a job's checkout gets: no inherited GIT_* or
 * SSH_ASKPASS (so no inherited GIT_DIR, GIT_CONFIG_*, GIT_SSH*, or askpass), no system or global
 * config, and no terminal prompt. The CLI's own askpass is added by the caller after this, never
 * before it.
 */
export function hardenedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const root = ensureStateRoot(env);
	const child = stripGitEnv(env);
	child.GIT_CONFIG_NOSYSTEM = "1";
	child.GIT_CONFIG_GLOBAL = emptyGlobalConfig(root);
	child.GIT_TERMINAL_PROMPT = "0";
	return child;
}

/**
 * The `-c` overrides that close config-driven code execution and credential sources on a job's
 * checkout: hooks and fsmonitor off, no credential helper, no ssh command. Command-line config
 * outranks the checkout's local config, and the CLI's own askpass still supplies the credential.
 */
export function gitGuardArgs(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	const root = ensureStateRoot(env);
	return ["-c", `core.hooksPath=${emptyHooksDir(root)}`, "-c", "core.fsmonitor=false",
		"-c", "credential.helper=", "-c", "core.sshCommand="];
}

/**
 * The job's state checkout when `workTree` is the one work tree the state git directory records;
 * null means `workTree` is the operator's own checkout, which no agent has been given, so callers
 * keep discovery there. Both spellings are realpath'd when they exist, so a symlink to the recorded
 * work tree is that same checkout.
 */
export function existingStateCheckout(jobId: string, workTree: string, env: NodeJS.ProcessEnv = process.env): JobCheckout | null {
	const gitDir = stateGitDir(jobId, env);
	if (!existsSync(gitDir)) return null;
	const recorded = recordedWorkTree(gitDir);
	return recorded !== null && sameWorkTree(recorded, workTree) ? { gitDir, workTree } : null;
}

/** Whether two paths name the same work tree: real paths when both exist, resolved spellings
 * otherwise. */
function sameWorkTree(left: string, right: string): boolean {
	const real = (path: string): string | null => {
		try { return realpathSync(path); } catch { return null; }
	};
	const leftReal = real(left);
	const rightReal = real(right);
	if (leftReal !== null && rightReal !== null) return leftReal === rightReal;
	return resolve(left) === resolve(right);
}

/** The work tree a state git directory was cloned into, or null when it records none. */
export function recordedWorkTree(gitDir: string): string | null {
	try {
		const text = readFileSync(join(gitDir, WORK_TREE_MARKER), "utf8").trim();
		return text === "" ? null : text;
	} catch { return null; }
}

/** Records the one work tree a state git directory belongs to, mode 0600 inside the 0700 state root. */
export function writeWorkTreeMarker(gitDir: string, workTree: string): void {
	writeFileSync(join(gitDir, WORK_TREE_MARKER), `${workTree}\n`, { mode: 0o600 });
}

/**
 * Local git config that must never meet the scoped work-repo token or a push: URL rewrites and push
 * targets can send it elsewhere, and the rest are code execution or credential sources. The state
 * git directory is CLI-owned, so any of these is config the CLI did not write; includes count
 * because they can smuggle the others in from a file this scan does not read.
 */
export function unsafeGitConfigKeys(git: GitProbe, gitDir: string, env: NodeJS.ProcessEnv): readonly string[] {
	const listed = git(["--git-dir", gitDir, "config", "--local", "--list", "--no-includes", "-z"], env);
	if (listed.status !== 0) {
		throw new CliError("GIT_FAILED", `Reading the git config of the job's state directory failed. ${listed.stderr.trim().slice(0, 200)}`.trim());
	}
	const unsafe = new Set<string>();
	for (const record of listed.stdout.split("\0")) {
		if (record === "") continue;
		// `--list -z` writes `key\nvalue\0`, so the value of a remote URL is here to read, never print.
		const newline = record.indexOf("\n");
		const key = (newline === -1 ? record : record.slice(0, newline)).trim().toLowerCase();
		const value = newline === -1 ? "" : record.slice(newline + 1).trim();
		// `pushInsteadOf` rewrites a push to the URL the command names, exactly as `insteadOf` does.
		if (/^url\..+\.(push)?insteadof$/.test(key) || /\.pushurl$/.test(key)
			|| (/^remote\..+\.url$/.test(key) && remoteOffGithub(value))
			|| /^core\.sshcommand$/.test(key) || /^core\.hookspath$/.test(key) || /^core\.fsmonitor$/.test(key)
			|| /^credential(\.|$)/.test(key) || /^include(\.|$)/.test(key) || /^includeif\./.test(key)) unsafe.add(key);
	}
	return [...unsafe].sort();
}

/** Whether a configured remote URL names a host that is not github.com. Only a github.com URL can be
 * the job's work repo; a local path names no host and carries no credential, so it is left alone. */
function remoteOffGithub(value: string): boolean {
	const scp = /^[^/@\s]+@([^/:\s]+):/.exec(value);
	let host = scp?.[1] ?? "";
	if (scp === null) {
		try { host = new URL(value).hostname; } catch { host = ""; }
	}
	if (host === "") return false;
	const name = host.toLowerCase();
	return name !== "github.com" && !name.endsWith(".github.com");
}

/** Refuses a push whose destination or credential path could be steered by config the CLI did not write. */
export function assertSafePushConfig(git: GitProbe, gitDir: string, env: NodeJS.ProcessEnv): void {
	const unsafe = unsafeGitConfigKeys(git, gitDir, env);
	if (unsafe.length > 0) {
		throw new CliError("GIT_CONFIG_UNSAFE", `Refusing to push: the job's git directory holds config the CLI did not write (${unsafe.join(", ")}). `
			+ "Remove the state git directory and clone afresh.");
	}
}
