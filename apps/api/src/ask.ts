// The "Ask the ledger" agent's server side. The browser's agent loop (AG Studio's, over the custom
// agent) relays every model turn through POST /api/ask-ledger/turn and executes every tool call it
// answers with through POST /api/ask-ledger/tool -- so the model's turns never leave this server,
// its key never leaves this process, and the tool set is a closed read-only list. The droid turn is
// read-only by construction: no --auto, so nothing the model asks to run can execute, and the
// turn's only product is the JSON envelope its answer carries. The openrouter path stays selectable
// on the same switch and is tested with injected transports only; no live OpenRouter call.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedDetail } from "../../../packages/core/src/verifier.ts";
import { classifyDroidRun, droidResultText, DROID_MODEL, factoryApiKey, modelProvider, reserveModelCall } from "../../../packages/core/src/model.ts";
import type { ModelCallLog } from "../../../packages/core/src/model.ts";
import { platformEscrowTotals } from "../../../packages/core/src/platform.ts";
import type { PlatformJobLedger, PlatformPayPalEventRow } from "../../../packages/core/src/platform.ts";
import type { JobView } from "../../../packages/core/src/acquit.ts";
import { operatorEscrow } from "./escrow.ts";
import type { PayoutRowView } from "./payouts.ts";
import type { ReceiptRowView } from "./receipts.ts";
import { FIGURE_IDS, isFigureId } from "../../../packages/core/src/explain.ts";
import type { FigureId } from "../../../packages/core/src/explain.ts";
import { HOUSE_MODEL_OPENROUTER, keyringKey } from "../../../packages/house/src/runner.ts";
import { authAssertion } from "../../../packages/core/src/paypal.ts";
import { searchInstant } from "../../../packages/core/src/reconcile.ts";
import type { MerchantId } from "../../../packages/core/src/ids.ts";
import { PayPalHttpError, paypalReader } from "../../../packages/mcp/src/paypal.ts";
import type { PaypalReader } from "../../../packages/mcp/src/paypal.ts";

// ---- the turn: one request in, one model turn out ----------------------------------------------

export type AskToolSchema = { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> };

export type AskMessage =
	| { readonly id: string; readonly role: "user" | "system" | "developer"; readonly content: string }
	| { readonly id: string; readonly role: "assistant"; readonly content?: string;
		readonly toolCalls?: readonly { readonly id: string; readonly function: { readonly name: string; readonly arguments: string } }[] }
	| { readonly id: string; readonly role: "tool"; readonly content: string; readonly toolCallId: string };

export type AskCall = { readonly id: string | null; readonly name: string; readonly arguments: unknown };

/** The outcome one model turn produced; the route maps it onto the model response the loop reads. */
export type AskTurnOutcome =
	| { readonly ok: true; readonly message: string | null; readonly calls: readonly AskCall[]; readonly model: string;
		readonly sessionId: string | null; readonly factoryCredits: number | null }
	| { readonly ok: false; readonly reason: "MODEL_PROVIDER_ERROR" | "MODEL_RATE_LIMITED" | "MODEL_BUDGET" | "MODEL_KEY_MISSING"; readonly detail: string };

/** The model-turn port, shared by both providers: the composed prompt in, the answer text out. */
export type AskModelPort = (prompt: string) => Promise<AskModelResult>;

export type AskModelResult =
	| { readonly ok: true; readonly text: string; readonly sessionId: string | null; readonly factoryCredits: number | null }
	| { readonly ok: false; readonly reason: "PROVIDER_ERROR" | "RATE_LIMITED" | "NO_KEY"; readonly detail: string;
		/** What the failed run still reported, when the provider's own answer carried it: the
		 * session it spent and the credits it charged. A failed call keeps its usage, like the
		 * House runner's failures do. */
		readonly sessionId?: string | null; readonly factoryCredits?: number | null };

export type AskTurnDeps = {
	readonly model: AskModelPort;
	readonly callLog: ModelCallLog;
};

/** The instruction every turn runs under, whatever the agent's own definition adds: one JSON
 * envelope per turn, whether the turn carries a message, tool calls, or both. */
export const ASK_TURN_CONTRACT = [
	"You are Ask the ledger, the platform escrow dashboard's own agent.",
	"You answer questions about Acquit's ledger and PayPal's view of it, from your tools alone.",
	"Reply with ONLY one JSON object (no prose around it, no code fences):",
	'  {"message": <string or null>, "calls": [{"id": "<a unique call id>", "name": "<tool name>", "arguments": <object>}]}',
	"- To use tools first, reply with a null message and the calls.",
	"- To answer the reader, reply with the message and no calls; the run then ends.",
].join("\n");

/** The same envelope for an operator's earnings dashboard. Its tools reach that operator's own jobs alone. */
export const ASK_OPERATOR_TURN_CONTRACT = [
	"You are Ask the ledger, the operator earnings dashboard's own agent.",
	"You answer questions about the signed-in operator's own jobs, payouts, and totals on Acquit, from your tools alone. Your tools reach only this operator's jobs.",
	"Reply with ONLY one JSON object (no prose around it, no code fences):",
	'  {"message": <string or null>, "calls": [{"id": "<a unique call id>", "name": "<tool name>", "arguments": <object>}]}',
	"- To use tools first, reply with a null message and the calls.",
	"- To answer the reader, reply with the message and no calls; the run then ends.",
].join("\n");

/** Which dashboard a turn serves: the platform's escrow book, or one operator's own earnings. */
export type AskScope = "PLATFORM" | "OPERATOR";

/** The prompt one model turn runs under: the agent's instruction, the envelope contract, the tool
 * schemas, the conversation. It names no secret -- the key travels in the child's environment. */
export function buildAskPrompt(input: { readonly messages: readonly AskMessage[]; readonly tools: readonly AskToolSchema[];
	readonly instructions?: string; readonly contract?: string }): string {
	const contract = input.contract ?? ASK_TURN_CONTRACT;
	const instruction = input.instructions !== undefined && input.instructions.trim() !== "" ? input.instructions.trim() : contract;
	return [
		instruction,
		...(instruction === contract ? [] : [contract]),
		`TOOLS: ${JSON.stringify(input.tools)}`,
		`CONVERSATION: ${JSON.stringify(input.messages)}`,
	].join("\n\n");
}

/** The envelope one turn replied in, read leniently: the whole text, then its lines back to front,
 * then its JSON spans, until one parses to an envelope. A model that ignores the contract still
 * reaches the reader: unparsed text arrives as the message. */
export function parseAskEnvelope(text: string): { readonly message: string | null; readonly calls: readonly AskCall[] } {
	const envelopeOf = (raw: string): { message: string | null; calls: AskCall[] } | null => {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (typeof parsed !== "object" || parsed === null) return null;
			const record = parsed as { message?: unknown; calls?: unknown };
			if (!("message" in record) && !("calls" in record)) return null;
			const message = typeof record.message === "string" && record.message.trim() !== "" ? record.message : null;
			const calls = Array.isArray(record.calls) ? record.calls.flatMap(parseAskCall) : [];
			return { message, calls };
		} catch { return null; }
	};
	const direct = envelopeOf(text);
	if (direct) return direct;
	for (const line of text.split("\n").reverse()) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		const fromLine = envelopeOf(trimmed);
		if (fromLine) return fromLine;
	}
	for (const span of text.match(/\{[\s\S]*\}/g) ?? []) {
		const fromSpan = envelopeOf(span);
		if (fromSpan) return fromSpan;
	}
	return { message: text.trim() === "" ? null : text.trim(), calls: [] };
}

function parseAskCall(raw: unknown): AskCall[] {
	if (typeof raw !== "object" || raw === null) return [];
	const record = raw as { id?: unknown; name?: unknown; arguments?: unknown; args?: unknown };
	if (typeof record.name !== "string" || record.name.trim() === "") return [];
	const args = record.arguments !== undefined ? record.arguments : record.args;
	return [{ id: typeof record.id === "string" && record.id !== "" ? record.id : null, name: record.name, arguments: args ?? {} }];
}

/** The model id the ask turns run on, per the deployment's provider switch: the one place the
 * route's answer and the turns themselves read the same name from. */
export function askModelName(): string {
	return modelProvider() === "droid" ? DROID_MODEL : HOUSE_MODEL_OPENROUTER;
}

/** One model turn: reserve from the shared budget, run the provider's port, read the envelope.
 * Every provider attempt is its own budget event -- the retry reserves its own slot and records
 * its own START and END, so the log counts exactly what ran -- and a retry the budget cannot
 * admit is refused, never an unreserved call past the cap. A provider error retries once; a
 * rate or usage limit is terminal for the run, never retried. The budget's stamps are the wall
 * clock: the turn takes no clock at all, so the dev offset clock that governs domain deadlines
 * cannot reach the budget through it. */
export async function askLedgerTurn(deps: AskTurnDeps, input: { readonly messages: readonly AskMessage[]; readonly tools: readonly AskToolSchema[];
	readonly instructions?: string; readonly scope?: AskScope }): Promise<AskTurnOutcome> {
	const provider = modelProvider();
	const model = askModelName();
	const prompt = buildAskPrompt({ ...input, contract: input.scope === "OPERATOR" ? ASK_OPERATOR_TURN_CONTRACT : ASK_TURN_CONTRACT });
	const stamp = (): string => new Date().toISOString();
	const recordEnd = async (attempt: AskModelResult): Promise<void> => {
		await deps.callLog.append({ at: stamp(), caller: "ask-ledger", jobId: null, provider, model, phase: "END",
			outcome: attempt.ok ? "answered" : attempt.reason,
			sessionId: attempt.sessionId ?? null, factoryCredits: attempt.factoryCredits ?? null });
	};
	const reserved = await reserveModelCall(deps.callLog, { at: stamp(), caller: "ask-ledger", jobId: null, provider, model });
	if (!reserved.ok) return { ok: false, reason: "MODEL_BUDGET", detail: reserved.detail ?? "the deployment's shared model budget is spent for now" };
	let result = await deps.model(prompt);
	await recordEnd(result);
	if (!result.ok && result.reason === "PROVIDER_ERROR") {
		const retried = await reserveModelCall(deps.callLog, { at: stamp(), caller: "ask-ledger", jobId: null, provider, model });
		if (!retried.ok) return { ok: false, reason: "MODEL_BUDGET", detail: retried.detail ?? "the shared model budget refused the one retry" };
		result = await deps.model(prompt);
		await recordEnd(result);
	}
	if (!result.ok) {
		return result.reason === "RATE_LIMITED"
			? { ok: false, reason: "MODEL_RATE_LIMITED", detail: result.detail }
			: result.reason === "NO_KEY" ? { ok: false, reason: "MODEL_KEY_MISSING", detail: result.detail }
				: { ok: false, reason: "MODEL_PROVIDER_ERROR", detail: result.detail };
	}
	const envelope = parseAskEnvelope(result.text);
	return { ok: true, message: envelope.message, calls: envelope.calls, model, sessionId: result.sessionId, factoryCredits: result.factoryCredits };
}

// ---- the tools: a closed read-only set ----------------------------------------------------------

/** The tools the ledger agent may call. Read-only by name and by execution: the executor below is
 * the only thing that runs them, and it holds no create, capture, refund, payout, or update tool. */
export const ASK_TOOL_NAMES = ["list_jobs", "get_job", "platform_totals", "get_order", "list_disputes", "get_dispute", "get_refund",
	"list_transactions", "trace_figure"] as const;

/** The one PayPal read the ask tools make: a GET of `path`. `payee` names the merchant a merchant-scoped
 * object (an order, a capture, a refund) belongs to; null reads under the platform token alone. */
export type PaypalAskReader = { readonly get: (path: string, payee: string | null) => Promise<unknown> };

export type AskToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type AskExecutorDeps = {
	/** The whole book, as the platform ledger query serves it. */
	readonly platformView: () => Promise<readonly PlatformJobLedger[]>;
	/** The book's PayPal rows: each job's capture, the refund it recorded, and the merchant both were taken for. */
	readonly paypalEvents: () => Promise<readonly Pick<PlatformPayPalEventRow, "jobId" | "refundId" | "merchant">[]>;
	/** PayPal's read side, through the toolkit's own API client. Null when the deployment has no
	 * PayPal credentials, in which case the PayPal tools report themselves as unavailable. */
	readonly paypal: PaypalAskReader | null;
	/** The figure trace the Studio's Explain panel reads: the same route answer, for the ask tool. */
	readonly traceFigure: (figure: FigureId) => Promise<unknown>;
	/** The clock a transaction window ends on. */
	readonly nowMs?: () => number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Transaction Search answers at most 31 days per request, and its rows lag the event by about three hours. */
const TRANSACTION_MAX_DAYS = 31;
const TRANSACTION_DEFAULT_DAYS = 7;
const PAGE_SIZE = "10";

const argText = (args: Record<string, unknown>, key: string): string => {
	const value = args[key];
	return typeof value === "string" ? value.trim() : "";
};
const recordOf = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const listOf = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const textOf = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const moneyOf = (value: unknown): { readonly currency: string | null; readonly value: string } | null => {
	const amount = textOf(recordOf(value).value);
	return amount === null ? null : { currency: textOf(recordOf(value).currency_code), value: amount };
};

/** One dispute, reduced to the fields the ledger agent reads. PayPal's body is not passed on whole. */
const disputeRow = (raw: unknown) => {
	const dispute = recordOf(raw);
	return { disputeId: textOf(dispute.dispute_id), status: textOf(dispute.status), reason: textOf(dispute.reason),
		amount: moneyOf(dispute.dispute_amount), createTime: textOf(dispute.create_time),
		transactionId: textOf(recordOf(listOf(dispute.disputed_transactions)[0]).seller_transaction_id) };
};

/** One Transaction Search row, reduced to the fields the ledger agent reads. */
const transactionRow = (raw: unknown) => {
	const info = recordOf(recordOf(raw).transaction_info);
	return { transactionId: textOf(info.transaction_id), eventCode: textOf(info.transaction_event_code),
		status: textOf(info.transaction_status), amount: moneyOf(info.transaction_amount),
		initiatedAt: textOf(info.transaction_initiation_date) };
};

export function askToolExecutor(deps: AskExecutorDeps): AskToolExecutor {
	/** One PayPal GET for one tool. A refusal becomes a plain line naming the status and the tool; PayPal's body never leaves. */
	const payPalGet = async (tool: string, noun: string, path: string, payee: string | null): Promise<unknown> => {
		if (deps.paypal === null) throw new Error(`${tool} is unavailable: the deployment has no PayPal credentials`);
		try {
			return await deps.paypal.get(path, payee);
		} catch (error) {
			if (!(error instanceof PayPalHttpError)) throw error;
			const access = error.status === 403 ? `; this sandbox account may not have ${noun} access` : "";
			throw new Error(`PayPal answered ${error.status} for ${tool}${access}.`);
		}
	};
	const readOrder = async (args: Record<string, unknown>): Promise<unknown> => {
		const id = argText(args, "id");
		if (id === "") throw new Error("get_order needs the order's id");
		// An order PayPal cannot see without its merchant's name is read under the assertion the
		// book's own capture names: the payee the escrow was taken on behalf of.
		const payee = (await deps.platformView()).find(job => job.capture?.orderId === id)?.capture?.payee ?? null;
		return payPalGet("get_order", "order", `/v2/checkout/orders/${encodeURIComponent(id)}`, payee);
	};
	const listDisputes = async (args: Record<string, unknown>): Promise<unknown> => {
		const query = new URLSearchParams();
		const since = argText(args, "startTime");
		if (since !== "") {
			const ms = Date.parse(since);
			if (Number.isNaN(ms)) throw new Error("list_disputes needs startTime as an ISO 8601 date");
			query.set("start_time", searchInstant(ms));
		}
		query.set("page_size", PAGE_SIZE);
		const body = recordOf(await payPalGet("list_disputes", "dispute", `/v1/customer/disputes?${query.toString()}`, null));
		return { disputes: listOf(body.items).map(disputeRow) };
	};
	const getDispute = async (args: Record<string, unknown>): Promise<unknown> => {
		const id = argText(args, "disputeId");
		if (id === "") throw new Error("get_dispute needs the dispute's id");
		const body = recordOf(await payPalGet("get_dispute", "dispute", `/v1/customer/disputes/${encodeURIComponent(id)}`, null));
		// PayPal Disputes v1 nests the code under dispute_outcome; the bare outcome key is the fallback.
		return { ...disputeRow(body), outcome: textOf(recordOf(body.dispute_outcome ?? body.outcome).outcome_code), evidenceCount: listOf(body.evidences).length,
			offerAmount: moneyOf(recordOf(body.offer).buyer_requested_amount) };
	};
	const getRefund = async (args: Record<string, unknown>): Promise<unknown> => {
		const jobId = argText(args, "jobId");
		const asked = argText(args, "refundId");
		if (jobId === "" && asked === "") throw new Error("get_refund needs a job id or a refund id");
		// The refund is the one the book records, under the merchant the book took it from. A refund id
		// the book does not hold is read without an assertion, and the answer says so.
		const events = await deps.paypalEvents();
		let refundId: string;
		let payee: string | null;
		let note: string | null = null;
		if (jobId !== "") {
			const row = events.find(event => event.jobId === jobId && event.refundId !== null);
			if (row === undefined || row.refundId === null) throw new Error(`the book records no refund for job ${jobId}`);
			refundId = row.refundId;
			payee = row.merchant;
		} else {
			const row = events.find(event => event.refundId === asked);
			refundId = asked;
			payee = row?.merchant ?? null;
			if (row === undefined) note = "The book holds no refund with this id, so it was read without a merchant assertion.";
		}
		const body = recordOf(await payPalGet("get_refund", "refund", `/v2/payments/refunds/${encodeURIComponent(refundId)}`, payee));
		return { refundId: textOf(body.id) ?? refundId, status: textOf(body.status), amount: moneyOf(body.amount),
			createTime: textOf(body.create_time), merchantAsserted: payee !== null, note };
	};
	const listTransactions = async (args: Record<string, unknown>): Promise<unknown> => {
		const asked = args["days"];
		const requested = typeof asked === "number" && Number.isFinite(asked) ? asked : TRANSACTION_DEFAULT_DAYS;
		const days = Math.min(TRANSACTION_MAX_DAYS, Math.max(1, Math.floor(requested)));
		const end = (deps.nowMs ?? Date.now)();
		const start = end - days * DAY_MS;
		const query = new URLSearchParams({ start_date: searchInstant(start), end_date: searchInstant(end), page_size: PAGE_SIZE, page: "1" });
		const body = recordOf(await payPalGet("list_transactions", "transaction", `/v1/reporting/transactions?${query.toString()}`, null));
		return { from: searchInstant(start), to: searchInstant(end), days, transactions: listOf(body.transaction_details).map(transactionRow) };
	};
	const jobSummary = (job: PlatformJobLedger) => ({
		jobId: job.jobId, title: job.title, status: job.status, escrow: job.escrow,
		heldCents: job.paidCents, operator: job.operator?.handle ?? null, tenant: job.tenant, capture: job.capture,
	});
	return async (name, args) => {
		switch (name) {
			case "list_jobs": return { jobs: (await deps.platformView()).map(jobSummary) };
			case "get_job": {
				const id = typeof args["jobId"] === "string" ? args["jobId"].trim() : "";
				const job = id === "" ? null : (await deps.platformView()).find(candidate => candidate.jobId === id);
				if (!job) throw new Error(`no job named ${id === "" ? "(none given)" : id}`);
				return job;
			}
			case "platform_totals": {
				const jobs = await deps.platformView();
				return { ...platformEscrowTotals(jobs), heldJobs: jobs.filter(job => job.escrow === "HELD").length };
			}
			case "get_order": return readOrder(args);
			case "list_disputes": return listDisputes(args);
			case "get_dispute": return getDispute(args);
			case "get_refund": return getRefund(args);
			case "list_transactions": return listTransactions(args);
			case "trace_figure": {
				const figure = args["figure"];
				if (!isFigureId(figure)) throw new Error(`trace_figure needs one figure: ${FIGURE_IDS.join(", ")}`);
				return deps.traceFigure(figure);
			}
			default: throw new Error(`no tool named ${name}`);
		}
	};
}

/** The tool list the route serves the browser: schemas for the closed read-only set. */
export function askToolList(paypalConfigured: boolean): readonly { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown>; readonly kind: "client" }[] {
	const list: { name: string; description: string; parameters: Record<string, unknown>; kind: "client" }[] = [
		{ name: "list_jobs", kind: "client",
			description: "Every job's money across all tenants: id, title, status, escrow state, held cents, the operator, and each held job's PayPal capture ids.",
			parameters: { type: "object", properties: {}, required: [] } },
		{ name: "get_job", kind: "client",
			description: "One job's full platform ledger row: its book lines, its funding capture (order id, capture id, payee, gross), its payout, receipt, and every judged attempt.",
			parameters: { type: "object", properties: { jobId: { type: "string", description: "The job's id, as list_jobs names it" } }, required: ["jobId"] } },
		{ name: "platform_totals", kind: "client",
			description: "The book's totals: held, released, refunded, and fee cents, plus how many jobs currently hold escrow.",
			parameters: { type: "object", properties: {}, required: [] } },
		{ name: "trace_figure", kind: "client",
			description: "One escrow figure traced to the money behind it: its total and the ledger lines that sum to it (job, kind, cents, receipt id), each with its PayPal object's id and live status (MATCHED, PENDING_AT_PAYPAL, MISMATCHED, or NOT_CHECKED with a note). Read-only.",
			parameters: { type: "object", properties: { figure: { type: "string", enum: [...FIGURE_IDS], description: "held, released, refunded, fees, or paid-by-clients" } }, required: ["figure"] } },
	];
	if (paypalConfigured) {
		list.push({ name: "get_order", kind: "client",
			description: "PayPal Agent Toolkit, read-only: retrieves one sandbox order's details by id -- its status, its capture, and the amounts PayPal holds. Use it on a held job's capture.orderId to check whether PayPal agrees with the book.",
			parameters: { type: "object", properties: { id: { type: "string", description: "The PayPal order id, as a held job's capture.orderId names it" } }, required: ["id"] } });
		list.push({ name: "list_disputes", kind: "client",
			description: "PayPal, read-only: the sandbox account's customer disputes, ten at a time, each with its id, status, reason, amount, open time, and the seller transaction it names. Pass startTime to see only disputes opened since then.",
			parameters: { type: "object", properties: { startTime: { type: "string", description: "An ISO 8601 date; only disputes opened on or after it" } }, required: [] } },
		{ name: "get_dispute", kind: "client",
			description: "PayPal, read-only: one dispute by id, with its status, reason, amount, the seller transaction it names, its outcome if any, how many evidence items it holds, and the buyer's offer where PayPal sends one.",
			parameters: { type: "object", properties: { disputeId: { type: "string", description: "The dispute's id, as list_disputes names it" } }, required: ["disputeId"] } },
		{ name: "get_refund", kind: "client",
			description: "PayPal, read-only: the refund the book records for a job (jobId) or for a refund id (refundId), with its status, amount, and creation time. The read asserts the merchant the book took the refund from; a refund id the book does not hold is read without an assertion, and the answer says so.",
			parameters: { type: "object", properties: { jobId: { type: "string", description: "The job whose refund to read, as list_jobs names it" }, refundId: { type: "string", description: "The PayPal refund id" } }, required: [] } },
		{ name: "list_transactions", kind: "client",
			description: "PayPal Transaction Search, read-only: the platform account's transactions over the last `days` (default 7, at most 31): id, event code, status, amount, and initiation time. PayPal lists a transaction about three hours after it happens, so the newest ones may be missing.",
			parameters: { type: "object", properties: { days: { type: "number", description: "How many days back to look, from 1 to 31; default 7" } }, required: [] } });
	}
	return list;
}

// ---- the operator's tools: its own jobs, receipts, and payouts ---------------------------------

/** The tools an operator's ask may call. Each reads the signed-in operator's own jobs alone: no PayPal
 * tool, no book-wide read, no figure trace. The executor below is the only thing that runs them. */
export const OPERATOR_ASK_TOOL_NAMES = ["my_jobs", "my_job", "my_payouts", "my_totals"] as const;

/** One of the operator's jobs: the hold its release will pay, or the settlement it was paid. Money is in cents. */
export type OperatorJobRow = {
	readonly jobId: string;
	readonly title: string | null;
	readonly status: string;
	readonly escrow: "HELD" | "RELEASED";
	/** The net the release pays while the job is held, and what was paid once it settled. */
	readonly netCents: number;
	/** The fee the book took on a settled job; null while it is held. */
	readonly feeCents: number | null;
	readonly receiptId: string | null;
	readonly releasedAt: string | null;
};

/** What an operator's executor reads. The server builds it per request from the operator's session actor. */
export type OperatorAskDeps = {
	readonly operatorId: string;
	/** The operator's view of the book, read under its own session: the jobs its escrow and bids name. */
	readonly jobs: () => Promise<readonly JobView[]>;
	/** The operator's receipts: its settled jobs, and seeded history rows that have no job behind them. */
	readonly receipts: () => Promise<readonly ReceiptRowView[]>;
	/** The operator's payouts: one row per job PayPal paid it. */
	readonly payouts: () => Promise<readonly PayoutRowView[]>;
};

const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const sumCents = (values: readonly number[]): number => values.reduce((total, cents) => total + cents, 0);

/** The operator's own jobs: each hold its release will pay (the rows the escrow route serves) and each settled receipt (the rows the receipts route serves). */
async function operatorJobRows(deps: OperatorAskDeps): Promise<OperatorJobRow[]> {
	const [jobs, receipts] = await Promise.all([deps.jobs(), deps.receipts()]);
	const views = new Map(jobs.map(job => [String(job.id), job] as const));
	const held = operatorEscrow(jobs, deps.operatorId).flatMap((row): OperatorJobRow[] => {
		const view = views.get(row.jobId);
		return view === undefined ? [] : [{ jobId: row.jobId, title: view.title, status: view.status, escrow: "HELD",
			netCents: row.cents, feeCents: null, receiptId: null, releasedAt: null }];
	});
	const settled = receipts.flatMap((receipt): OperatorJobRow[] => {
		const jobId = textOf(receipt.jobId);
		// A receipt names the operator it was paid to; a row for another operator is never this one's, whatever source sent it.
		if (jobId === null || receipt.operator !== deps.operatorId) return [];
		return [{ jobId, title: views.get(jobId)?.title ?? null, status: "PAID", escrow: "RELEASED",
			netCents: numberOrNull(receipt.paid) ?? 0, feeCents: numberOrNull(receipt.fee), receiptId: textOf(receipt.id), releasedAt: textOf(receipt.releasedAt) }];
	});
	return [...held, ...settled];
}

/** The operator's executor: its four tools, each answered from the operator's own rows. Any other name, the platform's included, falls to the default before any read. */
export function askOperatorToolExecutor(deps: OperatorAskDeps): AskToolExecutor {
	return async (name, args) => {
		switch (name) {
			case "my_jobs": return { jobs: await operatorJobRows(deps) };
			case "my_job": {
				const id = argText(args, "jobId");
				const job = id === "" ? undefined : (await operatorJobRows(deps)).find(candidate => candidate.jobId === id);
				// Another operator's job and an unknown id get this same answer, so a reply never shows whether a job exists.
				if (!job) throw new Error(`no job of yours named ${id === "" ? "(none given)" : id}`);
				return job;
			}
			case "my_payouts": {
				// A payout row names no operator, so it is the operator's where its job is one of the operator's settled jobs.
				const settled = new Set((await operatorJobRows(deps)).filter(row => row.escrow === "RELEASED").map(row => row.jobId));
				return { payouts: (await deps.payouts()).filter(payout => settled.has(payout.jobId)).map(payout => ({ jobId: payout.jobId,
					payoutItemId: payout.payoutItemId, captureId: payout.captureId, paidCents: payout.paid, releasedAt: payout.releasedAt,
					releaseAuthority: payout.releaseAuthority })) };
			}
			case "my_totals": {
				const rows = await operatorJobRows(deps);
				const settled = rows.filter(row => row.escrow === "RELEASED");
				const held = rows.filter(row => row.escrow === "HELD");
				// The sums the earnings tiles read (earnings() in apps/web/src/studio-data.ts). The API cannot import the web program, so the formula is kept equal by its tests.
				return { paidOutCents: sumCents(settled.map(row => row.netCents)), feesWithheldCents: sumCents(settled.map(row => row.feeCents ?? 0)),
					jobsPaid: settled.length, heldCents: sumCents(held.map(row => row.netCents)), heldJobs: held.length };
			}
			default: throw new Error(`no tool named ${name}`);
		}
	};
}

/** The tool list an operator's ask serves: the four tools, each worded for the operator's own jobs. */
export function askOperatorToolList(): readonly { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown>; readonly kind: "client" }[] {
	return [
		{ name: "my_jobs", kind: "client",
			description: "Your jobs on Acquit: each job you hold escrow for, and each job you were paid for. Each row has the job's id, title, status, escrow state, the net the release pays while held or the amount paid once settled (cents), the fee the book took on a settled job, and the receipt id.",
			parameters: { type: "object", properties: {}, required: [] } },
		{ name: "my_job", kind: "client",
			description: "One of your jobs, by id, with the same fields as my_jobs. A job that is not yours is not found.",
			parameters: { type: "object", properties: { jobId: { type: "string", description: "The job's id, as my_jobs names it" } }, required: ["jobId"] } },
		{ name: "my_payouts", kind: "client",
			description: "Your payouts: one row per job PayPal paid you, with the job id, the payout item it paid through, the capture, the amount paid (cents), and when it was released.",
			parameters: { type: "object", properties: {}, required: [] } },
		{ name: "my_totals", kind: "client",
			description: "Your totals in cents: paid out and fees withheld on your settled jobs, how many jobs were paid, and what is held for you now.",
			parameters: { type: "object", properties: {}, required: [] } },
	];
}

const MINUTE_MS = 60_000;
/** Ask turns one operator may run inside the deployment's shared model budget, per rolling minute and per rolling day. */
export const OPERATOR_TURNS_PER_MINUTE = 6;
export const OPERATOR_TURNS_PER_DAY = 60;

/**
 * The admission an operator's turn passes before the shared budget reserves: the operator's own rolling
 * counts, kept in memory. A refused turn reserves nothing. The platform's turns do not pass it.
 */
export function operatorTurnLimiter(now: () => number = Date.now): (operatorId: string) => boolean {
	const admitted = new Map<string, number[]>();
	return operatorId => {
		const at = now();
		const day = (admitted.get(operatorId) ?? []).filter(stamp => at - stamp < DAY_MS);
		const minute = day.filter(stamp => at - stamp < MINUTE_MS).length;
		const allowed = minute < OPERATOR_TURNS_PER_MINUTE && day.length < OPERATOR_TURNS_PER_DAY;
		if (allowed) day.push(at);
		admitted.set(operatorId, day);
		return allowed;
	};
}

// ---- the real ports -----------------------------------------------------------------------------

/** The deployment's PayPal ask reader: the same toolkit-backed reader the payout tool reads
 * through (one minted token, renewed before expiry, a refused read re-minted and retried once).
 * It makes GETs only, and the executor above is the one caller that names their paths. */
export function paypalAskReader(config: { readonly clientId: string; readonly clientSecret: string },
	fetchImpl: typeof fetch = fetch): PaypalAskReader {
	let reader: Promise<PaypalReader> | null = null;
	const read = (): Promise<PaypalReader> => {
		reader ??= paypalReader({ ...config, sandbox: true }, fetchImpl);
		return reader;
	};
	return {
		async get(path, payee) {
			// A merchant-scoped object hides from a bare platform read: the assertion names the payee
			// it belongs to, exactly as the platform's own PayPal client does.
			const assertion = payee === null ? undefined : authAssertion(config.clientId, payee as MerchantId);
			return (await read()).get(path, assertion);
		},
	};
}

/** The OpenRouter ask port, for the openrouter provider. Tested with injected transports only;
 * no live call is made by this mission. The key comes from the session keyring, in process. */
export function openrouterAskPort(deps: { readonly fetch?: typeof fetch; readonly key?: () => Promise<string | null>; readonly env?: NodeJS.ProcessEnv } = {}): AskModelPort {
	const fetchImpl = deps.fetch ?? fetch;
	const env = deps.env ?? process.env;
	const keyOf = deps.key ?? (async () => keyringKey());
	return async prompt => {
		const held = await keyOf();
		if (held === null || held === "" || /[\r\n]/.test(held)) return { ok: false, reason: "NO_KEY", detail: "no usable OpenRouter key in the keyring" };
		const base = env["OPENROUTER_API_BASE"]?.trim() || "https://openrouter.ai/api/v1";
		let response: Response;
		try {
			response = await fetchImpl(`${base}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${held}`, "content-type": "application/json" },
				body: JSON.stringify({ model: HOUSE_MODEL_OPENROUTER, max_tokens: 2048, messages: [{ role: "user", content: prompt }] }),
				signal: AbortSignal.timeout(120_000), redirect: "error",
			});
		} catch (error) {
			return { ok: false, reason: "PROVIDER_ERROR", detail: boundedDetail(error instanceof Error ? error.message : String(error)) };
		}
		if (response.status === 429) return { ok: false, reason: "RATE_LIMITED", detail: "OpenRouter answered 429" };
		if (!response.ok) return { ok: false, reason: "PROVIDER_ERROR", detail: `OpenRouter answered ${response.status}` };
		const body = await response.json() as { choices?: readonly { message?: { content?: unknown } }[] };
		const text = body.choices?.[0]?.message?.content;
		return typeof text === "string" && text.trim() !== ""
			? { ok: true, text, sessionId: null, factoryCredits: null }
			: { ok: false, reason: "PROVIDER_ERROR", detail: "OpenRouter answered no content" };
	};
}

/** The droid ask port: one read-only `droid exec` turn, the prompt by file, the Factory key in the
 * child's environment built in process -- never in argv, never in a log. No --auto: nothing the
 * model asks to run can execute, so the port's only product is the answer text. */
export function droidAskPort(deps: { readonly env?: NodeJS.ProcessEnv } = {}): AskModelPort {
	const env = deps.env ?? process.env;
	return async prompt => {
		const key = await factoryApiKey(env);
		if (key === null) return { ok: false, reason: "NO_KEY", detail: "no usable Factory key" };
		const dir = await mkdtemp(join(tmpdir(), "acquit-ask-"));
		const file = join(dir, "ask-instruction.txt");
		await writeFile(file, prompt, { mode: 0o600 });
		// Read-only argv, the ruling pinned: the model, json output, the prompt by file. No --auto,
		// and the working directory is the turn's own temp dir, never a job repo. The child runs
		// under `timeout 290` too, so one whose parent dies mid-turn still ends itself instead of
		// holding its connections forever.
		const argv = ["290", "droid", "exec", "-m", DROID_MODEL, "-o", "json", "-f", file];
		try {
			const run = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
				// stderr is ignored, not piped: nothing here reads it, and a chatty child would fill the
				// pipe buffer and wedge on a write that never drains, past every timeout this port sets.
				const child = spawn("timeout", argv, { env: { ...env, FACTORY_API_KEY: key }, cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
				let stdout = "";
				const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("the droid turn timed out")); }, 300_000);
				child.stdout.on("data", (chunk: Buffer) => { stdout += String(chunk); });
				child.on("error", (error: Error) => { clearTimeout(timer); reject(error); });
				child.on("exit", (code: number | null) => { clearTimeout(timer); resolve({ code, stdout }); });
			}).catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				return { code: null as number | null, stdout: "", spawnDetail: detail };
			});
			if ("spawnDetail" in run) return { ok: false, reason: "PROVIDER_ERROR", detail: boundedDetail(run.spawnDetail) };
			const classified = classifyDroidRun(run.code, run.stdout);
			// A failed run carries what it reported: the session it spent and the credits it charged.
			if (!classified.ok) {
				return { ok: false, reason: classified.reason, detail: classified.detail,
					sessionId: classified.sessionId, factoryCredits: classified.factoryCredits };
			}
			return { ok: true, text: droidResultText(run.stdout) ?? "", sessionId: classified.sessionId, factoryCredits: classified.factoryCredits };
		} finally { await rm(dir, { recursive: true, force: true }); }
	};
}

/** Whether the ask route can run a turn at all: a usable provider key in process. The answer says
 * so without naming one -- the key is never printed, never logged, never in a bundle. */
export async function askKeyConfigured(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	if (modelProvider(env) === "openrouter") return keyringKey() !== null;
	return (await factoryApiKey(env)) !== null;
}
