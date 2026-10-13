// The operator's confirmation of the exact commit a submission will push. The MCP server writes a
// request file naming the commit it read from the operator's checkout; `acquit confirm-submit`
// shows that commit and, on the operator's yes, writes the confirmation a waiting submit_attempt
// claims. No tool argument, environment switch, or server flag stands in for this handshake: a
// submission starts only inside a call that claimed a confirmation naming the requested commit.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommitSha } from "../../core/src/ids.ts";

export type SubmitRequest = { readonly jobId: string; readonly commit: CommitSha; readonly requestedAt: string };

/** The confirmation the CLI writes. `requestedAt` rides along so a stale file from an older
 * request never reads as current: a claim checks the commit against the live request. */
export type SubmitConfirmation = { readonly jobId: string; readonly commit: CommitSha; readonly confirmedAt: string };

/** The rendezvous the CLI and the server share: a deployment override, else the profile directory
 * the CLI already owns. The files carry a job id and a commit, never a secret. */
export function confirmationDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.ACQUIT_MCP_CONFIRMATIONS?.trim() || join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "acquit", "submit-confirmations");
}

const requestPath = (dir: string, jobId: string): string => join(dir, `${jobId}.request.json`);
const confirmationPath = (dir: string, jobId: string): string => join(dir, `${jobId}.confirmation.json`);

/** Writes (or rewrites) the request for a job. A rewrite is a new request: an older confirmation
 * for a different commit is removed, so only a confirmation of the current request can claim. */
export function writeRequest(dir: string, request: SubmitRequest): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	rmSync(confirmationPath(dir, request.jobId), { force: true });
	writeFileSync(requestPath(dir, request.jobId), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
}

/** The live request for a job, or null when there is none. */
export function readRequest(dir: string, jobId: string): SubmitRequest | null {
	try {
		const parsed = JSON.parse(readFileSync(requestPath(dir, jobId), "utf8")) as Record<string, unknown>;
		if (typeof parsed.jobId !== "string" || typeof parsed.commit !== "string") return null;
		return { jobId: parsed.jobId, commit: parsed.commit as CommitSha,
			requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : "" };
	} catch { return null; }
}

/** Claims the job's confirmation, if one is there. The rename is the whole claim: two waiting
 * calls can never both submit, because a claimed file is gone from the confirmation's name. */
export function claimConfirmation(dir: string, jobId: string): SubmitConfirmation | null {
	const path = confirmationPath(dir, jobId);
	const claimed = `${path}.claimed`;
	try { renameSync(path, claimed); } catch { return null; }
	try {
		const parsed = JSON.parse(readFileSync(claimed, "utf8")) as Record<string, unknown>;
		if (typeof parsed.jobId !== "string" || typeof parsed.commit !== "string"
			|| typeof parsed.confirmedAt !== "string") throw new Error("malformed confirmation");
		return { jobId: parsed.jobId, commit: parsed.commit as CommitSha, confirmedAt: parsed.confirmedAt };
	} catch (error) {
		throw new Error(`The confirmation file for ${jobId} is malformed (${error instanceof Error ? error.message : String(error)}). Nothing was submitted.`);
	} finally { rmSync(claimed, { force: true }); }
}

/** Removes every rendezvous file for a job: after a settled submit, a refusal, or a lapsed wait,
 * no stale request or confirmation can speak for the next one. */
export function clearRequest(dir: string, jobId: string): void {
	rmSync(requestPath(dir, jobId), { force: true });
	rmSync(confirmationPath(dir, jobId), { force: true });
	rmSync(`${confirmationPath(dir, jobId)}.claimed`, { force: true });
}
