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
import { ASK_SAMPLE_TURN_CONTRACT, askLedgerTurn, buildAskPrompt } from "../src/ask.ts";
import { modelCallLog } from "../../../packages/core/src/model.ts";
import { sampleAskToolExecutor, sampleAskToolList, sampleTurnLimiter, SAMPLE_ASK_TOOL_NAMES, SAMPLE_LABEL, withDeadline } from "../src/sample-ask.ts";
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
	const figure = await execute("explain_sample_figure", { figure: "held" }) as { sample: string; totalCents: number; lines: { paypal: { status: string } }[] };
	assert.equal(figure.sample, SAMPLE_LABEL);
	assert.equal(figure.totalCents, 32000);
	assert.ok(figure.lines.every(line => line.paypal.status === "NOT_CHECKED"), "every line says PayPal was not checked");
	assert.deepEqual(figure, { ...sampleExplain("held"), sample: SAMPLE_LABEL }, "the explain tool is the explain route's own answer");
});

test("list_sample_jobs and get_sample_job answer the six sample jobs, each labelled sample", async () => {
	const execute = sampleAskToolExecutor();
	const listed = await execute("list_sample_jobs", {}) as { sample: string; jobs: { jobId: string; title: string }[] };
	assert.equal(listed.sample, SAMPLE_LABEL);
	assert.deepEqual(listed.jobs.map(job => job.jobId), ["job_sample01", "job_sample02", "job_sample03", "job_sample04", "job_sample05", "job_sample06"]);
	for (const job of listed.jobs) assert.match(job.title, /^Sample: /);
	const one = await execute("get_sample_job", { jobId: "job_sample04" }) as { sample: string; job: { jobId: string; status: string } };
	assert.equal(one.sample, SAMPLE_LABEL);
	assert.equal(one.job.jobId, "job_sample04");
	assert.equal(one.job.status, "PAID");
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
	assert.equal(await withDeadline(new Promise<string>(() => undefined), 20, "answered without the model"), "answered without the model");
	assert.equal(await withDeadline(Promise.resolve("the model's answer"), 1_000, "answered without the model"), "the model's answer");
	const failing = withDeadline(Promise.reject(new Error("provider failed")), 1_000, "fallback");
	await assert.rejects(failing, /provider failed/, "a failure inside the deadline is the failure, not the fallback");
});
