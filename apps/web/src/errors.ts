import { ApiError } from "./api.ts";
import { PITCH_MAX } from "./bid-rules.ts";

/** What an error the page cannot name shows. The raw code goes in a Details line, never in the sentence. */
export const FALLBACK_WORDS = "Something went wrong. Try again in a moment.";

const WORDS = new Map<string, string>(
  Object.entries({
    // The API's own refusals (apps/api/src/server.ts) and the domain's DENIED reasons (packages/core/src/job.ts).
    AGENT_EXISTS: "You already have an agent with that name.",
    ALREADY_BID: "You already placed a bid on this job.",
    ALREADY_FROZEN: "The job's tests are already frozen. Refresh the page to see them.",
    ARTIFACT_CHANGED: "The delivered artifact changed after verification.",
    ASK_BODY_TOO_LARGE: "That message is too long. Shorten it and try again.",
    ATTEMPTS_EXHAUSTED: "No delivery attempts are left.",
    BUDGET_BELOW_MINIMUM: "The budget must be at least 10.00 USD.",
    BUSY: "The server is busy with this job. Try again in a moment.",
    CAP_AMOUNT: "That budget is higher than a sandbox job allows.",
    CAP_MODEL_RUNS: "Your account has used its verifier runs for today.",
    CAP_MODEL_RUNS_DAY: "The verifier has reached its daily limit for every account. Try again tomorrow.",
    CAP_SCENARIOS_DAY: "Scenario runs have reached today's limit for the whole deployment. Try again tomorrow.",
    CAP_SCENARIOS_REQUESTER_DAY: "You have used today's scenario runs. Try again tomorrow.",
    CAP_SPEND_DAY: "Your account has reached its daily limit for job budgets.",
    CAP_STARTER_JOBS_DAY: "New starter jobs arrive tomorrow.",
    CAP_VISITOR_JOBS: "Your account has opened as many jobs as an account can.",
    CAP_VISITORS_DAY: "Acquit has made as many new accounts as it can today. Try again tomorrow, or open your saved account link.",
    CLI_CODE_EXPIRED: "This sign-in link has expired. Run acquit login again.",
    CLI_CODE_UNKNOWN: "That sign-in code is not valid. Run acquit login again.",
    CLI_CODE_USED: "This sign-in link was already used. Run acquit login again.",
    CONTRACT_NOT_FROZEN: "The job's tests are not frozen yet.",
    COVERAGE_GATE: "Some rules have no test yet. Add cases for them, then approve again.",
    DEADLINE_PASSED: "The deadline has already passed.",
    DEADLINE_TOO_FAR: "The deadline must be within 14 days.",
    DEMO_NOT_CONFIGURED: "Accounts are not set up on this deployment yet.",
    DEMO_PRIVATE: "Acquit is private for now.",
    DEMO_REPOSITORY_FAILED: "GitHub could not create your workspace repository. Try again in a moment.",
    DEV_DISABLED: "Dev tools are off on this deployment.",
    FUNDING_BOUND: "The payment method was fixed when a bid was accepted.",
    GITHUB_NOT_CONFIGURED: "GitHub is not connected on this deployment yet.",
    HOUSE_ALREADY_BID: "The House has already bid on this job.",
    INSUFFICIENT_CREDITS: "Not enough bid credits. Each bid costs 10.",
    INTERNAL_ERROR: "Something went wrong on the server. Try again in a moment.",
    JOB_CHANGED: "The job changed while its clock moved. Try again.",
    JOB_NOT_OPEN: "This job is no longer open for bids.",
    KEY_REUSED_WITH_DIFFERENT_PAYLOAD: "This request was already sent with different values. Reload and try again.",
    MODEL_BUDGET: "The verifier has used its budget for today. Try again tomorrow.",
    MODEL_KEY_MISSING: "The assistant has no model key on this deployment.",
    NO_DRAFT: "The hidden tests are not drafted yet.",
    NO_MANIFEST: "The job has no frozen test manifest yet.",
    NOT_AN_ACCOUNT: "Only a Try Acquit account can do this.",
    NOT_DEMO_VISITOR: "Only a Try Acquit account can switch between client and operator.",
    NOT_FOUND: "That job or bid no longer exists.",
    NOT_OWNER: "You do not own this job.",
    NOT_VISITOR_JOB: "Only the job's client can change this job.",
    NOTHING_APPROVED: "Approve at least one test before you continue.",
    ONBOARDING_REQUIRED: "Finish PayPal payouts onboarding before bidding.",
    ORIGIN_DENIED: "This page cannot be used from this address.",
    PAYMENT_IN_PROGRESS: "A payment is in progress for this job.",
    PAYPAL_NOT_CONFIGURED: "PayPal is not set up on this deployment yet.",
    PAYPAL_READ_FAILED: "PayPal could not be reached. Try again in a moment.",
    PLATFORM_KEY_MISMATCH: "That platform key is not right.",
    PLATFORM_KEY_UNSET: "Platform sign-in is not set up on this deployment.",
    PLATFORM_ONLY: "Only the platform can open this.",
    PLATFORM_READ_ONLY: "The platform view is read only.",
    PRICE_OVER_BUDGET: "The price is higher than the job budget.",
    RESTORE_LIMITED: "Too many tries from this network. Wait 15 minutes, then open the link again.",
    REVIEW_CLOSED: "The review window is closed.",
    SEEDED_LOGIN_DISABLED: "Seeded sign-in is off on this deployment. Use Try Acquit instead.",
    SESSION_MINT_DISABLED: "Starting a session is off on this deployment.",
    TOOL_FAILED: "The assistant's tool failed. Try again in a moment.",
    UNAUTHENTICATED: "Your sign-in has expired. Sign in again.",
    UNKNOWN_FIGURE: "That figure is not in the ledger.",
    UNKNOWN_USER: "That user does not exist on this deployment.",
    VERIFIER_CI_NOT_CONFIGURED: "The verifier's CI is not set up on this deployment.",
    VERIFIER_MISMATCH: "The verifier's result did not match this job.",
    VERIFIER_PENDING: "The verifier is still running.",
    WEBHOOK_BODY_TOO_LARGE: "The webhook body was too large.",
    WORK_REPO_NOT_READY: "The work repository is not ready yet. Try again in a moment.",
    WORK_REPO_TOKEN_FAILED: "The work repository could not be opened. Try again in a moment.",
    WRONG_STATE: "The job is not in a state that allows this action.",
    BAD_RESPONSE: "The server sent a reply the page could not read. Try again.",
  }),
);

/** A bad request names only the field it refused, and the server's detail says which: the wording matches the form's rule. */
const BAD_INPUT_WORDS = new Map<string, string>(
  Object.entries({
    "Invalid pitch": `Write a pitch: one sentence on how the work will be done, at most ${PITCH_MAX} characters.`,
    "Invalid price": "Enter a price such as 400 or 400.00.",
    "Invalid agent": "Pick an agent to bid with.",
    "Invalid ETA": "Pick a delivery time of up to 14 days.",
    "Invalid budget": "Enter the budget in dollars, such as 400 or 400.00.",
    "Invalid deadline": "Pick a deadline within 14 days.",
  }),
);
const BAD_INPUT_FALLBACK = "Some of the details are not valid. Check the form and try again.";
const BAD_INPUT_CODES = new Set(["BAD_REQUEST", "BAD_COMMAND"]);

/** Whether the page has a plain sentence for this code, so the raw code may stay out of view. */
export function isKnownCode(code: string, detail?: string): boolean {
  if (BAD_INPUT_CODES.has(code)) return detail !== undefined && BAD_INPUT_WORDS.has(detail);
  return WORDS.has(code);
}

/** One plain sentence for an error code (and the server's detail, where it names a field). Unknown codes read generically. */
export function errorWords(code: string, detail?: string): string {
  if (BAD_INPUT_CODES.has(code)) {
    return (detail !== undefined && BAD_INPUT_WORDS.get(detail)) || BAD_INPUT_FALLBACK;
  }
  return WORDS.get(code) ?? FALLBACK_WORDS;
}

export type DescribedError = {
  /** The sentence the screen shows. */
  readonly message: string;
  /** The code and the server's detail, shown only when the page has no sentence for them: a copyable Details line. */
  readonly details: string | null;
};

/** The sentence a failed call shows. A code the page has no words for reads generically, never as CODE: detail. */
export function errorText(e: unknown): string {
  return describeError(e).message;
}

/** Any thrown value as a sentence plus, for an unknown code, the code for a Details line. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof ApiError) {
    const known = isKnownCode(error.code, error.detail);
    const raw = [error.code, error.detail].filter(Boolean).join(": ");
    return { message: errorWords(error.code, error.detail), details: known ? null : raw };
  }
  return { message: "Cannot reach the server. Check your connection and try again.", details: null };
}
