// `acquit diff <job> [--dir .]`. The work repo diff for the job: the frozen commit against the judged
// submission when the local checkout holds it, otherwise against the checkout's HEAD. Like `submit`,
// this reads the operator's own clone with git; nothing leaves the machine but the job read.

import { spawnSync } from "node:child_process";
import type { JobProjection } from "../../core/src/job.ts";
import { CliError, apiFlag, readLogin, resolveToken } from "./client.ts";
import type { ApiClient } from "./client.ts";

export type DiffOptions = { readonly apiUrl: string; readonly token: string; readonly jobId: string; readonly dir: string };

export type GitResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };
export type GitRunner = (dir: string, args: readonly string[]) => GitResult;

export type DiffDeps = { readonly client: ApiClient; readonly git?: GitRunner };

export function parseDiffArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): DiffOptions {
	const { apiUrl, rest } = apiFlag(argv, env);
	let jobId: string | null = null;
	let dir = ".";
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		if (flag === "--dir") {
			const next = rest[++index];
			if (next === undefined) throw new CliError("USAGE", "--dir needs a value.");
			dir = next;
		} else if (flag.startsWith("--")) throw new CliError("USAGE", `Unknown flag ${flag}.`);
		else if (jobId === null) jobId = flag;
		else throw new CliError("USAGE", `Unexpected argument ${flag}.`);
	}
	if (jobId === null) throw new CliError("USAGE", "Usage: acquit diff <job> [--dir .] [--api <url>]");
	return { apiUrl, token: resolveToken(undefined, env, () => readLogin(env)?.token ?? null), jobId, dir };
}

const defaultGit: GitRunner = (dir, args) => {
	const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30_000 });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * git's own index header (`diff --git`, `index`) is not part of the patch the tutorial shows, so it is
 * dropped. Everything else — modes, renames, binary notices, hunks — is printed as git wrote it.
 */
export function renderPatch(patch: string): string {
	return patch.split("\n").filter(line => !line.startsWith("diff --git ") && !line.startsWith("index ")).join("\n").trimEnd();
}

export async function runDiff(options: DiffOptions, deps: DiffDeps): Promise<string> {
	const body = await deps.client.get(`/api/jobs/${encodeURIComponent(options.jobId)}`) as { job?: JobProjection } | null;
	const job = body?.job;
	if (!job) throw new CliError("NOT_FOUND", `Job ${options.jobId} is not readable with this token.`);
	const frozen = job.contract?.frozenAt;
	if (!frozen) throw new CliError("CONTRACT_NOT_FROZEN", `Job ${options.jobId} has no frozen contract to compare against.`);
	const git = deps.git ?? defaultGit;
	// The judged tree is what the frozen commit was last compared against, but a rerun leaves newer
	// work in the checkout. Prefer a local HEAD that descends from the frozen commit; only a checkout
	// still sitting on the frozen commit has no newer work, so there the judged submission is shown.
	const judged = job.attempts?.history?.at(-1)?.sourceCommit ?? null;
	const judgedHere = judged !== null && git(options.dir, ["cat-file", "-e", `${judged}^{commit}`]).status === 0;
	const local = git(options.dir, ["rev-parse", "HEAD"]);
	const localHead = local.status === 0 ? local.stdout.trim() : "";
	const newer = localHead !== "" && localHead !== frozen
		&& git(options.dir, ["merge-base", "--is-ancestor", frozen, localHead]).status === 0;
	const head = newer ? "HEAD" : judgedHere ? judged : "HEAD";
	// One line of context: the tutorial's hunks are printed that way, and a review reads the change.
	const patch = git(options.dir, ["diff", "--no-color", "--unified=1", frozen, head]);
	if (patch.status !== 0) {
		const detail = patch.stderr.trim().replace(/\s+/g, " ").slice(0, 200);
		throw new CliError("DIFF_FAILED", `git diff failed in ${options.dir}.${detail ? ` ${detail}` : ""}`);
	}
	return renderPatch(patch.stdout);
}
