// Pure copy and state for the specialist screens. Nothing here reads the network or the DOM, so the wording is tested on its own.

import { parseUsd, runnerLabel, shortId } from "../../format.ts";
import type {
  AgentRecord,
  Counts,
  ExamStatus,
  Gate,
  NightEvent,
  ReplaySource,
  ReportEntry,
  StandingOrders,
  StandingOrdersInput,
  Task,
} from "./types.ts";

export const STEPS = [
  { step: 1, label: "Plug in", to: "/specialists" },
  { step: 2, label: "Exam", to: "/specialists/exam" },
  { step: 3, label: "Orders", to: "/specialists/orders" },
  { step: 4, label: "Activity", to: "/specialists/activity" },
  { step: 5, label: "Earnings", to: "/earnings" },
] as const;

const TASK_LABEL: Record<Task, string> = { code: "Code", "print-fdm": "3D print", "laser-cut": "Laser cut" };

export function taskLabel(task: Task): string {
  return TASK_LABEL[task];
}

/** The note under a simulated machine's name. Only the simulated machines carry it. */
export function simulatedNote(task: Task): string | null {
  if (task === "print-fdm") return "Simulated · No real hardware";
  if (task === "laser-cut") return "Simulated · coming";
  return null;
}

/** The only status words an agent shows. Never "cleared", "licensed" or "certified". */
export function acquittedWords(acquitted: boolean): string {
  return acquitted ? "Acquitted" : "not acquitted";
}

/** The label beside "Acquitted" when the acquittal came from a simulated run. */
export const SIMULATED_WORD = "Simulated";

export function gradeWords(grade: number | null): string {
  return grade === null ? "No grade yet" : `Grade ${grade}`;
}

/** The bid gate in plain words. The two closed reasons name what the agent still lacks. */
const GATE_WORDS: Record<Gate, string> = {
  OPEN: "Open",
  NOT_ACQUITTED: "Closed: not acquitted",
  WRONG_TASK: "Closed: only code work passes",
};

export function gateWords(gate: Gate): string {
  return GATE_WORDS[gate];
}

/** The simulated machines' runners have no product name, so they read as a neutral "Simulated runner". */
const SIMULATED_RUNNERS: Record<string, string> = { "simulated-fdm": "Simulated runner", "simulated-laser": "Simulated runner" };

export function runnerWords(runner: string): string {
  return SIMULATED_RUNNERS[runner] ?? runnerLabel(runner);
}

/** Autopilot runs claude-code agents only. Other runners keep the switch off. */
export function autopilotSupported(runner: string): boolean {
  return runner === "claude-code";
}

/** Laser cut has no exam, so the API refuses to plug it in (TASK_NOT_EXAMINABLE). Only the other two tasks can be plugged in. */
export function isExaminable(task: Task): boolean {
  return task !== "laser-cut";
}

/** Plugging in print is supported, but only code has an exam in this build. */
export function hasLiveExam(task: Task): boolean {
  return task === "code";
}

/** The label for one check on the exam. Check names stay out of view: the label is a number and the kind of work. */
export function checkLabel(task: Task, n: number): string {
  return task === "print-fdm" ? `Print job ${n}` : `Practice check ${n}`;
}

/** Each check's flag from its count: the first `passed` pass, the rest fail. A live run reports counts only. */
export function flagsFrom(counts: Counts): boolean[] {
  return Array.from({ length: counts.total }, (_, i) => i < counts.passed);
}

export function runsOnWords(runsOn: "owner" | "acquit"): string {
  return runsOn === "acquit" ? "Runs on Acquit's runner" : "Runs on your machine";
}

export function examStatusWords(status: ExamStatus): string {
  switch (status) {
    case "RUNNING":
      return "Running";
    case "VERIFYING":
      return "Checking";
    case "PASSED":
      return "Acquitted";
    case "FAILED":
      return "not acquitted";
    case "ERROR":
      return "Could not finish";
  }
}

export function isOpenExam(status: ExamStatus): boolean {
  return status === "RUNNING" || status === "VERIFYING";
}

/** The label on a replay. Until a real run is recorded, a replay is sample data and says so. */
export function replayLabel(source: ReplaySource): string {
  return source === "recorded" ? "Replay of a recorded run" : "Sample data";
}

export function countsWords(counts: Counts): string {
  return `${counts.passed} of ${counts.total}`;
}

export function hiddenWords(counts: Counts): string {
  return `${counts.passed} passed, ${counts.total - counts.passed} failed`;
}

/** Each reason kind as one plain sentence. The kind and any test name stay out of view. */
export function reasonSentence(kind: string): string {
  switch (kind) {
    case "TESTS_FAILED":
      return "Some checks did not pass.";
    case "TESTS_MISSING":
      return "Some checks did not run.";
    case "SUBJECT_FAULT":
      return "The agent's own work hit a fault while it ran.";
    default:
      return "The run stopped for a reason this page does not name yet.";
  }
}

export function reasonSentences(reasons: readonly string[]): string[] {
  return [...new Set(reasons.map(reasonSentence))];
}

/** The block copy for a task whose exam is not built: laser cut has none, and print's exam is not built in this build. */
const EXAM_COMING = "Exam coming.";

/**
 * Why a live run cannot start from this page, or null when it can. `refusal` is the code a start call last answered with.
 * The verifier's CI gap and the two exam refusals (EXAM_NOT_BUILT, TASK_NOT_EXAMINABLE) stay on the page as the reason.
 */
export function liveRunBlock(task: Task, acquitted: boolean, refusal: string | null): string | null {
  if (!hasLiveExam(task)) return EXAM_COMING;
  if (acquitted) return "This agent is already Acquitted.";
  return refusal === null ? null : examStartWords(refusal);
}

/** The sentence for a start refusal that blocks live runs from this page. Other codes return null and show as errors. */
export function examStartWords(code: string): string | null {
  if (code === "VERIFIER_CI_NOT_CONFIGURED") return "The verifier's CI is not set up on this deployment, so a live run cannot start.";
  if (code === "EXAM_NOT_BUILT" || code === "TASK_NOT_EXAMINABLE") return EXAM_COMING;
  return null;
}

export const DEFAULT_PRICE_USD = "$40.00";

/** The form the standing-orders screen edits. The price is text until it is parsed. */
export type OrdersForm = {
  readonly priceUsd: string;
  readonly maxConcurrent: number;
  readonly preApproveCap: number;
  readonly autopilot: boolean;
};

export const DEFAULT_FORM: OrdersForm = { priceUsd: DEFAULT_PRICE_USD, maxConcurrent: 1, preApproveCap: 3, autopilot: false };

export function formFrom(orders: StandingOrders | null): OrdersForm {
  if (!orders) return DEFAULT_FORM;
  return {
    priceUsd: dollars(orders.priceFloorCents),
    maxConcurrent: orders.maxConcurrent,
    preApproveCap: orders.preApproveCap,
    autopilot: orders.autopilot,
  };
}

export type OrdersProblems = { readonly priceUsd?: string };

/** Accept an optional currency prefix, never strip punctuation out of malformed input. */
export function parsePrice(input: string): number | null {
  return parseUsd(input.trim().replace(/^\$\s*/, ""));
}

export function formProblems(form: OrdersForm): OrdersProblems | null {
  const cents = parsePrice(form.priceUsd);
  if (cents === null || cents <= 0) return { priceUsd: "Enter a price such as 40 or 40.00." };
  return null;
}

/** The body for PUT standing orders. Autopilot and pre-approval switch together: a pre-approved submit needs both on. */
export function toOrdersInput(form: OrdersForm, runsOn: "owner" | "acquit"): StandingOrdersInput {
  return {
    priceFloorCents: parsePrice(form.priceUsd) ?? 0,
    maxConcurrent: form.maxConcurrent,
    autopilot: form.autopilot,
    runsOn,
    preApprove: form.autopilot,
    preApproveCap: form.preApproveCap,
  };
}

/** True when the form differs from the saved orders. An agent with no saved orders is unsaved. */
export function ordersDirty(form: OrdersForm, saved: StandingOrders | null): boolean {
  if (saved === null) return true;
  return (
    parsePrice(form.priceUsd) !== saved.priceFloorCents ||
    form.maxConcurrent !== saved.maxConcurrent ||
    form.autopilot !== saved.autopilot ||
    form.preApproveCap !== saved.preApproveCap
  );
}

/** The two sentences under the autopilot switch. On: the agent acts alone, up to the cap. Off: each submit waits for the owner. */
export function autopilotCopy(autopilot: boolean, cap: number): readonly string[] {
  if (!autopilot) return ["Each submit needs the owner's confirmation."];
  return [
    `With autopilot on, your agent bids, delivers and collects on its own, up to ${cap} submits a day.`,
    "You can close this tab now.",
  ];
}

/** Total of the payouts in cents, for the earnings headline. */
export function paidTotalCents(payouts: readonly { readonly amountCents: number }[]): number {
  return payouts.reduce((sum, p) => sum + p.amountCents, 0);
}

/** A grade change as a signed step: "+5" or "−5". Zero reads "0". */
export function gradeChangeWords(delta: number): string {
  if (delta === 0) return "0";
  return delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
}

export const SINCE_HOURS = 24;

/** The initial report window when the account has no saved read cursor. */
export function sinceIso(now: number): string {
  return new Date(now - SINCE_HOURS * 60 * 60 * 1000).toISOString();
}

/** The grade an agent starts on when it is first Acquitted. */
export const START_GRADE = 50;

/** How many checks each task's exam has, for drawing the board before a live run reports its counts. */
export const EXAM_SHAPE: Record<Task, { readonly visible: number; readonly hidden: number }> = {
  code: { visible: 5, hidden: 3 },
  "print-fdm": { visible: 5, hidden: 1 },
  "laser-cut": { visible: 0, hidden: 0 },
};

/** An explicit id must match. Only an unambiguous, single-agent list may infer a choice. */
export function pickAgent<T extends { readonly id: string }>(agents: readonly T[], id: string | undefined): T | null {
  return id !== undefined ? agents.find((a) => a.id === id) ?? null : agents.length === 1 ? agents[0]! : null;
}

/** Explicit choices must match; otherwise retain the last-used agent or the first available one. */
export function ownerAgent<T extends { readonly id: string }>(agents: readonly T[], id?: string, lastId?: string | null): T | null {
  return id !== undefined ? pickAgent(agents, id) : agents.find((a) => a.id === lastId) ?? agents[0] ?? null;
}

/** Large visible totals use one aggregate bar; icon rows stay readable at phone widths. */
export function checkLayout(total: number, hidden: boolean): { segmented: boolean; rows: number[][] } {
  const segmented = !hidden && total > 8;
  return { segmented, rows: segmented ? [] : Array.from({ length: Math.ceil(total / 4) }, (_, row) =>
    Array.from({ length: Math.min(4, total - row * 4) }, (_, i) => row * 4 + i)) };
}

export function provenanceWords(source: ReplaySource | null, simulated: boolean, seeded = false): string {
  return [source === "recorded" ? "Replay of a recorded run" : source === "fixture" ? "Sample data" : seeded ? "Seeded" : null, simulated ? "Simulated" : null].filter(Boolean).join(" · ");
}

export function localTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat(undefined, {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

/** Owner money uses one format; its caller must keep the status alongside it. */
export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** A track record as one line: "3 taken, 2 verified, 1 rejected". */
export function recordWords(record: AgentRecord): string {
  return `${record.jobsTaken} taken, ${record.verified} verified, ${record.rejected} rejected`;
}

/** A report line's title: the title the API sends, else the job's short id, else the fallback. */
export function entryTitle(entry: ReportEntry, fallback: string): string {
  if (entry.title) return entry.title;
  return entry.jobId ? `Job ${shortId(entry.jobId)}` : fallback;
}

export function nightKindWords(kind: NightEvent["kind"]): string {
  switch (kind) {
    case "bid":
      return "Bid";
    case "win":
      return "Won";
    case "money-held":
      return "Money held";
    case "delivery":
      return "Delivered";
    case "verdict":
      return "Verdict";
  }
}

/** Timeline tone: blue while work is open, amber while money is held, green once settled. */
export function nightTone(kind: NightEvent["kind"]): "open" | "held" | "ok" {
  switch (kind) {
    case "bid":
    case "delivery":
      return "open";
    case "money-held":
      return "held";
    case "win":
    case "verdict":
      return "ok";
  }
}
