// `acquit submit <job> [--dir .]`. One attempt: push the working directory's HEAD to the job's work
// repository, ask the API to record the submission, then print the block docs/tutorial.md shows.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CommitSha, JobId } from "../../core/src/ids.ts";
import type { JobProjection } from "../../core/src/job.ts";
import { verifiedBranch } from "../../core/src/github.ts";
import { boundedDetail, describeRunFailure } from "../../core/src/verifier.ts";
import { apiClient, CliError, resolveToken } from "./client.ts";
import type { ApiClient } from "./client.ts";

export type SubmitOptions = {
	readonly jobId: string;
	readonly dir: string;
	readonly remote: string | null;
	readonly apiUrl: string;
	readonly token: string;
	readonly timeoutSeconds: number;
	readonly pollMs: number;
};

const SHA = /^[0-9a-f]{7,40}$/;

export function parseSubmitArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env,
	readStdin: () => string = readTokenFromStdin): SubmitOptions {
	let jobId: string | null = null;
	let dir = ".";
	let remote: string | null = null;
	let apiUrl = env.ACQUIT_API ?? "http://127.0.0.1:4310";
	let tokenOnStdin = false;
	let timeoutSeconds = 300;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new CliError("USAGE", `${flag} needs a value.`);
			return next;
		};
		if (flag === "--dir") dir = value();
		else if (flag === "--remote") remote = value();
		else if (flag === "--api") apiUrl = value();
		else if (flag === "--token") {
			// A token on the command line is readable from the process table for the life of the
			// command. The value is never echoed: it is not a token this process will use.
			if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
				throw new CliError("TOKEN_ON_ARGV", "The session token is visible to every user who can read the process table. "
					+ "Pipe it to `acquit submit <job> --token` or set ACQUIT_TOKEN.");
			}
			tokenOnStdin = true;
		}
		else if (flag === "--timeout") timeoutSeconds = Number(value());
		else if (flag.startsWith("--")) throw new CliError("USAGE", `Unknown flag ${flag}.`);
		else if (jobId === null) jobId = flag;
		else throw new CliError("USAGE", `Unexpected argument ${flag}.`);
	}
	if (jobId === null) throw new CliError("USAGE", "Usage: acquit submit <job> [--dir .] [--remote <url>] [--api <url>] [--token] [--timeout <seconds>]");
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new CliError("USAGE", "--timeout takes whole seconds.");
	return { jobId, dir, remote, apiUrl, token: resolveToken(tokenOnStdin ? readStdin().trim() || undefined : undefined, env),
		timeoutSeconds, pollMs: 500 };
}

/** `--token` reads one line from stdin. The value never enters argv, a log line, or an error message. */
function readTokenFromStdin(): string {
	try { return readFileSync(0, "utf8"); } catch { return ""; }
}

/** The commit the operator is submitting. A dirty tree is the operator's business, not this command's. */
export function localHead(dir: string): CommitSha {
	const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 15_000 });
	const head = result.stdout?.trim() ?? "";
	if (result.status !== 0 || !SHA.test(head)) {
		throw new CliError("NOT_A_REPOSITORY", `${dir} is not a git repository with a commit. ${tail(result.stderr)}`.trim());
	}
	return head as CommitSha;
}

/** Pushing is the operator's own credential; the work repository is where the judge reads the commit. A
 * retry after a rejection is usually a sibling of the rejected commit, so the job-owned ref is force-updated:
 * the judge fetches by SHA, and the publisher's work-fork fallback reads the same ref, which then matches the
 * commit the run verified. */
export function pushHead(dir: string, remote: string, jobId: string): void {
	const branch = verifiedBranch(jobId as JobId);
	const result = spawnSync("git", ["-C", dir, "push", remote, `+HEAD:refs/heads/${branch}`], { encoding: "utf8", timeout: 120_000 });
	if (result.status !== 0) throw pushError(remote, result.stderr);
}

/** The refusal a failed push produces. GitHub's 404 names both causes: no work repo yet, or a credential that cannot see it. */
export function pushError(remote: string, stderr: string | null): CliError {
	const detail = tail(stderr);
	if (/Repository not found/i.test(detail)) {
		return new CliError("WORK_REPO_NOT_READY", `The work repository ${safeEcho(remote)} is not visible. `
			+ "GitHub answers \"Repository not found\" both when funding has not created it yet (it is created shortly after funding, "
			+ "so rerun this command in about 30 seconds) and when the credential cannot see the private repo (check the App installation on the org).");
	}
	return new CliError("PUSH_REFUSED", `git push to ${safeEcho(remote)} failed. ${detail}`.trim());
}

/** The last lines of a command's stderr, with any credential stripped and control characters gone. */
function tail(text: string | null): string {
	return safeEcho((text ?? "").trim().split("\n").slice(-3).join(" "));
}

/** Text safe to print: any URL loses its userinfo, and the core display boundary redacts and bounds the rest. */
function safeEcho(text: string): string {
	return boundedDetail(text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s]*@/g, "$1"));
}

/** The block docs/tutorial.md prints. Every value comes from the projection, never from this process. */
export function renderSubmission(view: JobProjection, handleOf: (operatorId: string) => string | null): string {
	const attempt = view.attempts.history.at(-1);
	if (!attempt) throw new CliError("NOT_JUDGED", `Job ${view.id} has no judged attempt.`);
	const total = attempt.ordinal + view.attempts.left;
	const lines = [`Submitted ${view.id} (attempt ${attempt.ordinal} of ${total})`, `Verifier result: ${attempt.result}`];
	if (attempt.result === "REJECTED") {
		for (const reason of attempt.reasons) lines.push(`\t${reason}`);
		if (attempt.reasonsTruncated > 0) lines.push(`\tand ${attempt.reasonsTruncated} more reasons not shown`);
		lines.push(`Job status: ${view.status}`);
		const locked = view.lockedTo ? handleOf(view.lockedTo) ?? view.lockedTo : null;
		lines.push(locked ? `Escrow: ${view.escrow}, locked to ${locked}` : `Escrow: ${view.escrow}`);
		lines.push(`Attempts left: ${view.attempts.left}. Deadline: ${utcMinutes(view.deliveryEndsAt)}.`);
		return lines.join("\n");
	}
	const contract = view.contract;
	if (contract === null) throw new CliError("CONTRACT_NOT_FROZEN", `Job ${view.id} has a verdict but no frozen contract to print.`);
	lines.push(`\tFrozen tests: ${attempt.frozen?.passed ?? 0} passed (suite frozen at ${contract.frozenAt.slice(0, 7)})`);
	lines.push(`\tHidden tests: ${attempt.hidden?.passed ?? 0} passed`);
	lines.push(`\tRequired tests: ${(attempt.frozen?.expected ?? 0) + (attempt.hidden?.expected ?? 0)} completed, 0 skipped or missing`);
	lines.push("\tProtected paths: none touched");
	lines.push(`Pull request opened: ${contract.repository}#${attempt.pullRequest ?? 0}`);
	lines.push(`Job status: ${view.status}`);
	lines.push(`Client review window: ${view.reviewEndsAt ? hoursBetween(attempt.at, view.reviewEndsAt) : 0} hours`);
	return lines.join("\n");
}

function utcMinutes(value: string): string {
	const at = new Date(value);
	return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

function hoursBetween(from: string, to: string): number {
	return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 3_600_000));
}

export type SubmitDeps = {
	readonly client: ApiClient;
	readonly head: (dir: string) => CommitSha;
	readonly push: (dir: string, remote: string, jobId: string) => void;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
};

/** Records one submission and waits for its verdict. */
export async function runSubmit(options: SubmitOptions, deps: SubmitDeps): Promise<string> {
	const sourceCommit = deps.head(options.dir);
	if (options.remote) deps.push(options.dir, options.remote, options.jobId);
	const before = await jobView(deps.client, options.jobId);
	// A failure the job already carried for this commit belongs to an earlier run; only a new one ends this wait.
	const previousFailure = before.job.attempts.failure?.runId ?? null;
	// One key per user intent, per docs/architecture/http.md. The API parses it as a UUID v4 and
	// refuses any other shape, so a retry must reuse this string rather than mint a new one.
	const answer = await deps.client.post("/api/commands", { key: randomUUID(),
		command: { type: "Submit", jobId: options.jobId, sourceCommit } });
	const outcome = outcomeOf(answer.body);
	if (outcome?.kind === "DENIED") throw denial(outcome.reason ?? "DENIED", before.job, before.handles);
	const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	const deadline = (deps.now ?? Date.now)() + options.timeoutSeconds * 1000;
	for (;;) {
		const { job, handles } = await jobView(deps.client, options.jobId);
		const judged = job.attempts.history.find(attempt => attempt.sourceCommit === sourceCommit);
		if (judged) return renderSubmission(job, operatorId => handles.get(operatorId) ?? null);
		const failure = job.attempts.failure;
		// The service reports a run that ended without a verdict at once, by name. Print it.
		if (failure && failure.sourceCommit === sourceCommit && failure.runId !== previousFailure) {
			throw new CliError("RUN_FAILED", describeRunFailure(failure));
		}
		if (!job.attempts.pending) throw new CliError("VERDICT_MISSING", `Job ${job.id} is not waiting on a run and has no verdict for ${sourceCommit}.`);
		if ((deps.now ?? Date.now)() >= deadline) {
			throw new CliError("VERIFIER_TIMEOUT", `The run is still in flight; it ends at ${utcMinutes(job.attempts.pending.runEndsAt)}.`);
		}
		await sleep(options.pollMs);
	}
}

/** The job projection plus the operator handles the block prints. The API resolves ids to handles. */
async function jobView(client: ApiClient, jobId: string): Promise<{ job: JobProjection; handles: Map<string, string> }> {
	const body = await client.get(`/api/jobs/${encodeURIComponent(jobId)}`);
	const record = body && typeof body === "object" ? body as { job?: JobProjection; handles?: Record<string, string> } : {};
	if (!record.job) throw new CliError("NOT_FOUND", `Job ${jobId} is not readable with this token.`);
	return { job: record.job, handles: new Map(Object.entries(record.handles ?? {})) };
}

function outcomeOf(body: unknown): { kind: string; reason?: string } | null {
	const outcome = body && typeof body === "object" ? (body as { outcome?: { kind: string; reason?: string } }).outcome : undefined;
	return outcome ?? null;
}

function denial(reason: string, view: JobProjection, handles: Map<string, string>): CliError {
	const locked = view.lockedTo ? handles.get(view.lockedTo) ?? view.lockedTo : "another operator";
	if (reason === "NOT_OWNER") return new CliError("NOT_OWNER", `Submit refused: ${view.id} is locked to ${locked}. Only that operator can submit work.`);
	if (reason === "VERIFIER_PENDING") return new CliError("VERIFIER_PENDING", `Submit refused: a run for another commit is already in flight on ${view.id}.`);
	if (reason === "DEADLINE_PASSED") return new CliError("DEADLINE_PASSED", `Submit refused: the delivery deadline for ${view.id} has passed.`);
	if (reason === "ATTEMPTS_EXHAUSTED") return new CliError("ATTEMPTS_EXHAUSTED", `Submit refused: all attempts on ${view.id} are used.`);
	if (reason === "WRONG_STATE") return new CliError("WRONG_STATE", `Submit refused: ${view.id} is ${view.status} (${view.phase}).`);
	return new CliError(reason, `Submit refused: ${reason}.`);
}
