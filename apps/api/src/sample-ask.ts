// The sample book's "Ask the ledger", server side: four read-only tools over the sample book alone, the caps its turns run
// under, and the deadline its model call is held to. The tools read apps/api/src/sample-book.ts and nothing else. They
// reach no store row, no PayPal object, and no request id, so a real job, order, refund, dispute, or capture id is not in
// the book and is answered "not found" here, never read anywhere else.

import { FIGURE_IDS, isFigureId, type FigureId } from "../../../packages/core/src/explain.ts";
import type { ModelCallAllowance } from "../../../packages/core/src/model.ts";
import { answerEndsWithLabel } from "../../../packages/core/src/sample-label.ts";
import { attemptResultWord, escrowWord, ledgerKindWord, paypalCheckWord, reasonWord, statusWord } from "./ask-words.ts";
import { TURN_LIMIT_DAY_DETAIL, TURN_LIMIT_MINUTE_DETAIL, type TurnWindow } from "../../../packages/core/src/turn-limit.ts";
import type { AskToolExecutor } from "./ask.ts";
import { sampleBook, sampleExplain } from "./sample-book.ts";

/** Every sample answer names itself as sample data, so none reads as the platform's money. */
export const SAMPLE_LABEL = "Simulated sample data. Not checked against PayPal.";

export const SAMPLE_ASK_TOOL_NAMES = ["sample_totals", "list_sample_jobs", "get_sample_job", "explain_sample_figure"] as const;

/** The caller name every sample turn is budgeted under, the first and retry calls alike. */
export const SAMPLE_CALLER = "sample-ask";

/**
 * The model turns one account or one address may run in a rolling minute and in a rolling day. A question runs up to six
 * model turns (the ledger's turn cap), so these caps hold three questions a minute and sixty a day for each key.
 */
export const SAMPLE_TURNS_PER_MINUTE = 18;
export const SAMPLE_TURNS_PER_DAY = 360;

/**
 * The model calls one visitor (an account or an address) may make to the sample book in a rolling day, retries included.
 * Each model turn of a question is one call, so this is a few questions a day, and it stops one visitor from taking the
 * shared sample pool below.
 */
export const SAMPLE_MODEL_CALLS_PER_KEY_DAY = 40;

/**
 * The sample book's ceiling inside the shared model budget. Every sample call, retries included, counts here, so the sample
 * as a whole never takes more than 18 a minute or 200 a day, and the platform's and the operators' calls keep the rest. The
 * minute is sized to the per-key minute, so one visitor's three questions in a minute are not cut short by the shared sample.
 */
export const SAMPLE_ALLOWANCE: ModelCallAllowance = { name: "sample", callers: [SAMPLE_CALLER], perMinute: SAMPLE_TURNS_PER_MINUTE, perDay: 200,
	perKeyDay: SAMPLE_MODEL_CALLS_PER_KEY_DAY };

/** A sample turn's model call, its one retry included, is held to this long; at the deadline the call is cancelled and the route answers without it. */
export const SAMPLE_TURN_DEADLINE_MS = 120_000;

/** The most sample turns whose model work runs at once. A turn runs up to the deadline, so this bounds the work a burst leaves outstanding. */
export const SAMPLE_MAX_IN_FLIGHT = 3;

/**
 * The in-flight gate for sample turns. `acquire` returns a release once a slot is free, and null while all `max` slots are
 * running; each release frees its slot once, however many times it is called.
 */
export function sampleInFlightGate(max: number = SAMPLE_MAX_IN_FLIGHT): () => (() => void) | null {
	let running = 0;
	return () => {
		if (running >= max) return null;
		running += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			running -= 1;
		};
	};
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A sample answer as the route sends it: the model's text with the sample label after it, whatever the model wrote. The
 * label is added in code, so no answer reads as platform money even when the model leaves the label out or words it away.
 * A label the model wrote counts only as the answer's own last paragraph, not inside a code fence, where it does not show.
 * An empty answer stays empty; it has no text to label.
 */
export function labelSampleAnswer(message: string | null): string | null {
	if (message === null || message.trim() === "") return message;
	return answerEndsWithLabel(message, SAMPLE_LABEL) ? message : `${message}\n\n${SAMPLE_LABEL}`;
}

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

/** A sample job as the tools answer it: its status, escrow, verdicts, and ledger lines in plain words. The book itself keeps its codes. */
function plainJob(job: ReturnType<typeof sampleBook>["jobs"][number]) {
	return { ...job, status: statusWord(job.status), escrow: escrowWord(job.escrow),
		lines: job.lines.map(line => ({ ...line, kind: ledgerKindWord(line.kind) })),
		attempts: job.attempts.map(attempt => ({ ...attempt, result: attemptResultWord(attempt.result), reasons: attempt.reasons.map(reasonWord) })) };
}

/**
 * The sample book's executor. Its only input is the sample book, so no store or PayPal read is reachable from it. Each
 * answer carries the `sample` label; explain keeps its own `label` for the figure's name. Codes the book stores (status,
 * escrow, verdict, ledger kind, PayPal check, reason) are answered in plain words, so the model has no code to repeat.
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
				return { sample: SAMPLE_LABEL, jobs: jobs.map(job => ({ jobId: job.jobId, title: job.title, status: statusWord(job.status),
					escrow: escrowWord(job.escrow), heldCents: job.paidCents, operator: job.operator?.handle ?? null })) };
			case "get_sample_job": {
				const id = typeof args["jobId"] === "string" ? args["jobId"].trim() : "";
				const job = id === "" ? undefined : jobs.find(candidate => candidate.jobId === id);
				if (!job) throw new Error(`not found: no sample job named ${id === "" ? "(none given)" : id}`);
				return { sample: SAMPLE_LABEL, job: plainJob(job) };
			}
			case "explain_sample_figure": {
				const figure = args["figure"];
				if (!isFigureId(figure)) throw new Error(`explain_sample_figure needs one figure: ${FIGURE_IDS.join(", ")}`);
				const trace = sampleExplain(figure);
				return { sample: SAMPLE_LABEL, ...trace, lines: trace.lines.map(line => ({ ...line, kind: ledgerKindWord(line.kind),
					paypal: { ...line.paypal, status: paypalCheckWord(line.paypal.status) } })) };
			}
			default: throw new Error(`no tool named ${name}`);
		}
	};
}

/**
 * The answer of `work`, or `fallback` once `ms` passes or `requestEnded` aborts (the client went away). Either way `work` is
 * handed a signal that aborts at that moment, so the model work is cancelled rather than left running for an answer nobody
 * reads. A failure before that moment is the failure, not the fallback.
 */
export async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, fallback: T, requestEnded?: AbortSignal): Promise<T> {
	const controller = new AbortController();
	let release: (value: T) => void = () => undefined;
	const late = new Promise<T>(resolve => { release = resolve; });
	const cutOff = (): void => { controller.abort(); release(fallback); };
	const timer = setTimeout(cutOff, ms);
	if (requestEnded?.aborted === true) cutOff();
	requestEnded?.addEventListener("abort", cutOff, { once: true });
	try { return await Promise.race([work(controller.signal), late]); }
	finally {
		clearTimeout(timer);
		requestEnded?.removeEventListener("abort", cutOff);
	}
}

/**
 * The admission a sample turn passes before the shared budget reserves. An account and an address each get the same
 * allowance. Every key the turn names must be under its rolling minute and day, and only then does each count the turn;
 * a turn one key refuses counts against neither. Returns the window that refused the turn, or null when it is admitted.
 */
export function sampleTurnLimiter(now: () => number = Date.now): (keys: readonly string[]) => TurnWindow | null {
	const admitted = new Map<string, number[]>();
	const withinDay = (key: string, at: number) => (admitted.get(key) ?? []).filter(stamp => at - stamp < DAY_MS);
	return keys => {
		const at = now();
		for (const key of keys) {
			const day = withinDay(key, at);
			if (day.filter(stamp => at - stamp < MINUTE_MS).length >= SAMPLE_TURNS_PER_MINUTE) return TURN_LIMIT_MINUTE_DETAIL;
			if (day.length >= SAMPLE_TURNS_PER_DAY) return TURN_LIMIT_DAY_DETAIL;
		}
		for (const key of keys) admitted.set(key, [...withinDay(key, at), at]);
		return null;
	};
}
