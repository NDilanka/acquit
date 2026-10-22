// The print demo's run store and its reply, driven with a stand-in job so no judge runs here. The real worker is
// exercised by print-demo-worker.test.ts, and the production handler by print-demo-route.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrintDemoRun, RunInput } from "../../../packages/verifier-print/src/run.ts";
import { createPrintRuns, printRunReply, PRINT_RUN_DEADLINE_MS, PRINT_STARTS_PER_HOUR } from "../src/print-demo.ts";
import type { PrintJob, PrintRunRecord, PrintRuns } from "../src/print-demo.ts";

/** A stand-in job the test settles by hand: `finish` or `fail` ends its work, `exit` stops its thread. */
type Fake = {
	readonly job: PrintJob;
	readonly finish: () => void;
	readonly fail: () => void;
	readonly exit: () => void;
	readonly state: { terminated: boolean };
};

function fake(): Fake {
	const state = { terminated: false };
	let finish!: () => void;
	let fail!: () => void;
	let exit!: () => void;
	const result = new Promise<PrintDemoRun>((done, reject) => {
		finish = () => done({} as PrintDemoRun);
		fail = () => reject(new Error("the worker failed"));
	});
	result.catch(() => {});
	const stopped = new Promise<void>(resolve => { exit = resolve; });
	return { job: { result, stopped, terminate: () => { state.terminated = true; } }, finish, fail, exit, state };
}

/** A store whose jobs the test settles, with a clock the test moves. */
function rig(options: { deadlineMs?: number } = {}) {
	let clock = Date.parse("2026-10-23T09:00:00Z");
	const jobs: Fake[] = [];
	const runs: PrintRuns = createPrintRuns({
		run: (_input: RunInput) => {
			const next = fake();
			jobs.push(next);
			return next.job;
		},
		now: () => clock,
		seed: () => new Uint8Array(32).fill(1),
		deadlineMs: options.deadlineMs,
	});
	return { runs, jobs, tick: (ms: number) => { clock += ms; }, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

function started(runs: PrintRuns, requester: string, farm: "honest" | "sloppy") {
	const outcome = runs.start(requester, farm);
	assert.equal(outcome.kind, "STARTED", outcome.kind === "REFUSED" ? outcome.code : "");
	return outcome.record;
}

test("a start is RUNNING at once, then DONE with its result, and only its own visitor reads it", async () => {
	const { runs, jobs, settle } = rig();
	const record = started(runs, "visitor-a", "honest");
	assert.equal(record.state, "RUNNING");
	assert.equal(record.result, null);
	jobs[0].finish();
	await settle();
	const done = runs.get(record.id) as PrintRunRecord;
	assert.equal(done.state, "DONE");
	assert.ok(done.result);
	assert.deepEqual(printRunReply(runs, "visitor-b", "GET", `/${record.id}`, undefined), { status: 404, body: { error: "NOT_FOUND" } });
	assert.equal(printRunReply(runs, "visitor-a", "GET", `/${record.id}`, undefined).status, 200);
	jobs[0].exit();
	await settle();
});

test("one visitor has one run in flight at a time", () => {
	const { runs } = rig();
	started(runs, "visitor-a", "honest");
	assert.deepEqual(runs.start("visitor-a", "honest"), { kind: "REFUSED", code: "PRINT_RUNNING_LIMIT" });
	assert.deepEqual(printRunReply(runs, "visitor-a", "POST", "", { farm: "honest" }), { status: 429, body: { error: "PRINT_RUNNING_LIMIT" } });
});

test("two runs in flight across the deployment, and a third is refused as busy", () => {
	const { runs } = rig();
	started(runs, "visitor-a", "honest");
	started(runs, "visitor-b", "honest");
	assert.deepEqual(printRunReply(runs, "visitor-c", "POST", "", { farm: "honest" }), { status: 503, body: { error: "PRINT_BUSY" } });
});

test("a slot is taken until the run's thread has stopped, not merely until its result arrives", async () => {
	const { runs, jobs, settle } = rig();
	started(runs, "visitor-a", "honest");
	jobs[0].finish();
	await settle();
	assert.deepEqual(runs.start("visitor-a", "honest"), { kind: "REFUSED", code: "PRINT_RUNNING_LIMIT" });
	jobs[0].exit();
	await settle();
	assert.equal(printRunReply(runs, "visitor-a", "POST", "", { farm: "honest" }).status, 201);
});

test("a visitor may start twelve runs in a rolling hour, and the thirteenth waits for the hour to pass", async () => {
	const { runs, jobs, tick, settle } = rig();
	for (let i = 0; i < PRINT_STARTS_PER_HOUR; i++) {
		started(runs, "visitor-a", "honest");
		jobs[i].finish();
		jobs[i].exit();
		await settle();
		tick(60_000);
	}
	assert.deepEqual(printRunReply(runs, "visitor-a", "POST", "", { farm: "honest" }), { status: 429, body: { error: "PRINT_RATE_LIMITED" } });
	tick(60 * 60_000);
	assert.equal(printRunReply(runs, "visitor-a", "POST", "", { farm: "honest" }).status, 201);
});

test("a run past its deadline is FAILED as timed out and its thread is terminated, and its slot stays taken until the thread stops", async () => {
	const { runs, jobs, settle } = rig({ deadlineMs: 40 });
	const slow = started(runs, "visitor-a", "honest");
	await new Promise(resolve => setTimeout(resolve, 120));
	await settle();
	const failed = runs.get(slow.id) as PrintRunRecord;
	assert.equal(failed.state, "FAILED");
	assert.equal(failed.failure, "TIMED_OUT");
	assert.equal(jobs[0].state.terminated, true, "the deadline stops the thread");
	started(runs, "visitor-b", "honest");
	// The timed-out thread has not stopped and visitor-b's has not either, so both slots are still taken.
	assert.deepEqual(printRunReply(runs, "visitor-c", "POST", "", { farm: "honest" }), { status: 503, body: { error: "PRINT_BUSY" } });
	jobs[0].exit();
	await settle();
	// The timed-out thread has stopped, so its slot is free: visitor-c takes it and the deployment is full again.
	assert.equal(printRunReply(runs, "visitor-c", "POST", "", { farm: "honest" }).status, 201);
	assert.equal(printRunReply(runs, "visitor-d", "POST", "", { farm: "honest" }).status, 503);
	const still = runs.get(slow.id) as PrintRunRecord;
	assert.equal(still.state, "FAILED", "a timed-out run stays FAILED when its thread stops");
	assert.equal(still.result, null, "a timed-out run never gains a result");
	jobs[1].exit();
	jobs[2].exit();
	await settle();
});

test("a run whose worker fails before it answers is FAILED as a run failure, and frees its slot once stopped", async () => {
	const { runs, jobs, settle } = rig();
	const record = started(runs, "visitor-a", "honest");
	jobs[0].fail();
	await settle();
	const failed = runs.get(record.id) as PrintRunRecord;
	assert.equal(failed.state, "FAILED");
	assert.equal(failed.failure, "RUN_FAILED");
	jobs[0].exit();
	await settle();
	assert.equal(printRunReply(runs, "visitor-a", "POST", "", { farm: "honest" }).status, 201);
});

test("a run that cannot start is FAILED and takes no slot", async () => {
	const runs = createPrintRuns({
		run: () => { throw new Error("no worker"); },
		now: () => Date.now(),
		seed: () => new Uint8Array(32).fill(1),
	});
	const first = runs.start("visitor-a", "honest");
	assert.equal(first.kind, "STARTED");
	if (first.kind !== "STARTED") return;
	assert.equal(runs.get(first.record.id)?.state, "FAILED");
	assert.equal(runs.get(first.record.id)?.failure, "RUN_FAILED");
	assert.equal(runs.start("visitor-a", "honest").kind, "STARTED", "a run that never started holds no slot");
});

test("the default deadline is two minutes", () => {
	assert.equal(PRINT_RUN_DEADLINE_MS, 120_000);
});

test("a body names one farm the run knows, and nothing else", () => {
	const { runs } = rig();
	assert.deepEqual(printRunReply(runs, "visitor-a", "POST", "", { farm: "fraud:made-up" }), { status: 404, body: { error: "UNKNOWN_FARM" } });
	assert.equal(printRunReply(runs, "visitor-a", "POST", "", { farm: 3 }).status, 400);
	assert.equal(printRunReply(runs, "visitor-a", "POST", "", { farm: "honest", extra: true }).status, 400);
	assert.equal(printRunReply(runs, "visitor-a", "POST", "", []).status, 400);
	assert.deepEqual(printRunReply(runs, "visitor-a", "GET", "/prt_nobody", undefined), { status: 404, body: { error: "NOT_FOUND" } });
	assert.deepEqual(printRunReply(runs, "visitor-a", "DELETE", "/prt_nobody", undefined), { status: 404, body: { error: "NOT_FOUND" } });
});
