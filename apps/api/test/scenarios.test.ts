// The scenario routes' server side, driven with the core's in-process harness: the scripted verifier, the
// fake PayPal, and the fake GitHub app. POST starts a run and GET polls it, and the visibility, dev gating,
// and fixture rules are the route's own. No network, no child process, no GitHub or PayPal call.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertTimings, harness } from "../../../packages/core/test/scenario-harness.ts";
import type { Harness } from "../../../packages/core/test/scenario-harness.ts";
import type { CommitSha, JobId } from "../../../packages/core/src/ids.ts";
import { startScenario } from "../../../packages/core/src/scenarios.ts";
import type { ScenarioRun } from "../../../packages/core/src/scenarios.ts";
import { newVisitorId } from "../../../packages/core/src/visitors.ts";
import type { VisitorRow } from "../../../packages/core/src/visitors.ts";
import type { HouseWorkPort } from "../../../packages/house/src/runner.ts";
import { scenarioReply, scriptedWorkspace } from "../src/scenarios.ts";
import type { ScenarioRouting } from "../src/scenarios.ts";

function routingOf(h: Harness): ScenarioRouting {
	return { runs: h.deps.runs, depsFor: () => h.deps };
}

/** GET one run through the route until it stops running. */
async function settle(routing: ScenarioRouting, visitor: VisitorRow, id: string): Promise<ScenarioRun> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const reply = await scenarioReply(routing, visitor, "GET", id);
		assert.equal(reply.status, 200);
		const run = reply.body as ScenarioRun;
		if (run.state !== "RUNNING") return run;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`run ${id} did not stop`);
}

test("an unknown scenario name is refused as UNKNOWN_SCENARIO", async () => {
	const h = await harness();
	try {
		assert.deepEqual(await scenarioReply(routingOf(h), h.visitor, "POST", "submit-everything"), { status: 404, body: { error: "UNKNOWN_SCENARIO" } });
	} finally { await h.dispose(); }
});

test("POST starts verified-and-paid and GET polls the run to DONE, PAID on CLIENT_APPROVAL", async () => {
	const h = await harness();
	try {
		const routing = routingOf(h);
		const posted = await scenarioReply(routing, h.visitor, "POST", "verified-and-paid");
		assert.equal(posted.status, 201);
		const { scenarioId, jobId } = posted.body as { scenarioId: string; jobId: string };
		assert.match(scenarioId, /^scn_/);
		assert.match(jobId, /^job_/);
		const run = await settle(routing, h.visitor, scenarioId);
		assert.equal(run.state, "DONE");
		assert.equal(run.jobId, jobId);
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-honest-reference-table", "submit", "approve"]);
		assert.deepEqual(run.endState, { jobStatus: "PAID", reason: "CLIENT_APPROVAL" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("POST starts deadline-refund and GET polls the run to DONE, REFUNDED on DELIVERY_DEADLINE", async () => {
	const h = await harness();
	try {
		const routing = routingOf(h);
		const posted = await scenarioReply(routing, h.visitor, "POST", "deadline-refund");
		assert.equal(posted.status, 201);
		const { scenarioId } = posted.body as { scenarioId: string };
		const run = await settle(routing, h.visitor, scenarioId);
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.endState, { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" });
		assert.equal(run.steps.find(step => step.name === "advance-clock")?.label, "Simulated time for this job");
	} finally { await h.dispose(); }
});

test("another visitor's run is refused as NOT_FOUND, the same answer an unknown run id gets", async () => {
	const h = await harness();
	try {
		const routing = routingOf(h);
		const posted = await scenarioReply(routing, h.visitor, "POST", "deadline-refund");
		const { scenarioId } = posted.body as { scenarioId: string };
		await settle(routing, h.visitor, scenarioId);
		const stranger: VisitorRow = { ...h.visitor, id: newVisitorId() };
		assert.deepEqual(await scenarioReply(routing, stranger, "GET", scenarioId), { status: 404, body: { error: "NOT_FOUND" } });
		assert.deepEqual(await scenarioReply(routing, stranger, "GET", "scn_nobody-holds-this"), { status: 404, body: { error: "NOT_FOUND" } });
		assert.equal((await scenarioReply(routing, h.visitor, "GET", scenarioId)).status, 200);
	} finally { await h.dispose(); }
});

test("dispute-arbiter is refused as DEV_DISABLED when development is off", async () => {
	const h = await harness();
	try {
		const routing: ScenarioRouting = { runs: h.deps.runs, depsFor: () => ({ ...h.deps, devEnabled: false }) };
		assert.deepEqual(await scenarioReply(routing, h.visitor, "POST", "dispute-arbiter"),
			{ status: 403, body: { error: "DEV_DISABLED", detail: "Set ACQUIT_DEV=1 when starting the API." } });
	} finally { await h.dispose(); }
});

test("a visitor whose deployment has no fixture is answered NO_FIXTURE and starts nothing", async () => {
	const h = await harness();
	try {
		const routing: ScenarioRouting = { runs: h.deps.runs, depsFor: () => null };
		assert.deepEqual(await scenarioReply(routing, h.visitor, "POST", "verified-and-paid"),
			{ status: 503, body: { error: "NO_FIXTURE", detail: "The deployment has no fixture for this visitor." } });
	} finally { await h.dispose(); }
});

test("the scripted push writes the score card tree the scenario names, over the score card base", async () => {
	const h = await harness();
	const root = await mkdtemp(join(tmpdir(), "acquit-scripted-"));
	try {
		const started = await startScenario(h.deps, "deadline-refund", h.visitor);
		await started.finished;
		const jobId = started.run.jobId as JobId;
		const workDir = join(root, "work");
		const work: HouseWorkPort = {
			prepare: async () => ({ workDir }),
			finalize: async () => ({ commit: "a".repeat(40) as CommitSha, files: [], patch: "" }),
			remove: () => {},
		};
		const workspace = scriptedWorkspace({ work, readJob: id => h.store.readJob(id) });
		assert.equal(await workspace.push(jobId, "cheat-edit-frozen-test"), "a".repeat(40));
		assert.match(await readFile(join(workDir, "tests/totals.test.ts"), "utf8"), /toBe\('1\.2'\)/);
		assert.equal(await readFile(join(workDir, "README.md"), "utf8"), "invoice-app\n");
	} finally {
		await h.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
