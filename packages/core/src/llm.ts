// The chat-completions client for the fireworks and meta providers: one fetch-based POST per call,
// no SDK, no retry. The feature layer owns the one fallback, so a call here is always one attempt.
// The base URL is fixed in code and checked before each request. The key is read in process from
// the provider's own environment name and travels only as a bearer header. A failure comes back as
// a value whose detail names no key and quotes no provider body.

import { boundedDetail } from "./verifier.ts";

export type LlmProvider = "fireworks" | "meta";

type LlmProviderSpec = {
	readonly name: string;
	readonly baseUrl: string;
	readonly host: string;
	readonly keyEnv: string;
	readonly tokenField: "max_tokens" | "max_completion_tokens";
};

/** The providers' fixed endpoints. Server-owned: no request and no environment value changes a base URL. */
export const LLM_PROVIDERS: Readonly<Record<LlmProvider, LlmProviderSpec>> = {
	fireworks: { name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", host: "api.fireworks.ai", keyEnv: "FIREWORKS_API_KEY", tokenField: "max_tokens" },
	meta: { name: "Meta", baseUrl: "https://api.meta.ai/v1", host: "api.meta.ai", keyEnv: "META_API_KEY", tokenField: "max_completion_tokens" },
};

/** One attempt's wall-clock limit when ACQUIT_LLM_TIMEOUT_MS is unset. A turn's own deadline cancels earlier through the request signal. */
export const LLM_TIMEOUT_MS = 60_000;

const LLM_TIMEOUT_ENV = "ACQUIT_LLM_TIMEOUT_MS";

const ERROR_BODY_LIMIT = 4096;

/** The one feature-layer call sites that run a model through this client. */
export type LlmFeature = "ask" | "scoping";
export type LlmRole = "primary" | "fallback";

const LLM_MODEL_ENV: Readonly<Record<LlmFeature, Readonly<Record<LlmRole, string>>>> = {
	ask: { primary: "ACQUIT_LLM_ASK_MODEL", fallback: "ACQUIT_LLM_ASK_FALLBACK_MODEL" },
	scoping: { primary: "ACQUIT_LLM_SCOPING_MODEL", fallback: "ACQUIT_LLM_SCOPING_FALLBACK_MODEL" },
};

const LLM_MODEL_DEFAULTS: Readonly<Record<LlmFeature, Readonly<Record<LlmRole, string>>>> = {
	ask: { primary: "accounts/fireworks/models/glm-5p3-flash", fallback: "accounts/fireworks/models/kimi-k3p1-pro" },
	scoping: { primary: "accounts/fireworks/models/kimi-k3p1-pro", fallback: "accounts/fireworks/models/glm-5p3" },
};

const MODEL_ID = /^[A-Za-z0-9._/:-]{1,200}$/;

/** The model a feature's attempt runs under: its server-owned env name when set, else the default. A malformed name is a
 * configuration error that names the variable and never echoes the value. */
export function llmModelFor(feature: LlmFeature, role: LlmRole, env: NodeJS.ProcessEnv = process.env): string {
	const envName = LLM_MODEL_ENV[feature][role];
	const named = env[envName]?.trim();
	if (named === undefined || named === "") return LLM_MODEL_DEFAULTS[feature][role];
	if (!MODEL_ID.test(named)) throw new Error(`${envName} must be a Fireworks model id, not the value it was given`);
	return named;
}

/** One attempt's time limit: ACQUIT_LLM_TIMEOUT_MS when set to a whole number of milliseconds from 1 s to 5 min. */
export function llmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const named = env[LLM_TIMEOUT_ENV]?.trim();
	if (named === undefined || named === "") return LLM_TIMEOUT_MS;
	const ms = Number(named);
	if (!Number.isInteger(ms) || ms < 1_000 || ms > 300_000) {
		throw new Error(`${LLM_TIMEOUT_ENV} must be a whole number of milliseconds from 1000 to 300000`);
	}
	return ms;
}

/** A provider's base URL, checked before use: https, the provider's own host, and no credentials, port, query, or fragment. */
export function llmBaseUrl(provider: LlmProvider): string {
	const spec = LLM_PROVIDERS[provider];
	const url = new URL(spec.baseUrl);
	const plain = url.protocol === "https:" && url.hostname === spec.host && url.port === ""
		&& url.username === "" && url.password === "" && url.search === "" && url.hash === "";
	if (!plain) throw new Error(`the ${spec.name} base URL is not its fixed endpoint`);
	return spec.baseUrl;
}

/** The provider's key from its environment name: null when unset, blank, or not a single line. Read in process, never logged. */
export function llmKey(provider: LlmProvider, env: NodeJS.ProcessEnv = process.env): string | null {
	const key = env[LLM_PROVIDERS[provider].keyEnv]?.trim();
	return key === undefined || key === "" || /[\r\n]/.test(key) ? null : key;
}

/** The per-model options the live probes proved on Fireworks: GLM answers only at minimal reasoning effort,
 * and Kimi's thinking is switched off. GLM rejects thinking-disabled, so the two are never mixed. */
function fireworksModelOptions(model: string): Record<string, unknown> {
	if (model.includes("glm-5p3")) return { reasoning_effort: "minimal" };
	if (model.includes("kimi-k3p1-pro")) return { thinking: { type: "disabled" } };
	return {};
}

export type LlmRequest = {
	readonly provider: LlmProvider;
	readonly model: string;
	/** The one user message the request carries. */
	readonly prompt: string;
	readonly maxTokens: number;
	readonly timeoutMs?: number | undefined;
	readonly signal?: AbortSignal | undefined;
};

export type LlmUsage = { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number };

export type LlmResult =
	| { readonly ok: true; readonly text: string; readonly requestId: string | null; readonly finishReason: string | null; readonly usage: LlmUsage | null }
	| { readonly ok: false; readonly reason: "PROVIDER_ERROR" | "RATE_LIMITED" | "NO_KEY"; readonly detail: string;
		readonly requestId: string | null; readonly usage: LlmUsage | null };

export type LlmDeps = { readonly fetch?: typeof fetch | undefined; readonly env?: NodeJS.ProcessEnv | undefined };

/** The JSON body one attempt posts. Meta takes max_completion_tokens; Fireworks takes max_tokens. Meta answers
 * only at minimal reasoning effort ("none" is rejected), so it gets the same reasoning option as GLM. */
export function llmRequestBody(request: Pick<LlmRequest, "provider" | "model" | "prompt" | "maxTokens">): Record<string, unknown> {
	const options = request.provider === "fireworks" ? fireworksModelOptions(request.model) : { reasoning_effort: "minimal" };
	return {
		model: request.model,
		messages: [{ role: "user", content: request.prompt }],
		[LLM_PROVIDERS[request.provider].tokenField]: request.maxTokens,
		...options,
	};
}

/** A rate or usage limit answers in the provider's own error text. The caller treats it as terminal. */
const LIMIT_BODY = /rate.?limit|usage limit|quota|too many requests|insufficient (credit|balance)/i;

/** The first `limit` characters of an error body, read as a stream so a large body is never buffered whole. */
async function boundedText(response: Response, limit: number): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (text.length < limit) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return text.slice(0, limit);
}

const redact = (text: string, key: string): string => text.split(key).join("[redacted]");

/** A provider's request id is kept only as a plain token: it is written to the model-call log, so it never carries
 * free text, and an id that contains the key is dropped. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const requestIdOf = (value: unknown, key: string): string | null =>
	typeof value === "string" && REQUEST_ID.test(value) && !value.includes(key) ? value : null;

function usageOf(raw: unknown): LlmUsage | null {
	if (typeof raw !== "object" || raw === null) return null;
	const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
	const { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } = usage;
	if (typeof promptTokens !== "number" || typeof completionTokens !== "number" || typeof totalTokens !== "number") return null;
	return { promptTokens, completionTokens, totalTokens };
}

/** One chat-completions attempt. A provider or transport failure is a value, never a throw. The timeout is an
 * AbortController that also covers reading the body; redirects are refused; the caller's signal aborts too. */
export async function llmChat(request: LlmRequest, deps: LlmDeps = {}): Promise<LlmResult> {
	const spec = LLM_PROVIDERS[request.provider];
	const env = deps.env ?? process.env;
	const key = llmKey(request.provider, env);
	const fail = (reason: "PROVIDER_ERROR" | "RATE_LIMITED" | "NO_KEY", detail: string,
		requestId: string | null = null, usage: LlmUsage | null = null): LlmResult => ({ ok: false, reason, detail, requestId, usage });
	if (key === null) return fail("NO_KEY", `no usable ${spec.keyEnv} is set`);
	const cancelled = (): boolean => request.signal?.aborted === true;
	if (cancelled()) return fail("PROVIDER_ERROR", `the turn was cancelled before ${spec.name} was asked`);
	const url = `${llmBaseUrl(request.provider)}/chat/completions`;
	const fetchImpl = deps.fetch ?? fetch;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs ?? llmTimeoutMs(env));
	const onAbort = (): void => { controller.abort(); };
	request.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(llmRequestBody(request)),
			redirect: "error",
			signal: controller.signal,
		});
		const headerId = requestIdOf(response.headers.get("x-request-id"), key);
		if (response.status === 429) return fail("RATE_LIMITED", `${spec.name} answered 429`, headerId);
		if (!response.ok) {
			const body = await boundedText(response, ERROR_BODY_LIMIT);
			const limited = (response.status === 402 || response.status === 403) && LIMIT_BODY.test(body);
			return fail(limited ? "RATE_LIMITED" : "PROVIDER_ERROR", `${spec.name} answered ${response.status}`, headerId);
		}
		const raw = await response.text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return fail("PROVIDER_ERROR", `${spec.name} answered malformed JSON`, headerId);
		}
		const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { id?: unknown; choices?: unknown; usage?: unknown };
		const requestId = requestIdOf(record.id, key) ?? headerId;
		const usage = usageOf(record.usage);
		const first: unknown = Array.isArray(record.choices) ? record.choices[0] : undefined;
		if (typeof first !== "object" || first === null) return fail("PROVIDER_ERROR", `${spec.name} answered with no choices`, requestId, usage);
		const choice = first as { finish_reason?: unknown; message?: { content?: unknown; reasoning_content?: unknown } };
		const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
		const text = typeof choice.message?.content === "string" ? choice.message.content : "";
		if (text.trim() === "") {
			const reasoned = choice.message?.reasoning_content !== undefined && choice.message.reasoning_content !== null;
			const why = finishReason === "length" ? "hit the token cap with no answer text"
				: reasoned ? "returned reasoning without an answer"
					: "returned no answer text";
			return fail("PROVIDER_ERROR", `${spec.name} ${why}`, requestId, usage);
		}
		// A reply that ran into the token cap is missing its end, and a caller cannot tell a truncated draft or envelope
		// from a complete one. It is a provider error, so the one fallback attempt may still answer the turn.
		if (finishReason === "length") return fail("PROVIDER_ERROR", `${spec.name} hit the token cap before the answer ended`, requestId, usage);
		return { ok: true, text, requestId, finishReason, usage };
	} catch (error) {
		if (timedOut) return fail("PROVIDER_ERROR", `${spec.name} did not answer in time`);
		if (cancelled()) return fail("PROVIDER_ERROR", "the turn was cancelled while the request was in flight");
		return fail("PROVIDER_ERROR", boundedDetail(redact(error instanceof Error ? error.message : String(error), key)));
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener("abort", onAbort);
	}
}
