import type { SessionUser } from "./api";

export function signInPrompt(user: SessionUser): string {
  return `Sign in to the Acquit CLI as ${user.handle} (${user.role.toLowerCase()})?`;
}

/** Words a CLI page shows. A `{ code }` part renders as inline code, so a backtick never reaches the page. */
export type Copy = readonly (string | { readonly code: string })[];

export type Failure = { readonly title: string; readonly body: Copy };

/** A sign-in code is 32 random bytes in base64url: 43 characters of A-Z, a-z, 0-9, "-" and "_". */
const CODE_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** A code of any other shape was never issued, so the page can refuse it without asking the API. */
export function isCodeFormat(code: string): boolean {
  return CODE_FORMAT.test(code);
}

/** The ends of a real code, so the user can match them against the link the terminal printed. */
export function codeHint(code: string): string {
  return `${code.slice(0, 4)}…${code.slice(-4)}`;
}

export const NOT_VALID: Failure = {
  title: "That code is not valid",
  body: ["Check the link your terminal printed, or run ", { code: "acquit login" }, " again."],
};

/** What a sign-in code the API refused says, or null when the failure is something else. */
export function approveFailure(status: number, error: string): Failure | null {
  if (status === 404) return NOT_VALID;
  if (status !== 410) return null;
  const why =
    error === "CLI_CODE_USED" ? "This sign-in link was already used."
      : error === "CLI_CODE_EXPIRED" ? "This sign-in link has expired."
        : "This sign-in link is no longer valid.";
  return { title: "Link no longer valid", body: [`${why} Run `, { code: "acquit login" }, " again."] };
}

/** The plain words of a copy, for a test or a label. */
export function copyText(copy: Copy): string {
  return copy.map((part) => (typeof part === "string" ? part : part.code)).join("");
}
