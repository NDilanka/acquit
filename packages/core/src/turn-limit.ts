// The `detail` a 429 MODEL_BUDGET carries when a turn is refused before any model call, so the browser can say which
// limit ran out. The API sends one of these tokens, and apps/web/src/ask-ledger.ts maps each to its own copy. A refusal
// from the shared model budget names the window that ran out (the rolling minute or day, shared with other callers). The
// one case with no token is a budget lock that never freed, which keeps the generic copy.

/** The account's or address's turns in the rolling minute are used up. */
export const TURN_LIMIT_MINUTE_DETAIL = "per-minute";
/** The account's or address's turns in the rolling day are used up. */
export const TURN_LIMIT_DAY_DETAIL = "per-day";
/** The sample book's turns that may run at once are all in use. */
export const TURN_BUSY_DETAIL = "busy";
/** One visitor's model calls in the rolling day are used up inside the sample book's group. Retries count. */
export const PER_KEY_DAY_DETAIL = "per-key-day";
/** The shared model budget's rolling minute, or a caller group's minute inside it, is used up. Other visitors share it. */
export const SHARED_MINUTE_DETAIL = "shared-minute";
/** The shared model budget's rolling day, or a caller group's day inside it, is used up. Other visitors share it. */
export const SHARED_DAY_DETAIL = "shared-day";

/** The window that refused a turn, when a per-account or per-address limit refused it. */
export type TurnWindow = typeof TURN_LIMIT_MINUTE_DETAIL | typeof TURN_LIMIT_DAY_DETAIL;
