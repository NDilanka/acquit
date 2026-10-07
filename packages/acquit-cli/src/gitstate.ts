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

/** The git directory host git must read, plus the work tree when the caller has one. Git reads a
 * worktree config only for a location that names a work tree, so a push and the scan that guards it
 * both hand git this same shape. */
export type GitLocation = { readonly gitDir: string; readonly workTree?: string };

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
		"-c", "credential.helper=", "-c", "core.sshCommand=", "-c", "http.sslVerify=true", "-c", "http.proxy="];
}

/**
 * The arguments every host-side git call on a checkout starts with: the location git must read (the
 * git directory, and the work tree whenever the caller has one) and the guard. A guarded push and the
 * config scan that guards it both build their arguments here, so the config files git reads for a scan
 * are the config files git reads for that push, worktree config included.
 */
export function checkoutGitArgs(location: GitLocation, env: NodeJS.ProcessEnv, args: readonly string[]): readonly string[] {
	const where = location.workTree === undefined
		? ["--git-dir", location.gitDir]
		: ["--git-dir", location.gitDir, "--work-tree", location.workTree];
	return [...where, ...gitGuardArgs(env), ...args];
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
 * Config the push would read that must never meet the scoped work-repo token or a push: URL rewrites
 * and push targets can send it elsewhere, and the rest are code execution, credential sources,
 * request rewriting, or TLS verification. The state git directory is CLI-owned, so any of these is
 * config the CLI did not write; includes count because they can smuggle the others in from a file this
 * scan does not read.
 *
 * The scan runs git with the push's own location arguments and guard, and no `--local`, so the keys
 * listed are the keys git resolves for that push, a worktree config included. `--show-scope` names
 * the file each key came from: the CLI's own `-c` guard is skipped by scope, and a system or global
 * key refuses outright, because the CLI hides both files, so git naming either one means this child
 * is not the one the push uses and no key-by-key judgement of that file can be trusted.
 *
 * The `remote.*.url` rule applies only to a state checkout (`where === "state"`): the scoped push
 * names the work-repo URL explicitly, while an operator's own checkout remotes are theirs.
 */
export function unsafeGitConfigKeys(git: GitProbe, location: GitLocation, env: NodeJS.ProcessEnv, where: GitDirKind): readonly string[] {
	const listed = git([...checkoutGitArgs(location, env, ["config", "--list", "--show-scope", "--no-includes", "-z"])], env);
	if (listed.status !== 0) {
		throw new CliError("GIT_FAILED", `Reading the git config of the job's state directory failed. ${listed.stderr.trim().slice(0, 200)}`.trim());
	}
	const unsafe = new Set<string>();
	// `--show-scope -z` writes `scope\0key\nvalue\0` per value and `scope\0key\0` for a key with no
	// value, so the fields alternate and a value may hold newlines of its own.
	const fields = listed.stdout.split("\0");
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const scope = fields[index].trim();
		const record = fields[index + 1];
		const newline = record.indexOf("\n");
		// The key as git listed it: a URL subsection is case-sensitive, so the boolean probe below
		// must name the key git resolves, while the refusal reports the lowercased spelling.
		const listedKey = (newline === -1 ? record : record.slice(0, newline)).trim();
		const key = listedKey.toLowerCase();
		const value = newline === -1 ? "" : record.slice(newline + 1).trim();
		// The `command` scope is the CLI's own `-c` guard, which outranks every file and is the guard
		// itself. Any other scope is a file the CLI did not hand this child.
		if (scope === "command") continue;
		if (scope !== "local" && scope !== "worktree") {
			throw new CliError("GIT_CONFIG_UNSAFE", `Refusing to push: git read ${scope} config for ${location.gitDir} (${listedKey}) although the CLI hides `
				+ "every config file but the checkout's own. Rerun with a clean environment: a GIT_CONFIG_* variable or a git wrapper is overriding the CLI's own.");
		}
		// Git parses a URL-scoped key the same way: the section first, then the name after the last
		// dot. A URL-scoped key outranks the guard's plain `-c` override, so `http.<url>.proxy`,
		// `http.<url>.sslVerify`, and `http.<url>.extraHeader` are refused here or one can move a
		// credential-bearing request, turn off TLS verification, or add a header to the scoped push.
		// A CA key refuses in both shapes: a planted bundle makes git trust a substituted certificate.
		const http = key.startsWith("http.") ? key.slice(key.lastIndexOf(".") + 1) : "";
		// `pushInsteadOf` rewrites a push to the URL the command names, exactly as `insteadOf` does.
		if (/^url\..+\.(push)?insteadof$/.test(key) || /\.pushurl$/.test(key)
			|| (where === "state" && /^remote\..+\.url$/.test(key) && remoteOffGithub(value))
			|| http === "proxy" || http === "extraheader" || http === "sslcainfo" || http === "sslcapath"
			|| (http === "sslverify" && !gitReadsTrue(git, location, env, listedKey))
			|| (where === "state" && key === "extensions.worktreeconfig" && gitReadsTrue(git, location, env, listedKey))
			|| /^core\.sshcommand$/.test(key) || /^core\.hookspath$/.test(key) || /^core\.fsmonitor$/.test(key)
			|| /^credential(\.|$)/.test(key) || /^include(\.|$)/.test(key) || /^includeif\./.test(key)) unsafe.add(key);
	}
	return [...unsafe].sort();
}

/**
 * Whether git reads every value of `key` as boolean true. The scan asks git rather than spelling
 * git's false forms itself: an empty value, `00`, `0x0`, and `0k` are all false to git, and a value
 * git cannot parse must refuse too. A listed key git cannot answer for is refused, never trusted.
 */
function gitReadsTrue(git: GitProbe, location: GitLocation, env: NodeJS.ProcessEnv, key: string): boolean {
	const answer = git([...checkoutGitArgs(location, env, ["config", "--no-includes", "--bool", "--get-all", key])], env);
	if (answer.status !== 0) return false;
	const values = answer.stdout.split("\n").map(line => line.trim()).filter(line => line !== "");
	return values.length > 0 && values.every(value => value === "true");
}

/** Whether a configured remote URL names a host that is not github.com. Only a github.com URL can be
 * the job's work repo; a local path names no host and carries no credential, so it is left alone.
 * An scp-like URL (`host:path`, with or without `user@`) names a host too. */
function remoteOffGithub(value: string): boolean {
	const scp = /^(?:[^/@\s]+@)?([^/:\s]+):([^/].*)?$/.exec(value);
	let host = scp?.[1] ?? "";
	if (scp === null) {
		try { host = new URL(value).hostname; } catch { host = ""; }
	}
	if (host === "") return false;
	const name = host.toLowerCase();
	return name !== "github.com" && !name.endsWith(".github.com");
}

/** Which checkout a refused push was about: the CLI's own state git directory, or the operator's. */
export type GitDirKind = "state" | "own";

/** Refuses a push whose destination or credential path could be steered by config the CLI did not
 * write. The refusal names the git directory and the remedy that belongs to it: a state directory is
 * removed and cloned afresh on a fresh --dir, while a key in the operator's own checkout is unset. */
export function assertSafePushConfig(git: GitProbe, location: GitLocation, env: NodeJS.ProcessEnv, where: GitDirKind): void {
	const unsafe = unsafeGitConfigKeys(git, location, env, where);
	if (unsafe.length === 0) return;
	const remedy = where === "own"
		? "Remove each key from that checkout (`git config --local --unset <key>`) and rerun."
		: "Remove the state git directory and run again on a fresh --dir.";
	throw new CliError("GIT_CONFIG_UNSAFE", `Refusing to push: the git directory ${location.gitDir} holds config the CLI did not write (${unsafe.join(", ")}). ${remedy}`);
}
