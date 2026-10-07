import type { SessionUser } from "./api";

export function signInPrompt(user: SessionUser): string {
  return `Sign in to the Acquit CLI as ${user.handle} (${user.role.toLowerCase()})?`;
}

/** The ends of the code, so the user can match it against the link the terminal printed. */
export function codeHint(code: string): string {
  return code.length <= 8 ? code : `${code.slice(0, 4)}…${code.slice(-4)}`;
}

/** The message for a code the API will no longer approve, or null when the failure is something else. */
export function approveFailure(status: number, error: string): string | null {
  if (status === 410 && error === "CLI_CODE_USED") return "This sign-in link was already used. Run `acquit login` again.";
  if (status === 410 && error === "CLI_CODE_EXPIRED") return "This sign-in link has expired. Run `acquit login` again.";
  if (status === 410 || status === 404) return "This sign-in link is no longer valid. Run `acquit login` again.";
  return null;
}
