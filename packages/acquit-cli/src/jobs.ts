// `acquit jobs list`. The tutorial's table, read from GET /api/jobs.

import { CliError, apiFlag, readLogin, resolveToken } from "./client.ts";
import type { ApiClient } from "./client.ts";
import { cell, usd, utcMinutes } from "./format.ts";

export type JobsOptions = { readonly apiUrl: string; readonly token: string };

type JobRow = {
	readonly id: string;
	readonly title: string;
	readonly budget: number;
	readonly deliveryEndsAt: string;
	readonly phase: string;
};

const COLUMNS = [11, 6, 12, 19];

export function parseJobsArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): JobsOptions {
	const { apiUrl, rest } = apiFlag(argv, env);
	if (rest.length !== 1 || rest[0] !== "list") throw new CliError("USAGE", "Usage: acquit jobs list [--api <url>]");
	return { apiUrl, token: resolveToken(undefined, env, () => readLogin(env)?.token ?? null) };
}

export async function runJobsList(options: JobsOptions, deps: { readonly client: ApiClient }): Promise<string> {
	void options; // the client already carries the origin and the token
	const body = await deps.client.get("/api/jobs") as { jobs?: readonly JobRow[] } | null;
	const jobs = body?.jobs ?? [];
	// The skeleton has one mode; the column is the tutorial's, so it stays spelled here.
	const header = ["ID", "MODE", "BUDGET", "DEADLINE", "TITLE"];
	const lines = [header.map((text, index) => cell(text, COLUMNS[index])).join("")];
	for (const job of jobs) {
		lines.push([cell(job.id, COLUMNS[0]), cell("Bid", COLUMNS[1]), cell(usd(job.budget), COLUMNS[2]),
			cell(utcMinutes(job.deliveryEndsAt), COLUMNS[3]), job.title].join(""));
	}
	return lines.join("\n");
}
