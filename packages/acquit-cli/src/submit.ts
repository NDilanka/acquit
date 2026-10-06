// `acquit submit <job> [--dir .]`. One attempt: push the working directory's HEAD to the job's work
// repository, ask the API to record the submission, then print the block docs/tutorial.md shows.

import { spawnSync } from "node:child_process";
import type { CommitSha, JobId } from "../../core/src/ids.ts";
import type { JobProjection } from "../../core/src/job.ts";
import { verifiedBranch } from "../../core/src/github.ts";
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

export function parseSubmitArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): SubmitOptions {
	let jobId: string | null = null;
	let dir = ".";
	let remote: string | null = null;
	let apiUrl = env.ACQUIT_API ?? "http://127.0.0.1:4310";
	let token: string | null = null;
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
		else if (flag === "--token") token = value();
		else if (flag === "--timeout") timeoutSeconds = Number(value());
		else if (flag.startsWith("--")) throw new CliError("USAGE", `Unknown flag ${flag}.`);
		else if (jobId === null) jobId = flag;
		else throw new CliError("USAGE", `Unexpected argument ${flag}.`);
	}
	if (jobId === null) throw new CliError("USAGE", "Usage: acquit submit <job> [--dir .] [--remote <url>] [--api <url>] [--timeout <seconds>]");
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new CliError("USAGE", "--timeout takes whole seconds.");
	return { jobId, dir, remote, apiUrl, token: resolveToken(token ?? undefined, env), timeoutSeconds, pollMs: 500 };
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

/** Pushing is the operator's own credential; the work repository is where the judge reads the commit. */
export function pushHead(dir: string, remote: string, jobId: string): void {
	const branch = verifiedBranch(jobId as JobId);
	const result = spawnSync("git", ["-C", dir, "push", remote, `HEAD:refs/heads/${branch}`], { encoding: "utf8", timeout: 120_000 });
	if (result.status !== 0) throw new CliError("PUSH_REFUSED", `git push to ${remote} failed. ${tail(result.stderr)}`.trim());
}

function tail(text: string | null): string {
	return (text ?? "").trim().split("\n").slice(-3).join(" ").slice(0, 400);
}

/** The block docs/tutorial.md prints. Every value comes from the projection, never from this process. */
export function renderSubmission(view: JobProjection, handleOf: (operatorId: string) => string | null): string {
	const attempt = view.attempts.history.at(-1);
	if (!attempt) throw new CliError("NOT_JUDGED", `Job ${view.id} has no judged attempt.`);
	const total = attempt.ordinal + view.attempts.left;
	const lines = [`Submitted ${view.id} (attempt ${attempt.ordinal} of ${total})`, `Verifier result: ${attempt.result}`];
	if (attempt.result === "REJECTED") {
		for (const reason of attempt.reasons) lines.push(`\t${reason}`);
		lines.push(`Job status: ${view.status}`);
		const locked = view.lockedTo ? handleOf(view.lockedTo) ?? view.lockedTo : null;
		lines.push(locked ? `Escrow: ${view.escrow}, locked to ${locked}` : `Escrow: ${view.escrow}`);
		lines.push(`Attempts left: ${view.attempts.left}. Deadline: ${utcMinutes(view.deliveryEndsAt)}.`);
		return lines.join("\n");
	}
	lines.push(`\tFrozen tests: ${attempt.frozen?.passed ?? 0} passed (suite frozen at ${view.contract.frozenAt.slice(0, 7)})`);
	lines.push(`\tHidden tests: ${attempt.hidden?.passed ?? 0} passed`);
	lines.push(`\tRequired tests: ${(attempt.frozen?.expected ?? 0) + (attempt.hidden?.expected ?? 0)} completed, 0 skipped or missing`);
	lines.push("\tProtected paths: none touched");
	lines.push(`Pull request opened: ${view.contract.repository}#${attempt.pullRequest ?? 0}`);
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
	const answer = await deps.client.post("/api/commands", { key: `submit:${options.jobId}:${sourceCommit}`,
		command: { type: "Submit", jobId: options.jobId, sourceCommit } });
	const outcome = outcomeOf(answer.body);
	if (outcome?.kind === "DENIED") throw denial(outcome.reason ?? "DENIED", before.job, before.handles);
	const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	const deadline = (deps.now ?? Date.now)() + options.timeoutSeconds * 1000;
	for (;;) {
		const { job, handles } = await jobView(deps.client, options.jobId);
		const judged = job.attempts.history.find(attempt => attempt.sourceCommit === sourceCommit);
		if (judged) return renderSubmission(job, operatorId => handles.get(operatorId) ?? null);
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
