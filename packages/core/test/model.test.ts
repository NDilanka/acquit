// The model provider switch and the droid client: pure logic, no Docker, no network, no key.
// The droid shapes here are the ones a real `droid exec -o json` run prints (probed once through
// the egress proxy on 2026-10-11); no test below opens a socket.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import {
	classifyDroidRun, droidExecArgv, DROID_INSTRUCTION_PATH, DROID_MODEL, droidResultText, factoryApiKey, modelCallLog, modelProvider,
	reserveModelCall,
} from "../src/model.ts";
import type { ModelCallLog } from "../src/model.ts";

test("the model provider switch defaults to droid with glm-5.3-flash", () => {
	assert.equal(modelProvider({}), "droid");
	assert.equal(modelProvider({ ACQUIT_MODEL_PROVIDER: "" }), "droid");
	assert.equal(modelProvider({ ACQUIT_MODEL_PROVIDER: "  " }), "droid");
	assert.equal(modelProvider({ ACQUIT_MODEL_PROVIDER: "droid" }), "droid");
	assert.equal(modelProvider({ ACQUIT_MODEL_PROVIDER: "DROID " }), "droid", "the value is read case-insensitively and trimmed");
	assert.equal(DROID_MODEL, "glm-5.3-flash");
});

test("openrouter stays selectable on the same switch", () => {
	assert.equal(modelProvider({ ACQUIT_MODEL_PROVIDER: "openrouter" }), "openrouter");
	assert.equal(modelProvider({ ACQUIT_MODEL_PROVIDER: "OpenRouter" }), "openrouter");
});

test("an unknown provider name is a configuration error, never a silent fallback", () => {
	assert.throws(() => modelProvider({ ACQUIT_MODEL_PROVIDER: "anthropic" }), /ACQUIT_MODEL_PROVIDER/);
	assert.throws(() => modelProvider({ ACQUIT_MODEL_PROVIDER: "factory" }), /ACQUIT_MODEL_PROVIDER/);
});

test("the droid client pins the ruled exec argv: auto medium, the model, json output, prompt by file", () => {
	assert.deepEqual(droidExecArgv({ model: "glm-5.3-flash", workDir: "/work" }),
		["droid", "exec", "--auto", "medium", "-m", "glm-5.3-flash", "-o", "json", "--cwd", "/work", "-f", DROID_INSTRUCTION_PATH]);
	assert.equal(DROID_INSTRUCTION_PATH, "/tmp/acquit-instruction.txt");
});

test("the droid classification reads the result line a real run prints", () => {
	const ok = `{"type":"result","subtype":"success","is_error":false,"duration_ms":3467,"num_turns":1,"result":"ok",`
		+ `"session_id":"4f8b1303-23d1-442b-a8cd-f655047ff977",`
		+ `"usage":{"input_tokens":11029,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"factory_credits":663,"ttft_ms":3313}}\n`;
	assert.deepEqual(classifyDroidRun(0, ok), { ok: true, sessionId: "4f8b1303-23d1-442b-a8cd-f655047ff977", factoryCredits: 663 });
	assert.deepEqual(classifyDroidRun(null, ok).ok, true, "a stream that ends with a success result is a run");
});

test("an is_error result is a provider error even on exit 0", () => {
	const denied = `{"type":"result","subtype":"failure","is_error":true,"duration_ms":142,"num_turns":0,`
		+ `"result":"403 status code (no body)","session_id":"7f98292d-bbec-41c4-bf6a-cc66790a0a6a",`
		+ `"usage":{"input_tokens":0,"output_tokens":0,"factory_credits":0}}\n`;
	const outcome = classifyDroidRun(0, denied);
	assert.equal(outcome.ok, false, "a denied run is never a success");
	assert.equal((outcome as { reason: string }).reason, "PROVIDER_ERROR", "a provider error gets the one retry");
	assert.match((outcome as { detail: string }).detail, /403/, "the detail names the provider's own text");
	assert.equal(classifyDroidRun(1, denied).ok, false);
});

test("a nonzero exit without a result line is a provider error", () => {
	const outcome = classifyDroidRun(1, "connect ECONNRESET walked off the wire\n");
	assert.equal(outcome.ok, false);
	assert.equal((outcome as { reason: string }).reason, "PROVIDER_ERROR", "a transport failure gets the one retry");
	assert.match((outcome as { detail: string }).detail, /exited 1/);
});

test("a rate or usage limit is its own terminal class, keeping the metadata the answer carried", () => {
	const rateLimited = `{"type":"result","subtype":"failure","is_error":true,"duration_ms":142,"num_turns":0,`
		+ `"result":"429 Too Many Requests: rate limit exceeded, try again later","session_id":"7f98292d-bbec-41c4-bf6a-cc66790a0a6a",`
		+ `"usage":{"input_tokens":0,"output_tokens":0,"factory_credits":0}}\n`;
	const outcome = classifyDroidRun(0, rateLimited);
	assert.equal(outcome.ok, false);
	assert.equal((outcome as { reason: string }).reason, "RATE_LIMITED", "a rate limit is terminal, never retried");
	assert.equal((outcome as { sessionId?: string }).sessionId, "7f98292d-bbec-41c4-bf6a-cc66790a0a6a", "the spent session survives on the error");
	assert.equal((classifyDroidRun(0, `{"type":"result","is_error":true,"result":"usage limit reached: insufficient credits for today",`
		+ `"session_id":"s-u","usage":{"factory_credits":12}}\n`) as { reason: string }).reason, "RATE_LIMITED", "a usage-limit answer is the same class");
	const generic = classifyDroidRun(0, `{"type":"result","subtype":"failure","is_error":true,`
		+ `"result":"403 status code (no body)","session_id":"s-g","usage":{"factory_credits":0}}\n`);
	assert.equal((generic as { reason: string }).reason, "PROVIDER_ERROR", "a generic provider error keeps its one retry");
	assert.equal((generic as { sessionId?: string }).sessionId, "s-g", "even a generic error keeps the session it spent");
	assert.equal((generic as { factoryCredits?: number }).factoryCredits, 0, "and the credits it reported");
});

test("a nonzero exit whose raw output names a rate or usage limit is RATE_LIMITED too", () => {
	const outcome = classifyDroidRun(1, "droid: usage limit reached; the quota is exhausted for today\n");
	assert.equal(outcome.ok, false);
	assert.equal((outcome as { reason: string }).reason, "RATE_LIMITED", "a quota-naming exit is terminal, never retried");
});

test("the shared budget refuses the 20th call in a rolling minute and the 1000th of a day, recording the START first", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-budget-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const call = (offsetMs: number) => ({ at: new Date(Date.parse("2026-10-12T00:00:00Z") + offsetMs).toISOString(),
			caller: "house", jobId: "job_x", provider: "droid", model: "glm-5.3-flash" });
		for (let index = 0; index < 18; index += 1) assert.deepEqual(await reserveModelCall(log, call(index * 1_000)), { ok: true });
		assert.deepEqual(await reserveModelCall(log, call(18_000)), { ok: true }, "18 calls in the window still admit the 19th");
		assert.deepEqual(await reserveModelCall(log, call(19_000)), { ok: false, reason: "BUDGET" }, "the 20th call in a minute is refused");
		const starts = (await log.records()).filter(record => record.phase === "START");
		assert.equal(starts.length, 19, "every admitted call wrote its START record before anything ran");

		const day = modelCallLog(join(dir, "day.jsonl"));
		const recent = new Date(Date.parse("2026-10-12T00:00:00Z") - 3_600_000).toISOString();
		const dayAgo = new Date(Date.parse("2026-10-12T00:00:00Z") - 25 * 3_600_000).toISOString();
		for (let index = 0; index < 999; index += 1) {
			await day.append({ at: recent, caller: "house", jobId: null, provider: "droid", model: "glm-5.3-flash", phase: "START" });
		}
		assert.deepEqual(await reserveModelCall(day, call(0)), { ok: false, reason: "BUDGET" }, "999 calls in the day refuse the 1000th");
		const old = modelCallLog(join(dir, "old.jsonl"));
		for (let index = 0; index < 999; index += 1) {
			await old.append({ at: dayAgo, caller: "house", jobId: null, provider: "droid", model: "glm-5.3-flash", phase: "START" });
		}
		assert.deepEqual(await reserveModelCall(old, call(0)), { ok: true }, "calls older than a day do not count");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two concurrent reservations cannot both pass the cap", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-budget-race-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const at = new Date().toISOString();
		for (let index = 0; index < 18; index += 1) {
			await log.append({ at, caller: "ask-ledger", jobId: null, provider: "droid", model: "glm-5.3-flash", phase: "START" });
		}
		const call = { at, caller: "ask-ledger", jobId: null, provider: "droid", model: "glm-5.3-flash" };
		const results = await Promise.all([reserveModelCall(log, call), reserveModelCall(log, call)]);
		assert.equal(results.filter(result => result.ok).length, 1, "exactly one of the two concurrent reservations is admitted");
		const starts = (await log.records()).filter(record => record.phase === "START");
		assert.equal(starts.length, 19, "the minute never holds the 20th start");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("thirty concurrent reservations admit exactly the minute's nineteen", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-budget-race30-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const call = { at: new Date().toISOString(), caller: "ask-ledger", jobId: null, provider: "droid", model: "glm-5.3-flash" };
		const results = await Promise.all(Array.from({ length: 30 }, () => reserveModelCall(log, call)));
		assert.equal(results.filter(result => result.ok).length, 19, "the window admits its 19, nothing more");
		assert.equal((await log.records()).filter(record => record.phase === "START").length, 19, "each admission wrote one START");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two waiters queue on a live owner's lock, enter one at a time after its release, and the caps hold", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-budget-queue-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const call = { at: new Date().toISOString(), caller: "ask-ledger", jobId: null, provider: "droid", model: "glm-5.3-flash" };
		for (let index = 0; index < 18; index += 1) await log.append({ ...call, phase: "START" });
		writeFileSync(`${log.path}.lock`, "4242.liveowner", { mode: 0o600 });
		const minute = Promise.all([reserveModelCall(log, call), reserveModelCall(log, call)]);
		// Both waiters are now cycling on the live owner's lock; then the owner releases it.
		await new Promise(resolve => { setTimeout(resolve, 100); });
		await fsPromises.unlink(`${log.path}.lock`);
		const results = await minute;
		assert.equal(results.filter(result => result.ok).length, 1, "the release admits the queued waiters strictly one at a time; the cap refuses the second");
		assert.equal((await log.records()).filter(record => record.phase === "START").length, 19, "the minute never holds the twentieth start");

		const day = modelCallLog(join(dir, "day.jsonl"));
		// An hour ago: inside the day window, outside the minute one, so only the day cap decides.
		const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
		for (let index = 0; index < 998; index += 1) await day.append({ ...call, at: anHourAgo, phase: "START" });
		writeFileSync(`${day.path}.lock`, "4242.liveowner", { mode: 0o600 });
		const dayQueue = Promise.all([reserveModelCall(day, call), reserveModelCall(day, call)]);
		await new Promise(resolve => { setTimeout(resolve, 100); });
		await fsPromises.unlink(`${day.path}.lock`);
		const dayResults = await dayQueue;
		assert.equal(dayResults.filter(result => result.ok).length, 1, "the same queue against the day window");
		assert.equal((await day.records()).filter(record => record.phase === "START").length, 999, "the day never holds its thousandth start");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a waiter never removes or takes over a stale lock, however old it looks", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-budget-stale-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const lockPath = `${log.path}.lock`;
		const call = { at: new Date().toISOString(), caller: "ask-ledger", jobId: null, provider: "droid", model: "glm-5.3-flash" };
		for (let index = 0; index < 18; index += 1) await log.append({ ...call, phase: "START" });
		writeFileSync(lockPath, "4242.longgoneowner", { mode: 0o600 });
		// An age no staleness threshold could call fresh: the lock's owner is long gone.
		const stale = new Date(Date.now() - 20_000);
		await fsPromises.utimes(lockPath, stale, stale);
		const refusal = await reserveModelCall(log, call);
		assert.ok(!refusal.ok && refusal.reason === "BUDGET", "the waiter waits out its bound and refuses; it never takes a lock over");
		assert.equal(readFileSync(lockPath, "utf8"), "4242.longgoneowner", "the stale lock is left exactly as its owner wrote it");
		assert.deepEqual((await fsPromises.readdir(dir)).filter(name => name.endsWith(".stale")), [], "no takeover tombstones were created beside the lock");
		assert.equal((await log.records()).filter(record => record.phase === "START").length, 18, "nothing was appended behind a lock the waiter does not own");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a releaser never removes a lock a replacement owner took over", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-budget-release-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const lockPath = `${log.path}.lock`;
		const replacement = "6311.replacementowner";
		const wrapped: ModelCallLog = {
			...log,
			append: async record => {
				await log.append(record);
				// the operator's clear plus a re-acquire replaced the lock while this holder is still inside its section
				rmSync(lockPath, { force: true });
				writeFileSync(lockPath, replacement, { mode: 0o600 });
			},
		};
		const call = { at: new Date().toISOString(), caller: "ask-ledger", jobId: null, provider: "droid", model: "glm-5.3-flash" };
		assert.deepEqual(await reserveModelCall(wrapped, call), { ok: true });
		let afterRelease: string | null = null;
		try { afterRelease = readFileSync(lockPath, "utf8"); } catch { afterRelease = null; }
		assert.equal(afterRelease, replacement, "the replacement owner's lock survives the first holder's release");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a waiter facing a lock that never frees refuses with BUDGET and leaves the lock alone", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-budget-wedge-"));
	try {
		const log = modelCallLog(join(dir, "model-calls.jsonl"));
		const lockPath = `${log.path}.lock`;
		writeFileSync(lockPath, "0.0.wedged", { mode: 0o600 });
		const call = { at: new Date().toISOString(), caller: "ask-ledger", jobId: null, provider: "droid", model: "glm-5.3-flash" };
		const refusal = await reserveModelCall(log, call);
		assert.ok(!refusal.ok && refusal.reason === "BUDGET", "a lock that never frees is a budget refusal, never an error");
		if (!refusal.ok) {
			assert.ok(refusal.detail !== undefined && refusal.detail.includes(lockPath), "the refusal names the lock path");
			assert.match(refusal.detail, /model-lock clear/, "and the operator's recovery command");
		}
		assert.equal(readFileSync(lockPath, "utf8"), "0.0.wedged", "the refusal leaves the wedged lock for its owner");
		assert.equal((await log.records()).length, 0, "nothing was appended behind the wedged lock");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an exit 0 with no result line defers to the commit step", () => {
	assert.deepEqual(classifyDroidRun(0, "the agent printed nothing parseable\n"), { ok: true, sessionId: null, factoryCredits: null });
});

test("a success result without session or usage still succeeds, with nulls recorded", () => {
	const bare = `{"type":"result","subtype":"success","is_error":false,"result":"done"}\n`;
	assert.deepEqual(classifyDroidRun(0, bare), { ok: true, sessionId: null, factoryCredits: null });
});

test("the Factory key comes from the environment first, then the laptop key file, never a log", async () => {	assert.equal(await factoryApiKey({ FACTORY_API_KEY: "from-env" }), "from-env", "the VM's env var wins");
	const home = mkdtempSync(join(tmpdir(), "acquit-model-key-"));
	const keyFile = join(home, ".config", "acquit", "factory-api-key");
	try {
		mkdirSync(join(home, ".config", "acquit"), { recursive: true });
		writeFileSync(keyFile, "file-canary-key\n", { mode: 0o600 });
		assert.equal(await factoryApiKey({ HOME: home }), "file-canary-key", "the laptop key file is read in-process");
		writeFileSync(keyFile, "line-canary-one\nline-canary-two\n", { mode: 0o600 });
		assert.equal(await factoryApiKey({ HOME: home }), null, "a multi-line file is not a usable key");
		writeFileSync(keyFile, "", { mode: 0o600 });
		assert.equal(await factoryApiKey({ HOME: home }), null, "an empty file is not a usable key");
	} finally { rmSync(home, { recursive: true, force: true }); }
	assert.equal(await factoryApiKey({ HOME: "/nonexistent-acquit-home" }), null, "a missing key file yields null, never a throw");
});

test("the result line's answer text is readable for a read-only ask turn", () => {
	const ok = `{"type":"result","subtype":"success","is_error":false,"result":"{\\"message\\":\\"378.00 held\\"}","session_id":"s1","usage":{"factory_credits":12}}\n`;
	assert.equal(droidResultText(ok), '{"message":"378.00 held"}');
	assert.equal(droidResultText("no result line at all\n"), null, "a stream with no result line has no text");
	assert.equal(droidResultText(""), null, "an empty stream has no text");
	const errored = `{"type":"result","subtype":"failure","is_error":true,"result":"the model refused"}\n`;
	assert.equal(droidResultText(errored), "the model refused", "an errored run still reports the text it carried");
});

