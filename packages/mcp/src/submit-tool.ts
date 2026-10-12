// submit_attempt: one delivery through the F5 CLI's own path, gated on the operator's
// confirmation of the exact commit. The tool reads the checkout's HEAD, writes the request, and
// waits for `acquit confirm-submit` to confirm that commit. The model cannot confirm: no tool
// argument names a confirmation, and the pinned commit is the one the operator's yes named.

import { randomUUID } from "node:crypto";
import type { CommitSha } from "../../core/src/ids.ts";
import { CliError } from "../../acquit-cli/src/client.ts";
import type { ApiClient } from "../../acquit-cli/src/client.ts";
import { pushHead, runSubmit } from "../../acquit-cli/src/submit.ts";
import type { ScopedPush } from "../../acquit-cli/src/submit.ts";
import { claimConfirmation, clearRequest, readRequest, writeRequest } from "./confirm.ts";

export type SubmitAttemptOptions = {
	readonly jobId: string;
	readonly dir: string;
	readonly apiUrl: string;
	readonly token: string;
	/** The verifier wait one delivery may run: the CLI submit's own bound. */
	readonly timeoutSeconds: number;
};

export type SubmitAttemptDeps = {
	readonly client: ApiClient;
	/** The checkout's HEAD, the way the CLI reads it: a run checkout's state git directory when
	 * one exists, else the checkout's own. */
	readonly head: (dir: string, jobId?: string, env?: NodeJS.ProcessEnv) => CommitSha;
	readonly push: (dir: string, remote: string, commit: CommitSha, env?: NodeJS.ProcessEnv, scoped?: ScopedPush) => void;
	readonly confirmDir: string;
	/** How long one call waits for the operator's confirmation before returning pending. */
	readonly confirmWaitMs: number;
	readonly pollMs?: number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now?: () => number;
};

export type SubmitAttemptOutcome =
	| { readonly pending: false; readonly commit: CommitSha; readonly verdict: string }
	| { readonly pending: true; readonly commit: CommitSha; readonly message: string };

/**
 * One confirmed submission. The commit is read once, pinned through the whole flow, and only a
 * confirmation naming that same commit can start the Submit; the run pushes the pinned commit
 * even if the checkout's HEAD moves after the confirmation, so what runs is what the operator
 * confirmed. A lapsed wait keeps the request alive: the operator confirms, and the next call
 * claims the confirmation and delivers.
 */
export async function runConfirmedSubmit(options: SubmitAttemptOptions, deps: SubmitAttemptDeps): Promise<SubmitAttemptOutcome> {
	const commit = deps.head(options.dir, options.jobId);
	const existing = readRequest(deps.confirmDir, options.jobId);
	if (existing === null || existing.commit !== commit) {
		writeRequest(deps.confirmDir, { jobId: options.jobId, commit, requestedAt: new Date((deps.now ?? Date.now)()).toISOString() });
	}
	const sleep = deps.sleep;
	const pollMs = deps.pollMs ?? 2_000;
	const deadline = (deps.now ?? Date.now)() + deps.confirmWaitMs;
	for (;;) {
		const confirmation = claimConfirmation(deps.confirmDir, options.jobId);
		if (confirmation !== null) {
			if (confirmation.jobId !== options.jobId || confirmation.commit !== commit) {
				clearRequest(deps.confirmDir, options.jobId);
				throw new CliError("CONFIRMATION_MISMATCH",
					`The confirmation for ${options.jobId} names commit ${confirmation.commit}, not the requested ${commit}. Nothing was submitted.`);
			}
			clearRequest(deps.confirmDir, options.jobId);
			const verdict = await runSubmit({ jobId: options.jobId, dir: options.dir, remote: null, apiUrl: options.apiUrl,
				token: options.token, timeoutSeconds: options.timeoutSeconds, pollMs: pollMs },
			{ client: deps.client, head: () => commit, push: deps.push });
			return { pending: false, commit, verdict };
		}
		if ((deps.now ?? Date.now)() >= deadline) {
			return { pending: true, commit, message: `Operator confirmation is pending for commit ${commit} on job ${options.jobId}. `
				+ "Nothing was pushed and no attempt was charged. Confirm with the operator CLI: "
				+ `acquit confirm-submit ${options.jobId} — then call submit_attempt again to deliver. The confirmation is typed by the operator; `
				+ "no tool argument can stand in for it." };
		}
		await sleep(pollMs);
	}
}
