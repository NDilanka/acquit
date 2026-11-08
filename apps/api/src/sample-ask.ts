// The sample book's "Ask the ledger", server side: four read-only tools over the sample book alone, the caps its turns run
// under, and the deadline its model call is held to. The tools read apps/api/src/sample-book.ts and nothing else. They
// reach no store row, no PayPal object, and no request id, so a real job, order, refund, dispute, or capture id is not in
// the book and is answered "not found" here, never read anywhere else.

import { FIGURE_IDS, isFigureId, type FigureId } from "../../../packages/core/src/explain.ts";
import { OPERATOR_TURNS_PER_DAY, OPERATOR_TURNS_PER_MINUTE, type AskToolExecutor } from "./ask.ts";
import { sampleBook, sampleExplain } from "./sample-book.ts";

/** Every sample answer names itself as sample data, so none reads as the platform's money. */
export const SAMPLE_LABEL = "Simulated sample data. Not checked against PayPal.";

export const SAMPLE_ASK_TOOL_NAMES = ["sample_totals", "list_sample_jobs", "get_sample_job", "explain_sample_figure"] as const;

/** A sample turn's model call, its one retry included, is held to this long before the route answers without it. */
export const SAMPLE_TURN_DEADLINE_MS = 120_000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The tool list the sample route serves: the four reads, each worded for the sample book. */
export function sampleAskToolList(): readonly { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown>; readonly kind: "client" }[] {
	return [
		{ name: "sample_totals", kind: "client",
			description: "The sample book's totals in cents: held, released, refunded, and fee cents, and how many sample jobs hold escrow. Simulated sample data.",
			parameters: { type: "object", properties: {}, required: [] } },
		{ name: "list_sample_jobs", kind: "client",
			description: "Every sample job: its id, title, status, escrow state, held cents, and operator. Simulated sample data.",
			parameters: { type: "object", properties: {}, required: [] } },
		{ name: "get_sample_job", kind: "client",
			description: "One sample job by id, with its book lines, funding capture, payout, receipt, and each verifier attempt. Simulated sample data; an id that is not a sample job is not found.",
			parameters: { type: "object", properties: { jobId: { type: "string", description: "The sample job's id, as list_sample_jobs names it" } }, required: ["jobId"] } },
		{ name: "explain_sample_figure", kind: "client",
			description: "One sample escrow figure traced to the sample ledger lines that sum to it, each with its sample PayPal reference, which is not checked against PayPal. Simulated sample data.",
			parameters: { type: "object", properties: { figure: { type: "string", enum: [...FIGURE_IDS], description: "held, released, refunded, fees, or paid-by-clients" } }, required: ["figure"] } },
	];
}

/**
 * The sample book's executor. Its only input is the sample book, so no store or PayPal read is reachable from it. Each
 * answer carries the `sample` label; explain keeps its own `label` for the figure's name.
 */
export function sampleAskToolExecutor(): AskToolExecutor {
	return async (name, args) => {
		const jobs = sampleBook().jobs;
		switch (name) {
			case "sample_totals": {
				// The figures are the explain route's own totals, so a total and its explanation cannot disagree.
				const figure = (id: FigureId) => sampleExplain(id).totalCents;
				return { sample: SAMPLE_LABEL, held: figure("held"), released: figure("released"), refunded: figure("refunded"), fees: figure("fees"),
					heldJobs: jobs.filter(job => job.escrow === "HELD").length };
			}
			case "list_sample_jobs":
				return { sample: SAMPLE_LABEL, jobs: jobs.map(job => ({ jobId: job.jobId, title: job.title, status: job.status, escrow: job.escrow,
					heldCents: job.paidCents, operator: job.operator?.handle ?? null })) };
			case "get_sample_job": {
				const id = typeof args["jobId"] === "string" ? args["jobId"].trim() : "";
				const job = id === "" ? undefined : jobs.find(candidate => candidate.jobId === id);
				if (!job) throw new Error(`not found: no sample job named ${id === "" ? "(none given)" : id}`);
				return { sample: SAMPLE_LABEL, job };
			}
			case "explain_sample_figure": {
				const figure = args["figure"];
				if (!isFigureId(figure)) throw new Error(`explain_sample_figure needs one figure: ${FIGURE_IDS.join(", ")}`);
				return { sample: SAMPLE_LABEL, ...sampleExplain(figure) };
			}
			default: throw new Error(`no tool named ${name}`);
		}
	};
}

/** The answer of `work`, or `fallback` if `ms` passes first. The work is not cancelled; its own bounds still end it. */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
	try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

/**
 * The admission a sample turn passes before the shared budget reserves. The caps are the operator turns' own, so an
 * account and an address each get the same allowance. Every key the turn names must be under its rolling minute and day,
 * and only then does each count the turn; a turn one key refuses counts against neither.
 */
export function sampleTurnLimiter(now: () => number = Date.now): (keys: readonly string[]) => boolean {
	const admitted = new Map<string, number[]>();
	const withinDay = (key: string, at: number) => (admitted.get(key) ?? []).filter(stamp => at - stamp < DAY_MS);
	return keys => {
		const at = now();
		const open = keys.every(key => {
			const day = withinDay(key, at);
			return day.length < OPERATOR_TURNS_PER_DAY && day.filter(stamp => at - stamp < MINUTE_MS).length < OPERATOR_TURNS_PER_MINUTE;
		});
		if (!open) return false;
		for (const key of keys) admitted.set(key, [...withinDay(key, at), at]);
		return true;
	};
}
