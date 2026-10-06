// The per-run mirror. The judge reads commits with plain git, so the service hands it a local bare
// repository holding both: the submitted commit from the job's work repo, and the frozen commit from
// the work repo (its base) or, failing that, from the client repo. The installation token rides in a
// git `http.extraHeader` read from a 0600 config file: never in a URL, never in argv.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workRepoName } from "../core/src/github.ts";
import type { CommitSha } from "../core/src/ids.ts";
import type { VerifierRunRequest } from "../core/src/verifier.ts";
import { gitSource } from "./judge.ts";
import type { RunSource } from "./service.ts";

/** Every way the source can refuse. The code is the name an operator acts on. */
export type SourceFailureCode = "SUBMITTED_COMMIT_UNFETCHABLE" | "FROZEN_COMMIT_UNFETCHABLE" | "GIT_UNAVAILABLE";

export class SourceUnavailable extends Error {
	readonly code: SourceFailureCode;
	constructor(code: SourceFailureCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "SourceUnavailable";
		this.code = code;
	}
}

export type GitResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };
export type GitRun = (args: readonly string[], env: NodeJS.ProcessEnv) => GitResult;

export type RunSourceOptions = {
	/** The organization that holds one work repository per job. */
	readonly organization: string;
	readonly tokenFor: (owner: string) => Promise<string>;
	readonly timeoutMs?: number;
	readonly git?: GitRun;
	readonly makeDir?: (label: string) => string;
	readonly removeDir?: (path: string) => void;
};

export function createRunSource(options: RunSourceOptions): (request: VerifierRunRequest) => Promise<RunSource> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const git = options.git ?? ((args: readonly string[], env: NodeJS.ProcessEnv) => defaultGit(args, env, timeoutMs));
	const makeDir = options.makeDir ?? ((label: string) => mkdtempSync(join(tmpdir(), `${label}-`)));
	const removeDir = options.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
	return async request => {
		const done = request.definitionOfDone;
		const workRepo = `${options.organization}/${workRepoName(done.issue.repository, request.jobId)}`;
		const dir = makeDir(`acquit-mirror-${request.runId}`);
		try {
			run(dir, ["-C", dir, "init", "--bare", "--quiet"]);
			await fetchCommit(dir, workRepo, request.sourceCommit, "SUBMITTED_COMMIT_UNFETCHABLE");
			if (!hasCommit(dir, done.frozenAt)) {
				try {
					await fetchCommit(dir, workRepo, done.frozenAt, "FROZEN_COMMIT_UNFETCHABLE");
				} catch (error) {
					if (!(error instanceof SourceUnavailable)) throw error;
					// The work repo does not carry the frozen commit; the client repo is where it was frozen.
					await fetchCommit(dir, done.issue.repository, done.frozenAt, "FROZEN_COMMIT_UNFETCHABLE");
				}
			}
			return { source: gitSource(dir), remove: () => removeDir(dir) };
		} catch (error) {
			removeDir(dir);
			throw error;
		}

		function run(cwd: string, args: readonly string[]): GitResult {
			const result = git(args, { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
			if (result.status === null) throw new SourceUnavailable("GIT_UNAVAILABLE", `git ${args[0] ?? ""} could not start.`);
			if (result.status !== 0) throw new SourceUnavailable("GIT_UNAVAILABLE", `git ${args[0] ?? ""} failed: ${tail(result.stderr)}`);
			return result;
		}

		function hasCommit(cwd: string, commit: CommitSha): boolean {
			return git(["-C", cwd, "cat-file", "-e", `${commit}^{commit}`],
				{ PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }).status === 0;
		}

		async function fetchCommit(cwd: string, repository: string, commit: CommitSha, code: SourceFailureCode): Promise<void> {
			const owner = repository.split("/")[0];
			const token = await options.tokenFor(owner);
			const configPath = join(cwd, "gitconfig");
			writeFileSync(configPath, `[http "https://github.com/"]\n\textraHeader = Authorization: Bearer ${token}\n`, { mode: 0o600 });
			chmodSync(configPath, 0o600);
			let result: GitResult;
			try {
				result = git(["-C", cwd, "-c", "credential.helper=", "-c", "protocol.version=2", "fetch", "--no-tags", "--quiet",
					`https://github.com/${repository}.git`, commit],
				{ PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: configPath, GIT_TERMINAL_PROMPT: "0" });
			} finally {
				rmSync(configPath, { force: true });
			}
			if (result.status !== 0) throw new SourceUnavailable(code, `${repository} ${commit.slice(0, 12)}: ${tail(result.stderr)}`);
		}
	};
}

function defaultGit(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): GitResult {
	const result = spawnSync("git", [...args], { encoding: "utf8", timeout: timeoutMs, env });
	if (result.error) return { status: null, stdout: "", stderr: String(result.error.message) };
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function tail(text: string): string {
	return text.trim().split("\n").slice(-2).join(" ").slice(0, 300);
}
