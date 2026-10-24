import type { CreditAccountView, DisputeView, JobView, LedgerLine, MergeProgress, RefundReason, ReleaseAuthority } from "./api-types";
import { errorWords } from "./errors.ts";
import { relativeTime } from "./time.ts";

export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac} USD`;
}

/** Parses a whole-or-decimal dollar string into cents without floating point. */
export function parseUsd(input: string): number | null {
  const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + frac;
  return Number.isSafeInteger(cents) ? cents : null;
}

/** The smallest budget a job opens with; apps/api/src/server.ts refuses below the same amount. */
export const MIN_BUDGET_CENTS = 1_000;

/** Why a budget cannot open a job, or null when it can. A blank or unreadable budget is not a number of cents. */
export function budgetProblem(cents: number | null): string | null {
  if (cents === null) return "Enter the budget in dollars, such as 400 or 400.00.";
  if (cents < MIN_BUDGET_CENTS) return `The budget must be at least ${usd(MIN_BUDGET_CENTS)}.`;
  return null;
}

/** Client escrow fee is 5% of the job price, half-up to the cent. Display only; the API is authoritative. */
export function escrowFee(price: number): number {
  return Math.floor((price * 500 + 5000) / 10000);
}

export function utc(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function eta(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "1 day" : `${days} days`;
  }
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

const bare = (cents: number) => usd(cents).replace(" USD", "");

export function dollars(cents: number): string {
  const [whole = "", frac = ""] = bare(Math.abs(cents)).split(".");
  return `${cents < 0 ? "-" : ""}$${whole.replace(/\B(?=(\d{3})+$)/g, ",")}.${frac}`;
}

/** `locked` is the accepted bid, when known, so the HELD split is exact rather than inferred. */
export function ledgerNote(line: LedgerLine, locked: { readonly handle: string; readonly price: number } | null): string {
  switch (line.kind) {
    case "HELD": {
      const job = locked?.price ?? Math.round((line.cents * 100) / 105);
      return `client payment (${bare(job)} job + ${bare(line.cents - job)} escrow fee)`;
    }
    case "RELEASED":
      return `payout to ${locked?.handle ?? "operator"}`;
    case "FEE":
      return `fees (${bare(line.processor)} PayPal processing + ${bare(line.acquit)} Acquit)`;
    case "REFUND":
      return "refunded to client";
  }
}

const mergeReasons: Record<string, string> = {
  GITHUB_MERGE_CONFLICT: "GitHub refused the merge",
};

/** `approved` is the judged tree the client approved; GitHub's merge commit arrives as `merge.sha`. */
export function mergeNote(merge: MergeProgress, pullRequest: number | null, approved: string | null): string {
  switch (merge.phase) {
    case "PENDING":
      return "Merge pending";
    case "MERGED": {
      const what = [
        pullRequest !== null && `pull request #${pullRequest}`,
        merge.sha && `merge commit ${merge.sha.slice(0, 7)}`,
        approved && `approved ${approved.slice(0, 7)}`,
      ].filter(Boolean);
      return `Merged ${utc(merge.at)}${what.length ? `: ${what.join(", ")}` : ""}`;
    }
    case "NEEDS_HUMAN": {
      const known = mergeReasons[merge.reason];
      return `Needs a person: ${known ? `${known} (${merge.reason})` : merge.reason}`;
    }
  }
}

/** An HTTP error code as one plain sentence. The raw code never reaches the screen (errors.ts has the words). */
export function refusalText(code: string, detail?: string): string {
  return errorWords(code, detail);
}

/** `credits` arrives only with an INSUFFICIENT_CREDITS refusal, so the message can say when credits return. */
export function denied(reason: string, credits?: CreditAccountView | null): string {
  if (reason === "INSUFFICIENT_CREDITS" && credits) {
    return (
      `Not enough bid credits: you have ${credits.available} and a bid costs 10. ` +
      `Your weekly allowance of ${credits.weeklyAllowance} returns ${utc(credits.nextGrantAt)}.`
    );
  }
  return errorWords(reason);
}

const authorities: Record<ReleaseAuthority, string> = {
  CLIENT_APPROVAL: "Released on the client's approval",
  REVIEW_SILENCE: "Released after review silence: the client did not respond within 72 hours",
  ARBITER_UPHELD: "Released by the arbiter",
  ARBITER_SLA_MISSED: "Released after the arbiter missed its deadline",
  CAPTURE_CUTOFF: "Released at the PayPal capture cutoff, 21 days after payment",
};

export function authorityNote(authority: ReleaseAuthority): string {
  return authorities[authority] ?? `Released (${authority})`;
}

/**
 * What the arbiter's deadline does with the payout, read after "or" or "If no decision comes by then,". While PayPal holds the payout,
 * the deadline only records the release, so the payout waits on PayPal and the copy never promises it.
 */
export function deadlineOutcome(held: boolean): string {
  return held ? "Acquit records the release for the operator, and the payout waits until PayPal decides the dispute." : "the payout releases to the operator.";
}

export function disputeNote(dispute: DisputeView, held = false): string {
  return `Disputed ${utc(dispute.openedAt)}: ${dispute.reason} The arbiter decides by ${utc(dispute.resolveBy)}, or ${deadlineOutcome(held)}`;
}

/** "20 of 30 left this week. New credits in 2 days." The exact grant time, `utc(credits.nextGrantAt)`, goes in the title beside it. */
export function creditLine(credits: CreditAccountView, now: number): string {
  return `${credits.available} of ${credits.weeklyAllowance} left this week. New credits ${relativeTime(credits.nextGrantAt, now)}.`;
}

const RUNNERS: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex" };

/** An agent's runner in words. A runner this map does not know yet shows as it is, which beats showing nothing. */
export function runnerLabel(runner: string): string {
  return RUNNERS[runner] ?? runner;
}

/** `settled` is true once the job is REFUNDED; `maxAttempts` is the job's attempt allowance (used plus left). */
export function refundNote(reason: RefundReason | null, settled: boolean, maxAttempts: number): string | null {
  switch (reason) {
    case null:
      return null;
    case "ARBITER_REFUND":
      return settled ? "Refunded by the arbiter." : "Refund pending: the arbiter refunded the client.";
    case "DELIVERY_DEADLINE":
      return settled ? "Refunded because the delivery deadline passed." : "Refund pending: the delivery deadline passed.";
    case "ATTEMPTS_EXHAUSTED":
      return settled
        ? `Refunded after all ${maxAttempts} delivery attempts were used.`
        : `Refund pending: all ${maxAttempts} delivery attempts were used.`;
    case "CAPTURE_CUTOFF":
      return settled ? "Refunded at the PayPal capture cutoff." : "Refund pending: the PayPal capture cutoff arrived.";
    case "CAPTURE_MISMATCH":
      return settled
        ? "Refunded because the capture did not match the order."
        : "Refund pending: the capture did not match the order.";
    case "PROVIDER_DISPUTE":
      return settled
        ? "Refunded after PayPal decided the buyer's dispute for the buyer."
        : "Refund pending: PayPal decided the buyer's dispute for the buyer.";
  }
}

/**
 * The served note belongs to the arbiter's most recent decision and stays on the row afterwards, so it is
 * shown only while the outcome is still that decision. Only a REWORK verdict returns a job to IN_PROGRESS
 * once a note exists, so an IN_PROGRESS job with a note and no refund is one the arbiter sent back.
 */
export function arbiterNoteLine(job: Pick<JobView, "status" | "arbiterNote" | "releaseAuthority" | "refundReason">): string | null {
  if (job.arbiterNote === null) return null;
  const decided =
    job.releaseAuthority === "ARBITER_UPHELD" || job.refundReason === "ARBITER_REFUND" || (job.status === "IN_PROGRESS" && job.refundReason === null);
  return decided ? `Arbiter's note: ${job.arbiterNote}` : null;
}

/** The chip's short form: a prefix such as `job_` kept, then eight characters of the id. */
export function shortId(value: string): string {
  const cut = value.indexOf("_") + 1;
  const rest = value.slice(cut);
  return `${value.slice(0, cut)}${rest.slice(0, 8)}${rest.length > 8 ? "…" : ""}`;
}

/** A long value cut in the middle, so both its start and its end stay readable. */
export function middleTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const tail = Math.floor((max - 1) / 3);
  return `${value.slice(0, max - 1 - tail)}…${value.slice(value.length - tail)}`;
}
