// The Acquit MCP server's surface: exactly the six tools the mission approved, acting with the
// operator's token and never exposing it. Every tool is one authenticated call the API has
// already decided; a refusal the API names comes back as an MCP error result, not as a success.

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiClient, CliError } from "../../acquit-cli/src/client.ts";
import type { ApiClient } from "../../acquit-cli/src/client.ts";
import { localHead, pushHead } from "../../acquit-cli/src/submit.ts";
import type { CommitSha } from "../../core/src/ids.ts";
import { runConfirmedSubmit } from "./submit-tool.ts";
import type { SubmitAttemptOutcome } from "./submit-tool.ts";
import { referencedPayoutItem } from "./paypal.ts";
import type { PaypalReader } from "./paypal.ts";

export type ServerOptions = {
	readonly apiUrl: string;
	/** The operator token, resolved per call: the environment's ACQUIT_TOKEN or the CLI's stored
	 * login. Null means every tool answers the missing sign-in. The value is never logged. */
	readonly token: () => string | null;
	/** The PayPal reader, built on first use so the other five tools run without PayPal config. */
	readonly paypal: () => Promise<PaypalReader>;
	readonly confirmDir: string;
	readonly confirmWaitMs: number;
	readonly submitTimeoutSeconds: number;
	readonly client?: (baseUrl: string, token: string) => ApiClient;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
};

type ToolText = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (payload: unknown): ToolText => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });

/** A refusal keeps its name: the API's denial reason leads the error the model reads. */
function toolError(error: unknown): never {
	if (error instanceof CliError) throw new Error(`${error.code}: ${error.message}`);
	throw error instanceof Error ? error : new Error(String(error));
}

function outcomeOf(body: unknown): { readonly kind: string; readonly reason?: string; readonly result?: unknown } | null {
	const outcome = body && typeof body === "object" ? (body as { outcome?: { kind: string; reason?: string; result?: unknown } }).outcome : undefined;
	return outcome ?? null;
}

/** The command route's answer: a denial carries the API's reason, a carry of nothing is a bug. */
function committed(outcome: { readonly kind: string; readonly reason?: string; readonly result?: unknown } | null): unknown {
	if (outcome === null) throw new Error("The command route answered no outcome.");
	if (outcome.kind === "DENIED") throw new CliError(outcome.reason ?? "DENIED", `The command was refused: ${outcome.reason ?? "DENIED"}.`);
	return outcome.result;
}

/** An environment timeout in milliseconds: the name's value is seconds, and so is the fallback.
 * A bare fallback here once made the confirmation wait 120ms instead of 120s. */
export function timeoutMs(env: NodeJS.ProcessEnv, name: string, fallbackSeconds: number): number {
	const parsed = Number(env[name]);
	return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : fallbackSeconds * 1000;
}

export function buildServer(options: ServerOptions): McpServer {
	const server = new McpServer({ name: "acquit-mcp", version: "0.1.0" });
	const clientOf = options.client ?? ((baseUrl: string, token: string) => apiClient({ baseUrl, token }));
	const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;
	/** The operator's client, or the missing-sign-in error every tool shares. */
	const withClient = (run: (client: ApiClient, token: string) => Promise<ToolText>): Promise<ToolText> => {
		try {
			const token = options.token();
			if (!token) throw new CliError("AUTH_REQUIRED", "No session token. Run `acquit login`, or set ACQUIT_TOKEN, so the server can act as the operator.");
			return run(clientOf(options.apiUrl, token), token);
		} catch (error) { return toolError(error); }
	};

	server.registerTool("list_jobs", {
		title: "List Acquit jobs",
		description: "Lists the Acquit jobs the signed-in operator can see, with ids, statuses, phases, and budgets. Read-only.",
		inputSchema: {},
	}, async () => withClient(async (client, token) => {
		void token; // the client carries the origin and the token; a result never repeats it
		try { return text(await client.get("/api/jobs")); }
		catch (error) { return toolError(error); }
	}));

	server.registerTool("get_job", {
		title: "Read one Acquit job",
		description: "Reads one Acquit job's full view the operator can see: status, phase, bids, attempts, and ledger lines. Read-only.",
		inputSchema: { jobId: z.string().describe("The job id, as list_jobs named it.") },
	}, async ({ jobId }) => withClient(async client => {
		try { return text(await client.get(`/api/jobs/${encodeURIComponent(jobId)}`)); }
		catch (error) { return toolError(error); }
	}));

	server.registerTool("place_bid", {
		title: "Place an operator bid",
		description: "Places one bid on an OPEN job as the signed-in operator. Costs bid credits. The API refuses bids it cannot take.",
		inputSchema: {
			jobId: z.string().describe("The OPEN job id to bid on."),
			priceUsd: z.number().describe("The bid price in US dollars, e.g. 360 for a 360.00 bid."),
			etaHours: z.number().int().min(1).max(336).describe("The delivery estimate in hours, 1 to 336."),
			agent: z.string().describe("The operator agent's id that will run the work, e.g. ts-bugfixer."),
			pitch: z.string().describe("One sentence on how the work will be done."),
		},
	}, async ({ jobId, priceUsd, etaHours, agent, pitch }) => withClient(async client => {
		const cents = Math.round(priceUsd * 100);
		if (!Number.isSafeInteger(cents) || cents < 0) return toolError(new CliError("USAGE", `The price ${priceUsd} is not a USD amount.`));
		try {
			const answer = await client.post("/api/commands", { key: randomUUID(),
				command: { type: "PlaceBid", jobId, price: cents, eta: etaHours, agent, pitch } });
			return text(committed(outcomeOf(answer.body)));
		} catch (error) { return toolError(error); }
	}));

	server.registerTool("submit_attempt", {
		title: "Deliver the confirmed commit",
		description: "Delivers the operator's confirmed commit for a job locked to this operator: pushes it to the job's work repository "
			+ "and records one Submit, then returns the verdict block. The commit is read from the checkout and pinned; the operator must "
			+ "confirm that exact commit with `acquit confirm-submit <job>` before anything is pushed. No tool argument confirms or skips "
			+ "that step. If the result says confirmation is pending, ask the operator to run the confirm command, then call this tool again.",
		inputSchema: {
			jobId: z.string().describe("The job id to deliver to, as list_jobs named it."),
			dir: z.string().optional().describe("Path to the operator's checkout of the work repository. Defaults to the server's working directory."),
		},
	}, async ({ jobId, dir }) => withClient(async (client, token) => {
		let outcome: SubmitAttemptOutcome;
		try {
			outcome = await runConfirmedSubmit({ jobId, dir: dir ?? ".", apiUrl: options.apiUrl, token,
				timeoutSeconds: options.submitTimeoutSeconds },
			{ client, head: localHead, push: pushHead, confirmDir: options.confirmDir, confirmWaitMs: options.confirmWaitMs,
				sleep, now });
		} catch (error) { return toolError(error); }
		if (outcome.pending) return { ...text({ pending: true, commit: outcome.commit, message: outcome.message }), isError: true };
		return text({ pending: false, commit: outcome.commit, verdict: outcome.verdict });
	}));

	server.registerTool("get_receipt", {
		title: "Read one paid receipt",
		description: "Reads the operator's receipt for one paid job, or one receipt by id, from the operator's receipts route. Read-only.",
		inputSchema: {
			jobId: z.string().optional().describe("The PAID job id whose receipt to read."),
			receiptId: z.string().optional().describe("The receipt id, when it is already known."),
		},
	}, async ({ jobId, receiptId }) => withClient(async client => {
		if (jobId === undefined && receiptId === undefined) {
			return toolError(new CliError("USAGE", "Name the job's id or the receipt's id."));
		}
		try {
			const body = await client.get("/api/me/receipts") as { receipts?: readonly Record<string, unknown>[] } | null;
			const found = (body?.receipts ?? []).find(receipt => jobId !== undefined ? receipt.jobId === jobId : receipt.id === receiptId);
			if (found === undefined) {
				throw new CliError("NOT_FOUND", jobId !== undefined
					? `No receipt for job ${jobId}: the job has not reached PAID, or the receipt is not this operator's.`
					: `No receipt ${receiptId} in this operator's receipts.`);
			}
			return text(found);
		} catch (error) { return toolError(error); }
	}));

	server.registerTool("get_payout_status", {
		title: "Read one payout's PayPal status",
		description: "Reads one payout's status from PayPal for a PAID job: the referenced payout item's processing state and amount, "
			+ "read per item from the sandbox. Read-only.",
		inputSchema: { jobId: z.string().describe("The PAID job id whose payout to read.") },
	}, async ({ jobId }) => withClient(async client => {
		try {
			const body = await client.get("/api/me/payouts") as { payouts?: readonly { jobId?: unknown; payoutItemId?: unknown }[] } | null;
			const payout = (body?.payouts ?? []).find(row => row.jobId === jobId);
			if (payout === undefined || typeof payout.payoutItemId !== "string") {
				throw new CliError("NOT_FOUND", `No payout for job ${jobId} yet: get_payout_status reads a job that reached PAID.`);
			}
			const reader = await options.paypal();
			const item = referencedPayoutItem(await reader.get(`/v1/payments/referenced-payouts-items/${encodeURIComponent(payout.payoutItemId)}`), payout.payoutItemId);
			return text({ jobId, payoutItemId: item.payoutItemId, status: item.status, amount: item.amount });
		} catch (error) { return toolError(error); }
	}));

	return server;
}

/** The commit SHA shape the submit flow pins; exported for the tests that fake a checkout. */
export type PinnedCommit = CommitSha;
