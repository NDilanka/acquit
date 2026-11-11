// The A1 scoping layer: the model turn behind the shared budget with no retry loop, the draft
// pipeline that parks a draft for the client's approval, and the read-only argv the droid caller
// runs (the A1 half of the operator's provider ruling). No test below calls a live model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCallLog } from "../../../packages/core/src/model.ts";
import { instant } from "../../../packages/core/src/ids.ts";
import type { CommitSha, Instant, JobId, TestId } from "../../../packages/core/src/ids.ts";
import type { FixtureContract, CurrencyFamily } from "../../../packages/core/src/fixtures.ts";
import type { JobScopingRow, ScopePhaseOutcome, ScopePhaseRunner } from "../../../packages/core/src/scoping.ts";
import { hiddenManifest } from "../../../packages/verifier/hidden.ts";
import { DEMO_FROZEN_AT, DEMO_FROZEN_TEST_PATH, demoFixture, exampleCases, exampleContract } from "../../../packages/core/test/hidden-fixture.ts";
import { scopeDraftModel, scopeModelName, scopeDraftTurn, scopingKick } from "../src/scoping.ts";
import { openrouterAskPort } from "../src/ask.ts";
import type { AskModelResult } from "../src/ask.ts";

const now = instant("2026-10-14T12:00:00Z");
const trustedFix = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const jobId = "job_scope" as JobId;
const issueBody = "Totals round wrong: BHD and its friends carry three decimals, and JPY keeps none — every total must name the currency's own minor-unit count.";
const families: readonly CurrencyFamily[] = [{ name: "three-decimal", currencies: ["BHD", "KWD"] }, { name: "zero-decimal", currencies: ["JPY"] }];

const contract: FixtureContract = demoFixture(exampleContract, { trustedFix, coverageFamilies: families });

/** A draft the parser takes: one candidate per family, each citing the issue body's own words. */
const goodDraft = JSON.stringify({ contract: "Every total formats to the currency's own minor-unit count.",
	candidates: [
		{ id: "c1", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235", citation: "three decimals" },
		{ id: "c2", target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500", citation: "the currency's own minor-unit count" },
	] });

const answered = (text: string): AskModelResult => ({ ok: true, text, sessionId: "s1", factoryCredits: 2 });
const failed = (reason: "PROVIDER_ERROR" | "RATE_LIMITED" | "NO_KEY"): AskModelResult => ({ ok: false, reason, detail: "injected" });

/** Both phases scripted: on the frozen commit every case runs but answers wrong; on the fix every
 * case answers exactly its expected value — the discriminating shape a real draft has. */
const phasesScripted: ScopePhaseRunner = async (commit, cases) => {
	const replies = new Map<TestId, ScopePhaseOutcome>();
	for (const test of cases) replies.set(test.id, commit === DEMO_FROZEN_AT
		? { ok: true, value: "__frozen__", error: null } : { ok: true, value: test.expected, error: null });
	return replies;
};

function deps(overrides: Partial<Parameters<typeof scopingKick>[0]> = {}): Parameters<typeof scopingKick>[0] {
	const dir = overrides.scopingDir ?? join(tmpdir(), `acquit-a1-api-${Math.random().toString(36).slice(2)}`);
	return {
		store: {
			readScoping: async () => null,
			writeScoping: async () => {},
		},
		fixture: contract,
		issueBody: async () => issueBody,
		model: async () => answered(goodDraft),
		callLog: modelCallLog(join(dir, "model-calls.jsonl")),
		runPhase: phasesScripted,
		scopingDir: dir,
		clock: { now: () => now },
		...overrides,
	};
}

test("the scoping model name follows the provider switch: the fireworks scoping primary by default, the droid id on droid, the :free id on openrouter", () => {
	assert.equal(scopeModelName({}), "accounts/fireworks/models/kimi-k3p1-pro");
	assert.equal(scopeModelName({ ACQUIT_MODEL_PROVIDER: "fireworks" }), "accounts/fireworks/models/kimi-k3p1-pro");
	assert.equal(scopeModelName({ ACQUIT_MODEL_PROVIDER: "droid" }), "glm-5.3-flash");
	assert.equal(scopeModelName({ ACQUIT_MODEL_PROVIDER: "openrouter" }), "nvidia/nemotron-3-ultra-550b-a55b:free");
});

test("the draft request carries the stored issue body and the frozen and fix commits, on either provider", async () => {
	const seen: string[] = [];
	const kick = scopingKick(deps({ model: async prompt => { seen.push(prompt); return answered(goodDraft); } }));
	await kick(jobId);
	const prompt = seen[0] ?? "";
	assert.match(prompt, /Totals round wrong: BHD and its friends carry three decimals/, "the stored issue body rides in the request");
	assert.match(prompt, new RegExp(issueBody.slice(0, 24)), "the body, not just its title");
	assert.match(prompt, /a3b6ead29f4e367d1871e753b516cc9e832871e4/, "the frozen commit is named");
	assert.match(prompt, /5cccb66515313caed72e4af329a62fc011139426/, "the trusted fix is named");
	assert.match(prompt, /maya-client\/invoice-app/, "the repository is named");

	// The openrouter transport takes the same request: the injected transport asserts the :free id
	// and the identical contents. No live openrouter call is ever made by this mission.
	let requested: { model?: string; messages?: readonly { content?: string }[] } | null = null;
	const openrouter = openrouterAskPort({ env: { OPENROUTER_API_KEY: "k" },
		key: async () => "k", fetch: (async (_url, init) => {
			requested = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
			return new Response(JSON.stringify({ choices: [{ message: { content: goodDraft } }] }), { status: 200 });
		}) as typeof fetch });
	const turn = await scopeDraftTurn({ model: openrouter, callLog: modelCallLog(join(tmpdir(), `a1-or-${Date.now()}.jsonl`)), jobId,
		env: { ACQUIT_MODEL_PROVIDER: "openrouter" } }, prompt);
	assert.ok(turn.ok, "the injected transport answers");
	assert.ok(requested!.model!.endsWith(":free"), "the openrouter model id is the free tier's");
	assert.match(requested!.messages![0]!.content!, /a3b6ead29f4e367d1871e753b516cc9e832871e4/, "the same frozen commit rides in the openrouter request");
	assert.match(requested!.messages![0]!.content!, /Totals round wrong: BHD and its friends carry three decimals/, "the same issue body rides in the openrouter request");
});

test("a drafted contract parks AWAITING_APPROVAL with the issue body, ids and counts, and its cases in the private file", async () => {
	const rows: JobScopingRow[] = [];
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-api-"));
	try {
		const kick = scopingKick(deps({ scopingDir: dir, runPhase: phasesScripted,
			store: { readScoping: async () => null, writeScoping: async row => { rows.push(row); } } }));
		await kick(jobId);
		assert.equal(rows.length, 2, "DRAFTING, then the parked draft");
		const parked = rows[1]!;
		assert.equal(parked.status, "AWAITING_APPROVAL");
		assert.equal(parked.issueBody, issueBody, "the job stores the issue body it scoped from");
		assert.deepEqual(parked.ids, ["draft:1", "draft:2"]);
		assert.equal(parked.digest, null, "nothing is frozen before the client approves");
		assert.deepEqual([parked.counts?.f1, parked.counts?.f2, parked.counts?.f3, parked.counts?.f4, parked.counts?.deduped], [2, 2, 2, 2, 2]);
		assert.equal(JSON.stringify(parked).includes("1.235"), false, "the store row carries no case value");
		const file = JSON.parse(await readFile(join(dir, "job_scope.json"), "utf8")) as { approved: string | null; cases: readonly { id: string; expected: string; citation: string }[] };
		assert.equal(file.approved, null);
		assert.deepEqual(file.cases.map(test => test.id), ["draft:1", "draft:2"]);
		assert.equal(file.cases[0]!.expected, "1.235", "the private file alone holds the case values");
		const mode = (await stat(join(dir, "job_scope.json"))).mode & 0o777;
		assert.equal(mode, 0o600, "the private file is the operator's own read");
		const dirMode = (await stat(dir)).mode & 0o777;
		assert.equal(dirMode, 0o700, "the private store's directory admits no one else");
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a failed or malformed draft freezes nothing and never loops: FAILED once, no case file, at most the one fallback call", async () => {
	const shapes: readonly [name: string, model: () => Promise<AskModelResult>, env: NodeJS.ProcessEnv, calls: number][] = [
		["provider error on droid", async () => failed("PROVIDER_ERROR"), { ACQUIT_MODEL_PROVIDER: "droid" }, 1],
		["provider error on fireworks", async () => failed("PROVIDER_ERROR"), {}, 2],
		["malformed on fireworks", async () => answered("not json at all"), {}, 1],
	];
	for (const [name, model, env, expectedCalls] of shapes) {
		const rows: JobScopingRow[] = [];
		const dir = await mkdtemp(join(tmpdir(), "acquit-a1-api-"));
		let calls = 0;
		try {
			const kick = scopingKick(deps({ scopingDir: dir, env, model: async () => { calls++; return model(); },
				store: { readScoping: async () => null, writeScoping: async row => { rows.push(row); } } }));
			await kick(jobId);
			assert.equal(calls, expectedCalls, `${name}: ${expectedCalls} model call(s), never a retry loop`);
			assert.equal(rows.length, 2);
			assert.equal(rows[1]!.status, "FAILED");
			assert.match(rows[1]!.reason ?? "", /draft|provider/i, `${name}: the refusal is named`);
			await assert.rejects(readFile(join(dir, "job_scope.json")));
		} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
	}
});

test("under fireworks a provider error gets one call on the scoping fallback model, and the log names both attempts", async () => {
	const rows: JobScopingRow[] = [];
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-api-"));
	const models: string[] = [];
	try {
		const kick = scopingKick(deps({ scopingDir: dir, env: {},
			model: async (_prompt, _signal, model) => { models.push(model ?? ""); return models.length === 1 ? failed("PROVIDER_ERROR") : answered(goodDraft); },
			store: { readScoping: async () => null, writeScoping: async row => { rows.push(row); } } }));
		await kick(jobId);
		assert.deepEqual(models, ["accounts/fireworks/models/kimi-k3p1-pro", "accounts/fireworks/models/glm-5p3"], "the primary, then the fallback");
		assert.equal(rows[1]!.status, "AWAITING_APPROVAL", "the fallback's answer parks the draft");
		const log = (await readFile(join(dir, "model-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { phase: string; model: string; outcome?: string });
		assert.deepEqual(log.filter(record => record.phase === "END").map(record => [record.model, record.outcome]),
			[["accounts/fireworks/models/kimi-k3p1-pro", "PROVIDER_ERROR"], ["accounts/fireworks/models/glm-5p3", "answered"]]);
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a draft every filter drops parks FAILED with the counts, and never a case file", async () => {
	const rows: JobScopingRow[] = [];
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-api-"));
	try {
		const kick = scopingKick(deps({ scopingDir: dir,
			model: async () => answered(goodDraft),
			runPhase: async (commit, cases) => {
				const replies = new Map<TestId, ScopePhaseOutcome>();
				for (const test of cases) replies.set(test.id, { ok: true, value: "1.235", error: null });
				return replies;
				// The frozen code passes c1 outright and the fix never matches c2: filter 2 keeps
				// nothing, so the draft is dead.
			},
			store: { readScoping: async () => null, writeScoping: async row => { rows.push(row); } } }));
		await kick(jobId);
		assert.equal(rows[1]!.status, "FAILED");
		assert.match(rows[1]!.reason ?? "", /NO_CASE_SURVIVED/i);
		await assert.rejects(readFile(join(dir, "job_scope.json")));
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a job that already carries a scoping row is never drafted twice", async () => {
	let calls = 0;
	const kick = scopingKick(deps({ model: async () => { calls++; return answered(goodDraft); },
		store: { readScoping: async () => ({ jobId, status: "AWAITING_APPROVAL", issueBody, ids: ["draft:1"] as TestId[], digest: null, reason: null, counts: null, updatedAt: now }), writeScoping: async () => {} } }));
	await kick(jobId);
	assert.equal(calls, 0);
});

test("the scoping turn reserves from the shared budget before the model, and an over-budget deployment never calls", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-budget-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		for (let i = 0; i < 20; i++) await log.append({ at: new Date().toISOString(), caller: "scoping", jobId: null, provider: "droid", model: "glm-5.3-flash", phase: "START" });
		let calls = 0;
		const outcome = await scopeDraftTurn({ model: async () => { calls++; return answered(goodDraft); }, callLog: log, jobId }, "prompt");
		assert.equal(outcome.ok, false);
		assert.equal((outcome as { reason: string }).reason, "BUDGET");
		assert.equal(calls, 0, "the budget refuses before any model call");
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

/** A scoping model answer for a call that runs until its signal is cancelled. The safety timer keeps a test from hanging
 * when no signal arrives; the test then fails on its own assertions. */
const untilCancelled = (signal: AbortSignal | undefined): Promise<AskModelResult> => new Promise(resolve => {
	const safety = setTimeout(() => { resolve(failed("PROVIDER_ERROR")); }, 2_000);
	signal?.addEventListener("abort", () => { clearTimeout(safety); resolve(failed("PROVIDER_ERROR")); }, { once: true });
});

const KIMI = "accounts/fireworks/models/kimi-k3p1-pro";
const GLM_FALLBACK = "accounts/fireworks/models/glm-5p3";

test("a scoping deadline that expires during the primary cancels it, and no fallback is reserved or asked", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-deadline-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const signals: (AbortSignal | undefined)[] = [];
		const outcome = await scopeDraftTurn({ model: async (_prompt, signal) => { signals.push(signal); return untilCancelled(signal); },
			callLog: log, jobId, env: {}, deadlineMs: 250 }, "prompt");
		assert.equal(outcome.ok, false, "the cancelled primary is a failed draft");
		assert.equal(signals.length, 1, "the primary was the only call");
		assert.equal(signals[0]?.aborted, true, "the primary's request was cancelled at the deadline");
		assert.deepEqual((await log.records()).map(record => [record.phase, record.model]), [["START", KIMI], ["END", KIMI]]);
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a scoping deadline that expires during the fallback aborts the fallback's request, and the turn ends there", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-deadline-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		let calls = 0;
		const signals: (AbortSignal | undefined)[] = [];
		const outcome = await scopeDraftTurn({ model: async (_prompt, signal) => {
			calls++;
			signals.push(signal);
			return calls === 1 ? failed("PROVIDER_ERROR") : untilCancelled(signal);
		}, callLog: log, jobId, env: {}, deadlineMs: 400 }, "prompt");
		assert.equal(outcome.ok, false, "the cancelled fallback is a failed draft");
		assert.equal(calls, 2, "the primary, then the one fallback, and nothing after it");
		assert.equal(signals[1]?.aborted, true, "the fallback's request was cancelled at the deadline");
		assert.deepEqual((await log.records()).map(record => [record.phase, record.model]),
			[["START", KIMI], ["END", KIMI], ["START", GLM_FALLBACK], ["END", GLM_FALLBACK]]);
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a deadline that expires before the fallback is reserved stops the turn: no fallback reservation and no fallback call", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-deadline-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const asked: (string | undefined)[] = [];
		// The primary ignores its signal and answers after the deadline has passed. The deadline is long enough for the
		// primary's own reservation to finish first, so the primary is asked and the test is about the fallback alone.
		const outcome = await scopeDraftTurn({ model: async (_prompt, _signal, model) => {
			asked.push(model);
			await new Promise(resolve => { setTimeout(resolve, 500); });
			return failed("PROVIDER_ERROR");
		}, callLog: log, jobId, env: {}, deadlineMs: 250 }, "prompt");
		assert.equal(outcome.ok, false);
		assert.deepEqual(asked, [KIMI], "the fallback is never asked once the turn has expired");
		assert.deepEqual((await log.records()).map(record => [record.phase, record.model]), [["START", KIMI], ["END", KIMI]],
			"no START is written for a fallback that never runs");
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a deadline that expires while the fallback reservation is written: its END records the cancel and no fallback call runs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-deadline-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		// The fallback's START takes longer than the deadline to write, so the deadline passes inside the reservation.
		const slow: typeof log = { ...log, append: async record => {
			if (record.phase === "START" && record.model === GLM_FALLBACK) await new Promise(resolve => { setTimeout(resolve, 500); });
			return log.append(record);
		} };
		const asked: (string | undefined)[] = [];
		const outcome = await scopeDraftTurn({ model: async (_prompt, _signal, model) => { asked.push(model); return failed("PROVIDER_ERROR"); },
			callLog: slow, jobId, env: {}, deadlineMs: 250 }, "prompt");
		assert.equal(outcome.ok, false);
		assert.deepEqual(asked, [KIMI], "the reserved-but-expired fallback never reaches the model");
		assert.deepEqual((await log.records()).map(record => [record.phase, record.model, record.outcome ?? null]),
			[["START", KIMI, null], ["END", KIMI, "PROVIDER_ERROR"], ["START", GLM_FALLBACK, null], ["END", GLM_FALLBACK, "PROVIDER_ERROR"]],
			"the reservation's END names the cancel, so the log counts every START");
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("the A1 scoping caller runs droid read-only: no --auto, json output, the pinned model, the prompt by file", { timeout: 30_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-argv-"));
	try {
		const bin = join(dir, "bin");
		await mkdir(bin);
		const argvFile = join(dir, "argv.txt");
		const envFile = join(dir, "env.txt");
		// The shim records its argv and whether a Factory key rode in its environment, then answers
		// the result line a real droid exec prints.
		const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: goodDraft, session_id: "s-a1", usage: { factory_credits: 1 } });
		await writeFile(join(bin, "droid"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nprintf '%s' "$FACTORY_API_KEY" > '${envFile}'\nprintf '%s\\n' '${result}'\n`, { mode: 0o700 });
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		// The same droid environment reaches the model port and the turn, so the turn logs the droid model it runs.
		const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, ACQUIT_MODEL_PROVIDER: "droid", FACTORY_API_KEY: "test-key-in-process" };
		const model = scopeDraftModel({ env });
		const outcome = await scopeDraftTurn({ model, callLog: log, jobId, env }, goodDraft);
		assert.ok(outcome.ok, "the shim's answer rides back");
		const argv = (await readFile(argvFile, "utf8")).split("\n").filter(line => line !== "");
		// The shim sees the argv after "droid": exec, the pinned model, json output, the prompt by
		// file. No --auto anywhere, and exactly one file argument — the port's own read-only shape.
		assert.deepEqual(argv.slice(0, 8), ["exec", "-m", "glm-5.3-flash", "-o", "json", "--only-tools", "TodoWrite", "-f"]);
		assert.equal(argv.length, 9, "nothing but the read-only argv, the one inert tool, and the prompt file");
		assert.match(argv[8]!, /ask-instruction\.txt$/);
		assert.ok(!argv.includes("--auto"), "no write-level autonomy flag: the scoping caller is read-only");
		assert.ok(argv.includes("-o") && argv.includes("json"), "the result line is json");
		assert.equal(await readFile(envFile, "utf8"), "test-key-in-process", "the Factory key rides in the child's environment");
		assert.ok(!argv.some(arg => arg.includes("test-key")), "the key is never in argv");
		const ends = (await log.records()).filter(record => record.phase === "END");
		assert.equal(ends.length, 1);
		assert.equal(ends[0]!.caller, "scoping");
		assert.equal(ends[0]!.model, "glm-5.3-flash");
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
