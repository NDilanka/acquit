// The chat-completions client for fireworks and meta: pure transport logic against an injected fetch.
// No socket opens here, and no test reads a real key -- every key below is a placeholder.

import assert from "node:assert/strict";
import { test } from "node:test";
import { llmBaseUrl, llmChat, llmKey, llmModelFor, llmRequestBody, llmTimeoutMs, LLM_TIMEOUT_MS } from "../src/llm.ts";
import type { LlmRequest } from "../src/llm.ts";

const FW_KEY = "fw-test-key-000000";
const META_KEY = "meta-test-key-000000";
const env = { FIREWORKS_API_KEY: FW_KEY, META_API_KEY: META_KEY };
const GLM = "accounts/fireworks/models/glm-5p3-flash";
const KIMI = "accounts/fireworks/models/kimi-k3p1-pro";

type Call = { readonly url: string; readonly init: RequestInit };

/** A fetch that records every call and answers each one from `answer`. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>): { readonly fetch: typeof fetch; readonly calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const call: Call = { url: String(url), init: init ?? {} };
		calls.push(call);
		return answer(call);
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const completion = (content: unknown, extra: Record<string, unknown> = {}, finish = "stop"): Record<string, unknown> => ({
	id: "req-1",
	choices: [{ finish_reason: finish, message: { role: "assistant", content } }],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	...extra,
});

const fireworksRequest = (model: string = GLM, extra: Partial<LlmRequest> = {}): LlmRequest =>
	({ provider: "fireworks", model, prompt: "hello there", maxTokens: 2048, ...extra });

const bodyOf = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const headerOf = (call: Call, name: string): string | undefined => (call.init.headers as Record<string, string>)[name];

test("fireworks posts one chat-completions request to its fixed endpoint, the key as a bearer header only", async () => {
	const { fetch, calls } = fakeFetch(() => jsonResponse(completion("an answer")));
	const result = await llmChat(fireworksRequest(), { fetch, env });
	assert.equal(result.ok, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://api.fireworks.ai/inference/v1/chat/completions");
	assert.equal(calls[0]!.init.method, "POST");
	assert.equal(headerOf(calls[0]!, "authorization"), `Bearer ${FW_KEY}`);
	assert.equal(headerOf(calls[0]!, "content-type"), "application/json");
	assert.equal(calls[0]!.init.redirect, "error", "a redirect is refused, never followed");
	assert.ok(calls[0]!.init.signal, "the request carries an abort signal for its timeout");
	assert.equal(JSON.stringify(calls[0]!.init.body).includes(FW_KEY), false, "the key never travels in the body");
});

test("fireworks request bodies: glm carries minimal reasoning and no thinking switch; kimi carries thinking disabled", () => {
	assert.deepEqual(llmRequestBody({ provider: "fireworks", model: GLM, prompt: "p", maxTokens: 2048 }), {
		model: GLM, messages: [{ role: "user", content: "p" }], max_tokens: 2048, reasoning_effort: "minimal",
	});
	assert.deepEqual(llmRequestBody({ provider: "fireworks", model: KIMI, prompt: "p", maxTokens: 2048 }), {
		model: KIMI, messages: [{ role: "user", content: "p" }], max_tokens: 2048, thinking: { type: "disabled" },
	});
	const glm = llmRequestBody({ provider: "fireworks", model: GLM, prompt: "p", maxTokens: 1 });
	assert.equal("thinking" in glm, false, "glm never carries the thinking switch, which it rejects");
	const kimi = llmRequestBody({ provider: "fireworks", model: KIMI, prompt: "p", maxTokens: 1 });
	assert.equal("reasoning_effort" in kimi, false);
});

test("meta posts to its fixed endpoint with max_completion_tokens, minimal reasoning, under META_API_KEY", async () => {
	const { fetch, calls } = fakeFetch(() => jsonResponse(completion("meta says hi")));
	const result = await llmChat({ provider: "meta", model: "meta-model-x", prompt: "hi", maxTokens: 512 }, { fetch, env });
	assert.equal(result.ok, true);
	assert.equal(calls[0]!.url, "https://api.meta.ai/v1/chat/completions");
	assert.equal(headerOf(calls[0]!, "authorization"), `Bearer ${META_KEY}`);
	const body = bodyOf(calls[0]!);
	assert.equal(body["max_completion_tokens"], 512);
	assert.equal("max_tokens" in body, false);
	assert.equal(body["reasoning_effort"], "minimal");
	assert.equal(headerOf(calls[0]!, "authorization")?.includes(FW_KEY), false, "meta never sends the fireworks key");
});

test("the key comes only from the provider's own environment name; unset, blank, or multi-line is NO_KEY with no call", async () => {
	assert.equal(llmKey("fireworks", { FIREWORKS_API_KEY: "  k1  " }), "k1");
	assert.equal(llmKey("fireworks", { FIREWORKS_API_KEY: "   " }), null);
	assert.equal(llmKey("fireworks", { FIREWORKS_API_KEY: "a\nb" }), null);
	assert.equal(llmKey("fireworks", { META_API_KEY: "only-meta" }), null, "a meta key is never used for fireworks");
	for (const scoped of [{}, { FIREWORKS_API_KEY: "" }, { FIREWORKS_API_KEY: "x\r\ny" }]) {
		const { fetch, calls } = fakeFetch(() => jsonResponse(completion("never")));
		const result = await llmChat(fireworksRequest(), { fetch, env: scoped });
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.reason, "NO_KEY");
		assert.equal(calls.length, 0, "no call is made without a usable key");
	}
});

test("a 200 answer returns the text, the request id, the finish reason, and the usage", async () => {
	const { fetch } = fakeFetch(() => jsonResponse(completion("{\"message\":\"ok\",\"calls\":[]}")));
	const result = await llmChat(fireworksRequest(), { fetch, env });
	assert.deepEqual(result, {
		ok: true, text: "{\"message\":\"ok\",\"calls\":[]}", requestId: "req-1", finishReason: "stop",
		usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
	});
});

test("401 and a plain 403 are provider errors that name only the status", async () => {
	for (const status of [401, 403]) {
		const { fetch } = fakeFetch(() => new Response("forbidden body with secret-detail", { status }));
		const result = await llmChat(fireworksRequest(), { fetch, env });
		assert.deepEqual(result, { ok: false, reason: "PROVIDER_ERROR", detail: `Fireworks answered ${status}`, requestId: null, usage: null });
	}
});

test("429 is a terminal rate limit, and a 402 or 403 carrying a usage or quota limit is a rate limit too", async () => {
	const tooMany = await llmChat(fireworksRequest(), { fetch: fakeFetch(() => new Response("slow down", { status: 429 })).fetch, env });
	assert.equal(tooMany.ok === false && tooMany.reason, "RATE_LIMITED");
	const credits = await llmChat(fireworksRequest(), {
		fetch: fakeFetch(() => new Response("{\"error\":\"insufficient balance on this account\"}", { status: 402 })).fetch, env,
	});
	assert.equal(credits.ok === false && credits.reason, "RATE_LIMITED");
	const quota = await llmChat(fireworksRequest(), {
		fetch: fakeFetch(() => new Response("monthly usage limit reached", { status: 403 })).fetch, env,
	});
	assert.equal(quota.ok === false && quota.reason, "RATE_LIMITED");
});

test("5xx answers are provider errors that name the status and never the body", async () => {
	for (const status of [500, 502, 503]) {
		const { fetch } = fakeFetch(() => new Response("upstream trace with internals", { status }));
		const result = await llmChat(fireworksRequest(), { fetch, env });
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.detail, `Fireworks answered ${status}`);
		assert.equal(JSON.stringify(result).includes("upstream trace"), false);
	}
});

test("no failure carries the key, whatever the provider answers", async () => {
	const answers: readonly (() => Response | Promise<Response>)[] = [
		() => new Response(`echoed ${FW_KEY}`, { status: 401 }),
		() => new Response(`rate limit for ${FW_KEY}`, { status: 429 }),
		() => new Response(`${FW_KEY} usage limit`, { status: 402 }),
		() => new Response(`{not json ${FW_KEY}`, { status: 200 }),
		() => jsonResponse({ id: FW_KEY, choices: [] }),
		() => jsonResponse(completion(`   `, {}, "length")),
	];
	for (const answer of answers) {
		const result = await llmChat(fireworksRequest(), { fetch: fakeFetch(answer).fetch, env });
		assert.equal(result.ok, false);
		assert.equal(JSON.stringify(result).includes(FW_KEY), false, "a failure never quotes the key");
	}
	const thrown = await llmChat(fireworksRequest(), {
		fetch: (async () => { throw new Error(`socket reset while sending ${FW_KEY}`); }) as typeof fetch, env,
	});
	assert.equal(thrown.ok, false);
	assert.equal(thrown.ok === false && thrown.detail.includes(FW_KEY), false, "a transport error text is redacted");
	assert.equal(thrown.ok === false && thrown.detail.includes("[redacted]"), true);
});

test("a timeout is a provider error that names the timeout, and the request is aborted", async () => {
	const hangs = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
	})) as typeof fetch;
	const quick = await llmChat(fireworksRequest(GLM, { timeoutMs: 20 }), { fetch: hangs, env });
	assert.deepEqual(quick, { ok: false, reason: "PROVIDER_ERROR", detail: "Fireworks did not answer in time", requestId: null, usage: null });
});

test("a turn cancelled before the call makes no request; a cancel in flight ends the request", async () => {
	const cancelled = new AbortController();
	cancelled.abort();
	const before = fakeFetch(() => jsonResponse(completion("never")));
	const refused = await llmChat(fireworksRequest(GLM, { signal: cancelled.signal }), { fetch: before.fetch, env });
	assert.equal(refused.ok === false && refused.reason, "PROVIDER_ERROR");
	assert.equal(before.calls.length, 0);

	const flight = new AbortController();
	const during = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		flight.abort();
	})) as typeof fetch;
	const inFlight = await llmChat(fireworksRequest(GLM, { signal: flight.signal }), { fetch: during, env });
	assert.deepEqual(inFlight, { ok: false, reason: "PROVIDER_ERROR", detail: "the turn was cancelled while the request was in flight", requestId: null, usage: null });
});

test("malformed JSON and an answer with no choices are provider errors", async () => {
	const malformed = await llmChat(fireworksRequest(), { fetch: fakeFetch(() => new Response("{not json", { status: 200 })).fetch, env });
	assert.deepEqual(malformed, { ok: false, reason: "PROVIDER_ERROR", detail: "Fireworks answered malformed JSON", requestId: null, usage: null });
	const none = await llmChat(fireworksRequest(), {
		fetch: fakeFetch(() => jsonResponse({ id: "req-9", choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } })).fetch, env,
	});
	assert.deepEqual(none, { ok: false, reason: "PROVIDER_ERROR", detail: "Fireworks answered with no choices", requestId: "req-9",
		usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } });
});

test("empty, length-truncated, and reasoning-only answers are failures; a length answer that has text is kept", async () => {
	const empty = await llmChat(fireworksRequest(), { fetch: fakeFetch(() => jsonResponse(completion(""))).fetch, env });
	assert.equal(empty.ok === false && empty.detail, "Fireworks returned no answer text");
	const truncated = await llmChat(fireworksRequest(), { fetch: fakeFetch(() => jsonResponse(completion("", {}, "length"))).fetch, env });
	assert.equal(truncated.ok === false && truncated.detail, "Fireworks hit the token cap with no answer text");
	const reasoned = await llmChat(fireworksRequest(), {
		fetch: fakeFetch(() => jsonResponse({ id: "r", choices: [{ finish_reason: "stop", message: { role: "assistant", content: null, reasoning_content: "thinking" } }] })).fetch, env,
	});
	assert.equal(reasoned.ok === false && reasoned.detail, "Fireworks returned reasoning without an answer");
	const partial = await llmChat(fireworksRequest(), { fetch: fakeFetch(() => jsonResponse(completion("partial but usable", {}, "length"))).fetch, env });
	assert.equal(partial.ok, true);
	assert.equal(partial.ok && partial.finishReason, "length");
});

test("redirects are refused: the request asks fetch to error on a redirect, and a refused redirect is a provider error", async () => {
	const redirected = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/v1" } }));
	const result = await llmChat(fireworksRequest(), { fetch: redirected.fetch, env });
	assert.equal(redirected.calls[0]!.init.redirect, "error");
	assert.equal(result.ok === false && result.reason, "PROVIDER_ERROR");
	const refused = await llmChat(fireworksRequest(), {
		fetch: (async () => { throw new TypeError("fetch failed: redirect mode is set to error"); }) as typeof fetch, env,
	});
	assert.equal(refused.ok === false && refused.reason, "PROVIDER_ERROR");
});

test("an oversized error body is read only up to its bound, so a streaming body cannot hold the call open", async () => {
	const encoder = new TextEncoder();
	let pulls = 0;
	const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(encoder.encode("x".repeat(1024))); } });
	const result = await llmChat(fireworksRequest(), { fetch: fakeFetch(() => new Response(endless, { status: 500 })).fetch, env });
	assert.deepEqual(result, { ok: false, reason: "PROVIDER_ERROR", detail: "Fireworks answered 500", requestId: null, usage: null });
	assert.ok(pulls < 16, `the body is read only to its bound, not drained (${pulls} pulls)`);
});

test("llmModelFor: the defaults per feature and role, an env override, and a malformed name that never echoes its value", () => {
	assert.equal(llmModelFor("ask", "primary", {}), GLM);
	assert.equal(llmModelFor("ask", "fallback", {}), KIMI);
	assert.equal(llmModelFor("scoping", "primary", {}), KIMI);
	assert.equal(llmModelFor("scoping", "fallback", {}), "accounts/fireworks/models/glm-5p3");
	assert.equal(llmModelFor("ask", "primary", { ACQUIT_LLM_ASK_MODEL: " accounts/fireworks/models/other-1 " }), "accounts/fireworks/models/other-1");
	assert.equal(llmModelFor("ask", "primary", { ACQUIT_LLM_ASK_MODEL: "" }), GLM, "a blank name is the default");
	assert.equal(llmModelFor("scoping", "fallback", { ACQUIT_LLM_SCOPING_FALLBACK_MODEL: "m-2" }), "m-2");
	assert.throws(() => llmModelFor("ask", "primary", { ACQUIT_LLM_ASK_MODEL: "bad model; drop table" }), (error: unknown) =>
		error instanceof Error && error.message.includes("ACQUIT_LLM_ASK_MODEL") && !error.message.includes("drop table"));
});

test("llmTimeoutMs: sixty seconds by default; whole milliseconds from one second to five minutes", () => {
	assert.equal(LLM_TIMEOUT_MS, 60_000);
	assert.equal(llmTimeoutMs({}), 60_000);
	assert.equal(llmTimeoutMs({ ACQUIT_LLM_TIMEOUT_MS: "5000" }), 5000);
	assert.equal(llmTimeoutMs({ ACQUIT_LLM_TIMEOUT_MS: "300000" }), 300000);
	for (const bad of ["999", "300001", "1.5", "abc", "-1000"]) {
		assert.throws(() => llmTimeoutMs({ ACQUIT_LLM_TIMEOUT_MS: bad }), /ACQUIT_LLM_TIMEOUT_MS/);
	}
});

test("the base URL is fixed in code: no environment value changes the endpoint", async () => {
	assert.equal(llmBaseUrl("fireworks"), "https://api.fireworks.ai/inference/v1");
	assert.equal(llmBaseUrl("meta"), "https://api.meta.ai/v1");
	const { fetch, calls } = fakeFetch(() => jsonResponse(completion("ok")));
	await llmChat(fireworksRequest(), { fetch, env: { ...env, FIREWORKS_API_BASE: "https://attacker.example/v1", FIREWORKS_BASE_URL: "http://127.0.0.1:9" } });
	assert.equal(calls[0]!.url, "https://api.fireworks.ai/inference/v1/chat/completions");
});
