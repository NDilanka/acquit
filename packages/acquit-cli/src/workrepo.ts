// The credential a push into the job's work repository uses. The API mints one token scoped to that
// repository alone; git reads it from a 0600 file named by a constant 0700 askpass script in a
// mkdtemp directory removed on every exit. The token is never an argv word, a printed line, or a
// value in the environment of a child that does not need it: the script knows the file path itself,
// so git's environment carries no token-bearing variable at all.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workRepoName } from "../../core/src/github.ts";
import type { JobId } from "../../core/src/ids.ts";
import { CliError } from "./client.ts";

/** A mkdtemp directory that holds the secret files for one push and is removed on every exit. */
export function makeSecretDir(): { readonly path: string; readonly remove: () => void } {
	const path = mkdtempSync(join(tmpdir(), "acquit-run-"));
	return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/** A path as one single-quoted shell word, so a path with a quote can never break the script. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function askpassScript(tokenFile: string): string {
	return `#!/bin/sh
# The token file path is written here; this script holds no secret and needs no variable.
case "$1" in
	*[Uu]sername*) printf '%s\\n' x-access-token ;;
	*) cat ${shellQuote(tokenFile)} ;;
esac
`;
}

/** The git credential for one push: a constant 0700 askpass script plus the 0600 token file it reads.
 * The script embeds the token file path, so git's environment carries no secret-bearing variable. */
export function writeAskpass(dir: string, token: string): { readonly env: NodeJS.ProcessEnv; readonly script: string; readonly tokenFile: string } {
	const tokenFile = join(dir, "token");
	const script = join(dir, "askpass.sh");
	writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
	chmodSync(tokenFile, 0o600);
	writeFileSync(script, askpassScript(tokenFile), { mode: 0o700 });
	chmodSync(script, 0o700);
	return { tokenFile, script, env: { GIT_ASKPASS: script } };
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

/** The clone URL of the work repo the API named, so the CLI never guesses a repository. */
export function workRepoUrl(repository: string): string {
	return `https://github.com/${repository}.git`;
}

/** The environment a child gets: the operator's, minus the two secrets this CLI itself holds and
 * the token-path variable an older build used. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child = { ...env };
	delete child.ACQUIT_TOKEN;
	delete child.ACQUIT_PROVIDER_KEY;
	delete child.ACQUIT_RUN_TOKEN_FILE;
	return child;
}

/** The host and repository name a remote URL points at, in any spelling git accepts: an https or ssh
 * URL, or the scp-like `git@host:owner/name`. Null when the text names no repository path. */
function remoteParts(url: string): { readonly host: string; readonly name: string } | null {
	const text = url.trim();
	const scp = /^[^/@\s]+@([^/:\s]+):(.+)$/.exec(text);
	let host = scp?.[1] ?? "";
	let path = scp?.[2] ?? "";
	if (scp === null) {
		try {
			const parsed = new URL(text);
			host = parsed.hostname;
			path = parsed.pathname;
		} catch { return null; }
	}
	if (host === "") return null;
	const name = (path.replace(/\/+$/, "").split("/").at(-1) ?? "").replace(/\.git$/i, "");
	return name === "" ? null : { host: host.toLowerCase(), name };
}

/** Whether a remote URL names the job's work repository. The API mints that repository from the
 * contract's repository and the job id, so the name is recognizable here without a token. Only a
 * github.com URL can be the work repo: the CLI builds every work-repo URL on that host. */
export function remoteNamesWorkRepo(url: string, repository: string, jobId: string): boolean {
	const remote = remoteParts(url);
	if (remote === null || remote.host !== "github.com") return false;
	try {
		return remote.name.toLowerCase() === workRepoName(repository, jobId as JobId).toLowerCase();
	} catch {
		// A repository string the API would not have frozen into a contract names no work repo.
		return false;
	}
}

/** The handlers a signal runs while a secret directory exists: a signal must not leave the
 * credential on disk. The returned function removes them. */
export function secretGuard(remove: () => void, ports: { readonly exit?: (code: number) => void } = {}): () => void {
	const exit = ports.exit ?? ((code: number) => process.exit(code));
	const onInterrupt = () => { remove(); exit(130); };
	const onTerminate = () => { remove(); exit(143); };
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onTerminate);
	return () => { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); };
}
