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
	const rows = jobs.map(job => [job.id, "Bid", usd(job.budget), utcMinutes(job.deliveryEndsAt)]);
	// A column keeps the tutorial's width unless a real cell is longer. `cell` always keeps one space
	// after a value, so the width a column needs is its longest cell plus that space; the tutorial's
	// sample stays character for character, and a real `job_<uuid>` widens the column for every row.
	// The title is the last column and is never padded.
	const widths = COLUMNS.map((width, index) => Math.max(width, ...rows.map(row => row[index].length + 1)));
	const lines = [header.slice(0, COLUMNS.length).map((text, index) => cell(text, widths[index])).join("") + header[COLUMNS.length]];
	rows.forEach((row, index) => {
		lines.push(row.map((text, column) => cell(text, widths[column])).join("") + jobs[index].title);
	});
	return lines.join("\n");
}
