import assert from "node:assert/strict";
import { test } from "node:test";
import { runPids } from "../src/process.ts";

const runOf = (pids: Record<string, number>) => Object.fromEntries(Object.entries(pids).map(([role, pid]) => [role, { pid }]));

test("a launch that recorded api, web, and verifier matches the run's three pids", () => {
	const pids = { api: 11, web: 12, verifier: 13 };
	assert.deepEqual(runPids(runOf(pids), pids), pids);
});

test("a changed verifier pid refuses ownership", () => {
	const pids = { api: 11, web: 12, verifier: 13 };
	assert.throws(() => assert.deepEqual(runPids(runOf({ api: 11, web: 12, verifier: 99 }), pids), pids));
});

test("a launch that recorded only api and web ignores a verifier the run added", () => {
	const pids = { api: 11, web: 12 };
	assert.deepEqual(runPids(runOf({ api: 11, web: 12, verifier: 13 }), pids), pids);
});
