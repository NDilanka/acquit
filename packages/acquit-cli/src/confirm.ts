// `acquit confirm-submit <job>`. The operator's half of the A2 confirmation: the MCP server's
// submit_attempt writes a request naming the commit it read from the checkout, and this command
// shows that commit in full and, on the operator's yes, writes the confirmation the waiting call
// claims. The answer is typed; no flag stands in for it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./client.ts";
import { confirmationDir, readRequest } from "./rendezvous.ts";
import type { SubmitConfirmation } from "./rendezvous.ts";

export type ConfirmOptions = {
	readonly jobId: string;
	readonly confirmDir: string;
};

export function parseConfirmArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ConfirmOptions {
	let jobId: string | null = null;
	for (const flag of argv) {
		if (flag.startsWith("--")) throw new CliError("USAGE", `Usage: acquit confirm-submit <job>  (no flags; the answer is typed)`);
		else if (jobId === null) jobId = flag;
		else throw new CliError("USAGE", `Unexpected argument ${flag}.`);
	}
	if (jobId === null) throw new CliError("USAGE", "Usage: acquit confirm-submit <job>");
	return { jobId, confirmDir: confirmationDir(env) };
}

export type ConfirmDeps = {
	readonly ask: (question: string) => Promise<string>;
	readonly write: (text: string) => void;
	readonly now?: () => number;
};

/** Writes the confirmation the waiting submit_attempt claims. */
export function writeConfirmation(dir: string, confirmation: SubmitConfirmation): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, `${confirmation.jobId}.confirmation.json`), `${JSON.stringify(confirmation, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The confirmation exchange. The prompt shows the request's commit in full, 40 characters, so the
 * operator confirms a SHA they can read whole. A no answer, a lost request, and a refused prompt
 * all leave nothing behind for a later call to submit.
 */
export async function runConfirmSubmit(options: ConfirmOptions, deps: ConfirmDeps): Promise<number> {
	const request = readRequest(options.confirmDir, options.jobId);
	if (request === null || request.jobId !== options.jobId) {
		throw new CliError("NO_REQUEST", `No pending submit request for ${options.jobId}. Nothing to confirm.`);
	}
	deps.write(`Confirm submit on job ${request.jobId}\n  Commit: ${request.commit}\n`
		+ "The submission pushes this commit to the job's work repository and records one Submit.\n");
	const answer = (await deps.ask("Type y to confirm: ")).trim().toLowerCase();
	if (answer !== "y" && answer !== "yes") {
		deps.write("Not confirmed. Nothing was submitted.\n");
		return 1;
	}
	writeConfirmation(options.confirmDir, { jobId: request.jobId, commit: request.commit,
		confirmedAt: new Date((deps.now ?? Date.now)()).toISOString() });
	deps.write(`Confirmed commit ${request.commit} for job ${request.jobId}. The waiting agent will deliver it.\n`);
	return 0;
}
