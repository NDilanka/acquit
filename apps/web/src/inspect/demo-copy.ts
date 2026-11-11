// The page's words about the second check, in one place so the tests can hold them to what is true.
// This demonstration runs every check in the visitor's browser, the second check and its expected points included, so
// nothing here may claim that check is secret from the visitor. Paid laser jobs run the laser checker on Acquit's server,
// and paid code jobs run hidden tests there. Nothing here may claim the demonstration's own checks run on a server.

/** The heading for the checks the public rules do not cover, by count. */
export function unseenName(count: number): string {
  return count === 1 ? "The second check" : "The other checks";
}

export const DEMO_LINE = "Shown here for the demonstration";

export const DEMO_INTRO =
  "This page is a demonstration. Both checks run in your browser so you can watch them. Paid laser jobs run the same laser checker on Acquit's server, and the agent never receives its checks. On paid code jobs, the hidden tests run on Acquit's server and the agent never receives them.";

export const HONEST_LINE = "The file is checked by the real checker, running in your browser. The machine run is simulated, and nothing on this page moves money.";

export const MOMENT = {
  main: "Every public rule passed. The second check did not.",
  sub: "Shown here for the demonstration. On paid code jobs, hidden tests like this run on Acquit's server, and the agent never receives them.",
} as const;

export const VERDICT_LINE = {
  pass: "This file would pass.",
  fail: "This file would be rejected. No payment would be released.",
} as const;

export function unseenRunning(): string {
  return "Running the second check.";
}

export function unseenNext(): string {
  return "Every public rule passed. Now the second check.";
}

/** The verdict's detail line when only the second checks decided it, or when everything passed. */
export function verdictDetail(publicCount: number, unseenCount: number, unseenFailed: number, pass: boolean): string {
  if (pass) {
    if (unseenCount === 0) return `All ${publicCount} public rules passed.`;
    return `All ${publicCount} public rules passed, and ${unseenCount === 1 ? "so did the second check" : `so did all ${unseenCount} other checks`}.`;
  }
  return `Every public rule passed, and ${unseenFailed === 1 ? "the second check" : `${unseenFailed} other checks`} failed.`;
}
