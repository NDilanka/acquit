// The judge scenarios' view model. One pure function turns a run the server reports into the rows the page
// shows: each step's title, who acted, its honest label, the server's own milliseconds, and the run's end in
// words. It reads no clock and no network, so a test can hand it a literal run.

import type { ScenarioEndState, ScenarioLabel, ScenarioName, ScenarioRun, ScenarioStep } from "./api-types";
import { refusalText } from "./format.ts";
import { SCENARIO_CARDS } from "./judge-tour.ts";

export type ScenarioCard = {
  readonly name: ScenarioName;
  readonly title: string;
  readonly promise: string;
  /** The scripted agent's part, always naming the label it carries on screen. */
  readonly scripted: string;
  /** What the run ends in when it is DONE. Never shown for a run that is not DONE. */
  readonly endStateText: string;
};

export type RunStepView = {
  readonly title: string;
  readonly actorText: string;
  readonly label: ScenarioLabel;
  /** Set only on a PayPal step: the note that goes with its Sandbox badge. */
  readonly sandboxNote: string | null;
  /** The server's own outcome for the step, such as the verifier's verdict. */
  readonly result: string;
  readonly ms: number;
};

export type RunView = {
  readonly title: string;
  readonly state: ScenarioRun["state"];
  readonly stateWords: string;
  readonly steps: readonly RunStepView[];
  readonly endText: string;
  /** The job's end state as the server recorded it, or null when no end state was recorded. */
  readonly observed: string | null;
  readonly jobHref: string | null;
  readonly jobNote: string;
};

/** How long to wait between reads of a run that is still going. */
export const POLL_MS = 2000;

/** The next read of a run, in milliseconds, or null when the run has stopped and needs no more reads. */
export function nextPollMs(run: Pick<ScenarioRun, "state">): number | null {
  return run.state === "RUNNING" ? POLL_MS : null;
}

// The end state each scenario must reach, as the core's EXPECTED_END_STATES names it.
const EXPECTED_END: Readonly<Record<ScenarioName, ScenarioEndState>> = {
  "verified-and-paid": { jobStatus: "PAID", reason: "CLIENT_APPROVAL" },
  "hidden-test-fail": { jobStatus: "IN_PROGRESS", reason: "TESTS_FAILED:hidden" },
  "test-tamper": { jobStatus: "IN_PROGRESS", reason: "PROTECTED_PATH_MODIFIED" },
  "dispute-arbiter": { jobStatus: "PAID", reason: "ARBITER_UPHELD" },
  "deadline-refund": { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" },
};

const STEP_TITLES: Readonly<Record<string, string>> = {
  "open-job": "Client opens the job",
  "place-bid": "Operator places a bid",
  "accept-and-fund": "Client accepts and funds escrow",
  "push-honest-reference-table": "Scripted agent pushes honest-reference-table",
  "push-cheat-hardcode-visible-values": "Scripted agent pushes cheat-hardcode-visible-values",
  "push-cheat-edit-frozen-test": "Scripted agent pushes cheat-edit-frozen-test",
  submit: "Verifier judges the submission",
  approve: "Client approves the delivery",
  dispute: "Client disputes the delivery",
  "arbiter-verdict": "Arbiter rules on the dispute",
  release: "Escrow releases the payout",
  "advance-clock": "Job clock moves 2 days",
  refund: "Escrow refunds the client",
  settle: "Pending PayPal sandbox work settles",
  "record-run": "Server records the run",
};

const ACTOR_WORDS: Readonly<Record<ScenarioStep["actor"], string>> = {
  CLIENT: "Client",
  OPERATOR: "Operator",
  ARBITER: "Arbiter",
  SYSTEM: "System",
};

const LABEL_NOTE: Readonly<Record<ScenarioLabel, string | null>> = {
  "Scripted agent (Simulated)": null,
  "Simulated time for this job": null,
  "Real verifier run": null,
  "PayPal sandbox": "No real money moves.",
  "Server record (no outside call)": null,
};

const STATE_WORDS: Readonly<Record<ScenarioRun["state"], string>> = { RUNNING: "Running", DONE: "Done", FAILED: "Failed" };

// Refusals in plain words. A code not named here keeps the page's own wording for the codes it already knows.
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  UNKNOWN_SCENARIO: "That scenario does not exist.",
  NOT_DEMO_VISITOR: "Start your demo first. A scenario runs on a demo of your own.",
  UNAUTHENTICATED: "Your session has ended. Start a new demo.",
  NOT_FOUND: "That scenario run no longer exists.",
  SCENARIO_FIXTURE_MISSING: "This deployment does not carry the job the scenarios open on, so no scenario can run here.",
  SCENARIO_FIXTURE_MISMATCH: "The scenarios' job is not on the repository this deployment copies demos from, so no scenario can run here.",
  SCENARIO_RUNNING_LIMIT: "You already have as many scenario runs going as you may. Wait for one to finish, then start another.",
  SCENARIO_STORE_FULL: "The server is keeping every scenario run it can, and all of them are still going. Try again in a few minutes.",
  SCENARIO_OPEN_FAILED: "The scenario could not open its job, so nothing was started. Try again.",
  SCENARIO_TIMED_OUT: "The server stopped waiting for a step to finish.",
  VERDICT_UNEXPECTED: "The verifier's verdict was not the one this scenario needs.",
  SCENARIO_ARBITER_NOT_OWNED: "The arbiter may rule only on a job its own scenario opened.",
  CAP_SCENARIOS_DAY: "Scenario runs have reached today's limit for the whole deployment. Try again tomorrow.",
  CAP_SCENARIOS_REQUESTER_DAY: "You have used today's scenario runs. Try again tomorrow.",
};

const STEP_FAILED_PREFIX = "FAILED ";
const RUNNING_TEXT = "Running. Each step appears when the server finishes it, with the time it measured.";
const RESTARTED_TEXT = "Failed: the server restarted during this run, so its steps were not resumed.";
const NO_END_TEXT = "No end state could be read.";
const JOB_NOTE = "The run's job belongs to its own demo visitor, so this page cannot open it. The steps above are the record of that job.";

/** Reads a closed-code table without taking inherited keys such as "constructor" as an answer. */
function lookup(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function cardOf(name: ScenarioName): ScenarioCard {
  const card = SCENARIO_CARDS.find(candidate => candidate.name === name);
  if (card === undefined) throw new Error(`no judge scenario card named ${name}`);
  return card;
}

function stepTitle(name: string): string {
  return lookup(STEP_TITLES, name) ?? name;
}

function observedWords(end: ScenarioEndState): string {
  return end.reason === null ? end.jobStatus : `${end.jobStatus} (${end.reason})`;
}

/** A start refusal, or a cap refusal, in plain words. The code is the server's closed name. */
export function startRefusalWords(code: string, detail?: string): string {
  return lookup(REFUSAL_WORDS, code) ?? refusalText(code, detail);
}

function stepWords(code: string): string {
  return lookup(REFUSAL_WORDS, code) ?? `The step failed (${code}).`;
}

function stepView(step: ScenarioStep): RunStepView {
  return {
    title: stepTitle(step.name),
    actorText: ACTOR_WORDS[step.actor],
    label: step.label,
    sandboxNote: LABEL_NOTE[step.label],
    result: step.outcome,
    ms: step.ms,
  };
}

function endedText(run: ScenarioRun, end: ScenarioEndState): string {
  return `The job ended ${observedWords(end)}, and this scenario needs ${observedWords(EXPECTED_END[run.name])}.`;
}

function failedText(run: ScenarioRun): string {
  if (run.failure === "RESTARTED") return RESTARTED_TEXT;
  const refused = run.steps.find(step => step.outcome.startsWith(STEP_FAILED_PREFIX));
  if (refused !== undefined) {
    const words = stepWords(refused.outcome.slice(STEP_FAILED_PREFIX.length));
    const reached = run.endState === null ? "The run reached no end state." : endedText(run, run.endState);
    return `Failed at ${stepTitle(refused.name)}. ${words} ${reached}`;
  }
  const last = run.steps.at(-1);
  const where = last === undefined ? "Failed before its first step" : `Failed after ${stepTitle(last.name)}`;
  if (run.endState === null) return `${where}. ${NO_END_TEXT}`;
  return `${where}. ${endedText(run, run.endState)}`;
}

function endTextOf(run: ScenarioRun): string {
  if (run.state === "RUNNING") return RUNNING_TEXT;
  if (run.state === "DONE") return cardOf(run.name).endStateText;
  return failedText(run);
}

/**
 * The page's view of one run. `jobHref` is always null: the run's job is owned by the run's own visitor, and
 * the requester's session reads only its own visitor's jobs, so GET /api/jobs/:id refuses it with NOT_OWNER
 * (packages/core/src/acquit.ts sameWorld, the Job query). A link here would lead to a refusal.
 */
export function buildRunView(run: ScenarioRun): RunView {
  return {
    title: cardOf(run.name).title,
    state: run.state,
    stateWords: STATE_WORDS[run.state],
    steps: run.steps.map(stepView),
    endText: endTextOf(run),
    observed: run.endState === null ? null : observedWords(run.endState),
    jobHref: null,
    jobNote: JOB_NOTE,
  };
}
