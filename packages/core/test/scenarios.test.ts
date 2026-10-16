// The five judge scenarios, each driven to its end state in process. The harness (scenario-harness.ts)
// supplies the scripted verifier, the fake PayPal, and the fake GitHub app.

import assert from "node:assert/strict";
import test from "node:test";
import { boundedRuns, isScenarioName, ScenarioRefused, SCENARIO_NAMES, SCENARIO_RUNNING_PER_REQUESTER, SCENARIO_RUNS_PER_REQUESTER,
	SCENARIO_RUNS_TOTAL, startScenario } from "../src/scenarios.ts";
import type { RunSlot, ScenarioName, ScenarioRun, ScenarioRuns } from "../src/scenarios.ts";
import { assertTimings, drive, harness, start } from "./scenario-harness.ts";
import { DEMO_REPOSITORY } from "./hidden-fixture.ts";

test("the scenario names are the five literal paths and nothing else", () => {
	assert.deepEqual([...SCENARIO_NAMES], ["verified-and-paid", "hidden-test-fail", "test-tamper", "dispute-arbiter", "deadline-refund"]);
	assert.equal(isScenarioName("verified-and-paid"), true);
	assert.equal(isScenarioName("submit-everything"), false);
});

test("S1 verified-and-paid: the honest tree verifies and the release pays the operator, reason CLIENT_APPROVAL", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "verified-and-paid");
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-honest-reference-table", "submit", "approve"]);
		assert.deepEqual(run.steps.map(step => step.label), ["Scripted agent (Simulated)", "Scripted agent (Simulated)", "PayPal sandbox",
			"Scripted agent (Simulated)", "Real verifier run", "PayPal sandbox"]);
		assert.equal(run.steps.find(step => step.name === "submit")?.outcome, "VERIFIED");
		assert.deepEqual(run.endState, { jobStatus: "PAID", reason: "CLIENT_APPROVAL" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("S2 hidden-test-fail: the visible-table cheat is REJECTED with TESTS_FAILED:hidden and the escrow stays held", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "hidden-test-fail");
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-cheat-hardcode-visible-values", "submit"]);
		assert.equal(run.steps.find(step => step.name === "submit")?.outcome, "REJECTED TESTS_FAILED:hidden");
		assert.deepEqual(run.endState, { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("S3 test-tamper: an edited frozen test is REJECTED with PROTECTED_PATH_MODIFIED", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "test-tamper");
		assert.equal(run.state, "DONE");
		assert.equal(run.steps.find(step => step.name === "submit")?.outcome, "REJECTED PROTECTED_PATH_MODIFIED");
		assert.deepEqual(run.endState, { jobStatus: "IN_PROGRESS", reason: "PROTECTED_PATH_MODIFIED" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("S2 is FAILED, not DONE, when its tree verifies: the VERIFIED job is recorded as the observed end", async () => {
	const h = await harness({ treeFor: tree => tree === "cheat-hardcode-visible-values" ? "honest-reference-table" : tree });
	try {
		const run = await drive(h, "hidden-test-fail");
		assert.equal(run.state, "FAILED");
		assert.equal(run.steps.find(step => step.name === "submit")?.outcome, "VERIFIED");
		assert.deepEqual(run.endState, { jobStatus: "VERIFIED", reason: null });
	} finally { await h.dispose(); }
});

test("S2 is FAILED when its tree is rejected for the protected path, and the observed reason is recorded", async () => {
	const h = await harness({ treeFor: tree => tree === "cheat-hardcode-visible-values" ? "cheat-edit-frozen-test" : tree });
	try {
		const run = await drive(h, "hidden-test-fail");
		assert.equal(run.state, "FAILED");
		assert.deepEqual(run.endState, { jobStatus: "IN_PROGRESS", reason: "PROTECTED_PATH_MODIFIED" });
	} finally { await h.dispose(); }
});

test("S3 is FAILED when its tree is rejected for the hidden tests, not for the protected path", async () => {
	const h = await harness({ treeFor: tree => tree === "cheat-edit-frozen-test" ? "cheat-hardcode-visible-values" : tree });
	try {
		const run = await drive(h, "test-tamper");
		assert.equal(run.state, "FAILED");
		assert.deepEqual(run.endState, { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" });
	} finally { await h.dispose(); }
});

test("S4 dispute-arbiter: a dispute the arbiter upholds pays the operator, reason ARBITER_UPHELD", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "dispute-arbiter");
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-honest-reference-table", "submit", "dispute",
			"arbiter-verdict", "release"]);
		assert.equal(run.steps.find(step => step.name === "arbiter-verdict")?.label, "Scripted agent (Simulated)");
		assert.deepEqual(run.endState, { jobStatus: "PAID", reason: "ARBITER_UPHELD" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("S4 is refused with DEV_DISABLED when development is off, and retains no run", async () => {
	const h = await harness({ devEnabled: false });
	try {
		await assert.rejects(start(h, "dispute-arbiter"), (error: unknown) => error instanceof ScenarioRefused && error.code === "DEV_DISABLED");
		assert.equal(h.deps.runs.size(), 0);
	} finally { await h.dispose(); }
});

test("S5 deadline-refund: a job past its delivery deadline is REFUNDED with reason DELIVERY_DEADLINE, and the clock step is labelled simulated", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "deadline-refund");
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "advance-clock", "refund"]);
		assert.equal(run.steps.find(step => step.name === "advance-clock")?.label, "Simulated time for this job");
		assert.deepEqual(run.endState, { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("a run keeps its own visitor and job, and the start returns the job before the chain ends", async () => {
	const h = await harness();
	try {
		const started = await start(h, "deadline-refund");
		assert.equal(started.run.requesterId, h.visitor.id);
		assert.equal(started.run.visitorId, h.visitor.id);
		assert.match(started.run.jobId, /^job_/);
		assert.equal(started.run.state, "RUNNING");
		const finished = await started.finished;
		assert.equal(finished.jobId, started.run.jobId);
		assert.equal(h.deps.runs.get(finished.id)?.state, "DONE");
	} finally { await h.dispose(); }
});

test("one requester starts all five scenarios, each on its own visitor, and each reaches its end state", async () => {
	const h = await harness();
	try {
		const runs: ScenarioRun[] = [];
		const finishing: Promise<ScenarioRun>[] = [];
		for (const name of SCENARIO_NAMES) {
			const provisioned = await h.provision(h.visitor);
			if (provisioned.kind !== "CREATED") throw new Error(`the run visitor was not created: ${provisioned.kind}`);
			const started = await start(h, name, provisioned.visitor);
			runs.push(started.run);
			finishing.push(started.finished);
		}
		const settled = await Promise.all(finishing);
		assert.deepEqual(new Set(runs.map(run => run.visitorId)).size, 5);
		assert.equal(runs.some(run => run.visitorId === h.visitor.id), false);
		assert.deepEqual(settled.map(run => [run.name, run.state, run.endState]), [
			["verified-and-paid", "DONE", { jobStatus: "PAID", reason: "CLIENT_APPROVAL" }],
			["hidden-test-fail", "DONE", { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" }],
			["test-tamper", "DONE", { jobStatus: "IN_PROGRESS", reason: "PROTECTED_PATH_MODIFIED" }],
			["dispute-arbiter", "DONE", { jobStatus: "PAID", reason: "ARBITER_UPHELD" }],
			["deadline-refund", "DONE", { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" }],
		]);
		assert.deepEqual(settled.map(run => run.requesterId), [h.visitor.id, h.visitor.id, h.visitor.id, h.visitor.id, h.visitor.id]);
	} finally { await h.dispose(); }
});

test("a sixth start from one requester while five are running is refused as SCENARIO_RUNNING_LIMIT", async () => {
	let open!: () => void;
	const gate = new Promise<void>(resolve => { open = resolve; });
	const h = await harness({ verdictGate: gate });
	try {
		const finishing: Promise<ScenarioRun>[] = [];
		for (let index = 0; index < SCENARIO_RUNNING_PER_REQUESTER; index++) {
			const provisioned = await h.provision(h.visitor);
			if (provisioned.kind !== "CREATED") throw new Error(`the run visitor was not created: ${provisioned.kind}`);
			finishing.push((await start(h, "verified-and-paid", provisioned.visitor)).finished);
		}
		assert.deepEqual(h.deps.runs.admit(h.visitor.id), { kind: "REFUSED", code: "SCENARIO_RUNNING_LIMIT" });
		open();
		const settled = await Promise.all(finishing);
		assert.deepEqual(settled.map(run => run.state), ["DONE", "DONE", "DONE", "DONE", "DONE"]);
		assert.equal(h.deps.runs.admit(h.visitor.id).kind, "ADMITTED");
	} finally { await h.dispose(); }
});

test("an open the core refuses releases its slot and retains no run", async () => {
	const h = await harness();
	try {
		const admitted = h.deps.runs.admit(h.visitor.id);
		if (admitted.kind !== "ADMITTED") throw new Error("the first start must be admitted");
		const refused: Partial<typeof h.deps> = { issueNumber: 999, repository: DEMO_REPOSITORY };
		await assert.rejects(startScenario({ ...h.deps, ...refused }, "verified-and-paid", h.visitor, h.visitor.id, admitted.slot),
			(error: unknown) => error instanceof ScenarioRefused && error.code === "NOT_FOUND");
		assert.equal(h.deps.runs.size(), 0);
		assert.equal(h.deps.runs.admit(h.visitor.id).kind, "ADMITTED");
	} finally { await h.dispose(); }
});

/** Admits and commits one run for a requester, in the given state. */
function commitRun(runs: ScenarioRuns, requesterId: string, index: number, state: "RUNNING" | "DONE" = "DONE"): RunSlot {
	const admitted = runs.admit(requesterId);
	if (admitted.kind !== "ADMITTED") throw new Error(`admission refused: ${admitted.code}`);
	const run: ScenarioRun = { id: `scn_${requesterId}_${index}`, name: "deadline-refund", requesterId, visitorId: `vis_${index}`, jobId: `job_${index}`,
		steps: [], state, endState: state === "DONE" ? { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" } : null };
	admitted.slot.commit(run);
	return admitted.slot;
}

test("the store's defaults are ten runs a requester, five running at once, and five hundred in all", () => {
	assert.equal(SCENARIO_RUNS_PER_REQUESTER, 10);
	assert.equal(SCENARIO_RUNNING_PER_REQUESTER, 5);
	assert.equal(SCENARIO_RUNS_TOTAL, 500);
});

test("a requester keeps its ten newest runs, and the eviction takes its oldest finished run first", () => {
	const runs = boundedRuns();
	for (let index = 0; index < 12; index++) commitRun(runs, "req-a", index);
	assert.equal(runs.size(), 10);
	assert.equal(runs.get("scn_req-a_0"), undefined);
	assert.equal(runs.get("scn_req-a_1"), undefined);
	assert.equal(runs.get("scn_req-a_2")?.id, "scn_req-a_2");
	assert.equal(runs.get("scn_req-a_11")?.id, "scn_req-a_11");
});

test("a running run is never evicted, so the oldest finished run goes instead", () => {
	const runs = boundedRuns({ perRequester: 2, running: 5, total: 100 });
	commitRun(runs, "req-a", 0, "RUNNING");
	commitRun(runs, "req-a", 1, "DONE");
	commitRun(runs, "req-a", 2, "DONE");
	assert.equal(runs.get("scn_req-a_0")?.state, "RUNNING");
	assert.equal(runs.get("scn_req-a_1"), undefined);
	assert.equal(runs.get("scn_req-a_2")?.state, "DONE");
});

test("the store's global bound evicts the oldest finished run across requesters", () => {
	const runs = boundedRuns({ perRequester: 10, running: 5, total: 3 });
	commitRun(runs, "req-a", 0);
	commitRun(runs, "req-b", 1);
	commitRun(runs, "req-a", 2);
	commitRun(runs, "req-b", 3);
	assert.equal(runs.size(), 3);
	assert.equal(runs.get("scn_req-a_0"), undefined);
	assert.equal(runs.get("scn_req-b_1")?.id, "scn_req-b_1");
});

test("a store full of running runs refuses the next start as SCENARIO_STORE_FULL", () => {
	const runs = boundedRuns({ perRequester: 10, running: 5, total: 2 });
	commitRun(runs, "req-a", 0, "RUNNING");
	commitRun(runs, "req-b", 1, "RUNNING");
	assert.deepEqual(runs.admit("req-c"), { kind: "REFUSED", code: "SCENARIO_STORE_FULL" });
});

test("a released slot retains nothing, and its place is free again", () => {
	const runs = boundedRuns({ perRequester: 10, running: 1, total: 10 });
	const admitted = runs.admit("req-a");
	if (admitted.kind !== "ADMITTED") throw new Error("admission refused");
	assert.deepEqual(runs.admit("req-a"), { kind: "REFUSED", code: "SCENARIO_RUNNING_LIMIT" });
	admitted.slot.release();
	admitted.slot.release();
	assert.equal(runs.size(), 0);
	assert.equal(runs.admit("req-a").kind, "ADMITTED");
});
