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
import type { PlatformJobLedger } from "../../../packages/core/src/platform.ts";
import { HOUSE_MODEL_OPENROUTER, keyringKey } from "../../../packages/house/src/runner.ts";
import { paypalReader } from "../../../packages/mcp/src/paypal.ts";
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
	| { readonly ok: false; readonly reason: "PROVIDER_ERROR" | "RATE_LIMITED" | "NO_KEY"; readonly detail: string };

export type AskTurnDeps = {
	readonly model: AskModelPort;
	readonly callLog: ModelCallLog;
	readonly now: () => string;
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

/** The prompt one model turn runs under: the agent's instruction, the envelope contract, the tool
 * schemas, the conversation. It names no secret -- the key travels in the child's environment. */
export function buildAskPrompt(input: { readonly messages: readonly AskMessage[]; readonly tools: readonly AskToolSchema[]; readonly instructions?: string }): string {
	const instruction = input.instructions !== undefined && input.instructions.trim() !== "" ? input.instructions.trim() : ASK_TURN_CONTRACT;
	return [
		instruction,
		...(instruction === ASK_TURN_CONTRACT ? [] : [ASK_TURN_CONTRACT]),
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
 * A provider error retries once; a rate or usage limit is terminal for the run, never retried. */
export async function askLedgerTurn(deps: AskTurnDeps, input: { readonly messages: readonly AskMessage[]; readonly tools: readonly AskToolSchema[]; readonly instructions?: string }): Promise<AskTurnOutcome> {
	const provider = modelProvider();
	const model = askModelName();
	const reserved = await reserveModelCall(deps.callLog, { at: deps.now(), caller: "ask-ledger", jobId: null, provider, model });
	if (!reserved.ok) return { ok: false, reason: "MODEL_BUDGET", detail: "the deployment's shared model budget is spent for now" };
	const prompt = buildAskPrompt(input);
	let result = await deps.model(prompt);
	if (!result.ok && result.reason === "PROVIDER_ERROR") result = await deps.model(prompt);
	if (!result.ok) {
		await deps.callLog.append({ at: deps.now(), caller: "ask-ledger", jobId: null, provider, model, phase: "END",
			outcome: result.reason, sessionId: null, factoryCredits: null });
		return result.reason === "RATE_LIMITED"
			? { ok: false, reason: "MODEL_RATE_LIMITED", detail: result.detail }
			: result.reason === "NO_KEY" ? { ok: false, reason: "MODEL_KEY_MISSING", detail: result.detail }
				: { ok: false, reason: "MODEL_PROVIDER_ERROR", detail: result.detail };
	}
	const envelope = parseAskEnvelope(result.text);
	await deps.callLog.append({ at: deps.now(), caller: "ask-ledger", jobId: null, provider, model, phase: "END",
		outcome: "answered", sessionId: result.sessionId, factoryCredits: result.factoryCredits });
	return { ok: true, message: envelope.message, calls: envelope.calls, model, sessionId: result.sessionId, factoryCredits: result.factoryCredits };
}

// ---- the tools: a closed read-only set ----------------------------------------------------------

/** The tools the ledger agent may call. Read-only by name and by execution: the executor below is
 * the only thing that runs them, and it holds no create, capture, refund, payout, or update tool. */
export const ASK_TOOL_NAMES = ["list_jobs", "get_job", "platform_totals", "get_order"] as const;

export type PaypalAskReader = { readonly getOrder: (id: string) => Promise<unknown> };

export type AskToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type AskExecutorDeps = {
	/** The whole book, as the platform ledger query serves it. */
	readonly platformView: () => Promise<readonly PlatformJobLedger[]>;
	/** PayPal's read side, through the toolkit's own API client. Null when the deployment has no
	 * PayPal credentials, in which case get_order reports the tool as unavailable. */
	readonly paypal: PaypalAskReader | null;
};

export function askToolExecutor(deps: AskExecutorDeps): AskToolExecutor {
	const readOrder = async (args: Record<string, unknown>): Promise<unknown> => {
		if (deps.paypal === null) throw new Error("get_order is unavailable: the deployment has no PayPal credentials");
		const id = typeof args["id"] === "string" ? args["id"].trim() : "";
		if (id === "") throw new Error("get_order needs the order's id");
		return deps.paypal.getOrder(id);
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
	];
	if (paypalConfigured) {
		list.push({ name: "get_order", kind: "client",
			description: "PayPal Agent Toolkit, read-only: retrieves one sandbox order's details by id -- its status, its capture, and the amounts PayPal holds. Use it on a held job's capture.orderId to check whether PayPal agrees with the book.",
			parameters: { type: "object", properties: { id: { type: "string", description: "The PayPal order id, as a held job's capture.orderId names it" } }, required: ["id"] } });
	}
	return list;
}

// ---- the real ports -----------------------------------------------------------------------------

/** The deployment's PayPal ask reader: the same toolkit-backed reader the payout tool reads
 * through (one minted token, renewed before expiry, a refused read re-minted and retried once),
 * pointed at the one read the ask tools may make, get_order. */
export function paypalAskReader(config: { readonly clientId: string; readonly clientSecret: string },
	fetchImpl: typeof fetch = fetch): PaypalAskReader {
	let reader: Promise<PaypalReader> | null = null;
	const read = (): Promise<PaypalReader> => {
		reader ??= paypalReader({ ...config, sandbox: true }, fetchImpl);
		return reader;
	};
	return {
		async getOrder(id) {
			return (await read()).get(`/v2/checkout/orders/${encodeURIComponent(id)}`);
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
		// and the working directory is the turn's own temp dir, never a job repo.
		const argv = ["droid", "exec", "-m", DROID_MODEL, "-o", "json", "-f", file];
		try {
			const run = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
				const child = spawn("droid", argv, { env: { ...env, FACTORY_API_KEY: key }, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
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
			if (!classified.ok) return { ok: false, reason: classified.reason, detail: classified.detail };
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
