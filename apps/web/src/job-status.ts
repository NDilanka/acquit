import type { BidView, CheckoutPhase, JobView, LedgerLine } from "./api-types";

/** The pill's color class: blue before work starts, amber while work is in flight, red for trouble, green once money moves, grey once ended. */
export type StatusTone = "open" | "held" | "alert" | "ok" | "new";

export type StatusLabel = { readonly label: string; readonly tone: StatusTone };

/** The fields the vocabulary reads. The last verdict tells a rejected job, still holding escrow, from a fresh one. */
export type StatusInput = Pick<JobView, "status" | "phase" | "checkoutPhase"> & {
  readonly attempts: Pick<JobView["attempts"], "last">;
};

/**
 * Every state a job can hold. An OPEN funding job splits by its checkout phase. An IN_PROGRESS job splits by
 * whether its last verdict rejected, since a rejection keeps escrow held until the next attempt or the refund.
 */
export type StateKey =
  | "OPEN/BIDDING"
  | `OPEN/FUNDING/${CheckoutPhase}`
  | "IN_PROGRESS/READY"
  | "IN_PROGRESS/READY/REJECTED"
  | "IN_PROGRESS/VERIFYING"
  | "IN_PROGRESS/REFUND_PENDING"
  | "IN_PROGRESS/REFUND_PENDING/REJECTED"
  | "VERIFIED/AWAITING_CLIENT"
  | "VERIFIED/DISPUTED"
  | "VERIFIED/RELEASE_PENDING"
  | "VERIFIED/REFUND_PENDING"
  | "PAID/PAID"
  | "REFUNDED/REFUNDED"
  | "CLOSED/CLOSED";

const WAITING: StatusLabel = { label: "Waiting for payment", tone: "open" };
const HELD: StatusLabel = { label: "Held in escrow", tone: "held" };
const REJECTED: StatusLabel = { label: "Rejected (escrow still held)", tone: "alert" };

/** One label per reachable state. A state added to StateKey fails typecheck until it has a row here. */
const LABELS: Record<StateKey, StatusLabel> = {
  "OPEN/BIDDING": { label: "Open for bids", tone: "open" },
  "OPEN/FUNDING/CREATING_ORDER": WAITING,
  "OPEN/FUNDING/AWAITING_APPROVAL": WAITING,
  "OPEN/FUNDING/CAPTURING": WAITING,
  // A capture that did not match its quote refunds, and the money stays held until the refund settles.
  "OPEN/FUNDING/REFUND_PENDING": HELD,
  "IN_PROGRESS/READY": HELD,
  "IN_PROGRESS/READY/REJECTED": REJECTED,
  "IN_PROGRESS/VERIFYING": { label: "Being verified", tone: "held" },
  "IN_PROGRESS/REFUND_PENDING": HELD,
  "IN_PROGRESS/REFUND_PENDING/REJECTED": REJECTED,
  "VERIFIED/AWAITING_CLIENT": { label: "Verified (awaiting review)", tone: "held" },
  "VERIFIED/DISPUTED": { label: "Disputed", tone: "alert" },
  "VERIFIED/RELEASE_PENDING": { label: "Paying out", tone: "ok" },
  // An arbiter's refund is still in flight, so the dispute is what the client sees until the money moves.
  "VERIFIED/REFUND_PENDING": { label: "Disputed", tone: "alert" },
  "PAID/PAID": { label: "Paid", tone: "ok" },
  "REFUNDED/REFUNDED": { label: "Refunded", tone: "new" },
  "CLOSED/CLOSED": { label: "Closed", tone: "new" },
};

function unlabeled(job: StatusInput): never {
  throw new Error(`no status label for ${job.status}/${job.phase}`);
}

export function stateKey(job: StatusInput): StateKey {
  const rejected = job.attempts.last === "REJECTED";
  switch (job.status) {
    case "OPEN":
      if (job.phase === "BIDDING") return "OPEN/BIDDING";
      if (job.phase === "FUNDING") return `OPEN/FUNDING/${job.checkoutPhase ?? "CREATING_ORDER"}`;
      return unlabeled(job);
    case "IN_PROGRESS":
      if (job.phase === "VERIFYING") return "IN_PROGRESS/VERIFYING";
      if (job.phase === "READY") return rejected ? "IN_PROGRESS/READY/REJECTED" : "IN_PROGRESS/READY";
      if (job.phase === "REFUND_PENDING") return rejected ? "IN_PROGRESS/REFUND_PENDING/REJECTED" : "IN_PROGRESS/REFUND_PENDING";
      return unlabeled(job);
    case "VERIFIED":
      if (job.phase === "AWAITING_CLIENT") return "VERIFIED/AWAITING_CLIENT";
      if (job.phase === "DISPUTED") return "VERIFIED/DISPUTED";
      if (job.phase === "RELEASE_PENDING") return "VERIFIED/RELEASE_PENDING";
      if (job.phase === "REFUND_PENDING") return "VERIFIED/REFUND_PENDING";
      return unlabeled(job);
    case "PAID":
      return "PAID/PAID";
    case "REFUNDED":
      return "REFUNDED/REFUNDED";
    case "CLOSED":
      return "CLOSED/CLOSED";
  }
}

/** The one label for a job everywhere it shows: pills, tables, and the job page. */
export function statusLabel(job: StatusInput): StatusLabel {
  return LABELS[stateKey(job)];
}

const ESCROW: Record<JobView["escrow"], string> = { NONE: "Not funded", HELD: "Held", RELEASED: "Released", REFUNDED: "Refunded" };
export function escrowWord(escrow: JobView["escrow"]): string {
  return ESCROW[escrow];
}

const BID_STATUS: Record<BidView["status"], string> = {
  PENDING: "Pending",
  CHOSEN: "Chosen",
  ACCEPTED: "Accepted",
  NOT_SELECTED: "Not selected",
  RETURNED: "Returned",
};
export function bidStatusWord(status: BidView["status"]): string {
  return BID_STATUS[status];
}

const LEDGER_KIND: Record<LedgerLine["kind"], string> = { HELD: "Held", RELEASED: "Released", FEE: "Fee", REFUND: "Refunded" };
export function ledgerKindWord(kind: LedgerLine["kind"]): string {
  return LEDGER_KIND[kind];
}

const VERDICT: Record<"VERIFIED" | "REJECTED", StatusLabel> = {
  VERIFIED: { label: "Verified", tone: "ok" },
  REJECTED: { label: "Rejected", tone: "alert" },
};
export function verdictLabel(result: "VERIFIED" | "REJECTED"): StatusLabel {
  return VERDICT[result];
}

const RUN_FAILURE: Record<string, string> = {
  PUBLISH_FAILED: "the result could not be published",
  SOURCE_UNAVAILABLE: "the source could not be fetched",
  SUBJECT_UNSTARTABLE: "the test subject would not start",
  SUBJECT_KILLED: "the test subject was killed",
  CONTRACT_MISMATCH: "the run did not match the contract",
  RUN_DEADLINE_EXCEEDED: "the run ran past its deadline",
};
/** A run failure in plain words. A name the table does not know reads as the server sent it. */
export function runFailureWord(name: string): string {
  return RUN_FAILURE[name] ?? name;
}
