// The print demo with its real worker: a run's work runs in its own thread, so the API's event loop keeps serving
// while a run is in flight, and a run past its deadline has its thread stopped. These tests run the real judge, so
// each honest run takes a few seconds. The stand-in store is in print-demo.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrintRuns, startPrintWorker } from "../src/print-demo.ts";
import type { PrintJob, PrintRunRecord, PrintRuns } from "../src/print-demo.ts";

/** A store that starts real workers, and keeps each job so a test can wait for its thread to stop. */
function realRuns(deadlineMs?: number): { readonly runs: PrintRuns; readonly jobs: PrintJob[] } {
	const jobs: PrintJob[] = [];
	const runs = createPrintRuns({
		run: input => {
			const job = startPrintWorker(input);
			jobs.push(job);
			return job;
		},
		now: () => Date.now(),
		seed: () => new Uint8Array(32).fill(9),
		deadlineMs,
	});
	return { runs, jobs };
}

test("a real run's work leaves the event loop free: a timer fires on schedule while the run is in flight", async t => {
	const { runs, jobs } = realRuns();
	const outcome = runs.start("visitor-a", "honest");
	assert.equal(outcome.kind, "STARTED");
	if (outcome.kind !== "STARTED") return;
	const id = outcome.record.id;
	let inFlightTicks = 0;
	let worstLateMs = 0;
	let last = performance.now();
	await new Promise<void>(resolve => {
		const interval = setInterval(() => {
			const now = performance.now();
			worstLateMs = Math.max(worstLateMs, now - last - 50);
			last = now;
			if (runs.get(id)?.state !== "RUNNING") {
				clearInterval(interval);
				resolve();
				return;
			}
			inFlightTicks += 1;
		}, 50);
	});
	const done = runs.get(id) as PrintRunRecord;
	assert.equal(done.state, "DONE", done.failure ?? "");
	assert.equal(done.result?.print?.verdict, "VERIFIED");
	assert.ok(done.result?.certificate, "a qualified farm carries its certificate");
	t.diagnostic(`in-flight timer ticks ${inFlightTicks}, worst lateness ${Math.round(worstLateMs)} ms`);
	assert.ok(inFlightTicks >= 10, `the timer ticked ${inFlightTicks} times while the run was in flight`);
	assert.ok(worstLateMs < 500, `the timer was late by ${Math.round(worstLateMs)} ms, so the event loop was held`);
	await jobs[0].stopped;
	assert.equal(runs.start("visitor-a", "honest").kind, "STARTED", "the finished run's thread has stopped, so its slot is free");
});

test("a real run past its deadline is FAILED as timed out, its thread stops, and its slot frees", async () => {
	const { runs, jobs } = realRuns(1);
	const outcome = runs.start("visitor-a", "honest");
	assert.equal(outcome.kind, "STARTED");
	if (outcome.kind !== "STARTED") return;
	const begun = performance.now();
	await jobs[0].stopped;
	// An honest run takes seconds, so a thread that ran on to its end would stop far later than this.
	const stoppedMs = performance.now() - begun;
	assert.ok(stoppedMs < 1500, `the thread stopped ${Math.round(stoppedMs)} ms after the deadline, so it was not terminated`);
	const failed = runs.get(outcome.record.id) as PrintRunRecord;
	assert.equal(failed.state, "FAILED");
	assert.equal(failed.failure, "TIMED_OUT");
	assert.equal(failed.result, null, "a stopped thread never answers the run");
	const again = runs.start("visitor-a", "honest");
	assert.equal(again.kind, "STARTED", "the stopped thread's slot is free for the same visitor");
	await jobs[1].stopped;
});
