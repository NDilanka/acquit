// The job owner. One versioned row per job, one state union, one private transition table.
// Pure. No I/O. effects.ts loads facts, calls applyJobCommand, and commits the plan with compare-and-set.

import type { Actor, JobView } from "./acquit";
import type { CreditAccount } from "./credits";
import type {
	AgentId,
	BidId,
	CaptureId,
	ClientId,
	CommitSha,
	Hours,
	Instant,
	JobId,
	MerchantId,
	OperatorId,
	OrderId,
	ReceiptId,
	Version,
} from "./ids";
import type { EmptyBook, HeldBook, PaidBook, RefundedBook, TreasuryEntry, UsdCents } from "./ledger";
import type { Agent, OperatorRow } from "./operator";
import type { CaptureEvidence, FeeQuote, RefundEvidence, ReleaseEvidence } from "./paypal";
import type { DefinitionOfDone, TestTally, Verdict, VerifierRunId } from "./verifier";

// Worst-case timeline from capture is delivery 14d, review 72h, dispute 48h, so day 19.
// The cutoff at day 21 leaves a week to reconcile an uncertain settlement before PayPal's day 28.
export const TERMS = {
	maxAttempts: 3,
	bidReviewHours: 72,
	checkoutHours: 3,
	clientReviewHours: 72,
	disputeResolutionHours: 48,
	maxDeliveryDaysAfterOpen: 14,
	captureCutoffDays: 21,
	providerAutoDisburseDays: 28,
} as const;

export type AcceptanceContract = {
	readonly definitionOfDone: DefinitionOfDone;
	readonly budget: UsdCents;
	/** OpenJob rejects a deadline later than openedAt + 14 days. Capture is after open, so it also bounds capture age. */
	readonly deliveryEndsAt: Instant;
	readonly terms: typeof TERMS;
};

// Bids

export type BidStatus = "PENDING" | "CHOSEN" | "ACCEPTED" | "NOT_SELECTED" | "RETURNED";

export type Bid = {
	readonly id: BidId;
	readonly operator: OperatorId;
	readonly handle: string;
	readonly kind: "INDEPENDENT" | "HOUSE";
	/** Copied from the operator's READY onboarding at PlaceBid. AcceptBid names it as the order payee. */
	readonly payee: MerchantId;
	readonly agent: AgentId;
	readonly runner: Agent["runner"];
	readonly price: UsdCents;
	readonly eta: Hours;
	readonly pitch: string;
	readonly placedAt: Instant;
	/** placedAt + bidReviewHours. A PENDING bid past this returns its credits. */
	readonly respondBy: Instant;
	readonly status: BidStatus;
};

/** "Locked to devon-ops". PayPal enforces it, because the order named this payee at creation. */
export type LockedBid = {
	readonly bidId: BidId;
	readonly operator: OperatorId;
	readonly payee: MerchantId;
	readonly agent: AgentId;
	readonly price: UsdCents;
	readonly eta: Hours;
};

export type RankedBids = {
	/** Independent operators. Most paid receipts first, then earliest placed, then bid id. */
	readonly operators: readonly Bid[];
	/** At most one per job. Rendered below the operators and labeled as the quality bar. */
	readonly house: Bid | null;
};

// Money held for a job

export type HeldEscrow = {
	readonly payee: LockedBid;
	readonly quote: FeeQuote;
	readonly capture: CaptureEvidence;
	readonly book: HeldBook;
	/** capturedAt + captureCutoffDays. The watchdog forces a disposition here in every state. */
	readonly cutoffAt: Instant;
};

export type RefundReason =
	| "DELIVERY_DEADLINE"
	| "ATTEMPTS_EXHAUSTED"
	| "ARBITER_REFUND"
	| "CAPTURE_CUTOFF"
	| "CAPTURE_MISMATCH";

export type RefundIntent = { readonly reason: RefundReason; readonly selectedAt: Instant };

export type ReleaseIntent = {
	readonly authority: "CLIENT_APPROVAL" | "REVIEW_SILENCE" | "ARBITER_UPHELD" | "CAPTURE_CUTOFF";
	readonly selectedAt: Instant;
};

// OPEN

export type Checkout =
	| { readonly phase: "CREATING_ORDER" }
	| { readonly phase: "AWAITING_APPROVAL"; readonly orderId: OrderId; readonly approveUrl: string }
	| { readonly phase: "CAPTURING"; readonly orderId: OrderId }
	/** Capture landed but its gross, payee, or platform fee differs from the quote. No work has started. */
	| { readonly phase: "REFUND_PENDING"; readonly escrow: HeldEscrow; readonly refund: RefundIntent };

export type OpenState = {
	readonly status: "OPEN";
	readonly phase:
		| { readonly kind: "BIDDING"; readonly fundingRounds: number }
		| {
			readonly kind: "FUNDING";
			readonly round: number;
			readonly chosen: LockedBid;
			readonly quote: FeeQuote;
			readonly checkoutEndsAt: Instant;
			readonly checkout: Checkout;
		};
};

// IN_PROGRESS

export type Ordinal = 1 | 2 | 3;
export type RejectedAttempt = { readonly ordinal: Ordinal; readonly verdict: Extract<Verdict, { result: "REJECTED" }> };
export type PassedAttempt = { readonly ordinal: Ordinal; readonly verdict: Extract<Verdict, { result: "VERIFIED" }> };
export type AttemptRecord = RejectedAttempt | PassedAttempt;
/** A pass stays in history if an arbiter sends the job back for rework. No fourth slot exists. */
export type History =
	| readonly []
	| readonly [AttemptRecord]
	| readonly [AttemptRecord, AttemptRecord]
	| readonly [AttemptRecord, AttemptRecord, AttemptRecord];

export type PendingAttempt = {
	readonly ordinal: Ordinal;
	/** Monotonic per job. A timed-out run gives its slot back and the resubmission gets the next run. */
	readonly run: number;
	readonly runId: VerifierRunId;
	readonly sourceCommit: CommitSha;
	readonly submittedAt: Instant;
	/** submittedAt + VERIFIER_RUN_MINUTES. The deadline refund waits for this and no longer. */
	readonly runEndsAt: Instant;
};

export type AttemptProgress =
	| { readonly phase: "READY"; readonly history: History; readonly runsStarted: number }
	| { readonly phase: "VERIFYING"; readonly history: History; readonly pending: PendingAttempt }
	| { readonly phase: "REFUND_PENDING"; readonly history: History; readonly refund: RefundIntent };

export type WorkState = {
	readonly status: "IN_PROGRESS";
	readonly escrow: HeldEscrow;
	readonly attempts: AttemptProgress;
};

// VERIFIED

export type Review =
	| { readonly phase: "AWAITING_CLIENT"; readonly endsAt: Instant }
	/** The review clock is paused. resolveBy is the arbiter's SLA. The cutoff is the hard stop. */
	| { readonly phase: "DISPUTED"; readonly reason: string; readonly openedAt: Instant; readonly resolveBy: Instant }
	| { readonly phase: "RELEASE_PENDING"; readonly release: ReleaseIntent }
	| { readonly phase: "REFUND_PENDING"; readonly refund: RefundIntent };

export type VerifiedState = {
	readonly status: "VERIFIED";
	readonly escrow: HeldEscrow;
	readonly history: History;
	readonly passed: PassedAttempt;
	readonly review: Review;
	readonly runsStarted: number;
};

// Terminal states

declare const receiptBrand: unique symbol;
/** Only the ReleaseSettled edge constructs one. No other code path can produce the brand. */
export type Receipt = {
	readonly [receiptBrand]: true;
	readonly id: ReceiptId;
	readonly jobId: JobId;
	readonly operator: OperatorId;
	readonly agent: AgentId;
	readonly pullRequest: number;
	readonly mergeCommit: CommitSha;
	readonly frozen: TestTally;
	readonly hidden: TestTally;
	readonly attemptsUsed: Ordinal;
	readonly paid: UsdCents;
	readonly releasedAt: Instant;
};

export type MergeProgress =
	| { readonly phase: "PENDING" }
	| { readonly phase: "MERGED"; readonly at: Instant }
	| { readonly phase: "NEEDS_HUMAN"; readonly reason: string };

export type PaidState = {
	readonly status: "PAID";
	readonly payee: LockedBid;
	readonly book: PaidBook;
	readonly receipt: Receipt;
	readonly merge: MergeProgress;
	readonly treasury: readonly TreasuryEntry[];
};

export type RefundedState = {
	readonly status: "REFUNDED";
	readonly payee: LockedBid;
	readonly book: RefundedBook;
	readonly reason: RefundReason;
	readonly refund: RefundEvidence;
	readonly history: History;
	readonly treasury: readonly TreasuryEntry[];
};

/** Closed before any capture. No ledger lines. REFUNDED always has HELD plus REFUND, so it cannot mean this. */
export type ClosedState = {
	readonly status: "CLOSED";
	readonly reason: "CLIENT_CANCEL" | "NO_ACCEPT_BY_DEADLINE";
	readonly closedAt: Instant;
	readonly book: EmptyBook;
};

export type JobState = OpenState | WorkState | VerifiedState | PaidState | RefundedState | ClosedState;
export type JobStatus = JobState["status"];

export type JobRow<S extends JobState = JobState> = {
	readonly id: JobId;
	readonly version: Version;
	readonly client: ClientId;
	readonly title: string;
	readonly contract: AcceptanceContract;
	readonly openedAt: Instant;
	readonly bids: readonly Bid[];
	readonly state: S;
};

// Effects the table asks for. effects.ts derives their keys and PayPal request ids.

export type JobEffect =
	| { readonly kind: "CREATE_ORDER"; readonly jobId: JobId; readonly round: number; readonly payee: MerchantId; readonly quote: FeeQuote }
	| { readonly kind: "CAPTURE"; readonly jobId: JobId; readonly round: number; readonly orderId: OrderId; readonly payee: MerchantId }
	| { readonly kind: "RELEASE"; readonly jobId: JobId; readonly captureId: CaptureId; readonly payee: MerchantId }
	| { readonly kind: "REFUND"; readonly jobId: JobId; readonly captureId: CaptureId; readonly payee: MerchantId; readonly amount: UsdCents }
	| { readonly kind: "START_VERIFIER"; readonly jobId: JobId; readonly attempt: PendingAttempt }
	| { readonly kind: "MERGE"; readonly jobId: JobId; readonly pullRequest: number; readonly mergeCommit: CommitSha }
	| {
		readonly kind: "ALERT";
		readonly jobId: JobId;
		readonly reason: "DISPUTE_SLA_MISSED" | "SETTLEMENT_UNCONFIRMED_AT_CUTOFF" | "OPERATOR_REIMBURSEMENT_OWED";
	};

// The table

export type Role = "CLIENT" | "OPERATOR" | "ARBITER" | "SYSTEM";
export type TrustedActor = Actor | { readonly role: "SYSTEM"; readonly source: "PAYPAL" | "VERIFIER" | "TIMER" | "OUTBOX" };

export type DomainFailure =
	| "NOT_FOUND"
	| "NOT_OWNER"
	| "WRONG_STATE"
	| "ONBOARDING_REQUIRED"
	| "PRICE_OVER_BUDGET"
	| "ALREADY_BID"
	| "HOUSE_ALREADY_BID"
	| "INSUFFICIENT_CREDITS"
	| "DEADLINE_TOO_FAR"
	| "DEADLINE_PASSED"
	| "ATTEMPTS_EXHAUSTED"
	| "VERIFIER_PENDING"
	| "ARTIFACT_CHANGED"
	| "REVIEW_CLOSED"
	| "PAYMENT_IN_PROGRESS";

/** Rows the shell loads before calling the table. The table never reads storage. */
export type Loaded =
	| { readonly kind: "NONE" }
	| { readonly kind: "OPEN_JOB"; readonly contract: AcceptanceContract; readonly title: string }
	| { readonly kind: "PLACE_BID"; readonly operator: OperatorRow; readonly agent: Agent; readonly credits: CreditAccount }
	| { readonly kind: "ACCEPT_BID"; readonly quote: FeeQuote }
	| { readonly kind: "BIDDER_CREDITS"; readonly accounts: ReadonlyMap<OperatorId, CreditAccount> };

export type Facts = { readonly actor: TrustedActor; readonly now: Instant; readonly loaded: Loaded };

/** effects.ts commits the row, credit accounts, outbox rows, and the request record atomically. */
export type Plan<Next> = {
	readonly next: Next;
	readonly credits: readonly CreditAccount[];
	readonly effects: readonly JobEffect[];
};

export type Edge<Before, Payload, After, By extends Role> = {
	readonly by: By;
	readonly apply: (before: Before, payload: Payload, facts: Facts) => Plan<After> | DomainFailure;
};

type Open = JobRow<OpenState>;
type Work = JobRow<WorkState>;
type Verified = JobRow<VerifiedState>;
type JobRef = { readonly jobId: JobId };

function transitionTable(): {
	OpenJob: Edge<null, { readonly repository: string; readonly issueNumber: number; readonly budget: UsdCents; readonly deliveryEndsAt: Instant }, Open, "CLIENT">;
	PlaceBid: Edge<Open, JobRef & { readonly price: UsdCents; readonly eta: Hours; readonly agent: AgentId; readonly pitch: string }, Open, "OPERATOR">;
	AcceptBid: Edge<Open, JobRef & { readonly bidId: BidId }, Open, "CLIENT">;
	CancelJob: Edge<Open, JobRef, JobRow<ClosedState>, "CLIENT">;
	OrderCreated: Edge<Open, JobRef & { readonly round: number; readonly orderId: OrderId; readonly approveUrl: string }, Open, "SYSTEM">;
	FundingFailed: Edge<Open, JobRef & { readonly round: number; readonly reason: string }, Open, "SYSTEM">;
	BuyerApproved: Edge<Open, JobRef & { readonly orderId: OrderId }, Open, "SYSTEM">;
	CaptureCompleted: Edge<Open, JobRef & { readonly capture: CaptureEvidence }, Open | Work, "SYSTEM">;
	Submit: Edge<Work, JobRef & { readonly sourceCommit: CommitSha }, Work, "OPERATOR">;
	VerifierFinished: Edge<Work, JobRef & { readonly runId: VerifierRunId; readonly verdict: Verdict }, Work | Verified, "SYSTEM">;
	Approve: Edge<Verified, JobRef & { readonly mergeCommit: CommitSha }, Verified, "CLIENT">;
	Dispute: Edge<Verified, JobRef & { readonly mergeCommit: CommitSha; readonly reason: string }, Verified, "CLIENT">;
	ResolveDispute: Edge<Verified, JobRef & { readonly verdict: "UPHOLD" | "REWORK" | "REFUND"; readonly note: string }, Verified | Work, "ARBITER">;
	ReleaseSettled: Edge<Verified, JobRef & { readonly release: ReleaseEvidence }, JobRow<PaidState>, "SYSTEM">;
	RefundSettled: Edge<JobRow, JobRef & { readonly refund: RefundEvidence }, JobRow<RefundedState>, "SYSTEM">;
	MergeFinished: Edge<JobRow<PaidState>, JobRef & { readonly outcome: MergeProgress }, JobRow<PaidState>, "SYSTEM">;
	TimerDue: Edge<JobRow, JobRef & { readonly expectedWakeAt: Instant }, JobRow, "SYSTEM">;
} {
	// OpenJob
	// TODO Reject deliveryEndsAt > now + 14 days (DEADLINE_TOO_FAR). Freeze the loaded contract. BIDDING, no ledger line.
	//
	// PlaceBid
	// TODO Require OPEN. FUNDING still admits bids, because an abandoned checkout returns to BIDDING.
	// TODO Require readyToBid(operator), else ONBOARDING_REQUIRED. Require price <= budget and one bid per operator.
	// TODO HOUSE: at most one per job (HOUSE_ALREADY_BID) and no credit move.
	// TODO INDEPENDENT: reduceCredits Spend keyed by the new bid id. The bid and the spend commit together.
	//
	// AcceptBid
	// TODO Require BIDDING, a PENDING bid, and now < deliveryEndsAt. Mark it CHOSEN. Other bids stay PENDING.
	// TODO Enter FUNDING with round = fundingRounds + 1, the loaded quote, checkoutEndsAt = now + checkoutHours.
	// TODO Emit CREATE_ORDER naming the chosen payee. No money is held yet.
	//
	// Checkout
	// TODO OrderCreated for the current round moves CREATING_ORDER to AWAITING_APPROVAL. Stale rounds are no-ops.
	// TODO BuyerApproved for the current order moves to CAPTURING and emits CAPTURE. Any other order is a no-op.
	// TODO FundingFailed (permanent create or capture failure) returns to BIDDING and the chosen bid to PENDING.
	// TODO CaptureCompleted for the current order applies reduceLedger Hold. If gross, payee, and platform fee match the
	//      quote, enter IN_PROGRESS READY, mark the chosen bid ACCEPTED and other PENDING bids NOT_SELECTED.
	//      NOT_SELECTED bids keep their spend. On mismatch, enter checkout REFUND_PENDING and emit REFUND.
	// TODO CaptureCompleted in any later state is a no-op. That is how a replay with a new event id pays nothing.
	//
	// CancelJob
	// TODO Allowed in BIDDING, CREATING_ORDER, and AWAITING_APPROVAL. Refused in CAPTURING (PAYMENT_IN_PROGRESS).
	// TODO Enter CLOSED and Return every PENDING or CHOSEN bid's credits with CLIENT_CANCEL.
	//
	// Work
	// TODO Submit requires READY, now < deliveryEndsAt, and history.length < 3. Reserve the next ordinal and run.
	//      Resubmitting the same commit while VERIFYING returns the pending attempt.
	// TODO VerifierFinished must match the pending runId. Anything else is a no-op.
	// TODO REJECTED with slots left returns to READY. REJECTED on slot 3 enters REFUND_PENDING ATTEMPTS_EXHAUSTED.
	// TODO VERIFIED enters VERIFIED AWAITING_CLIENT with endsAt = now + clientReviewHours, and opens the PR.
	//
	// Review
	// TODO Approve and Dispute must name passed.verdict.mergeCommit, else ARTIFACT_CHANGED.
	// TODO Approve from AWAITING_CLIENT enters RELEASE_PENDING CLIENT_APPROVAL and emits RELEASE.
	// TODO Dispute from AWAITING_CLIENT before endsAt enters DISPUTED with resolveBy = now + disputeResolutionHours.
	// TODO ResolveDispute UPHOLD releases ARBITER_UPHELD. REFUND refunds ARBITER_REFUND.
	//      REWORK returns to READY only if a slot is left and now < deliveryEndsAt. Otherwise WRONG_STATE.
	//
	// Settlement
	// TODO ReleaseSettled requires RELEASE_PENDING and the held capture id. reduceLedger Release with the observed
	//      net, processor fee, and platform fee. Build the receipt. Emit MERGE.
	//      If observed processor fee != quote, add PROCESSOR_FEE_VARIANCE. If the net is below split.operatorNet,
	//      add OPERATOR_REIMBURSEMENT_OWED and emit ALERT.
	// TODO RefundSettled requires a REFUND_PENDING phase. reduceLedger Refund. Add REFUND_FEE_RETAINED and
	//      OPERATOR_REIMBURSEMENT_OWED for the same cents. The sandbox debited the operator 15.15 on a full refund.
	// TODO A settlement observation that does not match the selected disposition is never applied. It is an ALERT.
	//      An uncertain release is never turned into a refund, and the reverse holds too.
	//
	// TimerDue, ignored unless expectedWakeAt = wakeAt(row). Evaluate in this order and apply the first that fires.
	// TODO 1 Capture-age watchdog, when now >= escrow.cutoffAt.
	//        IN_PROGRESS READY or VERIFYING        refund CAPTURE_CUTOFF
	//        VERIFIED AWAITING_CLIENT or DISPUTED  release CAPTURE_CUTOFF (the verifier passed, so the contract was met)
	//        any RELEASE_PENDING or REFUND_PENDING no new disposition, emit ALERT SETTLEMENT_UNCONFIRMED_AT_CUTOFF
	// TODO 2 IN_PROGRESS READY past deliveryEndsAt refunds DELIVERY_DEADLINE.
	// TODO 3 IN_PROGRESS VERIFYING past runEndsAt. If now < deliveryEndsAt, give the slot back and return to READY.
	//        Otherwise refund DELIVERY_DEADLINE. A running attempt defers the deadline by at most VERIFIER_RUN_MINUTES.
	// TODO 4 VERIFIED AWAITING_CLIENT past endsAt releases REVIEW_SILENCE.
	// TODO 5 VERIFIED DISPUTED past resolveBy emits ALERT DISPUTE_SLA_MISSED once. The cutoff still releases.
	// TODO 6 OPEN FUNDING past checkoutEndsAt and not CAPTURING returns to BIDDING, chosen bid back to PENDING.
	// TODO 7 OPEN past deliveryEndsAt and not CAPTURING enters CLOSED NO_ACCEPT_BY_DEADLINE, Return all open bids.
	// TODO 8 OPEN, PENDING bids past respondBy become RETURNED. Return each with NO_CLIENT_RESPONSE.
	throw new Error("not implemented");
}

type TransitionTable = ReturnType<typeof transitionTable>;
type PayloadOf<K extends keyof TransitionTable> = Parameters<TransitionTable[K]["apply"]>[1];
type RoleOf<K extends keyof TransitionTable> = TransitionTable[K]["by"];

export type JobCommand = { [K in keyof TransitionTable]: { readonly type: K } & PayloadOf<K> }[keyof TransitionTable];

export type UserJobCommand = {
	[K in keyof TransitionTable]: RoleOf<K> extends "SYSTEM" ? never : { readonly type: K } & PayloadOf<K>;
}[keyof TransitionTable];

export type SystemJobCommand = Exclude<JobCommand, UserJobCommand>;

/** The only entry into the table. Exhaustive over command types at compile time. */
export function applyJobCommand(row: JobRow | null, command: JobCommand, facts: Facts): Plan<JobRow> | DomainFailure {
	// TODO Look up the edge, check facts.actor against edge.by and row ownership, narrow row.state, apply.
	throw new Error("not implemented");
}

/** The earliest instant at which TimerDue would change this row. Stored by the commit for the timer index. */
export function wakeAt(row: JobRow): Instant | null {
	// TODO min over: PENDING respondBy, checkoutEndsAt, deliveryEndsAt, runEndsAt, review endsAt, resolveBy, cutoffAt.
	throw new Error("not implemented");
}

export function rankBids(bids: readonly Bid[], paidReceipts: ReadonlyMap<OperatorId, number>): RankedBids {
	throw new Error("not implemented");
}

/** Bidding shows proof first. After accept, the ledger spine leads. */
export function projectJob(row: JobRow, viewer: Actor, paidReceipts: ReadonlyMap<OperatorId, number>): JobView {
	throw new Error("not implemented");
}
