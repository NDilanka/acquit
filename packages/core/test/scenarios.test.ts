// The six judge scenarios, each driven to its end state in process. The harness (scenario-harness.ts)
// supplies the scripted verifier, the fake PayPal, and the fake GitHub app.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import type { CaptureId, JobId } from "../src/ids.ts";
import type { DisputeId } from "../src/paypal.ts";
import { instant } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import { recordSimulatedDispute } from "../src/scenario-binding.ts";
import { arbiterVerdictForRun, boundedRuns, EXPECTED_END_STATES, EXPECTED_SUBMIT_VERDICTS, isScenarioName, ScenarioRefused, SCENARIO_NAMES,
	SCENARIO_RUNNING_PER_REQUESTER, SCENARIO_RUNS_PER_REQUESTER, SCENARIO_RUNS_TOTAL, reachedOf, settleLabelOf, startScenario } from "../src/scenarios.ts";
import type { RunSlot, ScenarioName, ScenarioRun, ScenarioRuns } from "../src/scenarios.ts";
import { assertTimings, drive, harness, start } from "./scenario-harness.ts";
import { DEMO_REPOSITORY } from "./hidden-fixture.ts";

/** A dev-replay delivery of one dispute status, the way the route receives it. */
const disputeDelivery = (eventId: string, eventType: string, disputeId: string, status: string): Request =>
	new Request("http://acquit.test/paypal/webhook", { method: "POST",
		body: JSON.stringify({ id: eventId, event_type: eventType, resource_type: "dispute", resource: { dispute_id: disputeId, status } }) });

test("the scenario names are the six literal paths and nothing else", () => {
	assert.deepEqual([...SCENARIO_NAMES], ["verified-and-paid", "hidden-test-fail", "test-tamper", "dispute-arbiter", "buyer-dispute", "deadline-refund"]);
	assert.equal(isScenarioName("verified-and-paid"), true);
	assert.equal(isScenarioName("submit-everything"), false);
});

test("S1 verified-and-paid: the honest tree verifies and the release pays the operator, reason CLIENT_APPROVAL", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "verified-and-paid");
		assert.equal(run.state, "DONE");
		// Each command drains its own money effects, and each step's wait drains the rest, so no settle tick runs anything for this job.
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-honest-reference-table", "submit", "approve"]);
		assert.deepEqual(run.steps.map(step => [step.label, step.reached]), [
			["Scripted agent (Simulated)", []],
			["Scripted agent (Simulated)", []],
			["Scripted agent (Simulated)", ["PayPal sandbox", "GitHub work repository"]],
			["Scripted agent (Simulated)", ["GitHub work repository"]],
			["Scripted agent (Simulated)", ["Real verifier run"]],
			["Scripted agent (Simulated)", ["PayPal sandbox", "GitHub work repository"]],
		]);
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
		assert.deepEqual(run.steps.map(step => step.reached), [[], [], ["PayPal sandbox", "GitHub work repository"], ["GitHub work repository"], ["Real verifier run"]]);
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
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-cheat-edit-frozen-test", "submit"]);
		assert.deepEqual(run.steps.map(step => step.reached), [[], [], ["PayPal sandbox", "GitHub work repository"], ["GitHub work repository"], ["Real verifier run"]]);
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
		assert.equal(run.steps.find(step => step.name === "submit")?.outcome, "FAILED VERDICT_UNEXPECTED");
		assert.deepEqual(run.endState, { jobStatus: "VERIFIED", reason: null });
	} finally { await h.dispose(); }
});

test("S2 is FAILED when its tree is rejected for the protected path, and the observed reason is recorded", async () => {
	const h = await harness({ treeFor: tree => tree === "cheat-hardcode-visible-values" ? "cheat-edit-frozen-test" : tree });
	try {
		const run = await drive(h, "hidden-test-fail");
		assert.equal(run.state, "FAILED");
		assert.equal(run.steps.find(step => step.name === "submit")?.outcome, "FAILED VERDICT_UNEXPECTED");
		assert.deepEqual(run.endState, { jobStatus: "IN_PROGRESS", reason: "PROTECTED_PATH_MODIFIED" });
	} finally { await h.dispose(); }
});

test("S3 is FAILED when its tree is rejected for the hidden tests, not for the protected path", async () => {
	const h = await harness({ treeFor: tree => tree === "cheat-edit-frozen-test" ? "cheat-hardcode-visible-values" : tree });
	try {
		const run = await drive(h, "test-tamper");
		assert.equal(run.state, "FAILED");
		assert.equal(run.steps.find(step => step.name === "submit")?.outcome, "FAILED VERDICT_UNEXPECTED");
		assert.deepEqual(run.endState, { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" });
	} finally { await h.dispose(); }
});

test("a verified-and-paid run whose verifier rejects its fix on the hidden tests stops at submit, with no approve step", async () => {
	const h = await harness({ treeFor: tree => tree === "honest-reference-table" ? "cheat-hardcode-visible-values" : tree });
	try {
		const run = await drive(h, "verified-and-paid");
		assert.equal(run.state, "FAILED");
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-honest-reference-table", "submit"]);
		assert.equal(run.steps.find(step => step.name === "submit")?.outcome, "FAILED VERDICT_UNEXPECTED");
		assert.deepEqual(run.endState, { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" });
		assert.equal((await h.store.readJob(run.jobId as JobId))?.state.status, "IN_PROGRESS");
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("the submit verdicts are the literal reasons each scenario needs, and they match the end states it must reach", () => {
	assert.deepEqual(EXPECTED_SUBMIT_VERDICTS, {
		"verified-and-paid": "VERIFIED",
		"hidden-test-fail": "REJECTED TESTS_FAILED:hidden",
		"test-tamper": "REJECTED PROTECTED_PATH_MODIFIED",
		"dispute-arbiter": "VERIFIED",
		"buyer-dispute": "VERIFIED",
	});
	assert.equal(EXPECTED_SUBMIT_VERDICTS["hidden-test-fail"], `REJECTED ${EXPECTED_END_STATES["hidden-test-fail"].reason}`);
	assert.equal(EXPECTED_SUBMIT_VERDICTS["test-tamper"], `REJECTED ${EXPECTED_END_STATES["test-tamper"].reason}`);
});

test("S4 dispute-arbiter: a dispute the arbiter upholds pays the operator, reason ARBITER_UPHELD", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "dispute-arbiter");
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-honest-reference-table", "submit",
			"dispute", "arbiter-verdict", "settle", "release"]);
		// The verdict's own drain ran the release, so the verdict row reaches PayPal. The tick after it ran only GitHub's merge,
		// so its row names GitHub, not PayPal. The release row waits on a PAID the verdict already set, and reaches nothing.
		assert.deepEqual(run.steps.map(step => [step.name, step.label, step.reached]), [
			["open-job", "Scripted agent (Simulated)", []],
			["place-bid", "Scripted agent (Simulated)", []],
			["accept-and-fund", "Scripted agent (Simulated)", ["PayPal sandbox", "GitHub work repository"]],
			["push-honest-reference-table", "Scripted agent (Simulated)", ["GitHub work repository"]],
			["submit", "Scripted agent (Simulated)", ["Real verifier run"]],
			["dispute", "Scripted agent (Simulated)", []],
			["arbiter-verdict", "Scripted agent (Simulated)", ["PayPal sandbox"]],
			["settle", "GitHub work repository", ["GitHub work repository"]],
			["release", "Server record (no outside call)", []],
		]);
		assert.equal(run.steps.find(step => step.name === "release")?.outcome, "PAID (already settled by arbiter-verdict)");
		const settle = run.steps.find(step => step.name === "settle");
		assert.equal(settle?.outcome, "SETTLED MERGE");
		assert.deepEqual(run.endState, { jobStatus: "PAID", reason: "ARBITER_UPHELD" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("S6 buyer-dispute: a buyer's PayPal dispute holds the approved release, the seller wins it, and the job is paid", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "buyer-dispute");
		assert.equal(run.state, "DONE");
		// The settle tick after CREATED ran the evidence the job filed: a Simulated answer, which reached no outside place.
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-honest-reference-table", "submit",
			"dispute-created", "settle", "approve", "dispute-resolved", "settle", "release"]);
		const evidence = run.steps.find(step => step.name === "settle" && step.outcome.includes("DISPUTE_EVIDENCE"));
		assert.deepEqual([evidence?.label, evidence?.reached, evidence?.outcome], ["Simulated PayPal dispute", [], "SETTLED DISPUTE_EVIDENCE"]);
		const created = run.steps.findIndex(step => step.name === "dispute-created");
		const resolved = run.steps.findIndex(step => step.name === "dispute-resolved");
		// Between CREATED and RESOLVED no step reached PayPal and no step ran a RELEASE: the held approval moved no money.
		for (const step of run.steps.slice(created, resolved)) {
			assert.equal(step.reached.includes("PayPal sandbox"), false, step.name);
			assert.doesNotMatch(step.outcome, /RELEASE/, step.name);
		}
		assert.deepEqual(run.steps.filter(step => step.name.startsWith("dispute-")).map(step => [step.name, step.label, step.reached, step.outcome]), [
			["dispute-created", "Simulated PayPal dispute", [], "dispute OPEN"],
			["dispute-resolved", "Simulated PayPal dispute", [], "dispute RESOLVED_SELLER_FAVOUR"],
		]);
		assert.equal(run.steps.find(step => step.name === "approve")?.outcome, "HELD");
		assert.equal(run.steps.find(step => step.name === "release")?.outcome, "PAID (already settled by settle)");
		// The simulated dispute never reached PayPal: the dev replay read it from the run's own record, and the
		// evidence it filed was never sent (no dispute write reached the fake PayPal).
		assert.deepEqual(h.disputeReads, []);
		assert.deepEqual(h.paypalDispatches.filter(kind => kind.startsWith("DISPUTE")), []);
		const job = await h.store.readJob(run.jobId as JobId);
		assert.equal(job?.providerDispute?.id, `SIM-${run.id}`);
		assert.equal(job?.providerDispute?.answer, "EVIDENCE");
		assert.equal(job?.providerDispute?.simulated, true);
		assert.equal(job?.providerDispute?.status, "RESOLVED");
		assert.equal(job?.providerDispute?.outcome, "RESOLVED_SELLER_FAVOUR");
		assert.deepEqual(run.endState, { jobStatus: "PAID", reason: "CLIENT_APPROVAL" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("the simulated dispute source answers only a RUNNING buyer-dispute run's own job: a finished run's dispute, and another scenario's job, are read from PayPal", async () => {
	const h = await harness();
	try {
		const finished = await drive(h, "buyer-dispute");
		assert.equal(finished.state, "DONE");
		// The finished run's record is forgotten, so its dispute id goes to PayPal, which holds none for it.
		const late = await h.acquit.handlePayPalWebhookDev(disputeDelivery("WH-LATE-1", "CUSTOMER.DISPUTE.CREATED", `SIM-${finished.id}`, "OPEN"));
		assert.equal(late.status, 202);
		assert.deepEqual(h.disputeReads, [`SIM-${finished.id}`]);
		// A record forged for a job another scenario opened is refused: that run is not buyer-dispute, so PayPal answers.
		const other = await drive(h, "verified-and-paid");
		assert.equal(other.state, "DONE");
		const otherRow = await h.store.readJob(other.jobId as JobId);
		if (otherRow?.state.status !== "PAID") throw new Error(`expected PAID, got ${otherRow?.state.status}`);
		recordSimulatedDispute(h.deps.store.db, { id: other.id, jobId: other.jobId }, { kind: "DISPUTE", disputeId: "SIM-FORGED" as DisputeId,
			captureId: otherRow.state.release.captureId as CaptureId, status: "OPEN", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
			amount: usd("400.00"), openedAt: instant("2026-10-06T12:30:00Z") });
		const forged = await h.acquit.handlePayPalWebhookDev(disputeDelivery("WH-FORGED-1", "CUSTOMER.DISPUTE.CREATED", "SIM-FORGED", "OPEN"));
		assert.equal(forged.status, 202);
		assert.deepEqual(h.disputeReads, [`SIM-${finished.id}`, "SIM-FORGED"]);
		assert.equal((await h.store.readJob(other.jobId as JobId))?.providerDispute, undefined);
		assert.equal((await h.store.readJob(other.jobId as JobId))?.state.status, "PAID");
	} finally { await h.dispose(); }
});

test("the arbiter verdict is refused by name for any job the named dispute-arbiter run did not open", async () => {
	const h = await harness();
	try {
		const verified = await drive(h, "verified-and-paid");
		const arbiter = await drive(h, "dispute-arbiter");
		assert.equal(arbiter.state, "DONE");
		const refusedBy = (runId: string, jobId: string) => assert.rejects(
			arbiterVerdictForRun(h.deps, runId, jobId as JobId),
			(error: unknown) => error instanceof ScenarioRefused && error.code === "SCENARIO_ARBITER_NOT_OWNED");
		// The job is another run's: the name is not dispute-arbiter, so no ARBITER actor is used.
		await refusedBy(verified.id, verified.jobId);
		// The run is dispute-arbiter, but the job it names is another run's job.
		await refusedBy(arbiter.id, verified.jobId);
		// No run record names the job.
		await refusedBy("scn_unknown", arbiter.jobId);
		assert.equal((await h.store.readJob(verified.jobId as JobId))?.state.status, "PAID");
	} finally { await h.dispose(); }
});

test("the arbiter verdict is not an HTTP route: no API source names it", () => {
	const apiDir = new URL("../../../apps/api/src/", import.meta.url);
	for (const name of readdirSync(apiDir)) {
		if (!name.endsWith(".ts")) continue;
		assert.equal(readFileSync(new URL(name, apiDir), "utf8").includes("arbiterVerdictForRun"), false, name);
	}
});

test("S5 deadline-refund: a job past its delivery deadline is REFUNDED with reason DELIVERY_DEADLINE, and the clock step is labelled simulated", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "deadline-refund");
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "advance-clock", "settle", "refund"]);
		// The clock shift makes the refund due, and the tick after it runs the refund and the fee's reimbursement. The refund
		// row waits on a REFUNDED that tick already set, so it reaches nothing itself.
		assert.deepEqual(run.steps.map(step => [step.name, step.label, step.reached]), [
			["open-job", "Scripted agent (Simulated)", []],
			["place-bid", "Scripted agent (Simulated)", []],
			["accept-and-fund", "Scripted agent (Simulated)", ["PayPal sandbox", "GitHub work repository"]],
			["advance-clock", "Simulated time for this job", []],
			["settle", "PayPal sandbox", ["PayPal sandbox"]],
			["refund", "Server record (no outside call)", []],
		]);
		assert.equal(run.steps.find(step => step.name === "refund")?.outcome, "REFUNDED (already settled by settle)");
		const settle = run.steps.find(step => step.name === "settle");
		assert.equal(settle?.outcome, "SETTLED REFUND, REIMBURSE");
		assert.deepEqual(run.endState, { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" });
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("a tick that takes time is attributed to the step it runs in, and the steps sum to the run's total", async () => {
	const h = await harness();
	try {
		// Each tick waits 150 ms before the real tick runs. Every tick runs inside a step, so the steps carry all of that wait.
		let ticks = 0;
		const slowTick = { ...h.acquit, tick: async () => { ticks++; await new Promise(resolve => setTimeout(resolve, 150)); return h.acquit.tick(); } };
		const admitted = h.deps.runs.admit(h.visitor.id);
		if (admitted.kind !== "ADMITTED") throw new Error(`admission refused: ${admitted.code}`);
		const run = await (await startScenario({ ...h.deps, acquit: slowTick }, "deadline-refund", h.visitor, h.visitor.id, admitted.slot)).finished;
		assert.equal(run.state, "DONE");
		assertTimings(run);
		const sum = run.steps.reduce((acc, step) => acc + step.ms, 0);
		assert.ok(sum >= ticks * 140, `the steps sum to ${sum} ms, and ${ticks} ticks waited 150 ms each`);
		// The settle row is the tick that refunded the job, so its time is its own tick's wait.
		const settle = run.steps.find(step => step.name === "settle");
		assert.equal(settle?.label, "PayPal sandbox");
		assert.ok((settle?.ms ?? 0) >= 140, `settle ms ${settle?.ms}`);
	} finally { await h.dispose(); }
});

test("a tick whose summary names only another job's effects adds no settle row to this run", async () => {
	const h = await harness();
	try {
		const otherJob = { ...h.acquit, tick: async () => { await h.acquit.tick(); return { ran: [{ kind: "RELEASE" as const, jobId: "job_other" as JobId, reach: "PAYPAL" as const }] }; } };
		const admitted = h.deps.runs.admit(h.visitor.id);
		if (admitted.kind !== "ADMITTED") throw new Error(`admission refused: ${admitted.code}`);
		const run = await (await startScenario({ ...h.deps, acquit: otherJob }, "verified-and-paid", h.visitor, h.visitor.id, admitted.slot)).finished;
		assert.equal(run.state, "DONE");
		assert.deepEqual(run.steps.map(step => step.name), ["open-job", "place-bid", "accept-and-fund", "push-honest-reference-table", "submit", "approve"]);
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("a tick that ran GitHub work for this job is labelled GitHub at every settle, and never PayPal", async () => {
	const h = await harness();
	try {
		// The summary names one GitHub merge for the run's own job after every tick, so each settle row must read GitHub.
		const githubOnly = { ...h.acquit, tick: async () => {
			await h.acquit.tick();
			const [job] = await h.store.listJobs();
			return { ran: [{ kind: "MERGE" as const, jobId: job.id, reach: "GITHUB" as const }] };
		} };
		const admitted = h.deps.runs.admit(h.visitor.id);
		if (admitted.kind !== "ADMITTED") throw new Error(`admission refused: ${admitted.code}`);
		const run = await (await startScenario({ ...h.deps, acquit: githubOnly }, "verified-and-paid", h.visitor, h.visitor.id, admitted.slot)).finished;
		assert.equal(run.state, "DONE");
		const settles = run.steps.filter(step => step.name === "settle");
		assert.equal(settles.length, 5);
		for (const step of settles) assert.equal(step.label, "GitHub work repository", step.outcome);
		assert.deepEqual(run.steps.filter(step => step.reached.includes("PayPal sandbox")).map(step => step.name), ["accept-and-fund", "approve"]);
		assertTimings(run);
	} finally { await h.dispose(); }
});

test("each effect a real tick ran names where its work went: the refund and its reimbursement reached PayPal, the work repository and the merge reached GitHub", async () => {
	const h = await harness();
	try {
		const seen: { kind: string; reach: string }[] = [];
		const recording = { ...h.acquit, tick: async () => {
			const summary = await h.acquit.tick();
			seen.push(...summary.ran.map(effect => ({ kind: effect.kind, reach: effect.reach })));
			return summary;
		} };
		const recorded = { ...h, deps: { ...h.deps, acquit: recording } };
		const second = await h.provision(h.visitor);
		if (second.kind !== "CREATED") throw new Error(`the visitor was not created: ${second.kind}`);
		const refunded = await (await start(recorded, "deadline-refund")).finished;
		assert.equal(refunded.state, "DONE");
		assert.deepEqual(seen.filter(effect => effect.reach === "PAYPAL").map(effect => effect.kind), ["REFUND", "REIMBURSE"]);
		seen.length = 0;
		const paid = await (await start(recorded, "verified-and-paid", second.visitor)).finished;
		assert.equal(paid.state, "DONE");
		assert.deepEqual(seen.map(effect => `${effect.kind}/${effect.reach}`), ["CREATE_WORK_REPO/GITHUB", "MERGE/GITHUB"]);
	} finally { await h.dispose(); }
});

test("a settle row names what its tick reached: PayPal over the verifier over GitHub, and a server record when nothing left the server", () => {
	assert.equal(settleLabelOf([{ kind: "RELEASE", jobId: null, reach: "PAYPAL" }, { kind: "MERGE", jobId: null, reach: "GITHUB" }]), "PayPal sandbox");
	assert.equal(settleLabelOf([{ kind: "START_VERIFIER", jobId: null, reach: "VERIFIER" }]), "Real verifier run");
	assert.equal(settleLabelOf([{ kind: "MERGE", jobId: null, reach: "GITHUB" }]), "GitHub work repository");
	assert.equal(settleLabelOf([{ kind: "RELEASE", jobId: null, reach: "NONE" }]), "Server record (no outside call)");
});

test("a step's reach names each outside place once, in PayPal, verifier, GitHub order, and names none for a server-only effect", () => {
	assert.deepEqual(reachedOf([{ kind: "MERGE", jobId: null, reach: "GITHUB" }, { kind: "RELEASE", jobId: null, reach: "PAYPAL" },
		{ kind: "RELEASE", jobId: null, reach: "PAYPAL" }]), ["PayPal sandbox", "GitHub work repository"]);
	assert.deepEqual(reachedOf([{ kind: "START_VERIFIER", jobId: null, reach: "VERIFIER" }, { kind: "MERGE", jobId: null, reach: "GITHUB" },
		{ kind: "RELEASE", jobId: null, reach: "PAYPAL" }]), ["PayPal sandbox", "Real verifier run", "GitHub work repository"]);
	assert.deepEqual(reachedOf([{ kind: "ALERT", jobId: null, reach: "ALERT" }, { kind: "RELEASE", jobId: null, reach: "NONE" }]), []);
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

test("one requester starts all six scenarios, each on its own visitor, and each reaches its end state", async () => {
	const h = await harness();
	try {
		const runs: ScenarioRun[] = [];
		const finishing: Promise<ScenarioRun>[] = [];
		for (const name of SCENARIO_NAMES) {
			// One requester may have five runs RUNNING at once, so the sixth start waits for the first run to finish.
			if (finishing.length === SCENARIO_RUNNING_PER_REQUESTER) await finishing[0];
			const provisioned = await h.provision(h.visitor);
			if (provisioned.kind !== "CREATED") throw new Error(`the run visitor was not created: ${provisioned.kind}`);
			const started = await start(h, name, provisioned.visitor);
			runs.push(started.run);
			finishing.push(started.finished);
		}
		const settled = await Promise.all(finishing);
		assert.deepEqual(new Set(runs.map(run => run.visitorId)).size, 6);
		assert.equal(runs.some(run => run.visitorId === h.visitor.id), false);
		assert.deepEqual(settled.map(run => [run.name, run.state, run.endState]), [
			["verified-and-paid", "DONE", { jobStatus: "PAID", reason: "CLIENT_APPROVAL" }],
			["hidden-test-fail", "DONE", { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" }],
			["test-tamper", "DONE", { jobStatus: "IN_PROGRESS", reason: "PROTECTED_PATH_MODIFIED" }],
			["dispute-arbiter", "DONE", { jobStatus: "PAID", reason: "ARBITER_UPHELD" }],
			["buyer-dispute", "DONE", { jobStatus: "PAID", reason: "CLIENT_APPROVAL" }],
			["deadline-refund", "DONE", { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" }],
		]);
		assert.deepEqual(settled.map(run => run.requesterId), Array(6).fill(h.visitor.id));
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
		steps: [], state, endState: state === "DONE" ? { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" } : null, failure: null };
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
