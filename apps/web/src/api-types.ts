// Wire shapes from docs/architecture/http.md, mirrored from packages/core/src/acquit.ts.
// Mirrored rather than imported: a type-only import still makes tsc check core's implementation
// files under this app's compiler flags. Brands are dropped because JSON carries plain values.

export type UsdCents = number;
export type Hours = number;
export type Credits = number;
export type Instant = string;

export type JobStatus = "OPEN" | "IN_PROGRESS" | "VERIFIED" | "PAID" | "REFUNDED" | "CLOSED";

export type LedgerLine =
  | { readonly kind: "HELD"; readonly cents: UsdCents; readonly at: Instant }
  | { readonly kind: "RELEASED"; readonly cents: UsdCents; readonly at: Instant }
  | { readonly kind: "FEE"; readonly cents: UsdCents; readonly processor: UsdCents; readonly acquit: UsdCents; readonly at: Instant }
  | { readonly kind: "REFUND"; readonly cents: UsdCents; readonly at: Instant };

export type TestTally = { readonly expected: number; readonly passed: number };

/** Built only when a release settles; served on a PAID job. */
export interface Receipt {
  readonly id: string;
  readonly jobId: string;
  readonly operator: string;
  readonly agent: string;
  readonly pullRequest: number;
  readonly mergeCommit: string;
  readonly frozen: TestTally;
  readonly hidden: TestTally;
  readonly attemptsUsed: number;
  readonly paid: UsdCents;
  readonly releasedAt: Instant;
}

export type MergeProgress =
  | { readonly phase: "PENDING" }
  | { readonly phase: "MERGED"; readonly at: Instant; readonly sha: string | null }
  | { readonly phase: "NEEDS_HUMAN"; readonly reason: string };

/** The referenced payout item that paid the operator, as the release observed it. */
export interface ReleaseEvidence {
  readonly payoutItemId: string;
  readonly captureId: string;
  readonly paid: UsdCents;
  readonly at: Instant;
}

export type ReleaseAuthority = "CLIENT_APPROVAL" | "REVIEW_SILENCE" | "ARBITER_UPHELD" | "ARBITER_SLA_MISSED" | "CAPTURE_CUTOFF";

export interface DisputeView {
  readonly reason: string;
  readonly openedAt: Instant;
  /** The arbiter's deadline. */
  readonly resolveBy: Instant;
}

export interface BidView {
  readonly id: string;
  readonly operator: string;
  readonly handle: string;
  readonly label: "INDEPENDENT" | "HOUSE";
  readonly price: UsdCents;
  readonly eta: Hours;
  readonly agent: string;
  readonly runner: string;
  readonly pitch: string;
  readonly paidReceipts: number;
  readonly status: "PENDING" | "CHOSEN" | "ACCEPTED" | "NOT_SELECTED" | "RETURNED";
}

export interface JobView {
  readonly id: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly phase: string;
  readonly budget: UsdCents;
  readonly deliveryEndsAt: Instant;
  readonly bids: { readonly operators: readonly BidView[]; readonly house: BidView | null };
  /** The owning client, served to that client's own session only. Null for every other viewer. */
  readonly client: string | null;
  readonly lockedTo: string | null;
  /** The server's answer: this viewer owns the job and the review awaits its approval. */
  readonly viewerCanApprove: boolean;
  /** The same ownership gate for Dispute. */
  readonly viewerCanDispute: boolean;
  /** Served while `phase` is DISPUTED; null otherwise. */
  readonly dispute: DisputeView | null;
  /** What selected the release, while it is pending and once the job is PAID. Null before any release. */
  readonly releaseAuthority: ReleaseAuthority | null;
  readonly escrow: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
  readonly approveUrl: string | null;
  readonly ledger: readonly LedgerLine[];
  readonly attempts: { readonly used: number; readonly left: number; readonly last: "REJECTED" | "VERIFIED" | null; readonly reasons: readonly string[] };
  readonly reviewEndsAt: Instant | null;
  readonly pullRequest: number | null;
  /** The tree the verifier judged. Approve must name it. */
  readonly mergeCommit: string | null;
  /** Served on a PAID job only. */
  readonly merge: MergeProgress | null;
  /** Served on a PAID job only. */
  readonly release: ReleaseEvidence | null;
  readonly receipt: Receipt | null;
  readonly contract: { readonly repository: string; readonly frozenAt: string } | null;
}

export interface OperatorView {
  readonly id: string;
  readonly handle: string;
  readonly label: "INDEPENDENT" | "HOUSE";
  readonly payouts: "NOT_STARTED" | "AWAITING_CONSENT" | "READY";
  readonly onboardingUrl: string | null;
  readonly paidReceipts: number;
}

export interface CreditAccountView {
  readonly available: Credits;
  readonly weeklyAllowance: Credits;
  readonly nextGrantAt: Instant;
}

/** The user commands the web app sends (http.md "Commands"). */
export type UserCommand =
  | { readonly type: "OpenJob"; readonly repository: string; readonly issueNumber: number; readonly budget: UsdCents; readonly deliveryEndsAt: Instant }
  | { readonly type: "PlaceBid"; readonly jobId: string; readonly price: UsdCents; readonly eta: Hours; readonly agent: string; readonly pitch: string }
  | { readonly type: "AcceptBid"; readonly jobId: string; readonly bidId: string }
  | { readonly type: "CancelJob"; readonly jobId: string }
  | { readonly type: "Approve"; readonly jobId: string; readonly mergeCommit: string }
  | { readonly type: "Dispute"; readonly jobId: string; readonly mergeCommit: string; readonly reason: string };

export type PublicResult =
  | { readonly kind: "JOB"; readonly job: JobView }
  | { readonly kind: "BID"; readonly job: JobView; readonly bid: string; readonly creditsLeft: Credits }
  | { readonly kind: "OPERATOR"; readonly operator: OperatorView }
  | { readonly kind: "AGENT"; readonly agent: string };

export type CommandOutcome =
  | { readonly kind: "COMMITTED"; readonly result: PublicResult }
  | { readonly kind: "REPLAY"; readonly result: PublicResult }
  | { readonly kind: "DENIED"; readonly reason: string };

/** The `POST /api/commands` body. An INSUFFICIENT_CREDITS refusal also carries the credit view. */
export type CommandResponse = { readonly outcome: CommandOutcome; readonly credits?: CreditAccountView | null };
