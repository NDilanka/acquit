// The "Ask the ledger" agent's server side. The route is a model-turn relay and a tool executor:
// the browser's agent loop calls the ruled model through POST /api/ask-ledger/turn (one droid exec
// turn per call, read-only, the key in process), and every tool call the model makes is executed
// by POST /api/ask-ledger/tool from a closed read-only set. No test below opens a socket or
// spawns a real droid: the droid turn arrives through an injected port, the book and PayPal
// through injected readers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCallLog } from "../../../packages/core/src/model.ts";
import { usd } from "../../../packages/core/src/acquit.ts";
import { instant } from "../../../packages/core/src/ids.ts";
import type { CaptureId, ClientId, JobId, MerchantId, OperatorId, OrderId } from "../../../packages/core/src/ids.ts";
import type { PlatformJobLedger } from "../../../packages/core/src/platform.ts";
import { ASK_TOOL_NAMES, askLedgerTurn, askToolExecutor, buildAskPrompt, droidAskPort, openrouterAskPort, parseAskEnvelope } from "../src/ask.ts";

/** One held job's ledger row, the projection the platform route serves, as the executor reads it. */
const heldBookRow = (): PlatformJobLedger => ({
	jobId: "job_held" as JobId, title: "held job", tenant: null, client: "maya-client" as ClientId,
	status: "IN_PROGRESS", escrow: "HELD", operator: { id: "devon-ops" as OperatorId, handle: "devon-ops" },
	lines: [{ kind: "HELD", cents: usd("378.00"), at: instant("2026-10-13T12:00:00Z") }],
	paidCents: usd("378.00"),
	capture: { orderId: "ORDER1" as OrderId, captureId: "CAP1" as CaptureId, payee: "sandbox-seller" as MerchantId, gross: usd("378.00") },
	fee: null, payout: null, receipt: null, attempts: [],
});

const tools = [
	{ name: "platform_totals", description: "The book's held, released, refunded, and fee totals.", parameters: { type: "object", properties: {} } },
	{ name: "get_order", description: "Read one PayPal order.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

const question = [{ id: "m1", role: "user" as const, content: "How much escrow is held right now, and does PayPal agree?" }];

function logFile(root: string): { path: string; close: () => Promise<void> } {
	return { path: join(root, "model-calls.jsonl"), close: () => rm(root, { recursive: true, force: true }) };
}

/** Seeds the call log with recent wall-clock START records: a minute window that is already
 * nearly spent, exactly the shape the shared budget reads. */
async function seedStarts(log: ReturnType<typeof modelCallLog>, count: number): Promise<void> {
	const at = new Date(Date.now() - 5_000).toISOString();
	for (let index = 0; index < count; index += 1) {
		await log.append({ at, caller: "other", jobId: null, provider: "droid", model: "glm-5.3-flash", phase: "START" });
	}
}

test("the ask prompt carries the response contract, the tool schemas, and the conversation", () => {
	const prompt = buildAskPrompt({ messages: question, tools, instructions: "You are Ask the ledger." });
	assert.match(prompt, /Ask the ledger/);
	assert.match(prompt, /platform_totals/);
	assert.match(prompt, /How much escrow is held right now/);
	assert.match(prompt, /"calls"/, "the prompt names the JSON envelope the model must reply in");
	assert.ok(!prompt.includes("FACTORY_API_KEY"), "the prompt never names the key");
});

test("a model turn is relayed: the envelope's message and calls ride back, and the call is logged", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-"));
	const log = logFile(dir);
	try {
		const seen: string[] = [];
		const model = async (prompt: string) => {
			seen.push(prompt);
			return { ok: true as const, text: '{"message":null,"calls":[{"id":"c1","name":"platform_totals","arguments":{}}]}', sessionId: "sess-1", factoryCredits: 5 };
		};
		const outcome = await askLedgerTurn(
			{ model, callLog: modelCallLog(log.path) },
			{ messages: question, tools },
		);
		assert.deepEqual(outcome, {
			ok: true, message: null, model: "glm-5.3-flash", sessionId: "sess-1", factoryCredits: 5,
			calls: [{ id: "c1", name: "platform_totals", arguments: {} }],
		});
		assert.equal(seen.length, 1);
		const records = await modelCallLog(log.path).records();
		assert.deepEqual(records.map(r => [r.caller, r.phase, r.model]), [["ask-ledger", "START", "glm-5.3-flash"], ["ask-ledger", "END", "glm-5.3-flash"]]);
	} finally { await log.close(); }
});

test("a turn the model answers outright carries the message and no calls", async () => {
	const model = async () => ({ ok: true as const, text: 'Sure! {"message":"378.00 USD is held; PayPal agrees.","calls":[]}', sessionId: null, factoryCredits: 3 });
	const root = await mkdtemp(join(tmpdir(), "acquit-ask-outright-"));
	const outcome = await askLedgerTurn(
		{ model, callLog: modelCallLog(join(root, "log.jsonl")) },
		{ messages: question, tools },
	);
	try { await rm(root, { recursive: true, force: true }); } catch { /* the log file is disposable */ }
	assert.ok(outcome.ok);
	if (!outcome.ok) throw new Error("expected a completed turn");
	assert.equal(outcome.message, "378.00 USD is held; PayPal agrees.");
	assert.deepEqual(outcome.calls, []);
});

test("prose without the envelope still reaches the reader as the message", () => {
	assert.deepEqual(parseAskEnvelope("The escrow holds 378.00 USD."), { message: "The escrow holds 378.00 USD.", calls: [] });
	const fenced = '```json\n{"message":"held: 378.00","calls":[{"name":"get_order","arguments":{"id":"O1"}}]}\n```';
	assert.deepEqual(parseAskEnvelope(fenced), {
		message: "held: 378.00",
		calls: [{ id: null, name: "get_order", arguments: { id: "O1" } }],
	});
});

test("a provider error retries once and then fails; a rate limit never retries", async () => {
	const calls: number[] = [];
	let failing: "provider" | "rate" = "provider";
	const model = async () => {
		calls.push(1);
		return failing === "provider"
			? { ok: false as const, reason: "PROVIDER_ERROR" as const, detail: "the droid result line reported an error" }
			: { ok: false as const, reason: "RATE_LIMITED" as const, detail: "usage limit reached" };
	};
	const root = await mkdtemp(join(tmpdir(), "acquit-ask-retry-"));
	const run = () => askLedgerTurn({ model, callLog: modelCallLog(join(root, "log.jsonl")) }, { messages: question, tools });

	failing = "provider";
	const retried = await run();
	assert.ok(!retried.ok && retried.reason === "MODEL_PROVIDER_ERROR", "a provider error surfaces as the provider-error class");
	assert.equal(calls.length, 2, "the turn retried exactly once");

	calls.length = 0;
	failing = "rate";
	const limited = await run();
	assert.ok(!limited.ok && limited.reason === "MODEL_RATE_LIMITED", "a rate limit is its own terminal class");
	assert.equal(calls.length, 1, "a rate limit is never retried in a loop");
	try { await rm(root, { recursive: true, force: true }); } catch { /* the log file is disposable */ }
});

test("the retry is its own budget attempt: reserved, started, and ended like the first", async () => {
	const calls: number[] = [];
	const model = async () => {
		calls.push(1);
		return calls.length === 1
			? { ok: false as const, reason: "PROVIDER_ERROR" as const, detail: "the droid result line reported an error" }
			: { ok: true as const, text: '{"message":"done","calls":[]}', sessionId: "sess-2", factoryCredits: 2 };
	};
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-retry-slot-"));
	try {
		const path = join(dir, "model-calls.jsonl");
		const log = modelCallLog(path);
		await seedStarts(log, 17);
		const outcome = await askLedgerTurn({ model, callLog: log }, { messages: question, tools });
		assert.ok(outcome.ok, "17 spent slots leave the turn and its retry inside the budget");
		assert.equal(calls.length, 2, "the turn retried exactly once");
		const records = await modelCallLog(path).records();
		assert.equal(records.filter(record => record.phase === "START").length, 19, "the retry wrote its own START before it ran");
		assert.deepEqual(records.filter(record => record.phase === "END").map(record => record.outcome),
			["PROVIDER_ERROR", "answered"], "every attempt records its own END");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a retry the shared budget cannot admit is refused, never an unreserved 20th call", async () => {
	const calls: number[] = [];
	const model = async () => {
		calls.push(1);
		return calls.length === 1
			? { ok: false as const, reason: "PROVIDER_ERROR" as const, detail: "the droid result line reported an error" }
			: { ok: true as const, text: '{"message":"done","calls":[]}', sessionId: null, factoryCredits: 1 };
	};
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-retry-refused-"));
	try {
		const path = join(dir, "model-calls.jsonl");
		const log = modelCallLog(path);
		await seedStarts(log, 18);
		const outcome = await askLedgerTurn({ model, callLog: log }, { messages: question, tools });
		assert.ok(!outcome.ok && outcome.reason === "MODEL_BUDGET", "the retry is refused when the minute is spent");
		assert.equal(calls.length, 1, "the refused retry never ran");
		const records = await modelCallLog(path).records();
		assert.equal(records.filter(record => record.phase === "START").length, 19, "the minute never holds a 20th start");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a spent shared budget refuses the turn before any model call", async () => {
	const calls: number[] = [];
	const model = async () => { calls.push(1); return { ok: true as const, text: '{"message":"x","calls":[]}', sessionId: null, factoryCredits: 1 }; };
	const root = await mkdtemp(join(tmpdir(), "acquit-ask-budget-"));
	try {
		const log = modelCallLog(join(root, "model-calls.jsonl"));
		// Saturate the rolling minute with the cap's record count, stamped on the wall clock the
		// turn budgets on.
		await seedStarts(log, 19);
		const outcome = await askLedgerTurn({ model, callLog: log }, { messages: question, tools });
		assert.ok(!outcome.ok && outcome.reason === "MODEL_BUDGET");
		assert.deepEqual(calls, []);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("the ask turn budgets on the wall clock, never a domain clock a caller hands it", async () => {
	const calls: number[] = [];
	const model = async () => { calls.push(1); return { ok: true as const, text: '{"message":"x","calls":[]}', sessionId: null, factoryCredits: 1 }; };
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-wallclock-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		await seedStarts(log, 19);
		// Exactly what the server wiring used to pass: the dev offset clock, shifted eight days
		// ahead of the wall clock the log's real starts live on. The cast survives the type
		// system dropping the field; the budget must drop the field's clock with it.
		const offsetDeps = { model, callLog: log,
			now: () => new Date(Date.now() + 8 * 86_400_000).toISOString() } as unknown as Parameters<typeof askLedgerTurn>[0];
		const outcome = await askLedgerTurn(offsetDeps, { messages: question, tools });
		assert.ok(!outcome.ok && outcome.reason === "MODEL_BUDGET", "the wall-clock minute is full; the offset clock cannot buy a call");
		assert.deepEqual(calls, [], "no invocation ran");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("the tool executor answers from the book and PayPal, and the set is closed and read-only", async () => {
	const book = [heldBookRow()];
	const readBook = async () => book;
	const paypalOrders = new Map([["ORDER1", { status: "COMPLETED", amount: "378.00" }]]);
	const asked: (readonly (string | null)[])[] = [];
	const executor = askToolExecutor({ platformView: readBook, paypal: { getOrder: async (id, payee) => {
		asked.push([id, payee]);
		const found = paypalOrders.get(id);
		if (!found) throw new Error(`PayPal answered 404 for ${id}.`);
		return found;
	} } });

	const totals = await executor("platform_totals", {});
	assert.deepEqual(totals, { held: 37800, released: 0, refunded: 0, fees: 0, heldJobs: 1 });
	const order = await executor("get_order", { id: "ORDER1" });
	assert.deepEqual(order, { status: "COMPLETED", amount: "378.00" });
	// The order is the capture's: the read asserts the merchant the book named it under, or PayPal
	// cannot see it at all.
	assert.deepEqual(asked, [["ORDER1", "sandbox-seller"]]);
	await assert.rejects(executor("get_order", { id: "ORDER2" }), /PayPal answered 404/);
	await assert.rejects(executor("capture_order", {}), /no tool named capture_order/, "the executor is a closed set");

	// The registered set is read-only by name: no create, capture, refund, payout, or update tool.
	assert.deepEqual([...ASK_TOOL_NAMES].sort(), ["get_job", "get_order", "list_jobs", "platform_totals"]);
	for (const name of ASK_TOOL_NAMES) assert.doesNotMatch(name, /create|capture|refund|payout|update|send|cancel/);
});

test("the openrouter ask port runs on an injected transport, :free only, and never a live call", async () => {
	const calls: { readonly url: string; readonly init?: { readonly headers?: unknown; readonly body?: string } }[] = [];
	const transport = (async (url: string | URL, init?: { headers?: unknown; body?: string }) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify({ choices: [{ message: { content: "held: 378.00" } }] }), { status: 200 });
	}) as unknown as typeof fetch;
	const port = openrouterAskPort({ fetch: transport, key: async () => "keyring-canary", env: {} });
	const answered = await port(buildAskPrompt({ messages: question, tools }));
	assert.ok(answered.ok && answered.text === "held: 378.00");
	assert.equal(calls.length, 1);
	assert.ok(calls[0]!.url.startsWith("https://openrouter.ai/api/v1/chat/completions"), "the port calls OpenRouter's chat API");
	assert.match(String(calls[0]!.init?.body), /:free/, "the model the port names is a :free model");
	const headers = calls[0]!.init?.headers as { authorization?: string };
	assert.equal(headers.authorization, "Bearer keyring-canary", "the key rides the header in process");
	assert.equal(String(calls[0]!.init?.body).includes("keyring-canary"), false, "the key never rides the body");
	const refused = await openrouterAskPort({ fetch: async () => { throw new Error("no call may happen without a key"); }, key: async () => null, env: {} })(
		buildAskPrompt({ messages: question, tools }));
	assert.ok(!refused.ok && refused.reason === "NO_KEY", "no key, no call");
});

test("the executor answers a job's own book, with its capture, lines, and verdicts", async () => {
	const book = [heldBookRow()];
	const executor = askToolExecutor({ platformView: async () => book, paypal: { getOrder: async () => ({}) } });
	const job = await executor("get_job", { jobId: "job_held" }) as PlatformJobLedger;
	assert.equal(job.jobId, "job_held");
	assert.deepEqual(job.capture, { orderId: "ORDER1", captureId: "CAP1", payee: "sandbox-seller", gross: 37800 });
	await assert.rejects(executor("get_job", { jobId: "job_missing" }), /no job named job_missing/);
});

test("a chatty droid on stderr cannot wedge the turn: the port never waits on a full pipe", { timeout: 30_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-shim-"));
	try {
		const bin = join(dir, "bin");
		await mkdir(bin);
		// A droid that answers, then pours far more than a pipe buffer's worth down stderr before it
		// exits -- the shape that wedges a port that pipes stderr and never reads it.
		const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"message":"hi","calls":[]}', session_id: "s1", usage: { factory_credits: 1 } });
		await writeFile(join(bin, "droid"), `#!/bin/sh\nprintf '%s\\n' '${result}'\nhead -c 262144 /dev/zero | tr '\\0' x >&2\n`, { mode: 0o700 });
		const port = droidAskPort({ env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FACTORY_API_KEY: "test-key-in-process" } });
		const settled = await Promise.race([
			port(buildAskPrompt({ messages: question, tools })),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the turn did not settle: the port waits on a full stderr pipe")), 20_000)),
		]);
		assert.ok(settled.ok && /"message":"hi"/.test(settled.text), "the answer text rides back");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed droid run keeps the session id and credits it reported in the turn's log", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-failure-usage-"));
	try {
		const bin = join(dir, "bin");
		await mkdir(bin);
		// A failed run that still reports what it spent: the result shape classifyDroidRun reads.
		const failed = JSON.stringify({ type: "result", subtype: "failure", is_error: true, result: "injected provider failure", session_id: "synthetic-session", usage: { factory_credits: 7 } });
		await writeFile(join(bin, "droid"), `#!/bin/sh\nprintf '%s\\n' '${failed}'\nexit 1\n`, { mode: 0o700 });
		const port = droidAskPort({ env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FACTORY_API_KEY: "test-key-in-process" } });
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const outcome = await askLedgerTurn({ model: port, callLog: log }, { messages: question, tools });
		assert.ok(!outcome.ok && outcome.reason === "MODEL_PROVIDER_ERROR", "the failed run is the provider-error class");
		const ends = (await log.records()).filter(record => record.phase === "END");
		for (const end of ends) {
			assert.equal(end.sessionId, "synthetic-session", "the failed run's session survives into the log");
			assert.equal(end.factoryCredits, 7, "the failed run's credits survive into the log");
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});
