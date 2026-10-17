// Wire shapes from docs/architecture/http.md, mirrored from packages/core/src/acquit.ts.
// Mirrored rather than imported: a type-only import still makes tsc check core's implementation
// files under this app's compiler flags. Brands are dropped because JSON carries plain values.

export type UsdCents = number;
export type Hours = number;
export type Credits = number;
export type Instant = string;

export type JobStatus = "OPEN" | "IN_PROGRESS" | "VERIFIED" | "PAID" | "REFUNDED" | "CLOSED";

/** The projected phase: OPEN's kind, then the attempt or review phase, or the status itself once the job settles or closes. */
export type JobPhase =
  | "BIDDING"
  | "FUNDING"
  | "READY"
  | "VERIFYING"
  | "AWAITING_CLIENT"
  | "DISPUTED"
  | "RELEASE_PENDING"
  | "REFUND_PENDING"
  | "PAID"
  | "REFUNDED"
  | "CLOSED";

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
  /** The receipts table's provenance, served on the job view too since it reads that table. */
  readonly source: "SEED" | "JOB";
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

export type RefundReason = "DELIVERY_DEADLINE" | "ATTEMPTS_EXHAUSTED" | "ARBITER_REFUND" | "CAPTURE_CUTOFF" | "CAPTURE_MISMATCH";

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
  /** The House bid's receipts line, e.g. "41 fixes, 39 passed verified CI". Null on operator bids. */
  readonly houseLine: string | null;
  readonly status: "PENDING" | "CHOSEN" | "ACCEPTED" | "NOT_SELECTED" | "RETURNED";
}

export interface JobView {
  readonly id: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly phase: JobPhase;
  /** The stored checkout substate, non-null exactly while the job is OPEN in FUNDING. */
  readonly checkoutPhase: CheckoutPhase | null;
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
  /** The note from the arbiter's most recent decision, whatever the verdict. It outlives that decision, so a later outcome may not be the arbiter's. */
  readonly arbiterNote: string | null;
  /** What selected the release, while it is pending and once the job is PAID. Null before any release. */
  readonly releaseAuthority: ReleaseAuthority | null;
  /** What selected the refund, while it is pending and once the job is REFUNDED. Null before any refund and on rows stored before the reason was recorded. */
  readonly refundReason: RefundReason | null;
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
  /** The job's frozen contract: the frozen manifest the verifier runs, served since the frozen manifest row existed. */
  readonly contract: {
    readonly repository: string;
    readonly issue: number;
    readonly frozenAt: string;
    readonly frozenTestPath: string;
    readonly frozenTests: number;
    readonly hiddenTests: number;
    readonly hiddenManifest: string;
    readonly protectedPaths: readonly string[];
  } | null;
  /** The source this job's accept will use, served to the owning client only. Null when the deployment's default applies. */
  readonly funding: FundingMode | null;
  /** How far the owning client moved this job's own clock in total, 0 when unmoved. Null for every other viewer. */
  readonly clockShiftMs: number | null;
}

export type FundingMode = "card" | "checkout";

export type CheckoutPhase = "CREATING_ORDER" | "AWAITING_APPROVAL" | "CAPTURING" | "REFUND_PENDING";

/** `GET /api/me/receipts`: a settled job's receipt plus its repository and the receipts table's source. */
export type JobReceiptRow = Receipt & {
  readonly repository: string;
  readonly passedVerifiedCi: boolean;
  /** The gross the capture held: the job's HELD line. */
  readonly grossPaid: UsdCents | null;
  /** The fee the book took: the job's FEE line. */
  readonly fee: UsdCents | null;
  readonly feeSplit: { readonly processor: UsdCents | null; readonly acquit: UsdCents | null } | null;
  readonly result: "VERIFIED" | null;
};

/** A seeded history row has no job behind it, so it keeps only the facts the receipts table holds. */
export type SeededReceiptRow = {
  readonly id: string;
  readonly jobId: null;
  readonly operator: string;
  readonly agent: null;
  readonly pullRequest: null;
  readonly mergeCommit: null;
  readonly frozen: null;
  readonly hidden: null;
  readonly attemptsUsed: null;
  readonly paid: null;
  readonly releasedAt: Instant | null;
  readonly repository: null;
  readonly source: "SEED";
  readonly passedVerifiedCi: boolean;
  readonly grossPaid: null;
  readonly fee: null;
  readonly feeSplit: null;
  readonly result: null;
};

export type ReceiptRow = JobReceiptRow | SeededReceiptRow;

/** `GET /api/receipts/:receiptId`: the public receipt of one PAID job. Mirrors apps/api/src/receipts.ts. */
export type PublicAttempt = {
  readonly ordinal: number;
  readonly result: "VERIFIED" | "REJECTED";
  readonly at: Instant;
  readonly frozen: { readonly expected: number; readonly passed: number } | null;
  readonly hidden: { readonly expected: number; readonly passed: number } | null;
  /** Closed reason codes such as TESTS_FAILED:hidden. Test ids stay private. */
  readonly reasons: readonly string[];
};

export type PublicHiddenCase = {
  readonly id: string;
  readonly target: { readonly module: string; readonly export: string };
  readonly args: readonly unknown[];
  readonly expected: unknown;
};

export type PublicReceiptResponse = {
  readonly receipt: {
    readonly id: string;
    readonly title: string | null;
    readonly issue: number | null;
    readonly source: "SEED" | "JOB";
    readonly scripted: boolean;
    readonly releasedAt: Instant;
    readonly releaseAuthority: ReleaseAuthority | null;
    readonly operator: { readonly handle: string | null; readonly label: "INDEPENDENT" | "HOUSE" | null };
    readonly money: { readonly heldCents: UsdCents | null; readonly paidCents: UsdCents; readonly feeCents: UsdCents | null;
      readonly processorFeeCents: UsdCents | null; readonly acquitFeeCents: UsdCents | null };
    readonly verdict: { readonly attemptsUsed: number; readonly attemptsAllowed: number; readonly frozen: { readonly expected: number; readonly passed: number };
      readonly hidden: { readonly expected: number; readonly passed: number }; readonly pullRequest: number; readonly mergeCommit: string;
      readonly history: readonly PublicAttempt[] };
    readonly paypal: { readonly captureId: string | null; readonly payoutItemId: string | null; readonly feeBatchId: string | null };
    readonly hiddenCases: { readonly committedDigest: string; readonly committedAt: Instant | null;
      readonly revealed: { readonly salt: string; readonly cases: readonly PublicHiddenCase[] } | null } | null;
    readonly scoreCard: { readonly cheatsCaught: number; readonly cheatsTotal: number; readonly honestPassed: number; readonly honestTotal: number;
      readonly gaps: readonly string[] };
  };
};

/** `GET /api/me/payouts`: one row per released job the operator was paid. */
export type PayoutRow = {
  readonly jobId: string;
  readonly payoutItemId: string;
  readonly captureId: string | null;
  readonly paid: UsdCents | null;
  readonly releasedAt: Instant | null;
  readonly releaseAuthority: string | null;
  readonly repository: string;
};

/** `GET /api/me/escrow`: one row per hold the operator's release will pay, at the operator's net (the price less the operator fee). */
export type OperatorEscrowRow = { readonly jobId: string; readonly cents: UsdCents };

export type PlatformAttempt = {
  readonly ordinal: number;
  readonly result: "VERIFIED" | "REJECTED";
  readonly at: Instant;
  /** True when the rejection named the frozen tests: a tamper the verifier caught. */
  readonly tamper: boolean;
  readonly reasons: readonly string[];
};

/** One job's book in `GET /api/platform/ledger`, across every tenant. Mirrored from packages/core/src/platform.ts. */
export type PlatformJobLedger = {
  readonly jobId: string;
  readonly title: string;
  readonly tenant: string | null;
  readonly client: string;
  readonly status: JobStatus;
  readonly escrow: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
  readonly operator: { readonly id: string; readonly handle: string } | null;
  readonly lines: readonly LedgerLine[];
  readonly paidCents: UsdCents | null;
  readonly fee: { readonly cents: UsdCents; readonly processor: UsdCents; readonly acquit: UsdCents } | null;
  readonly payout: {
    readonly paid: UsdCents;
    readonly payoutItemId: string;
    readonly captureId: string | null;
    readonly releasedAt: Instant;
    readonly authority: string | null;
  } | null;
  readonly receipt: { readonly id: string; readonly paid: UsdCents; readonly releasedAt: Instant } | null;
  readonly attempts: readonly PlatformAttempt[];
};

/** The platform's relational tables in `GET /api/platform/tables`. Mirrored from packages/core/src/platform.ts. Money is integer cents. */
export type PlatformStage = "1 Posted" | "2 Bid" | "3 Funded" | "4 Verified" | "5 Paid" | "6 Refunded" | "7 Closed";

export type PlatformJobRow = {
  readonly jobId: string;
  readonly title: string;
  readonly tenant: string | null;
  readonly clientId: string;
  readonly status: JobStatus;
  readonly escrow: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
  readonly stage: PlatformStage;
  readonly operatorId: string | null;
  readonly operatorHandle: string | null;
  readonly openedAt: Instant;
  readonly releasedAt: Instant | null;
  readonly bidCount: number;
  readonly attemptCount: number;
  readonly grossCents: number;
  readonly heldCents: number;
  readonly releasedCents: number;
  readonly feeCents: number;
  readonly refundedCents: number;
};

export type PlatformBidRow = {
  readonly bidId: string;
  readonly jobId: string;
  readonly operatorId: string;
  readonly handle: string;
  readonly kind: "INDEPENDENT" | "HOUSE";
  readonly status: string;
  readonly priceCents: number;
  readonly etaHours: number;
  readonly placedAt: Instant;
};

export type PlatformVerdictRow = {
  readonly verdictId: string;
  readonly jobId: string;
  readonly ordinal: number;
  readonly result: "VERIFIED" | "REJECTED";
  readonly verified: 0 | 1;
  readonly tamper: 0 | 1;
  readonly reasonCount: number;
  readonly at: Instant;
};

export type PlatformLedgerEntryRow = {
  readonly entryId: string;
  readonly jobId: string;
  readonly kind: LedgerLine["kind"];
  readonly cents: number;
  readonly at: Instant;
  readonly captureId: string | null;
  readonly operatorId: string | null;
  readonly processorCents: number | null;
  readonly acquitCents: number | null;
};

export type PlatformPayPalEventRow = {
  readonly captureId: string;
  readonly jobId: string;
  readonly orderId: string | null;
  readonly merchant: string;
  readonly state: "CAPTURED" | "RELEASED" | "REFUNDED";
  readonly grossCents: number;
  readonly refundId: string | null;
  readonly refundedCents: number | null;
  readonly payoutItemId: string | null;
  readonly releasedAt: Instant | null;
};

export type PlatformOperatorRow = {
  readonly operatorId: string;
  readonly handle: string;
  readonly kind: "INDEPENDENT" | "HOUSE";
  readonly payoutReadiness: "NOT_STARTED" | "AWAITING_CONSENT" | "READY" | null;
  readonly paidReceipts: number;
};

export type PlatformClientRow = { readonly clientId: string; readonly jobCount: number };

export type PlatformTables = {
  readonly jobs: readonly PlatformJobRow[];
  readonly bids: readonly PlatformBidRow[];
  readonly verdicts: readonly PlatformVerdictRow[];
  readonly ledger_entries: readonly PlatformLedgerEntryRow[];
  readonly paypal_events: readonly PlatformPayPalEventRow[];
  readonly operators: readonly PlatformOperatorRow[];
  readonly clients: readonly PlatformClientRow[];
};

/**
 * `GET /api/platform/reconciliation`: each ledger line checked against the PayPal object it names, read live. Mirrored
 * from packages/core/src/reconcile.ts and apps/api/src/reconciliation.ts. Money is integer cents, unsigned: the line's
 * kind gives the direction.
 */
export type PlatformReconcileStatus = "MATCHED" | "PENDING_AT_PAYPAL" | "MISMATCHED" | "NOT_CHECKED";
export type PlatformReconcileReason =
  | "NOT_AT_PAYPAL" | "AMOUNT" | "CURRENCY" | "STATUS" | "NOT_REFUNDED" | "PAYPAL_PENDING"
  | "NO_PAYPAL_ID" | "PAYPAL_UNREADABLE" | "NOT_READ_YET" | "UNREADABLE_AMOUNT" | "NO_STATUS";

export type PlatformReconcileRow = {
  readonly entryId: string;
  readonly jobId: string;
  readonly kind: "HELD" | "RELEASED" | "FEE" | "REFUND";
  readonly at: string;
  readonly leg: "AMOUNT" | "FEE";
  /** The ledger's own cents for the line; null when the line names none. */
  readonly expectedCents: number | null;
  readonly objectKind: "CAPTURE" | "REFUND" | "PAYOUT_ITEM" | null;
  readonly objectId: string | null;
  readonly status: PlatformReconcileStatus;
  readonly reason: PlatformReconcileReason | null;
  /** A sentence for the screen: what matched, or what PayPal said. */
  readonly note: string | null;
  readonly observedCents: number | null;
  readonly paypalStatus: string | null;
  readonly payoutTransactionId: string | null;
};

/** A Transaction Search row on the platform account that no checked object claims: other activity, not escrow. */
export type PlatformOtherTransaction = {
  readonly transactionId: string;
  readonly eventCode: string;
  readonly initiatedAt: string;
  readonly amountCents: number | null;
  readonly feeCents: number | null;
  readonly currency: string;
};

export type PlatformOtherActivity =
  | { readonly state: "READ"; readonly from: string; readonly to: string; readonly fetchedAt: string; readonly cached: boolean;
      readonly count: number; readonly unreadable: number; readonly truncated: boolean; readonly sample: readonly PlatformOtherTransaction[] }
  | { readonly state: "NOT_READ"; readonly reason: "SPAN_TOO_LONG" | "PAYPAL_UNREADABLE" };

export type PlatformReconciliation = {
  readonly counts: { readonly matched: number; readonly pending: number; readonly mismatched: number; readonly notChecked: number };
  readonly rows: readonly PlatformReconcileRow[];
  /** When this refresh read PayPal. */
  readonly checkedAt: string;
  /** PayPal object reads this refresh made, the ones answered from the cache, and the budget it ran under. */
  readonly objects: { readonly read: number; readonly cached: number; readonly budget: number };
  readonly other: PlatformOtherActivity;
};

export type FigureId = "held" | "released" | "refunded" | "fees" | "paid-by-clients";

/**
 * `GET /api/platform/explain?figure=` and the ask tool's `trace_figure`: one escrow figure and the ledger lines that sum to
 * it, each with the PayPal object it names. Mirrored from apps/api/src/figure-trace.ts. Money is integer cents. `receiptId` is
 * set on a PAID job only.
 */
export type FigureTraceLine = {
  readonly entryId: string;
  readonly jobId: string;
  readonly kind: "HELD" | "RELEASED" | "FEE" | "REFUND";
  readonly cents: number;
  readonly at: string;
  readonly receiptId: string | null;
  readonly paypal: {
    readonly id: string | null;
    readonly status: PlatformReconcileStatus;
    /** The cents PayPal was compared on; a fee line's processor component only. */
    readonly checkedCents: number | null;
    readonly observedCents: number | null;
    readonly note: string | null;
  };
};

export type FigureTrace = {
  readonly figure: FigureId;
  readonly label: string;
  readonly totalCents: number;
  readonly lines: readonly FigureTraceLine[];
};

/** One data line of `GET /api/platform/stream`: the store committed a write. It carries no data; the page reads again. */
export type PlatformStreamEvent = { readonly kind: "changed"; readonly at: string };

/** `GET /api/jobs/:id`, and `POST /api/jobs/:id/clock` after the job's own time moved. */
export type JobResponse = { readonly job: JobView; readonly handles: Readonly<Record<string, string>>; readonly now: Instant };

/** The House run's own git diff. `patch` may end in a `... (truncated)` line. */
export type JobDiff = {
  readonly commit: string;
  readonly files: readonly { readonly path: string; readonly added: number; readonly binary: boolean }[];
  readonly patch: string;
};

/** `GET /api/jobs/:id` only: the job response plus the House run's diff, null when the job has none. */
export type JobDetailResponse = JobResponse & { readonly diff: JobDiff | null };

/** One judged attempt. A VERIFIED one carries the test tallies; a REJECTED one carries the reasons. */
export type Attempt = { readonly ordinal: number; readonly sourceCommit: string; readonly at: string } & (
  | { readonly result: "REJECTED"; readonly reasons: readonly string[]; readonly reasonsTruncated: number }
  | { readonly result: "VERIFIED"; readonly frozen: TestTally; readonly hidden: TestTally; readonly pullRequest: number }
);

/** The attempt fields the projection serves on a job, which JobView above does not mirror. */
export type VerifierFields = {
  readonly attempts: {
    readonly history: readonly Attempt[];
    readonly pending: { readonly ordinal: number; readonly sourceCommit: string; readonly submittedAt: string; readonly runEndsAt: string } | null;
    readonly failure: { readonly sourceCommit: string; readonly name: string; readonly detail: string; readonly at: string } | null;
  };
};

/** A judge-mode visitor: its own client and operator handles, its forked repository, and when the demo ends. */
export interface VisitorView {
  readonly id: string;
  readonly client: string;
  readonly operator: string;
  /** Null when the deployment has no GitHub App, so the visitor's jobs open on the deployment's repository. */
  readonly repository: string | null;
  readonly expiresAt: Instant;
}

export type SessionUser = { readonly handle: string; readonly role: "CLIENT" | "OPERATOR" | "PLATFORM" };

/** `public` offers only Start my demo; `dev` offers the seeded picker. */
export type DeploymentMode = "public" | "dev";

/** `GET /api/session`. `visitor` is null for a seeded session. `fundingMode` is the deployment's default for a job nobody chose for. */
export type SessionResponse = {
  readonly user: SessionUser | null;
  readonly visitor: VisitorView | null;
  readonly mode: DeploymentMode;
  readonly fundingMode: FundingMode;
};

/** `POST /api/session`, `POST /api/demo`, and `POST /api/demo/switch`. */
export type SignedInResponse = { readonly user: SessionUser; readonly visitor: VisitorView | null; readonly token: string };

/** `POST /api/platform/session`: the platform role has no visitor. */
export type PlatformSignedInResponse = { readonly user: SessionUser; readonly token: string };

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

/** One tool the ledger agent may call, as `GET /api/ask-ledger/tools` serves it. Mirrored from apps/api/src/ask.ts. */
export type AskToolSchema = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly kind: "client";
};

/** `GET /api/ask-ledger/tools`. */
export type AskToolsResponse = { readonly tools: readonly AskToolSchema[]; readonly model: string; readonly keyConfigured: boolean };

/** The conversation `POST /api/ask-ledger/turn` relays, one message per role it accepts. */
export type AskMessage =
  | { readonly id: string; readonly role: "user" | "system" | "developer"; readonly content: string }
  | {
      readonly id: string;
      readonly role: "assistant";
      readonly content?: string;
      readonly toolCalls?: readonly { readonly id: string; readonly function: { readonly name: string; readonly arguments: string } }[];
    }
  | { readonly id: string; readonly role: "tool"; readonly content: string; readonly toolCallId: string };

/** The `POST /api/ask-ledger/turn` body. `tools` is the loop's own schema list for this turn (the
 * agent's read tools plus the harness's delegate_to), relayed so the prompt can offer them. */
export type AskTurnRequest = {
  readonly messages: readonly AskMessage[];
  readonly instructions?: string;
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> }[];
};

/** A tool call one model turn asked for. `id` is the model's own, and may be missing. */
export type AskCall = { readonly id: string | null; readonly name: string; readonly arguments: unknown };

/** `POST /api/ask-ledger/turn` on 200. A refused turn arrives as an error status instead. */
export type AskTurnResponse = {
  readonly ok: true;
  readonly message: string | null;
  readonly calls: readonly AskCall[];
  readonly model: string;
  readonly sessionId: string | null;
  readonly factoryCredits: number | null;
};

/** `POST /api/ask-ledger/tool` on 200. */
export type AskToolResponse = { readonly result: unknown };

export type ScopingStatus = "DRAFTING" | "AWAITING_APPROVAL" | "APPROVED" | "FAILED";

/** How many drafted candidates survived each of the four filters, then the dedupe. */
export type FilterCounts = {
  readonly candidates: number;
  readonly f1: number;
  readonly f2: number;
  readonly f3: number;
  readonly f4: number;
  readonly deduped: number;
};

/** One drafted hidden case, with its private expected value and the issue text that justifies it. */
export type ScopingCase = {
  readonly id: string;
  readonly target: { readonly module: string; readonly export: string };
  readonly args: readonly unknown[];
  readonly expected: unknown;
  readonly citation: string;
};

/** `GET /api/jobs/:id/scoping` on 200, for the job's own client. Once approved, `cases` holds only the kept set. */
export type ScopingResponse = {
  readonly jobId: string;
  readonly status: ScopingStatus;
  readonly reason: string | null;
  readonly counts: FilterCounts | null;
  readonly issueBody: string | null;
  readonly approvedAt: Instant | null;
  /** The frozen row's digest: null while the draft awaits approval, the approved digest once it is APPROVED. */
  readonly digest: string | null;
  readonly contract: string | null;
  readonly frozenAt: string | null;
  readonly cases: readonly ScopingCase[];
};

/** `POST /api/jobs/:id/scoping/approve` on 200. */
export type ScopingApproveResponse = { readonly jobId: string; readonly digest: string; readonly approvedIds: readonly string[] };

/** The five judge scenarios, as core SCENARIO_NAMES names them. */
export type ScenarioName = "verified-and-paid" | "hidden-test-fail" | "test-tamper" | "dispute-arbiter" | "deadline-refund";

/** The honest labels a scenario step carries, as core SCENARIO_LABELS spells them. */
export type ScenarioLabel = "Scripted agent (Simulated)" | "Simulated time for this job" | "Real verifier run" | "PayPal sandbox" | "GitHub work repository" | "Server record (no outside call)";

/** The outside places a step's own work can reach, as core SCENARIO_LABELS spells them. */
export type ScenarioReachLabel = "Real verifier run" | "PayPal sandbox" | "GitHub work repository";

export type ScenarioStep = {
  readonly name: string;
  readonly actor: "CLIENT" | "OPERATOR" | "ARBITER" | "SYSTEM";
  readonly startedAt: Instant;
  readonly endedAt: Instant;
  /** Server-measured duration of the step, in milliseconds. */
  readonly ms: number;
  readonly outcome: string;
  /** Who acted. On a system step it names what the step reached. */
  readonly label: ScenarioLabel;
  /** The outside places the step's own work reached, in order. Empty when nothing left the server. Absent on a run stored before reach was kept. */
  readonly reached?: readonly ScenarioReachLabel[];
};

export type ScenarioEndState = { readonly jobStatus: JobStatus; readonly reason: string | null };

/** `GET /api/demo/scenarios/:runId`, and the run `POST /api/demo/scenarios/:name` starts. */
export type ScenarioRun = {
  readonly id: string;
  readonly name: ScenarioName;
  readonly requesterId: string;
  readonly visitorId: string;
  readonly jobId: string;
  readonly steps: readonly ScenarioStep[];
  readonly state: "RUNNING" | "DONE" | "FAILED";
  readonly endState: ScenarioEndState | null;
  readonly failure: "RESTARTED" | null;
};

/** `POST /api/demo/scenarios/:name` on 201. */
export type ScenarioStartResponse = { readonly scenarioId: string; readonly jobId: string };
