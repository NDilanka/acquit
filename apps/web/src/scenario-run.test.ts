import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobStatus, ScenarioLabel, ScenarioName, ScenarioReachLabel, ScenarioRun, ScenarioStep } from "./api-types.ts";
import { buildRunView, nextPollMs, startRefusalWords } from "./scenario-run.ts";

// Literal types, so one constant reads as a label and as a place the step reached.
const SCRIPTED = "Scripted agent (Simulated)" as const;
const PAYPAL = "PayPal sandbox" as const;
const VERIFIER = "Real verifier run" as const;
const SERVER = "Server record (no outside call)" as const;
const GITHUB = "GitHub work repository" as const;

function step(name: string, actor: ScenarioStep["actor"], label: ScenarioLabel, ms: number, outcome: string,
  reached: readonly ScenarioReachLabel[] = []): ScenarioStep {
  return { name, actor, label, ms, outcome, reached, startedAt: "2026-05-01T10:00:00.000Z", endedAt: "2026-05-01T10:00:01.000Z" };
}

const RUN: ScenarioRun = {
  id: "scn_run-1",
  name: "verified-and-paid",
  requesterId: "visitor-requester",
  visitorId: "visitor-run",
  jobId: "job_1",
  steps: [],
  state: "RUNNING",
  endState: null,
  failure: null,
};

test("a RUNNING run mid-way shows its finished steps with their labels and times, and no end state yet", () => {
  const view = buildRunView({
    ...RUN,
    steps: [
      step("open-job", "CLIENT", SCRIPTED, 412, "opened job_1"),
      step("place-bid", "OPERATOR", SCRIPTED, 388, "bid bid_1"),
      step("accept-and-fund", "CLIENT", SCRIPTED, 9120, "HELD", [PAYPAL, GITHUB]),
    ],
  });
  assert.deepEqual(view, {
    title: "Verified and paid",
    state: "RUNNING",
    stateWords: "Running",
    steps: [
      { title: "Client opens the job", actorText: "Client", label: "Scripted agent (Simulated)", reached: [], result: "opened job_1", ms: 412 },
      { title: "Operator places a bid", actorText: "Operator", label: "Scripted agent (Simulated)", reached: [], result: "bid bid_1", ms: 388 },
      { title: "Client accepts and funds escrow", actorText: "Client", label: "Scripted agent (Simulated)",
        reached: [{ label: "PayPal sandbox", sandboxNote: "No real money moves." }, { label: "GitHub work repository", sandboxNote: null }],
        result: "HELD", ms: 9120 },
    ],
    endText: "Running. Each step appears when the server finishes it, with the time it measured.",
    observed: null,
    jobHref: null,
    jobNote: "The run's job belongs to its own demo visitor, so this page cannot open it. The steps above are the record of that job.",
  });
});

// One DONE run per scenario, each ending in its own end state. The end text is the card's own sentence.
const DONE_CASES: readonly [ScenarioName, JobStatus, string, string, string][] = [
  ["verified-and-paid", "PAID", "CLIENT_APPROVAL", "Paid. The client approved a verified fix.", "PAID (CLIENT_APPROVAL)"],
  ["hidden-test-fail", "IN_PROGRESS", "TESTS_FAILED:hidden", "Rejected on hidden tests. The escrow stays held.", "IN_PROGRESS (TESTS_FAILED:hidden)"],
  ["test-tamper", "IN_PROGRESS", "PROTECTED_PATH_MODIFIED", "Rejected for changing a protected test file. The escrow stays held.", "IN_PROGRESS (PROTECTED_PATH_MODIFIED)"],
  ["dispute-arbiter", "PAID", "ARBITER_UPHELD", "Paid. The arbiter upheld the delivered fix.", "PAID (ARBITER_UPHELD)"],
  ["deadline-refund", "REFUNDED", "DELIVERY_DEADLINE", "Refunded. The delivery deadline passed.", "REFUNDED (DELIVERY_DEADLINE)"],
];

for (const [name, jobStatus, reason, endText, observed] of DONE_CASES) {
  test(`a DONE ${name} run ends in its own end state, ${observed}`, () => {
    const view = buildRunView({
      ...RUN,
      name,
      state: "DONE",
      steps: [step("submit", "OPERATOR", VERIFIER, 74210, "VERIFIED")],
      endState: { jobStatus, reason },
    });
    assert.equal(view.state, "DONE");
    assert.equal(view.stateWords, "Done");
    assert.equal(view.endText, endText);
    assert.equal(view.observed, observed);
    assert.equal(view.jobHref, null);
  });
}

test("a FAILED run that the server restarted says so, and never shows a success end state", () => {
  const view = buildRunView({
    ...RUN,
    state: "FAILED",
    failure: "RESTARTED",
    steps: [step("open-job", "CLIENT", SCRIPTED, 412, "opened job_1"), step("place-bid", "OPERATOR", SCRIPTED, 388, "bid bid_1")],
  });
  assert.equal(view.stateWords, "Failed");
  assert.equal(view.endText, "Failed: the server restarted during this run, so its steps were not resumed.");
  assert.equal(view.observed, null);
});

test("a FAILED run that ends in a wrong end state names the step, and the observed and needed end states", () => {
  const view = buildRunView({
    ...RUN,
    state: "FAILED",
    steps: [
      step("open-job", "CLIENT", SCRIPTED, 412, "opened job_1"),
      step("place-bid", "OPERATOR", SCRIPTED, 388, "bid bid_1"),
      step("accept-and-fund", "CLIENT", PAYPAL, 9120, "HELD"),
      step("push-honest-reference-table", "OPERATOR", SCRIPTED, 1204, "pushed honest-reference-table"),
      step("submit", "OPERATOR", VERIFIER, 74210, "REJECTED TESTS_FAILED:hidden"),
    ],
    endState: { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" },
  });
  assert.equal(view.endText, "Failed after Verifier judges the submission. The job ended IN_PROGRESS (TESTS_FAILED:hidden), and this scenario needs PAID (CLIENT_APPROVAL).");
  assert.equal(view.observed, "IN_PROGRESS (TESTS_FAILED:hidden)");
  assert.equal(view.endText.includes("Paid."), false);
});

test("a FAILED run whose step was refused names that step and says no end state was reached", () => {
  const view = buildRunView({
    ...RUN,
    name: "test-tamper",
    state: "FAILED",
    steps: [
      step("open-job", "CLIENT", SCRIPTED, 412, "opened job_1"),
      step("submit", "OPERATOR", VERIFIER, 60123, "FAILED SCENARIO_TIMED_OUT"),
    ],
    endState: null,
  });
  assert.equal(view.endText, "Failed at Verifier judges the submission. The server stopped waiting for a step to finish. The run reached no end state.");
  assert.equal(view.observed, null);
});

test("a FAILED run whose verdict was not the one its scenario needs names the step, the observed reason, and the needed end", () => {
  const view = buildRunView({
    ...RUN,
    state: "FAILED",
    steps: [
      step("open-job", "CLIENT", SCRIPTED, 412, "opened job_1"),
      step("submit", "OPERATOR", VERIFIER, 74210, "FAILED VERDICT_UNEXPECTED"),
    ],
    endState: { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" },
  });
  assert.equal(view.endText, "Failed at Verifier judges the submission. The verifier's verdict was not the one this scenario needs. The job ended IN_PROGRESS (TESTS_FAILED:hidden), and this scenario needs PAID (CLIENT_APPROVAL).");
  assert.equal(view.observed, "IN_PROGRESS (TESTS_FAILED:hidden)");
  assert.equal(view.endText.includes("no end state"), false);
});

test("every step names its label, and a PayPal place it reached carries the sandbox note", () => {
  const view = buildRunView({
    ...RUN,
    name: "deadline-refund",
    steps: [
      step("open-job", "CLIENT", SCRIPTED, 400, "opened job_1"),
      step("advance-clock", "CLIENT", "Simulated time for this job", 35, "advanced 2 days"),
      step("refund", "SYSTEM", PAYPAL, 2210, "REFUNDED", [PAYPAL]),
    ],
  });
  assert.deepEqual(view.steps.map(s => s.label), ["Scripted agent (Simulated)", "Simulated time for this job", "PayPal sandbox"]);
  assert.deepEqual(view.steps.map(s => s.reached), [[], [], [{ label: "PayPal sandbox", sandboxNote: "No real money moves." }]]);
  assert.deepEqual(view.steps.map(s => s.ms), [400, 35, 2210]);
});

test("a scripted step that moved sandbox money or wrote to GitHub names what it reached beside its Simulated label", () => {
  const view = buildRunView({
    ...RUN,
    name: "dispute-arbiter",
    steps: [
      step("arbiter-verdict", "ARBITER", SCRIPTED, 1734, "ARBITER_UPHELD", [PAYPAL]),
      step("push-honest-reference-table", "OPERATOR", SCRIPTED, 6783, "pushed honest-reference-table", [GITHUB]),
    ],
  });
  // Each row keeps its Simulated label, and the place it reached rides beside it, so the badge never sits alone.
  assert.deepEqual(view.steps.map(s => s.label), [SCRIPTED, SCRIPTED]);
  assert.deepEqual(view.steps.map(s => s.reached), [
    [{ label: "PayPal sandbox", sandboxNote: "No real money moves." }],
    [{ label: "GitHub work repository", sandboxNote: null }],
  ]);
});

test("a run stored before reach was kept shows its labels and says its reach was not recorded, never none", () => {
  // No reached list, as a run recorded before this change carries.
  const legacy: ScenarioStep = { name: "arbiter-verdict", actor: "ARBITER", label: SCRIPTED, ms: 1734, outcome: "ARBITER_UPHELD",
    startedAt: "2026-05-01T10:00:00.000Z", endedAt: "2026-05-01T10:00:01.000Z" };
  const view = buildRunView({ ...RUN, name: "dispute-arbiter", steps: [legacy] });
  assert.deepEqual(view.steps, [
    { title: "Arbiter rules on the dispute", actorText: "Arbiter", label: "Scripted agent (Simulated)", reached: null, result: "ARBITER_UPHELD", ms: 1734 },
  ]);
});

test("each start refusal reads in plain words, and the code stays visible", () => {
  assert.equal(startRefusalWords("SCENARIO_RUNNING_LIMIT"), "You already have as many scenario runs going as you may. Wait for one to finish, then start another.");
  assert.equal(startRefusalWords("SCENARIO_STORE_FULL"), "The server is keeping every scenario run it can, and all of them are still going. Try again in a few minutes.");
  assert.equal(startRefusalWords("CAP_SCENARIOS_DAY"), "Scenario runs have reached today's limit for the whole deployment. Try again tomorrow.");
  assert.equal(startRefusalWords("CAP_SCENARIOS_REQUESTER_DAY"), "You have used today's scenario runs. Try again tomorrow.");
  assert.equal(startRefusalWords("CAP_VISITORS_DAY"), "Today's demos are all taken: the daily limit is reached. Try again tomorrow. (CAP_VISITORS_DAY)");
  assert.equal(startRefusalWords("NOT_DEMO_VISITOR"), "Start your demo first. A scenario runs on a demo of your own.");
  assert.equal(startRefusalWords("SCENARIO_FIXTURE_MISMATCH"), "The scenarios' job is not on the repository this deployment copies demos from, so no scenario can run here.");
  assert.equal(startRefusalWords("SOME_UNNAMED_CODE"), "The request was refused. (SOME_UNNAMED_CODE)");
});

test("a settle step reads Pending work settles, with the sandbox note only when PayPal ran, and the time it measured", () => {
  const view = buildRunView({
    ...RUN,
    steps: [
      step("place-bid", "OPERATOR", SCRIPTED, 388, "bid bid_1"),
      step("settle", "SYSTEM", PAYPAL, 4235, "SETTLED REFUND, REIMBURSE", [PAYPAL]),
    ],
  });
  assert.deepEqual(view.steps, [
    { title: "Operator places a bid", actorText: "Operator", label: "Scripted agent (Simulated)", reached: [], result: "bid bid_1", ms: 388 },
    { title: "Pending work settles", actorText: "System", label: "PayPal sandbox",
      reached: [{ label: "PayPal sandbox", sandboxNote: "No real money moves." }], result: "SETTLED REFUND, REIMBURSE", ms: 4235 },
  ]);
});

test("a step an earlier step already settled names that step by its title, not its id", () => {
  const view = buildRunView({
    ...RUN,
    steps: [
      step("refund", "SYSTEM", SERVER, 6, "REFUNDED (already settled by settle)"),
      step("release", "SYSTEM", SERVER, 4, "PAID (already settled by arbiter-verdict)"),
      step("release", "SYSTEM", SERVER, 4, "PAID (already settled)"),
    ],
  });
  assert.deepEqual(view.steps.map(entry => entry.result), [
    "REFUNDED (already settled at Pending work settles)",
    "PAID (already settled at Arbiter rules on the dispute)",
    "PAID (already settled)",
  ]);
});

test("a settle step that ran GitHub work reads GitHub work repository, with no sandbox note", () => {
  const view = buildRunView({
    ...RUN,
    steps: [step("settle", "SYSTEM", GITHUB, 6, "SETTLED MERGE", [GITHUB])],
  });
  assert.deepEqual(view.steps, [
    { title: "Pending work settles", actorText: "System", label: "GitHub work repository",
      reached: [{ label: "GitHub work repository", sandboxNote: null }], result: "SETTLED MERGE", ms: 6 },
  ]);
});

test("a record-run step reads Server records the run, with its own label and reaches nothing", () => {
  const view = buildRunView({
    ...RUN,
    state: "FAILED",
    steps: [step("record-run", "SYSTEM", SERVER, 3, "FAILED STORE_WRITE_FAILED")],
  });
  assert.deepEqual(view.steps, [
    { title: "Server records the run", actorText: "System", label: "Server record (no outside call)", reached: [], result: "FAILED STORE_WRITE_FAILED", ms: 3 },
  ]);
});

test("a FAILED run whose settle step failed names that step and its code, and says no end state was reached", () => {
  const view = buildRunView({
    ...RUN,
    state: "FAILED",
    steps: [
      step("open-job", "CLIENT", SCRIPTED, 412, "opened job_1"),
      step("place-bid", "OPERATOR", SCRIPTED, 388, "bid bid_1"),
      step("settle", "SYSTEM", PAYPAL, 61, "FAILED PAYPAL_UNAVAILABLE"),
    ],
    endState: null,
  });
  assert.equal(view.endText, "Failed at Pending work settles. The step failed (PAYPAL_UNAVAILABLE). The run reached no end state.");
  assert.equal(view.observed, null);
});

test("a FAILED run whose final write failed names the record-run step and keeps the end the job observed", () => {
  const view = buildRunView({
    ...RUN,
    state: "FAILED",
    steps: [step("record-run", "SYSTEM", SERVER, 3, "FAILED STORE_WRITE_FAILED")],
    endState: { jobStatus: "PAID", reason: "CLIENT_APPROVAL" },
  });
  assert.equal(view.endText, "Failed at Server records the run. The step failed (STORE_WRITE_FAILED). The job ended PAID (CLIENT_APPROVAL), and this scenario needs PAID (CLIENT_APPROVAL).");
  assert.equal(view.observed, "PAID (CLIENT_APPROVAL)");
});

test("a run still going is read again in 2 seconds, and a stopped run is not read again", () => {
  assert.equal(nextPollMs({ state: "RUNNING" }), 2000);
  assert.equal(nextPollMs({ state: "DONE" }), null);
  assert.equal(nextPollMs({ state: "FAILED" }), null);
});
