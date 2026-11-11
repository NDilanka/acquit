// The page's words about the second check, in one place so the tests can hold them to what the page really does.
// This demonstration runs every check in the visitor's browser, the second check and its expected points included, so
// nothing here may claim that check is secret from the visitor. Only on a real job is it kept from the agent.

/** The check the agent never sees, by count. */
export function unseenName(count: number): string {
  return count === 1 ? "The check the agent never sees" : "The checks the agent never sees";
}

export const DEMO_LINE = "Shown here for the demonstration";

export const DEMO_INTRO =
  "This page is a demonstration: the public rules and the check the agent never sees both run in your browser, so you can watch them. On a real job that check runs on Acquit's server and the agent never receives it.";

export const HONEST_LINE = "The file is checked by the real checker, running in your browser. The machine run is simulated, and nothing on this page moves money.";

export const MOMENT = {
  main: "Every public rule passed. The check the agent never sees did not.",
  sub: "Shown here for the demonstration. On a real job this check runs on Acquit's server, and the agent never receives it.",
} as const;

export const VERDICT_LINE = {
  pass: "On a real job: passed, payment could be released.",
  fail: "On a real job: rejected, no payment.",
} as const;

export function unseenRunning(): string {
  return "Running the check the agent never sees.";
}

export function unseenNext(): string {
  return "Every public rule passed. Now the check the agent never sees.";
}

/** The verdict's detail line when only the unseen checks decided it, or when everything passed. */
export function verdictDetail(publicCount: number, unseenCount: number, unseenFailed: number, pass: boolean): string {
  if (pass) {
    if (unseenCount === 0) return `All ${publicCount} public rules passed.`;
    return `All ${publicCount} public rules passed, and ${unseenCount === 1 ? "so did the check the agent never sees" : `so did all ${unseenCount} checks the agent never sees`}.`;
  }
  return `Every public rule passed, and ${unseenFailed === 1 ? "the check the agent never sees" : `${unseenFailed} checks the agent never sees`} failed.`;
}
