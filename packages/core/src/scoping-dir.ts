// The one resolver for the deployment's private scoping store (K1/M1). The API and the verifier
// both call it, so one environment lands both processes on the same directory: an approval the
// API parks is the file the verifier's book reads. ACQUIT_SCOPING_DIR names the directory when a
// deployment sets one — the VM pins /var/lib/acquit/scoping this way, and a launcher that keeps
// earlier retained scoping files names their existing directory outright. The default lives in
// the deployment's private store, the one the M1 private case files already use
// (~/.config/acquit/private), in a per-database subdirectory so lanes never collide. It never
// sits beside the database: for a local or lane run that is inside a gitignored worktree, and a
// repository is exactly where private case files must not live. A default that would resolve
// inside a git work tree therefore refuses by name instead of parking private cases in a repo.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** The profile config root, the way the CLI's own login file resolves it: XDG, else the home's
 * .config, always resolved to an absolute path so a relative spelling cannot spin the guard's
 * walk. The private store beneath it is the deployment's, never the repo's. */
function configHome(env: NodeJS.ProcessEnv): string {
	const xdg = env.XDG_CONFIG_HOME?.trim();
	if (xdg) return resolve(xdg);
	const home = env.HOME?.trim();
	return resolve(join(home ? home : homedir(), ".config"));
}

/** The database the store scopes, resolved the way every reader resolves it. */
function databaseFile(env: NodeJS.ProcessEnv): string {
	return resolve(repoRoot, env.DATABASE_PATH?.trim() || "./data/acquit.db");
}

/** One store per database: the file's name plus a short digest of the resolved path, so two lanes
 * (or two worktrees) whose databases share a name still never share a directory. */
function storeKey(dbPath: string): string {
	return `${basename(dbPath)}-${createHash("sha256").update(dbPath).digest("hex").slice(0, 12)}`;
}

/** The guard the M1 private case file is held to, walked here: no ancestor of the store — the
 * directory itself included — may hold a git work tree. The check covers the default only; an
 * explicit ACQUIT_SCOPING_DIR is the deployment's own named directory, honored as given. */
function assertOutsideWorkTree(dir: string): void {
	for (let at = dir; ; at = dirname(at)) {
		if (existsSync(join(at, ".git"))) throw new Error(`The scoping store ${dir} sits inside a git work tree (${at} holds one); private case files never live in a repository. Name ACQUIT_SCOPING_DIR with a directory outside every repository.`);
		if (dirname(at) === at) break; // a spelling that can walk no further stops here instead of spinning
	}
}

export function resolveScopingDir(env: NodeJS.ProcessEnv): string {
	const override = env.ACQUIT_SCOPING_DIR?.trim() ?? "";
	if (override !== "") return override;
	const dir = join(configHome(env), "acquit", "private", "scoping", storeKey(databaseFile(env)));
	assertOutsideWorkTree(dir);
	return dir;
}
