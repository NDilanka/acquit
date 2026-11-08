// The sample book's Ask the ledger, in process: the four tools answer from the sample book alone, a real id is not found,
// no tool makes a PayPal call (a positive control shows the spy counts), the per-account and per-address admission counts a
// turn once for each key and refuses a turn one key refuses without charging the other, and the deadline answers without the model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { ASK_SAMPLE_TURN_CONTRACT, askLedgerTurn, buildAskPrompt, type AskModelResult } from "../src/ask.ts";
import { modelCallLog } from "../../../packages/core/src/model.ts";
import { labelSampleAnswer, sampleAskToolExecutor, sampleAskToolList, sampleInFlightGate, sampleTurnLimiter, SAMPLE_ALLOWANCE, SAMPLE_ASK_TOOL_NAMES, SAMPLE_CALLER, SAMPLE_LABEL, SAMPLE_MAX_IN_FLIGHT, withDeadline } from "../src/sample-ask.ts";
import { sampleExplain } from "../src/sample-book.ts";

const FORGED_REAL_IDS = ["job_real_paid", "job_real_refund", "REFUND_REAL_SENTINEL", "CAP-REAL_SENTINEL", "PAYOUT_REAL_SENTINEL", "rcpt_real", "SAMPLE-ORDER-02"];
const PLATFORM_AND_PAYPAL_NAMES = ["list_jobs", "get_job", "platform_totals", "get_order", "list_disputes", "get_dispute", "get_refund", "list_transactions", "trace_figure"];
const SPY = join(import.meta.dirname, "sample-paypal-spy.mjs");

test("the sample tools are the four reads the route serves, each worded for the sample book and none a PayPal or platform tool", () => {
	const listed = sampleAskToolList().map(tool => tool.name);
	assert.deepEqual(listed, ["sample_totals", "list_sample_jobs", "get_sample_job", "explain_sample_figure"]);
	assert.deepEqual([...SAMPLE_ASK_TOOL_NAMES], listed, "the closed set is the list the route serves");
	for (const name of listed) assert.ok(!PLATFORM_AND_PAYPAL_NAMES.includes(name), `${name} is a platform tool`);
	for (const tool of sampleAskToolList()) {
		assert.match(tool.description, /Simulated sample data|sample/i, `${tool.name} says it reads the sample book`);
		assert.doesNotMatch(tool.description, /demo|guest|visitor|judge|platform|PayPal's|all tenants/i, `${tool.name} is worded for the sample book`);
	}
});

test("sample_totals and explain_sample_figure return the literal sample figures, labelled as sample data", async () => {
	const execute = sampleAskToolExecutor();
	const totals = await execute("sample_totals", {}) as Record<string, unknown>;
	assert.deepEqual(totals, { sample: SAMPLE_LABEL, held: 32000, released: 20300, refunded: 9000, fees: 2700, heldJobs: 2 });
	const figure = await execute("explain_sample_figure", { figure: "held" }) as { sample: string; totalCents: number; lines: { kind: string; cents: number; paypal: { status: string } }[] };
	assert.equal(figure.sample, SAMPLE_LABEL);
	assert.equal(figure.totalCents, 32000);
	assert.ok(figure.lines.every(line => line.paypal.status === "Not checked against PayPal"), "every line says PayPal was not checked, in words");
	assert.ok(figure.lines.every(line => line.kind === "Held"), "every held line reads as Held, not HELD");
	assert.deepEqual(figure.lines.map(line => line.cents), sampleExplain("held").lines.map(line => line.cents), "the lines are the explain route's own lines");
});

test("list_sample_jobs and get_sample_job answer the six sample jobs, each labelled sample, with their codes in plain words", async () => {
	const execute = sampleAskToolExecutor();
	const listed = await execute("list_sample_jobs", {}) as { sample: string; jobs: { jobId: string; title: string; status: string; escrow: string }[] };
	assert.equal(listed.sample, SAMPLE_LABEL);
	assert.deepEqual(listed.jobs.map(job => job.jobId), ["job_sample01", "job_sample02", "job_sample03", "job_sample04", "job_sample05", "job_sample06"]);
	for (const job of listed.jobs) assert.match(job.title, /^Sample: /);
	assert.deepEqual(listed.jobs.map(job => [job.status, job.escrow]), [
		["Open for bids", "Not funded"], ["In progress", "Held"], ["Verified, awaiting release", "Held"],
		["Paid", "Released"], ["Refunded", "Refunded"], ["Paid", "Released"],
	]);
	const one = await execute("get_sample_job", { jobId: "job_sample04" }) as { sample: string; job: { jobId: string; status: string; escrow: string } };
	assert.equal(one.sample, SAMPLE_LABEL);
	assert.equal(one.job.jobId, "job_sample04");
	assert.equal(one.job.status, "Paid");
	assert.equal(one.job.escrow, "Released");
	const rejected = await execute("get_sample_job", { jobId: "job_sample02" }) as { job: { attempts: { result: string; reasons: string[] }[]; lines: { kind: string }[] } };
	assert.deepEqual(rejected.job.attempts.map(attempt => [attempt.result, attempt.reasons]), [["Rejected", ["Visible tests failed"]]]);
	assert.deepEqual(rejected.job.lines.map(line => line.kind), ["Held"]);
});

test("forged real job, order, refund, dispute, and capture ids are not found, and no tool answers a platform or PayPal name", async () => {
	const execute = sampleAskToolExecutor();
	for (const jobId of [...FORGED_REAL_IDS, ""]) {
		await assert.rejects(execute("get_sample_job", { jobId }), /not found: no sample job named/, `${jobId || "(no id)"} is not found`);
	}
	await assert.rejects(execute("explain_sample_figure", { figure: "REFUND_REAL_SENTINEL" }), /needs one figure/, "a forged figure is refused");
	for (const name of ["list_jobs", "get_order", "list_transactions", "list_disputes", "platform_totals", "capture_order"]) {
		await assert.rejects(execute(name, {}), /no tool named/, `${name} is not a sample tool`);
	}
});

test("no sample tool makes a PayPal call: a positive control shows the spy counts, and the tools leave the count unchanged", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-sample-ask-spy-"));
	const log = join(dir, "fetch.log");
	try {
		process.env.SAMPLE_FETCH_LOG = log;
		// The spy is loaded by path at test time, so the log path it reads is the one this test set.
		await import(pathToFileURL(SPY).href);
		const paypalLines = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(line => /paypal/i.test(line));
		try { await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", { method: "POST" }); } catch { /* the spy refuses it, as designed */ }
		assert.equal((await paypalLines()).length, 1, "positive control: the spy logged the PayPal call it refused");

		const execute = sampleAskToolExecutor();
		await execute("sample_totals", {});
		await execute("list_sample_jobs", {});
		await execute("get_sample_job", { jobId: "job_sample02" });
		await execute("explain_sample_figure", { figure: "paid-by-clients" });
		for (const jobId of FORGED_REAL_IDS) await execute("get_sample_job", { jobId }).catch(() => undefined);
		assert.equal((await paypalLines()).length, 1, "the sample tools made no PayPal call");
	} finally {
		delete process.env.SAMPLE_FETCH_LOG;
		await rm(dir, { recursive: true, force: true });
	}
});

test("the sample executor's source reads the sample book and nothing else: no store, no platform read, no fetch", () => {
	const source = readFileSync(join(import.meta.dirname, "..", "src", "sample-ask.ts"), "utf8");
	assert.doesNotMatch(source, /\bfetch\(|acquit\.query|SqliteStore|platformView|platformTables|paypalAskReader|\.prepare\(/, "no store, platform, or network read");
	assert.match(source, /from "\.\/sample-book\.ts"/, "the tools read the sample book");
});

test("the sample contract replaces the platform's and names no PayPal tool", () => {
	const prompt = buildAskPrompt({ messages: [{ id: "m1", role: "user", content: "What is held?" }], tools: sampleAskToolList(), contract: ASK_SAMPLE_TURN_CONTRACT });
	assert.ok(prompt.includes("Simulated sample data"));
	assert.match(prompt, /"name":"sample_totals"/);
	assert.doesNotMatch(prompt, /platform_totals|get_order|list_disputes|list_transactions/);
});

test("a sample turn is sent under the sample contract and budgeted under its own caller name", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-sample-ask-turn-"));
	try {
		const seen: string[] = [];
		const model = async (prompt: string) => {
			seen.push(prompt);
			return { ok: true as const, text: '{"message":"Nothing is held.","calls":[]}', sessionId: null, factoryCredits: 1 };
		};
		const callLog = modelCallLog(join(root, "log.jsonl"));
		const outcome = await askLedgerTurn({ model, callLog, caller: "sample-ask" },
			{ messages: [{ id: "m1", role: "user", content: "What is held?" }], tools: sampleAskToolList(), scope: "SAMPLE" });
		assert.ok(outcome.ok);
		assert.ok(seen[0]?.includes(ASK_SAMPLE_TURN_CONTRACT), "the sample contract is the one the model is shown");
		const records = (await readFile(join(root, "log.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { caller: string; phase: string });
		assert.deepEqual(records.map(record => [record.caller, record.phase]), [["sample-ask", "START"], ["sample-ask", "END"]]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the sample turn's admission admits six a minute for an account or an address, refuses the seventh, and a refused turn charges neither key", () => {
	let at = 1_000_000;
	const admit = sampleTurnLimiter(() => at);
	for (let turn = 1; turn <= 6; turn += 1) assert.equal(admit(["account:a", "ip:x"]), true, `turn ${turn} is inside the allowance`);
	assert.equal(admit(["account:b", "ip:x"]), false, "a new account on a full address is refused by the address");
	for (let turn = 1; turn <= 6; turn += 1) {
		assert.equal(admit(["account:b", `ip:fresh-${turn}`]), true, `account b's turn ${turn} is not charged by the refused turn`);
	}
	at += 60_000;
	assert.equal(admit(["account:a", "ip:x"]), true, "a minute later the address's allowance has renewed");
});

test("the sample turn's admission caps a day at sixty for one key", () => {
	let at = 0;
	const admit = sampleTurnLimiter(() => at);
	for (let turn = 1; turn <= 60; turn += 1) {
		assert.equal(admit(["account:a", `ip:${turn}`]), true, `turn ${turn} is inside the day`);
		at += 61_000;
	}
	assert.equal(admit(["account:a", "ip:61"]), false, "the sixty-first turn in the day is refused by the account");
});

test("a model call past its deadline is answered without the model, and a call inside it is answered with it", async () => {
	assert.equal(await withDeadline(() => new Promise<string>(() => undefined), 20, "answered without the model"), "answered without the model");
	assert.equal(await withDeadline(() => Promise.resolve("the model's answer"), 1_000, "answered without the model"), "the model's answer");
	const failing = withDeadline(() => Promise.reject(new Error("provider failed")), 1_000, "fallback");
	await assert.rejects(failing, /provider failed/, "a failure inside the deadline is the failure, not the fallback");
});

test("the work is handed a signal that aborts at the deadline, and a request that ends answers at once with its signal aborted", async () => {
	const atDeadline: { signal?: AbortSignal } = {};
	assert.equal(await withDeadline(signal => { atDeadline.signal = signal; return new Promise<string>(() => undefined); }, 20, "fallback"), "fallback");
	assert.equal(atDeadline.signal?.aborted, true, "the deadline aborted the work");
	const ended = new AbortController();
	const onRequestEnd: { signal?: AbortSignal } = {};
	const started = Date.now();
	const answered = withDeadline(signal => { onRequestEnd.signal = signal; return new Promise<string>(() => undefined); }, 60_000, "fallback", ended.signal);
	ended.abort();
	assert.equal(await answered, "fallback");
	assert.ok(Date.now() - started < 5_000, "the request's end answered without waiting for the deadline");
	assert.equal(onRequestEnd.signal?.aborted, true, "the request's end aborted the work");
});

test("a sample turn cancelled at its deadline stops its model call and starts no retry, and a turn cancelled before it starts reserves nothing", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-sample-ask-cancel-"));
	try {
		const log = join(root, "log.jsonl");
		const messages = [{ id: "m1", role: "user" as const, content: "What is held?" }];
		let modelCalls = 0;
		// The model answers a provider error only once its signal aborts: the cancel is what ends it.
		const model = async (_prompt: string, signal?: AbortSignal): Promise<AskModelResult> => {
			modelCalls += 1;
			await new Promise<void>(resolve => { if (signal?.aborted === true) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
			return { ok: false, reason: "PROVIDER_ERROR", detail: "the request was aborted" };
		};
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30);
		const outcome = await askLedgerTurn({ model, callLog: modelCallLog(log), caller: SAMPLE_CALLER, allowance: SAMPLE_ALLOWANCE },
			{ messages, tools: sampleAskToolList(), scope: "SAMPLE", signal: controller.signal });
		clearTimeout(timer);
		assert.equal(outcome.ok, false, "a cancelled turn is not an answer");
		assert.equal(modelCalls, 1, "the cancelled call is the only model call: the one retry never starts");
		const phases = (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => (JSON.parse(line) as { phase: string }).phase);
		assert.deepEqual(phases, ["START", "END"], "one reservation and its end, nothing after the cancel");

		const cancelled = await askLedgerTurn({ model, callLog: modelCallLog(log), caller: SAMPLE_CALLER, allowance: SAMPLE_ALLOWANCE },
			{ messages, tools: sampleAskToolList(), scope: "SAMPLE", signal: controller.signal });
		assert.equal(cancelled.ok, false);
		assert.equal(modelCalls, 1, "a turn cancelled before it starts runs no model call");
		assert.equal((await readFile(log, "utf8")).split("\n").filter(Boolean).length, 2, "and reserves nothing");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the sample's ceiling inside the shared budget refuses a sample turn while the platform keeps its capacity", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-sample-ask-ceiling-"));
	try {
		const callLog = modelCallLog(join(root, "log.jsonl"));
		const messages = [{ id: "m1", role: "user" as const, content: "What is held?" }];
		const now = Date.now();
		// Six sample calls in the last minute fill the sample's per-minute ceiling.
		for (let call = 0; call < 6; call += 1) {
			await callLog.append({ at: new Date(now - 1_000 * call).toISOString(), caller: SAMPLE_CALLER, jobId: null, provider: "droid", model: "m", phase: "START" });
		}
		let modelCalls = 0;
		const model = async (): Promise<AskModelResult> => {
			modelCalls += 1;
			return { ok: true, text: '{"message":"Nothing is held.","calls":[]}', sessionId: null, factoryCredits: null };
		};
		const sample = await askLedgerTurn({ model, callLog, caller: SAMPLE_CALLER, allowance: SAMPLE_ALLOWANCE }, { messages, tools: sampleAskToolList(), scope: "SAMPLE" });
		assert.deepEqual(sample, { ok: false, reason: "MODEL_BUDGET", detail: "the sample allowance inside the shared model budget is spent for now" });
		assert.equal(modelCalls, 0, "a refused sample turn runs no model call");
		const platform = await askLedgerTurn({ model, callLog }, { messages, tools: [], scope: "PLATFORM" });
		assert.equal(platform.ok, true, "the platform's turn still runs while the sample is at its ceiling");
		assert.equal(modelCalls, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a sample retry that would pass the sample's ceiling is refused, so a provider error cannot spend past it", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-sample-ask-retry-"));
	try {
		const callLog = modelCallLog(join(root, "log.jsonl"));
		const messages = [{ id: "m1", role: "user" as const, content: "What is held?" }];
		const now = Date.now();
		// Five sample calls in the minute leave one: the first call takes it, and the retry finds the ceiling full.
		for (let call = 0; call < 5; call += 1) {
			await callLog.append({ at: new Date(now - 1_000 * call).toISOString(), caller: SAMPLE_CALLER, jobId: null, provider: "droid", model: "m", phase: "START" });
		}
		let modelCalls = 0;
		const model = async (): Promise<AskModelResult> => {
			modelCalls += 1;
			return { ok: false, reason: "PROVIDER_ERROR", detail: "the provider failed" };
		};
		const outcome = await askLedgerTurn({ model, callLog, caller: SAMPLE_CALLER, allowance: SAMPLE_ALLOWANCE }, { messages, tools: sampleAskToolList(), scope: "SAMPLE" });
		assert.equal(outcome.ok, false);
		assert.equal(outcome.ok === false ? outcome.reason : "", "MODEL_BUDGET", "the retry is refused by the sample's ceiling");
		assert.equal(modelCalls, 1, "the refused retry runs no model call");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the sample's daily ceiling refuses sample calls for the rest of the day, and a platform call still runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-sample-ask-day-"));
	try {
		const callLog = modelCallLog(join(root, "log.jsonl"));
		const messages = [{ id: "m1", role: "user" as const, content: "What is held?" }];
		const now = Date.now();
		// Two hundred sample calls earlier in the day, none in the last minute: the day is what is full.
		for (let call = 0; call < SAMPLE_ALLOWANCE.perDay; call += 1) {
			await callLog.append({ at: new Date(now - 120_000 - 1_000 * call).toISOString(), caller: SAMPLE_CALLER, jobId: null, provider: "droid", model: "m", phase: "START" });
		}
		let modelCalls = 0;
		const model = async (): Promise<AskModelResult> => {
			modelCalls += 1;
			return { ok: true, text: '{"message":"Nothing is held.","calls":[]}', sessionId: null, factoryCredits: null };
		};
		const sample = await askLedgerTurn({ model, callLog, caller: SAMPLE_CALLER, allowance: SAMPLE_ALLOWANCE }, { messages, tools: sampleAskToolList(), scope: "SAMPLE" });
		assert.equal(sample.ok, false, "the sample's day is spent");
		assert.equal(modelCalls, 0);
		const platform = await askLedgerTurn({ model, callLog }, { messages, tools: [], scope: "PLATFORM" });
		assert.equal(platform.ok, true, "the platform's day is not the sample's");
		assert.equal(modelCalls, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the sample's in-flight gate runs at most its slots at once, a release frees its slot once, and the route holds a slot for each turn", () => {
	const acquire = sampleInFlightGate(2);
	const first = acquire();
	const second = acquire();
	assert.ok(first !== null && second !== null, "two turns get their slots");
	assert.equal(acquire(), null, "a third turn finds both slots running and is refused");
	first?.();
	first?.();
	const third = acquire();
	assert.ok(third !== null, "the freed slot admits the next turn");
	assert.equal(acquire(), null, "a second release of the same slot frees nothing more");
	second?.();
	third?.();
	assert.ok(acquire() !== null, "every slot is free again once its turn ends");
	const server = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf8");
	assert.match(server, /const releaseSlot = acquireSampleSlot\(\);/, "the sample route takes a slot before it admits the turn");
	assert.match(server, /\} finally \{\s*releaseSlot\(\);\s*\}/, "the sample route returns its slot in a finally");
	assert.ok(SAMPLE_MAX_IN_FLIGHT >= 1 && SAMPLE_MAX_IN_FLIGHT <= 6, "the in-flight cap is a small number of turns");
});

test("every sample answer carries the sample label, whatever the model wrote, and an empty answer stays empty", () => {
	assert.equal(labelSampleAnswer("Nothing is held."), `Nothing is held.\n\n${SAMPLE_LABEL}`);
	assert.equal(labelSampleAnswer(`Held is 320.\n\n${SAMPLE_LABEL}`), `Held is 320.\n\n${SAMPLE_LABEL}`, "a label the model already wrote is not doubled");
	assert.equal(labelSampleAnswer(null), null);
	assert.equal(labelSampleAnswer("  "), "  ");
	const server = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf8");
	assert.match(server, /json\(res, 200, \{ \.\.\.outcome, message: labelSampleAnswer\(outcome\.message\) \}\)/, "the sample route labels the answer it sends");
	assert.match(server, /scope: "SAMPLE", signal \}/, "the sample turn passes its signal to the model");
});

test("a label that does not show as the answer's own text is labelled again: a fenced label, an unclosed fence, an indented or early label", () => {
	const fenced = `Held is $320.\n\n\`\`\`${SAMPLE_LABEL}\nNot provenance\n\`\`\``;
	assert.equal(labelSampleAnswer(fenced), `${fenced}\n\n${SAMPLE_LABEL}`, "a label in a fence's info string is not visible, so it is appended");
	assert.equal(labelSampleAnswer(`Held is $320.\n\n\`\`\`\n${SAMPLE_LABEL}`), `Held is $320.\n\n\`\`\`\n${SAMPLE_LABEL}\n\n${SAMPLE_LABEL}`,
		"a label inside a fence that never closes is not visible, so it is appended");
	assert.equal(labelSampleAnswer(`Held is $320.\n\n~~~\n~~~\n${SAMPLE_LABEL}`), `Held is $320.\n\n~~~\n~~~\n${SAMPLE_LABEL}\n\n${SAMPLE_LABEL}`,
		"a label after a closed fence with no blank line before it is not the final paragraph, so it is appended");
	assert.equal(labelSampleAnswer(`Held is $320.\n\n    ${SAMPLE_LABEL}`), `Held is $320.\n\n    ${SAMPLE_LABEL}\n\n${SAMPLE_LABEL}`,
		"an indented label is a code block, so it is appended");
	assert.equal(labelSampleAnswer(`${SAMPLE_LABEL}\n\nHeld is $320.`), `${SAMPLE_LABEL}\n\nHeld is $320.\n\n${SAMPLE_LABEL}`,
		"a label that is not the last paragraph is appended after the answer");
	assert.equal(labelSampleAnswer(`Held is $320.\n\n\`\`\`\nHeld is $320.\n\`\`\`\n\n${SAMPLE_LABEL}`), `Held is $320.\n\n\`\`\`\nHeld is $320.\n\`\`\`\n\n${SAMPLE_LABEL}`,
		"a label that is the final paragraph after a closed fence is kept, not doubled");
});
