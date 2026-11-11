import type { Delivery, InspectFinding } from "./contract.ts";
import { LASER_CHECKER } from "./laser-deliveries.ts";

/** How a measured value reads: its label, unit and decimals. Keys without an entry are labelled from their name. */
export type MeasuredFormat = { readonly label: string; readonly unit?: string; readonly digits?: number };

/** The machine drawn around the scene. "none" draws the scene on a plain floor. */
export type Dressing = "laser" | "none";

/** Everything the inspector needs from one checker. Adding a checker is adding one entry to CHECKERS. */
export type CheckerEntry = {
  readonly workflow: string;
  /** One sentence naming the job the deliveries answer, read from the spec. */
  readonly jobSummary: () => string;
  readonly specFileName: string;
  readonly specText: string;
  readonly deliveries: readonly Delivery[];
  /** Delivery ids shown before "More cheats", in order. The rest follow in catalogue order. */
  readonly featured: readonly string[];
  /** A plain name for each public rule id. A rule without one is shown by its id. */
  readonly ruleNames: Readonly<Record<string, string>>;
  /** A plain caption for a failed public finding, built only from its message; null falls back to the message. */
  readonly failCaption: (finding: InspectFinding) => string | null;
  readonly measured: Readonly<Record<string, MeasuredFormat>>;
  readonly dressing: Dressing;
  /** The caption while the machine runs. */
  readonly runCaption: string;
};

export const CHECKERS: Readonly<Record<string, CheckerEntry>> = {
  [LASER_CHECKER.workflow]: LASER_CHECKER,
};

export const DEFAULT_WORKFLOW = LASER_CHECKER.workflow;

export function checkerFor(workflow: string): CheckerEntry | null {
  return CHECKERS[workflow] ?? null;
}
