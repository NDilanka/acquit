// `acquit bid <job> --price --eta --agent --pitch`. One PlaceBid through the command route, printed as
// the client will see it. The credit line comes from the command's own live read.

import { randomUUID } from "node:crypto";
import { BID_COST } from "../../core/src/credits.ts";
import { usd as parseUsd } from "../../core/src/ledger.ts";
import { CliError, apiFlag, readLogin, resolveToken } from "./client.ts";
import type { ApiClient } from "./client.ts";
import { eta, usd } from "./format.ts";

export type BidOptions = {
	readonly apiUrl: string;
	readonly token: string;
	readonly jobId: string;
	readonly price: number;
	readonly etaHours: number;
	readonly agent: string;
	readonly pitch: string;
};

type BidView = {
	readonly id: string;
	readonly handle: string;
	readonly price: number;
	readonly eta: number;
	readonly agent: string;
	readonly runner: string;
	readonly paidReceipts: number;
};

type BidResult = {
	readonly kind: string;
	readonly job: { readonly bids: { readonly operators: readonly BidView[] } };
	readonly bid: string;
	readonly creditsLeft: number;
};

const USAGE = "Usage: acquit bid <job> --price <usd> --eta <days|hours> --agent <name> --pitch <text> [--api <url>]";

function priceOf(value: string): number {
	try { return parseUsd(value); }
	catch { throw new CliError("USAGE", "--price takes dollars, such as 400 or 400.50."); }
}

function etaOf(value: string): number {
	const match = /^(\d+)(d|h)?$/.exec(value);
	const hours = match ? Number(match[1]) * (match[2] === "d" ? 24 : 1) : Number.NaN;
	if (!Number.isSafeInteger(hours) || hours < 1 || hours > 336) throw new CliError("USAGE", "--eta takes 1 to 336 hours, such as 2d or 48h.");
	return hours;
}

export function parseBidArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): BidOptions {
	const { apiUrl, rest } = apiFlag(argv, env);
	let jobId: string | null = null;
	let price: number | null = null;
	let etaHours: number | null = null;
	let agent: string | null = null;
	let pitch: string | null = null;
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		const value = (): string => {
			const next = rest[++index];
			if (next === undefined) throw new CliError("USAGE", `${flag} needs a value.`);
			return next;
		};
		if (flag === "--price") price = priceOf(value());
		else if (flag === "--eta") etaHours = etaOf(value());
		else if (flag === "--agent") agent = value();
		else if (flag === "--pitch") pitch = value();
		else if (flag.startsWith("--")) throw new CliError("USAGE", `Unknown flag ${flag}.`);
		else if (jobId === null) jobId = flag;
		else throw new CliError("USAGE", `Unexpected argument ${flag}.`);
	}
	if (jobId === null || price === null || etaHours === null || agent === null || pitch === null) throw new CliError("USAGE", USAGE);
	return { apiUrl, token: resolveToken(undefined, env, () => readLogin(env)?.token ?? null), jobId, price, etaHours, agent, pitch };
}

type Outcome = { readonly kind: string; readonly reason?: string; readonly result?: unknown };

function outcomeOf(body: unknown): Outcome | null {
	const outcome = body && typeof body === "object" ? (body as { outcome?: Outcome }).outcome : undefined;
	return outcome ?? null;
}

function denial(reason: string, body: unknown): CliError {
	const credits = body && typeof body === "object" ? (body as { credits?: { available?: number; nextGrantAt?: string } }).credits : undefined;
	if (reason === "INSUFFICIENT_CREDITS" && credits) {
		return new CliError("INSUFFICIENT_CREDITS", `Bid refused: ${credits.available} credits left; the weekly allowance returns ${credits.nextGrantAt}.`);
	}
	return new CliError(reason, `Bid refused: ${reason}.`);
}

export async function runBid(options: BidOptions, deps: { readonly client: ApiClient }): Promise<string> {
	const answer = await deps.client.post("/api/commands", { key: randomUUID(),
		command: { type: "PlaceBid", jobId: options.jobId, price: options.price, eta: options.etaHours, agent: options.agent, pitch: options.pitch } });
	const outcome = outcomeOf(answer.body);
	if (outcome === null || outcome.kind === "DENIED") throw denial(outcome?.reason ?? "DENIED", answer.body);
	const result = outcome.result as BidResult;
	const bid = result.job.bids.operators.find(entry => entry.id === result.bid);
	if (!bid) throw new CliError("BID_MISSING", `The API committed the bid but ${options.jobId} does not show it.`);
	const receipts = bid.paidReceipts === 0 ? "0 (new operator)" : String(bid.paidReceipts);
	return [`Bid sent on ${options.jobId}`, `\tOperator: ${bid.handle}`, `\tPrice: ${usd(bid.price)}`, `\tETA: ${eta(bid.eta)}`,
		`\tAgent: ${bid.agent} (${bid.runner})`, `\tVerified receipts: ${receipts}`,
		`Credits spent: ${BID_COST} (${result.creditsLeft} left this week)`].join("\n");
}
