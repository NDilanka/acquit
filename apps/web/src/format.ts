import type { LedgerLine, MergeProgress, ReleaseEvidence } from "./api-types";

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

export function mergeNote(merge: MergeProgress, pullRequest: number | null, mergeCommit: string | null): string {
  switch (merge.phase) {
    case "PENDING":
      return "Merge pending";
    case "MERGED": {
      const what = [pullRequest !== null && `pull request #${pullRequest}`, mergeCommit && `commit ${mergeCommit.slice(0, 7)}`].filter(Boolean);
      return `Merged ${utc(merge.at)}${what.length ? `: ${what.join(", ")}` : ""}`;
    }
    case "NEEDS_HUMAN": {
      const known = mergeReasons[merge.reason];
      return `Needs a person: ${known ? `${known} (${merge.reason})` : merge.reason}`;
    }
  }
}

export function releaseNote(release: ReleaseEvidence): string {
  return `Payout item ${release.payoutItemId}, capture ${release.captureId}`;
}

const reasons: Record<string, string> = {
  NOT_FOUND: "That job or bid no longer exists.",
  NOT_OWNER: "You do not own this job.",
  WRONG_STATE: "The job is not in a state that allows this action.",
  ONBOARDING_REQUIRED: "Finish PayPal payouts onboarding before bidding.",
  PRICE_OVER_BUDGET: "The price is higher than the job budget.",
  ALREADY_BID: "You already placed a bid on this job.",
  HOUSE_ALREADY_BID: "The House has already bid on this job.",
  INSUFFICIENT_CREDITS: "Not enough bid credits. Each bid costs 10.",
  DEADLINE_TOO_FAR: "The deadline must be within 14 days.",
  DEADLINE_PASSED: "The deadline has already passed.",
  ATTEMPTS_EXHAUSTED: "No delivery attempts are left.",
  VERIFIER_PENDING: "The verifier is still running.",
  ARTIFACT_CHANGED: "The delivered artifact changed after verification.",
  REVIEW_CLOSED: "The review window is closed.",
  PAYMENT_IN_PROGRESS: "A payment is in progress for this job.",
  KEY_REUSED_WITH_DIFFERENT_PAYLOAD: "This request was already sent with different values. Reload and try again.",
  BUSY: "The server is busy with this job. Try again in a moment.",
};

export function denied(reason: string): string {
  return `${reasons[reason] ?? "The request was refused."} (${reason})`;
}
