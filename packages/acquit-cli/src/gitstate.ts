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

/** The answer a git probe gives: run.ts's GitRun and submit.ts's probe both fit this shape. */
export type GitResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

/** A git invocation the hardening helpers drive; run.ts's GitRun and submit.ts's probe both fit.
 * `timeoutMs` names this call's bound, so the caller that knows what the call does also names how
 * long it may take; the probe's own default applies when it is absent. */
export type GitProbe = (args: readonly string[], env?: NodeJS.ProcessEnv, timeoutMs?: number) => GitResult;

/**
 * The bound every remote call names: the clone, the rerun fetch, and every push alike, in both
 * commands. One owner, so a remote call cannot inherit the config scan's short local bound and the
 * two commands cannot drift. It is also `gitCli`'s default, which is the bound every call on that
 * port already had, local reads included.
 */
export const REMOTE_GIT_TIMEOUT_MS = 300_000;

/** The bound a local git call names: it reads files the machine already has, so a git that hangs on
 * it is broken rather than slow. The config scan that guards a scoped call is a local call too. */
export const LOCAL_GIT_TIMEOUT_MS = 15_000;

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
 * checkout: hooks and fsmonitor off, no credential helper, no ssh command, and no submodule
 * recursion of any kind. Command-line config outranks the checkout's local config and a planted
 * `.gitmodules`, so no fetched or pushed tree can make git spawn a child git in the work tree, where
 * the scoped askpass would ride along. The CLI's own askpass still supplies the credential.
 */
export function gitGuardArgs(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	const root = ensureStateRoot(env);
	return ["-c", `core.hooksPath=${emptyHooksDir(root)}`, "-c", "core.fsmonitor=false",
		"-c", "credential.helper=", "-c", "core.sshCommand=", "-c", "http.sslVerify=true", "-c", "http.proxy=",
		"-c", "submodule.recurse=false", "-c", "fetch.recurseSubmodules=false", "-c", "push.recurseSubmodules=no"];
}

/**
 * The transport overrides a token call to an https destination gets: the CLI mints every work-repo
 * URL on https, so a token call to one may use https and no other transport, whatever a scanned
 * checkout's config says. A destination that is not an https URL (a local bare path in a test or a
 * development fixture) keeps the default transports.
 */
export function tokenTransportArgs(destination: string): readonly string[] {
	return /^https:\/\//i.test(destination) ? ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"] : [];
}

/**
 * One remote spelling per repository: trim, drop trailing slashes and a `.git`, lowercase. The CLI
 * clones the work repo and every token call names the same URL, so an exact comparison after this
 * normalization is the origin check that matters; no host parsing is involved, because WHATWG's URL
 * parser and git disagree about values like `http://github.com\@127.0.0.1/...`.
 */
export function sameRemote(left: string, right: string): boolean {
	const normalize = (value: string) => value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
	return normalize(left) === normalize(right);
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
 * One entry of the scan: the key exactly as git listed it (git lowercases the section and the name
 * and keeps a URL subsection's case, so a policy can name `remote.origin.url` and mean that remote
 * alone), the value git resolved for that entry, and git's own boolean reading of it on demand.
 */
type ConfigEntry = {
	readonly key: string;
	readonly value: string;
	readonly readsTrue: () => boolean;
};

/**
 * One rule of a config policy: the keys it judges, what it says about them, and, where the value is
 * what matters, the values it acts on. A `keep` rule is an entry of a state checkout's allowlist; a
 * `refuse` rule is an entry of an own checkout's denylist.
 */
type ConfigRule = {
	readonly key: RegExp;
	readonly verdict: "keep" | "refuse";
	/** Whether this entry is one the rule acts on; every entry it matches when absent. `sameKey` holds
	 * every resolved entry that carries this exact key, so a rule can judge how many values git read. */
	readonly when?: (entry: ConfigEntry, sameKey: readonly ConfigEntry[]) => boolean;
};

/** What a key no rule matches gets: a state checkout refuses it, an operator's own checkout keeps it. */
type ConfigPolicy = { readonly unlisted: "keep" | "refuse"; readonly rules: readonly ConfigRule[] };

/** The refspec a clone writes, and the one the rerun fetch names when it fetches the work-repo URL
 * directly: the state policy keeps only this refspec, and the fetch and the policy share the string. */
export const DEFAULT_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/**
 * The state policy: the CLI writes every byte of a state git directory's config, so the scan keeps
 * exactly the keys its own `git clone --template= --separate-git-dir` writes under the hardened env,
 * plus the commit identity `seedCommitIdentity` copies in, and refuses every other key from every
 * scope. `core.symlinks`, `core.ignorecase`, `core.precomposeunicode`, and
 * `extensions.objectformat` are on the list because git itself writes them: init writes the first
 * where the work tree cannot hold symlinks, the second where the filesystem folds case, the third
 * where it decomposes UTF-8, and `initialize_repository_version` writes the fourth for a clone that
 * is not sha1. A value that steers a scoped call is judged where the value matters.
 *
 * `remote.origin.url` keeps only when it is the one URL the CLI cloned and this token call names:
 * the call never lets git resolve the destination from config, and the exact comparison keeps the
 * checkout honest, so a lookalike value or a second value refuses instead of being read.
 */
function stateConfig(workRepoUrl: string): ConfigPolicy {
	return {
		unlisted: "refuse",
		rules: [
			{ key: /^core\.repositoryformatversion$/, verdict: "keep" },
			{ key: /^core\.filemode$/, verdict: "keep" },
			{ key: /^core\.bare$/, verdict: "keep", when: entry => !entry.readsTrue() },
			{ key: /^core\.logallrefupdates$/, verdict: "keep" },
			{ key: /^core\.symlinks$/, verdict: "keep" },
			{ key: /^core\.ignorecase$/, verdict: "keep" },
			{ key: /^core\.precomposeunicode$/, verdict: "keep" },
			{ key: /^extensions\.objectformat$/, verdict: "keep", when: entry => entry.value === "sha1" || entry.value === "sha256" },
			{ key: /^remote\.origin\.url$/, verdict: "keep",
				when: (entry, sameKey) => sameKey.length === 1 && sameRemote(entry.value, workRepoUrl) },
			{ key: /^remote\.origin\.fetch$/, verdict: "keep", when: entry => entry.value === DEFAULT_FETCH_REFSPEC },
			{ key: /^branch\..+\.remote$/, verdict: "keep", when: entry => entry.value === "origin" },
			{ key: /^branch\..+\.merge$/, verdict: "keep" },
			{ key: /^user\.name$/, verdict: "keep" },
			{ key: /^user\.email$/, verdict: "keep" },
		],
	};
}

/**
 * The own policy: the operator's own config is theirs, so only the keys that can steer a scoped call
 * refuse. Git reads `remote.<url>.*` for a push that names that URL, and a remote nickname cannot
 * hold a slash, so a `remote.<name>.url` whose name is a URL refuses: a planted `.url`, `.pushurl`,
 * or `.proxy` there is the destination or the proxy for the CLI's token.
 */
const OWN_CONFIG: ConfigPolicy = {
	unlisted: "keep",
	rules: [
		// `pushInsteadOf` rewrites a push to the URL the command names, exactly as `insteadOf` does.
		{ key: /^url\..+\.(push)?insteadof$/, verdict: "refuse" },
		{ key: /\.pushurl$/, verdict: "refuse" },
		{ key: /^remote\..+\.url$/, verdict: "refuse", when: entry => urlNamed(entry.key) },
		{ key: /^remote\..+\.proxy$/, verdict: "refuse" },
		{ key: /^remote\..+\.proxyauthmethod$/, verdict: "refuse" },
		// A URL-scoped key outranks the guard's plain `-c` override, so `http.<url>.proxy`,
		// `http.<url>.sslVerify`, and `http.<url>.extraHeader` are refused here or one can move a
		// credential-bearing request, turn off TLS verification, or add a header to the scoped push.
		// A CA key refuses in both shapes: a planted bundle makes git trust a substituted certificate.
		{ key: /^http\.(?:.+\.)?(?:proxy|extraheader|sslcainfo|sslcapath)$/, verdict: "refuse" },
		{ key: /^http\.(?:.+\.)?sslverify$/, verdict: "refuse", when: entry => !entry.readsTrue() },
		{ key: /^core\.(?:sshcommand|hookspath|fsmonitor)$/, verdict: "refuse" },
		{ key: /^credential(?:\.|$)/, verdict: "refuse" },
		{ key: /^include(?:\.|$)/, verdict: "refuse" },
		{ key: /^includeif\./, verdict: "refuse" },
	],
};

/** Whether a matching entry leaves the scoped token unsafe. A `keep` rule that does not act on a key
 * it matches, and a `refuse` rule that does, both leave it unsafe; a key no rule matches gets the
 * policy's own default. */
function unsafeEntry(policy: ConfigPolicy, entry: ConfigEntry, sameKey: readonly ConfigEntry[]): boolean {
	for (const rule of policy.rules) {
		if (!rule.key.test(entry.key)) continue;
		const acts = rule.when === undefined || rule.when(entry, sameKey);
		return rule.verdict === "keep" ? !acts : acts;
	}
	return policy.unlisted === "refuse";
}

/** Whether a `remote.<name>.url` key's name is a URL rather than a remote nickname. */
function urlNamed(key: string): boolean {
	return (/^remote\.(.+)\.url$/.exec(key)?.[1] ?? "").includes("/");
}

/**
 * Config a scoped-token command would read that the CLI refuses: a state checkout may hold only the
 * keys the CLI's own clone wrote, while an operator's own checkout is judged key by key, because
 * that config is theirs. Either policy answers one question: could this entry send the scoped token
 * somewhere the job's work repo is not, or turn off the verification of where it goes.
 *
 * The scan runs git with the command's own location arguments and guard, and no `--local`, so the
 * keys judged are the keys git resolves for that command, a worktree config included. `--show-scope`
 * names the file each key came from: the CLI's own `-c` guard is skipped by scope, and a system or
 * global key refuses outright, because the CLI hides both files, so git naming either one means this
 * child is not the one the command uses and no key-by-key judgement of that file can be trusted.
 *
 * `workRepoUrl` is the exact URL this token call names, the one the CLI minted. The state policy
 * judges the checkout's origin against it, so a value the CLI did not clone from refuses.
 */
export function unsafeGitConfigKeys(git: GitProbe, location: GitLocation, env: NodeJS.ProcessEnv, where: GitDirKind,
	workRepoUrl: string): readonly string[] {
	const policy = where === "state" ? stateConfig(workRepoUrl) : OWN_CONFIG;
	const listed = git([...checkoutGitArgs(location, env, ["config", "--list", "--show-scope", "--no-includes", "-z"])], env, LOCAL_GIT_TIMEOUT_MS);
	if (listed.status !== 0) {
		throw new CliError("GIT_FAILED", `Reading the git config of the job's state directory failed. ${listed.stderr.trim().slice(0, 200)}`.trim());
	}
	// `--show-scope -z` writes `scope\0key\nvalue\0` per value and `scope\0key\0` for a key with no
	// value, so the fields alternate and a value may hold newlines of its own.
	const fields = listed.stdout.split("\0");
	const entries: ConfigEntry[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const scope = fields[index].trim();
		const record = fields[index + 1];
		const newline = record.indexOf("\n");
		// The key as git listed it: the section and the name are lowercased and a URL subsection keeps
		// its case, so the state policy can name one remote exactly while the refusal reports the
		// lowercased spelling.
		const key = (newline === -1 ? record : record.slice(0, newline)).trim();
		const value = newline === -1 ? "" : record.slice(newline + 1).trim();
		// The `command` scope is the CLI's own `-c` guard, which outranks every file and is the guard
		// itself. Any other scope is a file the CLI did not hand this child.
		if (scope === "command") continue;
		if (scope !== "local" && scope !== "worktree") {
			throw new CliError("GIT_CONFIG_UNSAFE", `Refusing to run git with the scoped token: git read ${scope} config for ${location.gitDir} (${key}) although the CLI hides `
				+ "every config file but the checkout's own. Rerun with a clean environment: a GIT_CONFIG_* variable or a git wrapper is overriding the CLI's own.");
		}
		entries.push({ key, value, readsTrue: () => gitReadsTrue(git, location, env, key) });
	}
	// Every resolved value of a key, so a rule can judge multiplicity: the state origin must be
	// exactly one value, whatever that value is.
	const byKey = new Map<string, ConfigEntry[]>();
	for (const entry of entries) byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
	const unsafe = new Set<string>();
	for (const entry of entries) {
		if (unsafeEntry(policy, entry, byKey.get(entry.key) ?? [entry])) unsafe.add(entry.key.toLowerCase());
	}
	return [...unsafe].sort();
}

/**
 * Whether git reads every value of `key` as boolean true. The scan asks git rather than spelling
 * git's false forms itself: an empty value, `00`, `0x0`, and `0k` are all false to git, and a value
 * git cannot parse must refuse too. A listed key git cannot answer for is refused, never trusted.
 */
function gitReadsTrue(git: GitProbe, location: GitLocation, env: NodeJS.ProcessEnv, key: string): boolean {
	const answer = git([...checkoutGitArgs(location, env, ["config", "--no-includes", "--bool", "--get-all", key])], env, LOCAL_GIT_TIMEOUT_MS);
	if (answer.status !== 0) return false;
	const values = answer.stdout.split("\n").map(line => line.trim()).filter(line => line !== "");
	return values.length > 0 && values.every(value => value === "true");
}

/** Which checkout a refused command was about: the CLI's own state git directory, or the operator's. */
export type GitDirKind = "state" | "own";

/** Refuses a git command that carries the CLI's scoped token when the location it reads holds config
 * the CLI did not write. The refusal names the git directory and the remedy that belongs to it: a
 * state directory is removed and cloned afresh on a fresh --dir, while a key in the operator's own
 * checkout is unset. `workRepoUrl` is the URL this call names, which the state policy judges the
 * checkout's origin against. */
export function assertSafeScopedConfig(git: GitProbe, location: GitLocation, env: NodeJS.ProcessEnv, where: GitDirKind,
	workRepoUrl: string): void {
	const unsafe = unsafeGitConfigKeys(git, location, env, where, workRepoUrl);
	if (unsafe.length === 0) return;
	const remedy = where === "own"
		? "Remove each key from that checkout (`git config --local --unset <key>`) and rerun."
		: "Remove the state git directory and run again on a fresh --dir.";
	throw new CliError("GIT_CONFIG_UNSAFE", `Refusing to run git with the scoped token: the git directory ${location.gitDir} holds config `
		+ `the CLI did not write (${unsafe.join(", ")}). ${remedy}`);
}

/**
 * One git command that carries the CLI's scoped work-repo token. There is one way a command gets that
 * token: this function scans the config of the location that command reads first, with the command's
 * own location arguments and the same hardened env, and only then runs git with the askpass added. So
 * a token never meets config the CLI did not write, whether the command is a push or a rerun's fetch.
 * Every remote-reaching command the scoped token drives goes through here; a local-only command runs
 * on the hardened env alone and never carries the askpass.
 *
 * `workRepoUrl` is the exact URL the call names, the one the CLI minted: the scan judges the state
 * checkout's origin against it, and an https URL settles the transport as https only. The args
 * themselves name that URL, never a remote name git would resolve from config.
 *
 * The bounds are the two this call knows apart: the scan reads files the machine already has and gets
 * `LOCAL_GIT_TIMEOUT_MS`, while the call that carries the token to a remote gets
 * `REMOTE_GIT_TIMEOUT_MS`. Both are named here, so no scoped call can inherit the scan's short bound.
 */
export function scopedGit(git: GitProbe, location: GitLocation, env: NodeJS.ProcessEnv, askpass: NodeJS.ProcessEnv,
	where: GitDirKind, workRepoUrl: string, args: readonly string[]): GitResult {
	assertSafeScopedConfig(git, location, env, where, workRepoUrl);
	return git(checkoutGitArgs(location, env, [...tokenTransportArgs(workRepoUrl), ...args]), { ...env, ...askpass }, REMOTE_GIT_TIMEOUT_MS);
}
