// The five judge scenarios, each driven to its end state in process. The harness (scenario-harness.ts)
// supplies the scripted verifier, the fake PayPal, and the fake GitHub app.

import assert from "node:assert/strict";
import test from "node:test";
import { isScenarioName, ScenarioRefused, SCENARIO_NAMES, startScenario } from "../src/scenarios.ts";
import { assertTimings, drive, harness } from "./scenario-harness.ts";

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

test("S4 is refused with DEV_DISABLED when development is off, before any step runs", async () => {
	const h = await harness({ devEnabled: false });
	try {
		await assert.rejects(startScenario(h.deps, "dispute-arbiter", h.visitor), (error: unknown) => error instanceof ScenarioRefused && error.code === "DEV_DISABLED");
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
		const started = await startScenario(h.deps, "deadline-refund", h.visitor);
		assert.equal(started.run.visitorId, h.visitor.id);
		assert.match(started.run.jobId, /^job_/);
		assert.equal(started.run.state, "RUNNING");
		const finished = await started.finished;
		assert.equal(finished.jobId, started.run.jobId);
		assert.equal(h.deps.runs.get(finished.id)?.state, "DONE");
	} finally { await h.dispose(); }
});
