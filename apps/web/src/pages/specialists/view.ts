// Pure copy and state for the specialist screens. Nothing here reads the network or the DOM, so the wording is tested on its own.

import { parseUsd, runnerLabel, shortId } from "../../format.ts";
import type { AgentRecord, Counts, ExamStatus, NightEvent, ReplaySource, ReportEntry, StandingOrders, StandingOrdersInput, Task } from "./types.ts";

export const STEPS = [
  { step: 1, label: "Plug in", to: "/specialists" },
  { step: 2, label: "The exam", to: "/specialists/exam" },
  { step: 3, label: "Standing orders", to: "/specialists/orders" },
  { step: 4, label: "The night", to: "/specialists/night" },
  { step: 5, label: "The morning", to: "/specialists/morning" },
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

export function gradeWords(grade: number | null): string {
  return grade === null ? "No grade yet" : `Grade ${grade}`;
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

/** The label on a replay. Until part A records a real run, a replay is sample data and says so. */
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

/**
 * Why a live run cannot start from this page, or null when it can. `refusal` is the code a start call last answered with.
 * A 503 for the verifier's CI or for exams not built yet stays on the page as the reason.
 */
export function liveRunBlock(task: Task, acquitted: boolean, refusal: string | null): string | null {
  if (!isExaminable(task)) return "Laser cut has no exam yet.";
  if (acquitted) return "This agent is already Acquitted.";
  return refusal === null ? null : examStartWords(refusal);
}

/** The sentence for a start refusal that blocks live runs from this page. Other codes return null and show as errors. */
export function examStartWords(code: string): string | null {
  if (code === "VERIFIER_CI_NOT_CONFIGURED") return "The verifier's CI is not set up on this deployment, so a live run cannot start.";
  if (code === "EXAM_NOT_BUILT") return "Exams are not set up on this deployment yet.";
  return null;
}

export const DEFAULT_PRICE_USD = "10.00";

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
    priceUsd: (orders.priceFloorCents / 100).toFixed(2),
    maxConcurrent: orders.maxConcurrent,
    preApproveCap: orders.preApproveCap,
    autopilot: orders.autopilot,
  };
}

export type OrdersProblems = { readonly priceUsd?: string };

export function formProblems(form: OrdersForm): OrdersProblems | null {
  const cents = parseUsd(form.priceUsd);
  if (cents === null || cents <= 0) return { priceUsd: "Enter a price such as 40 or 40.00." };
  return null;
}

/** The body for PUT standing orders. Autopilot and pre-approval switch together: a pre-approved submit needs both on. */
export function toOrdersInput(form: OrdersForm, runsOn: "owner" | "acquit"): StandingOrdersInput {
  return {
    priceFloorCents: parseUsd(form.priceUsd) ?? 0,
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
    parseUsd(form.priceUsd) !== saved.priceFloorCents ||
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

/** Total of the payouts in cents, for the morning report's headline. */
export function paidTotalCents(payouts: readonly { readonly amountCents: number }[]): number {
  return payouts.reduce((sum, p) => sum + p.amountCents, 0);
}

/** A grade change as "50 → 55". */
export function gradeChangeWords(from: number, to: number): string {
  return `${from} → ${to}`;
}

export const SINCE_HOURS = 24;

/** The "since" a morning report reads from: the last SINCE_HOURS before `now`. */
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

/** The agent a route names, or the first agent when it names none or the one it names is gone. */
export function pickAgent<T extends { readonly id: string }>(agents: readonly T[], id: string | undefined): T | null {
  return agents.find((a) => a.id === id) ?? agents[0] ?? null;
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

/** The timeline tone for a night event: blue while work is open, amber while money is held, green once settled. */
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
