// The print demo's run store and its reply, driven with a stand-in run so no judge runs here. The real run is
// exercised by print-demo-route.test.ts through the production handler.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrintDemoRun, RunInput } from "../../../packages/verifier-print/src/run.ts";
import { createPrintRuns, printRunReply, PRINT_RUN_DEADLINE_MS, PRINT_STARTS_PER_HOUR } from "../src/print-demo.ts";
import type { PrintRunRecord, PrintRuns } from "../src/print-demo.ts";

type Gate = { readonly promise: Promise<PrintDemoRun>; readonly resolve: () => void; readonly reject: (error: Error) => void };

function gate(): Gate {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<PrintDemoRun>((done, fail) => { resolve = () => done({} as PrintDemoRun); reject = fail; });
	promise.catch(() => {});
	return { promise, resolve, reject };
}

/** A store whose runs wait on gates the test opens, with a clock the test moves. */
function rig(options: { deadlineMs?: number } = {}) {
	let clock = Date.parse("2026-10-23T09:00:00Z");
	const gates: Gate[] = [];
	const runs: PrintRuns = createPrintRuns({
		run: (_input: RunInput) => {
			const next = gate();
			gates.push(next);
			return next.promise;
		},
		now: () => clock,
		seed: () => new Uint8Array(32).fill(1),
		deadlineMs: options.deadlineMs,
	});
	return { runs, gates, tick: (ms: number) => { clock += ms; }, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

function started(runs: PrintRuns, requester: string, farm: "honest" | "sloppy") {
	const outcome = runs.start(requester, farm);
	assert.equal(outcome.kind, "STARTED", outcome.kind === "REFUSED" ? outcome.code : "");
	return outcome.record;
}

test("a start is RUNNING at once, then DONE with its result, and only its own visitor reads it", async () => {
	const { runs, gates, settle } = rig();
	const record = started(runs, "visitor-a", "honest");
	assert.equal(record.state, "RUNNING");
	assert.equal(record.result, null);
	gates[0].resolve();
	await settle();
	const done = runs.get(record.id) as PrintRunRecord;
	assert.equal(done.state, "DONE");
	assert.ok(done.result);
	assert.deepEqual(printRunReply(runs, "visitor-b", "GET", `/${record.id}`, undefined), { status: 404, body: { error: "NOT_FOUND" } });
	assert.equal(printRunReply(runs, "visitor-a", "GET", `/${record.id}`, undefined).status, 200);
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

test("a visitor may start twelve runs in a rolling hour, and the thirteenth waits for the hour to pass", async () => {
	const { runs, gates, tick, settle } = rig();
	for (let i = 0; i < PRINT_STARTS_PER_HOUR; i++) {
		started(runs, "visitor-a", "honest");
		gates[i].resolve();
		await settle();
		tick(60_000);
	}
	assert.deepEqual(printRunReply(runs, "visitor-a", "POST", "", { farm: "honest" }), { status: 429, body: { error: "PRINT_RATE_LIMITED" } });
	tick(60 * 60_000);
	assert.equal(printRunReply(runs, "visitor-a", "POST", "", { farm: "honest" }).status, 201);
});

test("a run past its deadline is FAILED as timed out, and its slot stays taken until its work settles", async () => {
	const { runs, gates, settle } = rig({ deadlineMs: 20 });
	const slow = started(runs, "visitor-a", "honest");
	started(runs, "visitor-b", "honest");
	await new Promise(resolve => setTimeout(resolve, 60));
	await settle();
	const failed = runs.get(slow.id) as PrintRunRecord;
	assert.equal(failed.state, "FAILED");
	assert.equal(failed.failure, "TIMED_OUT");
	assert.deepEqual(printRunReply(runs, "visitor-c", "POST", "", { farm: "honest" }), { status: 503, body: { error: "PRINT_BUSY" } });
	// The timed-out run's work is still going, and visitor-b's too, so both slots are taken.
	gates[0].resolve();
	await settle();
	// Its work has now settled, so its slot is free: visitor-c takes it, and the deployment is full again.
	assert.equal(printRunReply(runs, "visitor-c", "POST", "", { farm: "honest" }).status, 201);
	assert.equal(printRunReply(runs, "visitor-d", "POST", "", { farm: "honest" }).status, 503);
	assert.equal((runs.get(slow.id) as PrintRunRecord).state, "FAILED", "a timed-out run stays FAILED when its work settles");
	gates[1].resolve();
	gates[2].resolve();
	await settle();
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
