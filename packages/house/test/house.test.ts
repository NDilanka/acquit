// The House's own facts: its bid-row line comes from receipt rows, and its seed never borrows
// another operator's payee. Everything here runs without Docker, a browser, or a model call.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { defaultInstruction } from "../../acquit-cli/src/run.ts";
import type { GitRun } from "../../acquit-cli/src/run.ts";
import type { CommitSha, JobId } from "../../core/src/ids.ts";
import { houseLine } from "../../core/src/job.ts";
import {
	classifyModelRun, droidRunPort, gitWorkPort, houseInstruction, HOUSE_INSTRUCTION_SUFFIX, houseMode, HOUSE_MODEL_OPENROUTER,
	HOUSE_OPERATOR_ID, houseRunPort, isDeliverableHouseJob, runHouseDelivery, stateStore,
	type HouseDeliverableFacts, type HouseDelivery, type HouseDeliveryDeps, type HouseDeliveryState,
	type HouseRunOutcome, type HouseRunPlan, type HouseTarget,
} from "../src/runner.ts";
import { DROID_INSTRUCTION_PATH } from "../../core/src/model.ts";

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

test("migrate applies to an existing database without data loss, and twice changes nothing", () => {
	const database = join(mkdtempSync(join(tmpdir(), "acquit-house-migrate-")), "acquit.db");
	try {
		// A database from before the receipts table: seed one, then drop exactly what the migration adds.
		const seeded = spawnSync(process.execPath, [ctl, "seed-db", "--yes"],
			{ encoding: "utf8", timeout: 120_000, env: { ...process.env, ACQUIT_DEV: "1", DATABASE_PATH: database, OPERATOR_HOUSE_MERCHANT_ID: "HOUSESEEDMERCHANT" } });
		assert.equal(seeded.status, 0, `the seed for the migration test must pass: ${seeded.stderr.slice(0, 300)}`);
		const before = new DatabaseSync(database);
		const jobsBefore = Number(before.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n);
		const operatorsBefore = Number(before.prepare("SELECT COUNT(*) AS n FROM operators").get()?.n);
		before.exec("DROP INDEX IF EXISTS receipts_operator");
		before.exec("DROP TABLE receipts");
		before.close();

		const env = { ...process.env, DATABASE_PATH: database };
		for (const run of [1, 2]) {
			const migrated = spawnSync(process.execPath, [ctl, "migrate"], { encoding: "utf8", timeout: 60_000, env });
			assert.equal(migrated.status, 0, `migrate run ${run} must pass: ${migrated.stderr.slice(0, 300)}`);
		}
		const after = new DatabaseSync(database, { readOnly: true });
		try {
			assert.equal(Number(after.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n), jobsBefore, "every job row survives");
			assert.equal(Number(after.prepare("SELECT COUNT(*) AS n FROM operators").get()?.n), operatorsBefore, "every operator row survives");
			// The table the dropped database lacked exists again; the PAID history it lost comes back
			// through the store's backfill, which the store suite covers with a real PAID row.
			const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'receipts'").all();
			assert.equal(tables.length, 1, "the receipts table exists again");
		} finally { after.close(); }
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
	id: "job_9e0f6b72-1111-4222-8333-444455556666" as JobId, title: "Totals round wrong for 3-decimal currencies",
	repository: "NDilanka/acquit-work-9e0f6b72", frozenAt: "0123456789abcdef0123456789abcdef01234567" as CommitSha, tenant: null,
};
const fresh: HouseDeliveryState = { calls: 0, submittedCommit: null, submitAttempts: 0, prepareFailures: 0 };

/** Injected delivery: the run port records plans, the work port mints one commit, the state is a map. */
function fakeDeps(run?: (plan: HouseRunPlan) => Promise<HouseRunOutcome>, overrides: Partial<HouseDeliveryDeps> = {}) {
	const plans: HouseRunPlan[] = [];
	const commits: string[] = [];
	const deliveries: (HouseDelivery | null)[] = [];
	const states = new Map<string, HouseDeliveryState>();
	const record = async (plan: HouseRunPlan): Promise<HouseRunOutcome> => {
		plans.push(plan);
		return run === undefined ? { ok: true } : run(plan);
	};
	const deps: HouseDeliveryDeps = {
		mode: houseMode({}),
		run: record,
		work: {
			prepare: async () => ({ workDir: "/tmp/house-work" }),
			finalize: async () => ({
				commit: "5f5b7c0a9c0e1d2b3a4f5e6d7c8b9a0f1e2d3c4b" as CommitSha,
				files: [{ path: "src/totals.ts", added: 4, binary: false }], patch: "diff --git a/src/totals.ts b/src/totals.ts\n",
			}),
			remove: () => {},
		},
		readState: async jobId => states.get(jobId) ?? fresh,
		writeState: async (jobId, state) => { states.set(jobId, state); },
		submit: async (job, commit, delivery) => {
			commits.push(`${job.id}:${commit}`);
			deliveries.push(delivery ?? null);
		},
		log: () => {},
		...overrides,
	};
	return { deps, plans, commits, deliveries, states };
}

test("the House runner pins the provider's model and the CLI default instruction plus the committed suffix", async () => {
	assert.equal(HOUSE_MODEL_OPENROUTER, "nvidia/nemotron-3-ultra-550b-a55b:free", "the nemotron :free id stays the openrouter path's model");
	// The committed suffix is byte-identical to the ruling file the mission names.
	assert.equal(HOUSE_INSTRUCTION_SUFFIX, readFileSync(suffixFile, "utf8").replace(/\n$/, ""));
	const expected = houseInstruction(defaultInstruction({ title: target.title }));
	const { deps, plans, deliveries } = fakeDeps();
	const outcome = await runHouseDelivery(deps, target);
	assert.equal(outcome, "SUBMITTED");
	assert.equal(plans.length, 1);
	assert.deepEqual(plans[0], {
		runner: "model", jobId: target.id, workDir: "/tmp/house-work", model: "glm-5.3-flash", instruction: expected,
	});
	// The delivery rides to the submit, so the job's timeline can show the run's own diff.
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0]?.commit, "5f5b7c0a9c0e1d2b3a4f5e6d7c8b9a0f1e2d3c4b");
	assert.equal(deliveries[0]?.files[0]?.path, "src/totals.ts");
	assert.match(deliveries[0]?.patch ?? "", /diff --git/);
});

test("with ACQUIT_MODEL_PROVIDER=openrouter the run plan carries the nemotron :free id", async () => {
	const { deps, plans } = fakeDeps(undefined, { mode: houseMode({ ACQUIT_MODEL_PROVIDER: "openrouter" }) });
	await runHouseDelivery(deps, target);
	const plan = plans[0];
	assert.equal(plan?.runner, "model");
	assert.equal(plan?.runner === "model" ? plan.model : undefined, HOUSE_MODEL_OPENROUTER);
	assert.match(plan?.runner === "model" ? plan.model : "", /:free$/, "the openrouter path stays on a :free id");
});

test("the House mode follows the provider switch: droid by default with glm-5.3-flash", () => {
	assert.deepEqual(houseMode({}), { runner: "model", provider: "droid", model: "glm-5.3-flash" });
	assert.deepEqual(houseMode({ ACQUIT_MODEL_PROVIDER: "droid" }), { runner: "model", provider: "droid", model: "glm-5.3-flash" });
	assert.deepEqual(houseMode({ ACQUIT_MODEL_PROVIDER: "openrouter" }),
		{ runner: "model", provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
});

test("the command runner stays the lane mode under either provider", () => {
	assert.deepEqual(houseMode({ ACQUIT_HOUSE_COMMAND: "/srv/house/fix.sh", ACQUIT_MODEL_PROVIDER: "droid" }),
		{ runner: "command", commandPath: "/srv/house/fix.sh" });
	assert.deepEqual(houseMode({ ACQUIT_HOUSE_COMMAND: "/srv/house/fix.sh", ACQUIT_MODEL_PROVIDER: "openrouter" }),
		{ runner: "command", commandPath: "/srv/house/fix.sh" });
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

// ---- the run ports -----------------------------------------------------------------------------

type FakeDockerCall = { readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv | undefined };

/** A DockerPort that records every call and can hand the runner a fixed stdout chunk back. */
function fakeDocker(runnerOutput?: string) {
	const calls: FakeDockerCall[] = [];
	return {
		calls,
		run: async (args: readonly string[], options: { env?: NodeJS.ProcessEnv; onOutput?: (chunk: string) => void } = {}) => {
			calls.push({ args, env: options.env });
			const isRunner = args[0] === "run" && !args.includes("--detach");
			if (isRunner && runnerOutput !== undefined) options.onOutput?.(runnerOutput);
			return 0;
		},
	};
}

const okDroidResult = `{"type":"result","subtype":"success","is_error":false,"duration_ms":3467,"num_turns":1,"result":"ok",`
	+ `"session_id":"4f8b1303-23d1-442b-a8cd-f655047ff977","usage":{"input_tokens":11029,"output_tokens":3,"factory_credits":663}}\n`;

test("the droid run port starts droid exec in the sandbox with the key in-process and Factory's hosts", async () => {
	const docker = fakeDocker(okDroidResult);
	const run = droidRunPort({
		docker, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		getKey: async () => "CANARY-FACTORY-KEY", env: {},
	});
	const outcome = await run({ runner: "model", jobId: target.id, workDir: "/tmp/house-work", model: "glm-5.3-flash", instruction: "Fix it." });
	assert.deepEqual(outcome, { ok: true, sessionId: "4f8b1303-23d1-442b-a8cd-f655047ff977", model: "glm-5.3-flash", factoryCredits: 663 });
	const runner = docker.calls.findIndex(call => call.args[0] === "run" && !call.args.includes("--detach"));
	assert.equal(runner >= 0, true);
	const argv = docker.calls[runner].args;
	assert.deepEqual(argv.slice(argv.indexOf("--exec")), ["--exec", "droid", "exec", "--auto", "medium",
		"-m", "glm-5.3-flash", "-o", "json", "--cwd", "/work", "-f", DROID_INSTRUCTION_PATH]);
	// The prompt rides the ACQUIT_INSTRUCTION env, which run.mjs writes to the file the argv names;
	// it never becomes a bare word of the exec command the way the claude argv carries it.
	assert.equal(argv.slice(argv.indexOf("--exec")).some(arg => arg.includes("Fix it.")), false);
	assert.equal(docker.calls[runner].env?.FACTORY_API_KEY, "CANARY-FACTORY-KEY");
	assert.equal(docker.calls[runner].args.some(arg => arg.includes("CANARY-FACTORY-KEY")), false);
	// The droid runner is not a claude runner: no claude-specific switch.
	assert.equal(argv.includes("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"), false);
	// The proxy was started with the hosts the droid provider needs, and only those.
	const proxy = docker.calls.findIndex(call => call.args[0] === "run" && call.args.includes("--detach"));
	assert.equal(docker.calls[proxy].args.includes("ACQUIT_PROVIDER_HOST=api.factory.ai,prem.factory.ai"), true);
});

test("the droid run port refuses a run without a usable Factory key, without starting a sandbox", async () => {
	const docker = fakeDocker();
	const run = droidRunPort({
		docker, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20", getKey: async () => null, env: {},
	});
	const outcome = await run({ runner: "model", jobId: target.id, workDir: "/tmp/house-work", model: "glm-5.3-flash", instruction: "Fix it." });
	assert.equal(outcome.ok, false);
	assert.equal((outcome as { reason: string }).reason, "RUN_FAILED", "a missing key is not the provider's error, so no retry burns");
	assert.equal(docker.calls.length, 0, "no container is started without a key");
});

test("houseRunPort picks the droid port by default and the openrouter port when selected", async () => {
	const droid = fakeDocker(okDroidResult);
	const runDroid = houseRunPort({
		docker: droid, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		env: { FACTORY_API_KEY: "CANARY-FACTORY-KEY" },
	});
	const droidOutcome = await runDroid({ runner: "model", jobId: target.id, workDir: "/tmp/house-work", model: "glm-5.3-flash", instruction: "Fix it." });
	assert.equal(droidOutcome.ok, true);
	assert.equal((droidOutcome as { sessionId?: string }).sessionId, "4f8b1303-23d1-442b-a8cd-f655047ff977");

	// The openrouter path keeps its injected transport: an injected key getter and a recording
	// DockerPort, no keyring read and no socket to openrouter.ai anywhere in this suite.
	const openrouter = fakeDocker();
	const runOpenrouter = houseRunPort({
		docker: openrouter, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
		env: { ACQUIT_MODEL_PROVIDER: "openrouter" }, openrouterKey: async () => "or-CANARY",
	});
	const openrouterOutcome = await runOpenrouter({ runner: "model", jobId: target.id, workDir: "/tmp/house-work", model: HOUSE_MODEL_OPENROUTER, instruction: "Fix it." });
	assert.equal(openrouterOutcome.ok, true);
	const proxy = openrouter.calls.findIndex(call => call.args[0] === "run" && call.args.includes("--detach"));
	assert.equal(openrouter.calls[proxy].args.includes("ACQUIT_PROVIDER_HOST=openrouter.ai"), true);
	const runner = openrouter.calls.findIndex(call => call.args[0] === "run" && !call.args.includes("--detach"));
	assert.equal(openrouter.calls[runner].args.includes(`ANTHROPIC_MODEL=${HOUSE_MODEL_OPENROUTER}`), true, "the run pins the plan's model id");
	assert.equal(openrouter.calls[runner].env?.ANTHROPIC_AUTH_TOKEN, "or-CANARY");
	assert.equal(openrouter.calls[runner].env?.FACTORY_API_KEY, undefined, "the droid key never rides the openrouter path");
	assert.equal(openrouter.calls.flatMap(call => call.args).some(arg => arg.includes("or-CANARY")), false);
});

test("a command plan runs the command sandbox under either provider, with no key and no droid argv", async () => {
	for (const provider of ["droid", "openrouter"]) {
		const docker = fakeDocker();
		const run = houseRunPort({
			docker, image: "acquit/runner-node20", proxyImage: "acquit/runner-node20",
			env: { ACQUIT_MODEL_PROVIDER: provider, FACTORY_API_KEY: "CANARY-FACTORY-KEY" },
			droidKey: async () => "CANARY-FACTORY-KEY", openrouterKey: async () => "or-CANARY",
		});
		const outcome = await run({ runner: "command", jobId: target.id, workDir: "/tmp/house-work", commandPath: "/srv/house/fix.sh" });
		assert.deepEqual(outcome, { ok: true });
		const runner = docker.calls.findIndex(call => call.args[0] === "run" && !call.args.includes("--detach"));
		const argv = docker.calls[runner].args;
		assert.deepEqual(argv.slice(argv.indexOf("--exec")), ["--exec", "/bin/sh", "/acquit/command.sh"]);
		assert.equal(argv.includes("FACTORY_API_KEY"), false, `${provider}: the command runner names no key variable`);
		assert.equal(docker.calls.flatMap(call => call.args).some(arg => arg.includes("CANARY-FACTORY-KEY")), false);
	}
});

test("a successful run records its session, model, and Factory credits in the run log", async () => {
	const lines: string[] = [];
	const { deps } = fakeDeps(async () => ({ ok: true, sessionId: "s-9", model: "glm-5.3-flash", factoryCredits: 12 }), { log: line => lines.push(line) });
	await runHouseDelivery(deps, target);
	const logged = lines.join("\n");
	assert.match(logged, /session s-9/);
	assert.match(logged, /model glm-5.3-flash/);
	assert.match(logged, /credits 12/);
});

test("a failed run records no session line, only the failure the series already logs", async () => {
	const lines: string[] = [];
	const { deps } = fakeDeps(async () => ({ ok: false, reason: "PROVIDER_ERROR", detail: "403 status code (no body)" }), { log: line => lines.push(line) });
	await runHouseDelivery(deps, target);
	assert.match(lines.join("\n"), /PROVIDER_ERROR/);
	assert.doesNotMatch(lines.join("\n"), /session /);
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

test("the state store accepts the job_-prefixed ids the id parser mints", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-house-state-"));
	try {
		const store = stateStore(dir);
		const realId = "job_8c7501ff-c2ff-4559-b4b7-b2cd470991cf" as JobId;
		assert.deepEqual(await store.readState(realId), fresh);
		await store.writeState(realId, { calls: 1, submittedCommit: "ccdd" as CommitSha, submitAttempts: 0, prepareFailures: 0 });
		assert.deepEqual(await store.readState(realId), { calls: 1, submittedCommit: "ccdd", submitAttempts: 0, prepareFailures: 0 });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the work port keeps the askpass secret alive from prepare through the push", async () => {
	// The push is the only reader of the askpass script, and it runs in finalize, long after prepare
	// returned: the secret directory may not be removed until the series is done.
	const root = mkdtempSync(join(tmpdir(), "acquit-house-work-"));
	try {
		const frozen = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
		let askpassAtPush: string | null = null;
		let askpassExistedAtPush = false;
		const git: GitRun = (args, env) => {
			// Every call arrives with the location and guard args prepended, so the branches match
			// anywhere in the argv.
			if (args.includes("push")) {
				askpassAtPush = env?.GIT_ASKPASS ?? null;
				// The script's own lifetime is the fact under test: read it at the push, not after.
				askpassExistedAtPush = askpassAtPush !== null && existsSync(askpassAtPush);
			}
			if (args.includes("clone")) {
				// The real clone creates both locations and the work tree's `gitdir:` link; prepare
				// chmods the git directory and rewrites that link right after.
				const gitDir = args[args.indexOf("--separate-git-dir") + 1];
				const workTree = args.at(-1) as string;
				mkdirSync(gitDir, { recursive: true, mode: 0o700 });
				mkdirSync(workTree, { recursive: true, mode: 0o700 });
				writeFileSync(join(workTree, ".git"), `gitdir: ${gitDir}\n`, { mode: 0o644 });
				return { status: 0, stdout: "", stderr: "" };
			}
			if (args.includes("rev-parse")) return { status: 0, stdout: `${frozen}\n`, stderr: "" };
			if (args.includes("--porcelain")) return { status: 0, stdout: " M src/money.ts\n", stderr: "" };
			if (args.includes("--numstat")) return { status: 0, stdout: "2\t1\0src/money.ts\0", stderr: "" };
			return { status: 0, stdout: "", stderr: "" };
		};
		const port = gitWorkPort({
			stateRoot: join(root, "state"), workRoot: join(root, "work"),
			mint: async () => ({ repository: "acquit-forks/invoice-app-x", token: "GHT-TEST-TOKEN" }),
			git, env: { ...process.env },
		});
		const target: HouseTarget = { id: "job_7Q2K" as JobId, title: "Totals", repository: "maya-client/invoice-app", frozenAt: frozen, tenant: null };
		const prepared = await port.prepare(target);
		assert.equal(typeof prepared.workDir, "string");
		const delivery = await port.finalize(target, prepared.workDir);
		assert(delivery !== null, "the stubbed checkout is dirty, so the series has a submission");
		assert(askpassAtPush !== null, "the push carries the askpass");
		assert.equal(askpassExistedAtPush, true, "the askpass script still exists when the push runs");
		assert.equal(existsSync(String(askpassAtPush)), false, "finalize swept the secret once the push was done");
		port.remove(target.id);
		assert.equal(existsSync(String(askpassAtPush)), false, "remove sweeps the askpass secret");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
