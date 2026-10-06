import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

type ProbeSide = { label: string; lane: number; api: number; web: number; databasePath: string };
type StartedData = { alreadyRunning: boolean; urls: { api: string; web: string }; databasePath: string };
type StopResult = { code: number; open?: number[] };
const { admitStartedSide, probeSide, withProbeCleanup } = await import(new URL("../../../scripts/perf/ledger-sides.mjs", import.meta.url).href) as {
	admitStartedSide: (side: ProbeSide, stdout: string) => StartedData;
	probeSide: (label: "trunk" | "head", root: string) => ProbeSide;
	withProbeCleanup: (measure: () => Promise<unknown>, sides: ProbeSide[], stopSide: (side: ProbeSide) => Promise<StopResult>) => Promise<unknown>;
};

const root = resolve("probe-worktree");
const envelope = (data: unknown) => JSON.stringify({ ok: true, command: "start", data });
const freshReport = (side: ProbeSide) => envelope({ alreadyRunning: false,
	urls: { api: `http://localhost:${side.api}`, web: `http://localhost:${side.web}` }, databasePath: side.databasePath });

test("the ledger probe refuses an app that was already running instead of tracking it for cleanup", async () => {
	const side = probeSide("head", root);
	const tracked: ProbeSide[] = [];
	const stopped: string[] = [];
	await assert.rejects(withProbeCleanup(async () => {
		admitStartedSide(side, envelope({ alreadyRunning: true,
			urls: { api: `http://localhost:${side.api}`, web: `http://localhost:${side.web}` }, databasePath: side.databasePath }));
		tracked.push(side);
	}, tracked, async current => { stopped.push(current.label); return { code: 0 }; }), /already running/);
	assert.deepEqual([tracked.length, stopped], [0, []]);
});
test("the ledger probe admits a fresh lane-owned start and cleanup stops exactly that side", async () => {
	const side = probeSide("head", root);
	const tracked: ProbeSide[] = [];
	const stopped: string[] = [];
	await withProbeCleanup(async () => {
		assert.equal(admitStartedSide(side, freshReport(side)).alreadyRunning, false);
		tracked.push(side);
	}, tracked, async current => { stopped.push(current.label); return { code: 0 }; });
	assert.deepEqual(stopped, ["head"]);
});
test("the ledger probe refuses a start report that does not use its own ports or database", async () => {
	const side = probeSide("head", root);
	assert.throws(() => admitStartedSide(side, envelope({ alreadyRunning: false,
		urls: { api: "http://localhost:4310", web: "http://localhost:5173" }, databasePath: side.databasePath })), /ports/);
	assert.throws(() => admitStartedSide(side, envelope({ alreadyRunning: false,
		urls: { api: `http://localhost:${side.api}`, web: `http://localhost:${side.web}` }, databasePath: resolve("other", "acquit.db") })), /database/);
	assert.equal(admitStartedSide(side, freshReport(side)).databasePath, side.databasePath);
});
test("cleanup stops every side and a failed stop never masks the measurement error", async () => {
	const sides = [probeSide("trunk", root), probeSide("head", root)];
	const stopped: string[] = [];
	const stopSide = async (side: ProbeSide) => { stopped.push(side.label); return { code: side.label === "trunk" ? 1 : 0, open: [] }; };
	await assert.rejects(withProbeCleanup(async () => { throw new Error("measurement failed"); }, sides, stopSide), /measurement failed/);
	assert.deepEqual(stopped, ["trunk", "head"]);
	stopped.length = 0;
	await assert.rejects(withProbeCleanup(async () => "measured", sides, stopSide), /cleanup failed: trunk stop exited 1/);
	assert.deepEqual(stopped, ["trunk", "head"]);
	await assert.rejects(withProbeCleanup(async () => "measured", [sides[0]], async () => ({ code: 0, open: [sides[0].api] })), /ports still open/);
});
