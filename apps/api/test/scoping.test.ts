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
		fixture: contract, repository: "maya-client/invoice-app", issue: { number: 12 },
		issueBody: async () => issueBody,
		model: async () => answered(goodDraft),
		callLog: modelCallLog(join(dir, "model-calls.jsonl")),
		runPhase: phasesScripted,
		scopingDir: dir,
		clock: { now: () => now },
		...overrides,
	};
}

test("the scoping model name follows the provider switch: glm-5.3-flash by default, the :free id on openrouter", () => {
	assert.equal(scopeModelName(), "glm-5.3-flash");
	assert.equal(scopeModelName({ ACQUIT_MODEL_PROVIDER: "droid" }), "glm-5.3-flash");
	assert.equal(scopeModelName({ ACQUIT_MODEL_PROVIDER: "openrouter" }), "nvidia/nemotron-3-ultra-550b-a55b:free");
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
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a failed or malformed draft freezes nothing and never retries: FAILED once, no case file", async () => {
	for (const [name, model] of [["provider error", async () => failed("PROVIDER_ERROR")], ["malformed", async () => answered("not json at all")]] as const) {
		const rows: JobScopingRow[] = [];
		const dir = await mkdtemp(join(tmpdir(), "acquit-a1-api-"));
		let calls = 0;
		try {
			const kick = scopingKick(deps({ scopingDir: dir, model: async prompt => { calls++; return model(); },
				store: { readScoping: async () => null, writeScoping: async row => { rows.push(row); } } }));
			await kick(jobId);
			assert.equal(calls, 1, `${name}: exactly one model call, never a retry loop`);
			assert.equal(rows.length, 2);
			assert.equal(rows[1]!.status, "FAILED");
			assert.match(rows[1]!.reason ?? "", /draft|provider/i, `${name}: the refusal is named`);
			await assert.rejects(readFile(join(dir, "job_scope.json")));
		} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
	}
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
		const model = scopeDraftModel({ env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, ACQUIT_MODEL_PROVIDER: "droid", FACTORY_API_KEY: "test-key-in-process" } });
		const outcome = await scopeDraftTurn({ model, callLog: log, jobId }, goodDraft);
		assert.ok(outcome.ok, "the shim's answer rides back");
		const argv = (await readFile(argvFile, "utf8")).split("\n").filter(line => line !== "");
		// The shim sees the argv after "droid": exec, the pinned model, json output, the prompt by
		// file. No --auto anywhere, and exactly one file argument — the port's own read-only shape.
		assert.deepEqual(argv.slice(0, 6), ["exec", "-m", "glm-5.3-flash", "-o", "json", "-f"]);
		assert.equal(argv.length, 7, "nothing but the read-only argv and the prompt file");
		assert.match(argv[6]!, /ask-instruction\.txt$/);
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
