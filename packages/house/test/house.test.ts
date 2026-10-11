// The House's own facts: its bid-row line comes from receipt rows, and its seed never borrows
// another operator's payee. Everything here runs without Docker, a browser, or a model call.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { defaultInstruction } from "../../acquit-cli/src/run.ts";
import type { CommitSha, JobId } from "../../core/src/ids.ts";
import { houseLine } from "../../core/src/job.ts";
import {
	classifyModelRun, houseInstruction, HOUSE_INSTRUCTION_SUFFIX, HOUSE_MODEL, HOUSE_OPERATOR_ID,
	isDeliverableHouseJob, runHouseDelivery, stateStore,
	type HouseDeliveryDeps, type HouseDeliveryState, type HouseDeliverableFacts,
	type HouseRunOutcome, type HouseRunPlan, type HouseTarget,
} from "../src/runner.ts";

const root = resolve(import.meta.dirname, "../../..");
const ctl = join(root, "packages/ctl/src/main.ts");

test("the House label counts a receipts table of 41 rows with 39 paid", () => {
	assert.equal(houseLine({ total: 41, paid: 39 }), "41 fixes, 39 passed verified CI");
});

test("the House label counts a new real receipt together with the seeded rows", () => {
	assert.equal(houseLine({ total: 42, paid: 40 }), "42 fixes, 40 passed verified CI");
});

test("seed run without the House merchant id fails and writes no House operator with Devon's merchant", () => {
	const database = join(mkdtempSync(join(tmpdir(), "acquit-house-seed-")), "acquit.db");
	try {
		const run = spawnSync(process.execPath, [ctl, "seed-db", "--yes"],
			{ encoding: "utf8", timeout: 120_000, env: { ...process.env, ACQUIT_DEV: "1", DATABASE_PATH: database, OPERATOR_HOUSE_MERCHANT_ID: "" } });
		assert.notEqual(run.status, 0, "the seed must fail without OPERATOR_HOUSE_MERCHANT_ID");
		assert.match(`${run.stdout}\n${run.stderr}`, /OPERATOR_HOUSE_MERCHANT_ID/);
		assert.ok(!existsSync(database) || !houseOperator(database), "a failed seed writes no house-tsfix operator");
		assert.ok(!existsSync(database) || !houseOperatorWithDevonMerchant(database), "the House must never carry Devon's merchant");
	} finally { rmSync(join(database, ".."), { recursive: true, force: true }); }
});

test("seed writes the configured House merchant, different from Devon's, with 41 seeded receipts", () => {
	const database = join(mkdtempSync(join(tmpdir(), "acquit-house-seed-")), "acquit.db");
	// A stand-in value passed through the child environment, compared in process here and never printed.
	const configured = "HOUSESEEDMERCHANT";
	try {
		const run = spawnSync(process.execPath, [ctl, "seed-db", "--yes"],
			{ encoding: "utf8", timeout: 120_000, env: { ...process.env, ACQUIT_DEV: "1", DATABASE_PATH: database, OPERATOR_HOUSE_MERCHANT_ID: configured } });
		assert.equal(run.status, 0, `the seed with the House merchant id set must pass: ${run.stderr.slice(0, 300)}`);
		const db = new DatabaseSync(database, { readOnly: true });
		try {
			const house = merchantOf(db, "house-tsfix");
			const devon = merchantOf(db, "devon-ops");
			assert.equal(house === configured, true, "the seeded House merchant equals the configured value");
			assert.equal(house !== null && house !== devon, true, "the House merchant differs from Devon's");
			const rows = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(paid), 0) AS paid, COALESCE(GROUP_CONCAT(DISTINCT source), '') AS sources FROM receipts WHERE operator = ?").get("house-tsfix");
			assert.equal(Number(rows?.n ?? 0), 41, "the seed writes 41 House receipt rows");
			assert.equal(Number(rows?.paid ?? 0), 39, "39 of the seeded rows are paid");
			assert.equal(String(rows?.sources ?? ""), "SEED", "every seeded row is marked SEED");
		} finally { db.close(); }
	} finally { rmSync(join(database, ".."), { recursive: true, force: true }); }
});

function houseOperator(database: string): boolean {
	const db = new DatabaseSync(database, { readOnly: true });
	try { return db.prepare("SELECT 1 FROM operators WHERE id = ?").get("house-tsfix") !== undefined; }
	finally { db.close(); }
}

function houseOperatorWithDevonMerchant(database: string): boolean {
	const db = new DatabaseSync(database, { readOnly: true });
	try {
		const row = db.prepare("SELECT json FROM operators WHERE id = ?").get("house-tsfix");
		const devon = merchantOf(db, "devon-ops");
		if (!row) return false;
		const merchant = JSON.parse(String(row.json))?.payouts?.merchant;
		return devon !== null && merchant === devon;
	} finally { db.close(); }
}

function merchantOf(db: DatabaseSync, operator: string): string | null {
	const row = db.prepare("SELECT json FROM operators WHERE id = ?").get(operator);
	if (!row) return null;
	const merchant = JSON.parse(String(row.json))?.payouts?.merchant;
	return typeof merchant === "string" ? merchant : null;
}

// ---- the runner --------------------------------------------------------------------------------

const suffixFile = "/home/factory-user/repos/acquit/data/trail/house-instruction-suffix.txt";
const target: HouseTarget = {
	id: "9e0f6b72-1111-4222-8333-444455556666" as JobId, title: "Totals round wrong for 3-decimal currencies",
	repository: "NDilanka/acquit-work-9e0f6b72", frozenAt: "0123456789abcdef0123456789abcdef01234567" as CommitSha,
};
const fresh: HouseDeliveryState = { calls: 0, submittedCommit: null, submitAttempts: 0, prepareFailures: 0 };

/** Injected delivery: the run port records plans, the work port mints one commit, the state is a map. */
function fakeDeps(run?: (plan: HouseRunPlan) => Promise<HouseRunOutcome>, overrides: Partial<HouseDeliveryDeps> = {}) {
	const plans: HouseRunPlan[] = [];
	const commits: string[] = [];
	const states = new Map<string, HouseDeliveryState>();
	const record = async (plan: HouseRunPlan): Promise<HouseRunOutcome> => {
		plans.push(plan);
		return run === undefined ? { ok: true } : run(plan);
	};
	const deps: HouseDeliveryDeps = {
		mode: { runner: "model" },
		run: record,
		work: {
			prepare: async () => ({ workDir: "/tmp/house-work" }),
			finalize: async () => "5f5b7c0a9c0e1d2b3a4f5e6d7c8b9a0f1e2d3c4b" as CommitSha,
			remove: () => {},
		},
		readState: async jobId => states.get(jobId) ?? fresh,
		writeState: async (jobId, state) => { states.set(jobId, state); },
		submit: async (jobId, commit) => { commits.push(`${jobId}:${commit}`); },
		log: () => {},
		...overrides,
	};
	return { deps, plans, commits, states };
}

test("the House runner pins the ruled free model and the CLI default instruction plus the committed suffix", async () => {
	assert.equal(HOUSE_MODEL, "nvidia/nemotron-3-ultra-550b-a55b:free");
	// The committed suffix is byte-identical to the ruling file the mission names.
	assert.equal(HOUSE_INSTRUCTION_SUFFIX, readFileSync(suffixFile, "utf8").replace(/\n$/, ""));
	const expected = houseInstruction(defaultInstruction({ title: target.title }));
	const { deps, plans } = fakeDeps();
	const outcome = await runHouseDelivery(deps, target);
	assert.equal(outcome, "SUBMITTED");
	assert.equal(plans.length, 1);
	assert.deepEqual(plans[0], {
		runner: "model", jobId: target.id, workDir: "/tmp/house-work", model: HOUSE_MODEL, instruction: expected,
	});
});

test("one provider error retries once and still submits, with both calls persisted", async () => {
	let calls = 0;
	const { deps, plans, commits, states } = fakeDeps(async () => {
		calls += 1;
		return calls === 1
			? { ok: false, reason: "PROVIDER_ERROR", detail: "503 upstream" }
			: { ok: true };
	});
	const outcome = await runHouseDelivery(deps, target);
	assert.equal(outcome, "SUBMITTED");
	assert.equal(plans.length, 2, "exactly one retry");
	assert.equal(states.get(target.id)?.calls, 2, "both model calls persist");
	assert.deepEqual(commits, [`${target.id}:5f5b7c0a9c0e1d2b3a4f5e6d7c8b9a0f1e2d3c4b`]);
});

test("two provider errors in a row make exactly two calls, never a submit, and no attempt charged", async () => {
	const { deps, plans, commits, states } = fakeDeps(async () => ({ ok: false, reason: "PROVIDER_ERROR", detail: "503 upstream" }));
	const outcome = await runHouseDelivery(deps, target);
	assert.equal(outcome, "FAILED");
	assert.equal(plans.length, 2);
	assert.equal(states.get(target.id)?.calls, 2, "both model calls persist");
	assert.equal(states.get(target.id)?.submittedCommit, null, "nothing submitted");
	assert.deepEqual(commits, [], "the House submits nothing without a run");
});

test("a 429 from the free tier gets the same single retry and never a loop", async () => {
	let calls = 0;
	const { deps, plans } = fakeDeps(async () => {
		calls += 1;
		return { ok: false, reason: "PROVIDER_ERROR", detail: `429 ${calls}` };
	});
	const outcome = await runHouseDelivery(deps, target);
	assert.equal(outcome, "FAILED");
	assert.equal(plans.length, 2, "at most two calls in total");
});

test("a runner whose calls are spent is skipped without a call or a submit", async () => {
	const { deps, plans, commits } = fakeDeps(undefined, { readState: async () => ({ ...fresh, calls: 2 }) });
	const outcome = await runHouseDelivery(deps, target);
	assert.equal(outcome, "CALLS_SPENT");
	assert.equal(plans.length, 0);
	assert.deepEqual(commits, []);
});

test("a job that already submitted resubmits the same commit without a model call", async () => {
	const committed = "aabbccdd00112233445566778899aabbccddeeff" as CommitSha;
	const { deps, plans, commits, states } = fakeDeps(undefined, {
		readState: async () => ({ ...fresh, calls: 1, submittedCommit: committed }),
	});
	const outcome = await runHouseDelivery(deps, target);
	assert.equal(outcome, "RESUBMITTED");
	assert.equal(plans.length, 0, "no model call on the re-submit path");
	assert.deepEqual(commits, [`${target.id}:${committed}`]);
	assert.equal(states.get(target.id)?.submitAttempts, 1);
});

test("a checkout the run left clean produces no submission", async () => {
	const { deps, commits } = fakeDeps(undefined, { work: {
		prepare: async () => ({ workDir: "/tmp/house-work" }), finalize: async () => null, remove: () => {},
	} });
	const outcome = await runHouseDelivery(deps, target);
	assert.equal(outcome, "NO_SUBMISSION");
	assert.deepEqual(commits, []);
});

test("the command runner mode makes zero model calls and still submits through the same edge", async () => {
	const { deps, plans, commits } = fakeDeps(undefined, { mode: { runner: "command", commandPath: "/srv/house/fix.sh" } });
	const outcome = await runHouseDelivery(deps, target);
	assert.equal(outcome, "SUBMITTED");
	assert.equal(plans.length, 1);
	assert.equal(plans.filter(plan => plan.runner === "model").length, 0, "zero model calls");
	assert.deepEqual(plans[0], { runner: "command", jobId: target.id, workDir: "/tmp/house-work", commandPath: "/srv/house/fix.sh" });
	assert.deepEqual(commits, [`${target.id}:5f5b7c0a9c0e1d2b3a4f5e6d7c8b9a0f1e2d3c4b`]);
});

test("the model run classification reads the claude result line the M3 run printed", () => {
	const ok = `{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success","is_error":false,"result":"done"}\n`;
	assert.deepEqual(classifyModelRun(0, ok), { ok: true });
	assert.deepEqual(classifyModelRun(null, ok), { ok: true }, "a stream that ends with a success result is a run");
	const throttled = `{"type":"result","subtype":"error_error","is_error":true,"api_error_status":429,"result":"rate limited"}\n`;
	assert.equal(classifyModelRun(0, throttled).ok, false, "a 429 result is a provider error even on exit 0");
	assert.equal(classifyModelRun(1, throttled).ok, false);
	const throttledOutcome = classifyModelRun(1, throttled);
	assert.equal(throttledOutcome.ok, false);
	assert.match(throttledOutcome.ok === false ? throttledOutcome.detail : "", /429/);
	const upstream = `{"type":"result","subtype":"error_max_retries","is_error":true,"api_error_status":503}\n`;
	assert.equal(classifyModelRun(1, upstream).ok, false);
	assert.equal((classifyModelRun(1, upstream) as { reason: string }).reason, "PROVIDER_ERROR", "a 503 result is a provider error");
	const network = classifyModelRun(1, "connect ECONNRESET walked off the wire\n");
	assert.equal(network.ok, false);
	assert.match(network.ok === false ? network.detail : "", /exited 1/, "a network-shaped exit retries once");
	assert.deepEqual(classifyModelRun(0, "the agent printed nothing parseable\n"), { ok: true }, "exit 0 with no result line defers to the commit step");
});

test("the delivery facts pick exactly the held House jobs with no charged attempt", () => {
	const deliverable: HouseDeliverableFacts = { status: "IN_PROGRESS", attemptsPhase: "READY", attemptsUsed: 0,
		lockedToOperator: HOUSE_OPERATOR_ID, frozenAt: target.frozenAt };
	assert.equal(isDeliverableHouseJob(deliverable), true);
	assert.equal(isDeliverableHouseJob({ ...deliverable, status: "OPEN" }), false, "an unfunded job delivers nothing");
	assert.equal(isDeliverableHouseJob({ ...deliverable, attemptsPhase: "VERIFYING" }), false, "a run already in flight is left alone");
	assert.equal(isDeliverableHouseJob({ ...deliverable, attemptsUsed: 1 }), false, "a charged attempt ends the deliveries");
	assert.equal(isDeliverableHouseJob({ ...deliverable, lockedToOperator: "devon-ops" }), false, "the House delivers only its own jobs");
	assert.equal(isDeliverableHouseJob({ ...deliverable, frozenAt: null }), false, "no frozen commit, no run");
});

test("the delivery state round-trips through a file and a fresh job starts at zero", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-house-state-"));
	try {
		const store = stateStore(dir);
		assert.deepEqual(await store.readState(target.id), fresh);
		await store.writeState(target.id, { calls: 2, submittedCommit: "aabb" as CommitSha, submitAttempts: 1, prepareFailures: 3 });
		assert.deepEqual(await store.readState(target.id), { calls: 2, submittedCommit: "aabb", submitAttempts: 1, prepareFailures: 3 });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
