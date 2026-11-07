// The judge scenarios' view model. One pure function turns a run the server reports into the rows the page
// shows: each step's title, who acted, its honest label, the outside places it reached, the server's own
// milliseconds, and the run's end in words. It reads no clock and no network, so a test can hand it a literal run.

import type { ScenarioEndState, ScenarioLabel, ScenarioName, ScenarioReachLabel, ScenarioRun, ScenarioStep } from "./api-types";
import { refusalText } from "./format.ts";
import { SCENARIO_CARDS } from "./judge-tour.ts";
import { reasonWords } from "./receipt-view.ts";

export type ScenarioCard = {
  readonly name: ScenarioName;
  readonly title: string;
  readonly promise: string;
  /** The scripted agent's part, always naming the label it carries on screen. */
  readonly scripted: string;
  /** What the run ends in when it is DONE. Never shown for a run that is not DONE. */
  readonly endStateText: string;
};

/** One outside place a step reached. A PayPal place carries the note that goes with its Sandbox badge. */
export type RunReachView = {
  readonly label: ScenarioReachLabel;
  readonly sandboxNote: string | null;
};

export type RunStepView = {
  readonly title: string;
  readonly actorText: string;
  /** Who acted, or on a system step what it reached. */
  readonly label: ScenarioLabel;
  /** Each outside place the step reached, in the server's order. Empty when nothing left the server. Null on a run that kept no reach. */
  readonly reached: readonly RunReachView[] | null;
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
  "buyer-dispute": { jobStatus: "PAID", reason: "CLIENT_APPROVAL" },
  "deadline-refund": { jobStatus: "REFUNDED", reason: "DELIVERY_DEADLINE" },
};

const STEP_TITLES: Readonly<Record<string, string>> = {
  "open-job": "Client opens the job",
  "place-bid": "Operator places a bid",
  "accept-and-fund": "Client accepts and funds escrow",
  "push-honest-reference-table": "Scripted agent writes the honest fix",
  "push-cheat-hardcode-visible-values": "Scripted agent writes the shortcut",
  "push-cheat-edit-frozen-test": "Scripted agent edits the frozen test",
  submit: "Verifier checks the submission",
  approve: "Client approves the delivery",
  dispute: "Client disputes the delivery",
  "dispute-created": "Buyer opens a PayPal dispute",
  "dispute-resolved": "PayPal resolves the dispute",
  "arbiter-verdict": "Arbiter rules on the dispute",
  release: "Escrow releases the payout",
  "advance-clock": "Job clock moves 2 days",
  refund: "Escrow refunds the client",
  settle: "Pending work settles",
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
  "Simulated PayPal dispute": null,
  "Real verifier run": null,
  "PayPal sandbox": "No real money moves.",
  "GitHub work repository": null,
  "Server record (no outside call)": null,
};

const STATE_WORDS: Readonly<Record<ScenarioRun["state"], string>> = { RUNNING: "Running", DONE: "Done", FAILED: "Failed" };

// Refusals in plain words. A code not named here keeps the page's own wording for the codes it already knows.
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  UNKNOWN_SCENARIO: "That scenario does not exist.",
  NOT_DEMO_VISITOR: "Make your account first. A scenario runs in a workspace of its own.",
  UNAUTHENTICATED: "Your session has ended. Open your saved account link to sign in again.",
  NOT_FOUND: "That scenario run no longer exists.",
  SCENARIO_FIXTURE_MISSING: "This deployment does not carry the job the scenarios open on, so no scenario can run here.",
  SCENARIO_FIXTURE_MISMATCH: "The scenarios' job is not on the repository this deployment copies workspaces from, so no scenario can run here.",
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
const JOB_NOTE = "The job page shows where this run left the job.";

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

// A wait-only step's outcome: the status the job already held, then the step that settled it by its id, when one did.
// The status reads in plain words and the settling step by its title, so "REFUNDED (already settled by settle)" reads
// "Refunded (already settled at Pending work settles)".
const ALREADY_SETTLED = /^([A-Z_]+) \(already settled(?: by ([a-z-]+))?\)$/;

// The outcomes a buyer dispute's steps record, in plain words. Any other outcome reads as the server sent it. The approve
// step's HELD is read only on that step: accept-and-fund also records HELD, in every scenario.
const APPROVED_HELD = "Approved. The payout is held while the dispute is open.";
const DISPUTE_OUTCOME_WORDS: Readonly<Record<string, string>> = {
  "dispute OPEN": "The dispute is open with PayPal, and the payout is held.",
  "dispute RESOLVED_SELLER_FAVOUR": "PayPal resolved the dispute for the seller.",
};

// The reasons a run's end can name, in the words a person reads. Other reasons read through reasonWords, the receipt's table.
const END_REASON_WORDS: Readonly<Record<string, string>> = {
  CLIENT_APPROVAL: "Approved by the client",
  ARBITER_UPHELD: "Upheld by the arbiter",
  DELIVERY_DEADLINE: "Delivery deadline passed",
};

/** A closed code in words, so "IN_PROGRESS" reads "In progress". */
function plainWords(code: string): string {
  const words = code.toLowerCase().replace(/[_:]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function reasonWordsOf(code: string): string {
  return lookup(END_REASON_WORDS, code) ?? (reasonWords(code) === code ? plainWords(code) : reasonWords(code));
}

// A step's outcome as the server sends it: a closed code, a rejection with its reason, a failure, or a settle list.
function outcomeWords(outcome: string): string {
  const rejected = /^REJECTED (\S+)$/.exec(outcome);
  if (rejected?.[1]) return `Rejected: ${reasonWordsOf(rejected[1])}.`;
  const failed = /^FAILED (\S+)$/.exec(outcome);
  if (failed?.[1]) return stepWords(failed[1]);
  if (outcome.startsWith("SETTLED ")) return `Settled: ${outcome.slice("SETTLED ".length).toLowerCase().replace(/_/g, " ")}.`;
  // The server names the job, bid, and tree in these outcomes. The page says what happened, and the ids stay in the record.
  if (outcome.startsWith("opened ")) return "Job opened.";
  if (outcome.startsWith("bid ")) return "Bid placed.";
  if (outcome.startsWith("pushed ")) return "Work pushed to the job's repository.";
  if (/^[A-Z_]+$/.test(outcome)) return `${plainWords(outcome)}.`;
  return outcome;
}

function resultWords(name: string, outcome: string): string {
  const settled = ALREADY_SETTLED.exec(outcome);
  if (settled) {
    const [, status = "", step] = settled;
    return `${plainWords(status)} (already settled${step === undefined ? "" : ` at ${stepTitle(step)}`})`;
  }
  return name === "approve" && outcome === "HELD" ? APPROVED_HELD : (lookup(DISPUTE_OUTCOME_WORDS, outcome) ?? outcomeWords(outcome));
}

function observedWords(end: ScenarioEndState): string {
  return end.reason === null ? plainWords(end.jobStatus) : `${plainWords(end.jobStatus)} (${reasonWordsOf(end.reason)})`;
}

/** A start refusal, or a cap refusal, in plain words. The code is the server's closed name. */
export function startRefusalWords(code: string, detail?: string): string {
  return lookup(REFUSAL_WORDS, code) ?? refusalText(code, detail);
}

function stepWords(code: string): string {
  return lookup(REFUSAL_WORDS, code) ?? "Something went wrong. Try again in a moment.";
}

function stepView(step: ScenarioStep): RunStepView {
  // A run stored before reach was kept has no list for its steps, so its reach is unknown, not none.
  return {
    title: stepTitle(step.name),
    actorText: ACTOR_WORDS[step.actor],
    label: step.label,
    reached: step.reached === undefined ? null : step.reached.map(place => ({ label: place, sandboxNote: LABEL_NOTE[place] })),
    result: resultWords(step.name, step.outcome),
    ms: step.ms,
  };
}

function endedText(run: ScenarioRun, end: ScenarioEndState): string {
  return `The job's end state is ${observedWords(end)}, and this scenario needs ${observedWords(EXPECTED_END[run.name])}.`;
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
 * The page's view of one run. `jobHref` is the run's job once the run has stopped: the requester's session reads
 * that job through startedRunJob in the Job query (packages/core/src/acquit.ts), in the platform's read-only view.
 */
export function buildRunView(run: ScenarioRun): RunView {
  return {
    title: cardOf(run.name).title,
    state: run.state,
    stateWords: STATE_WORDS[run.state],
    steps: run.steps.map(stepView),
    endText: endTextOf(run),
    observed: run.endState === null ? null : observedWords(run.endState),
    jobHref: run.state === "RUNNING" || !run.jobId ? null : `/jobs/${encodeURIComponent(run.jobId)}`,
    jobNote: JOB_NOTE,
  };
}
