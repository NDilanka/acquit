// The /print page's wording and view rules. The page reads this module, the shared catalog of frauds and the pass
// rule (dependency-free, so the browser can bundle it), and the API's run record.

import { PASS_RULE } from "../../../packages/verifier-print/src/catalog.ts";
import type { PrintChallengeView, PrintDemoRunView, PrintOutcomeView } from "./api-types.ts";

export const PRINT_TITLE = "3D printing (FDM)";

export const PRINT_INTRO = "A simulated farm answers five hidden print jobs and one trap job. A farm that qualifies may print one job, and the real print judge decides whether that print is honest. Every farm, printer, and camera on this page is Simulated.";

/** What the page's runs are made of. The judge is real; the rest is Simulated. */
export const REAL_AND_SIMULATED = [
  { label: "Real", text: "The print judge. It is the same code that the score card on the verifiers page tests, and it runs on this server for each print." },
  { label: "Simulated", text: "The farm, its printer's telemetry, its camera photos, and the G-code. The G-code comes from a built-in generator, not from a slicer." },
] as const;

export const QUALIFICATION_RULE = "A farm qualifies when it fulfils all five challenges and declines the trap with a reason. A farm that does not qualify never prints.";

export const TRAP_NOTE = "The trap is a 300 mm cube, wider than the farm's 250 mm bed. A farm must decline it and say why.";

export const HONEST_LIMIT = "Software proves the G-code and the evidence, not the atoms.";

export const MONEY_LINE = "Money: next. Print jobs do not move money yet.";

/** The farm's name as the page shows it. Every farm on this page is Simulated, and the heading says so. */
export function farmHeading(name: string): string {
  return `${name} (Simulated)`;
}

/** The tally in one sentence, read from the run's own counts and its qualified flag. */
export function tallyLine(qualification: PrintDemoRunView["qualification"]): string {
  const counts = `Fulfilled ${qualification.fulfilled} of ${PASS_RULE.fulfilled} challenges. Declined ${qualification.declinedTraps} of ${PASS_RULE.declinedTraps} trap.`;
  return qualification.qualified ? `${counts} Qualified.` : `${counts} Not qualified, so it did not print.`;
}

/** One challenge's status in a word. A trap is Declined when the farm declined it with a reason. */
export function challengeStatus(challenge: PrintChallengeView): string {
  if (challenge.expect === "FULFIL") return challenge.passed ? "Fulfilled" : "Not passed";
  return challenge.passed ? "Declined" : "Accepted";
}

/** The run's verdict as the page words it: the judge's result, and the known gap named where it applies. */
export function verdictView(outcome: PrintOutcomeView): { readonly tone: "ok" | "alert"; readonly title: string; readonly sentence: string } {
  if (outcome.verdict === "REJECTED") {
    return { tone: "alert", title: "Rejected", sentence: "The judge refused this print, for the reasons below." };
  }
  const gap = outcome.fraud?.knownGap
    ? " This fraud is the known gap: the judge matches only the file hash, so an earlier print of the same file passes."
    : "";
  return { tone: "ok", title: "Verified", sentence: `The judge accepted this print.${gap}` };
}

/** What the farm did with the print, in one sentence. */
export function farmDoingLine(outcome: PrintOutcomeView): string {
  return outcome.fraud === null
    ? "The farm printed what it submitted."
    : `The farm ran a planted fraud: ${outcome.fraud.label.charAt(0).toLowerCase()}${outcome.fraud.label.slice(1)}.`;
}

/** The evidence the judge read, one row each. The telemetry and the photos are Simulated, and their labels say so. */
export function evidenceRows(evidence: PrintOutcomeView["evidence"]): readonly { readonly label: string; readonly value: string }[] {
  return [
    { label: "Layers in the G-code", value: String(evidence.layers) },
    { label: "Filament in the G-code", value: `${evidence.filamentMm} mm` },
    { label: "Filament in the telemetry (Simulated)", value: `${evidence.telemetryFilamentMm} mm` },
    { label: "Time estimated from the G-code", value: durationWords(evidence.estimatedS) },
    { label: "Time in the telemetry (Simulated)", value: durationWords(evidence.telemetryS) },
    { label: "Telemetry frames (Simulated)", value: String(evidence.frames) },
    { label: "Camera photos (Simulated)", value: String(evidence.photos) },
  ];
}

/** A length of time in whole seconds, in minutes and seconds: 1255 is "20 min 55 s", 45 is "45 s". */
export function durationWords(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes === 0 ? `${rest} s` : `${minutes} min ${rest} s`;
}

const PRINT_REFUSAL_WORDS: Partial<Record<string, string>> = {
  PRINT_RUNNING_LIMIT: "A run of yours is still going. Wait for it to finish, then start another.",
  PRINT_BUSY: "The print demo is busy with other runs. Try again in a minute.",
  PRINT_RATE_LIMITED: "You have started the most runs allowed this hour. Try again later.",
  PRINT_STORE_FULL: "The print demo has no room for another run right now. Try again later.",
  UNKNOWN_FARM: "That farm is not one the print demo runs.",
  NOT_FOUND: "That run is not here. The server may have restarted and dropped it.",
};

/** A refusal of a print run in plain words, or null when the code is not one the print demo sends. */
export function printRefusalWords(code: string): string | null {
  return PRINT_REFUSAL_WORDS[code] ?? null;
}

/** Why a run stopped without a result, in plain words. */
export function failureWords(failure: string | null): string {
  return failure === "TIMED_OUT"
    ? "The run passed its time limit and stopped. Start it again."
    : "The run failed on the server. Start it again.";
}
