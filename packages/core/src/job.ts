// The job owner. One versioned row per job, one state union, one private transition table.
// Pure. No I/O. effects.ts loads facts, calls applyJobCommand, and commits the plan with compare-and-set.

import { randomUUID } from "node:crypto";
import type { Actor, JobView } from "./acquit.ts";
import type { Reservation } from "./caps.ts";
import { reduceCredits } from "./credits.ts";
import type { CreditAccount } from "./credits.ts";
import { addHours, hours, instant, parseBidId, parseJobId, parseReceiptId } from "./ids.ts";
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
	VisitorId,
} from "./ids.ts";
import { reduceLedger, refundTreasury, releaseTreasury } from "./ledger.ts";
import type { EmptyBook, HeldBook, LedgerLine, PaidBook, RefundedBook, TreasuryEntry, UsdCents } from "./ledger.ts";
import type { JobFundingMode } from "./funding.ts";
import { readyToBid } from "./operator.ts";
import type { Agent, OperatorRow } from "./operator.ts";
import type { CaptureEvidence, FeeQuote, RefundEvidence, ReimbursementEvidence, ReleaseEvidence } from "./paypal.ts";
import { describeRejectReason, VERIFIER_RUN_MINUTES } from "./verifier.ts";
import type { DefinitionOfDone, RunFailure, TestTally, Verdict, VerifierReport, VerifierRunId } from "./verifier.ts";

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
	/** OpenJob freezes one. A row stored before F3 has none, so every read goes through storedDefinitionOfDone. */
	readonly definitionOfDone: DefinitionOfDone | null;
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
	/**
	 * Set when the day-21 cutoff acted on this escrow: it selected the disposition, or it reported that a
	 * settlement was still unconfirmed. Absent on rows stored before the watchdog, and on a fresh escrow.
	 */
	readonly cutoffHandledAt?: Instant;
};

export type RefundReason =
	| "DELIVERY_DEADLINE"
	| "ATTEMPTS_EXHAUSTED"
	| "ARBITER_REFUND"
	| "CAPTURE_CUTOFF"
	| "CAPTURE_MISMATCH";

/** The reason a refund was selected. Null on a row stored before the reason was recorded; the store read types that absence. */
export type RefundIntent = { readonly reason: RefundReason | null; readonly selectedAt: Instant };

export type ReleaseIntent = {
	readonly authority: "CLIENT_APPROVAL" | "REVIEW_SILENCE" | "ARBITER_UPHELD" | "ARBITER_SLA_MISSED" | "CAPTURE_CUTOFF";
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
	| { readonly phase: "READY"; readonly history: History; readonly runsStarted: number; readonly failure: RunFailure | null }
	| { readonly phase: "VERIFYING"; readonly history: History; readonly runsStarted: number; readonly pending: PendingAttempt; readonly failure: RunFailure | null }
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
	/**
	 * GitHub's merge commit, the commit the verified pull request landed on. It is not the judged tree the
	 * receipt names. A row stored before this field reads as MERGED with a null sha at the store boundary.
	 */
	| { readonly phase: "MERGED"; readonly at: Instant; readonly sha: CommitSha | null }
	| { readonly phase: "NEEDS_HUMAN"; readonly reason: string };

export type PaidState = {
	readonly status: "PAID";
	readonly payee: LockedBid;
	readonly book: PaidBook;
	readonly receipt: Receipt;
	/** The release the receipt was built from: the referenced payout item that paid the operator. */
	readonly release: ReleaseEvidence;
	/** The authority the release was selected under. A row stored before F4 reads as null at the store boundary. */
	readonly releaseAuthority: ReleaseIntent["authority"] | null;
	readonly merge: MergeProgress;
	readonly treasury: readonly TreasuryEntry[];
};

export type RefundedState = {
	readonly status: "REFUNDED";
	readonly payee: LockedBid;
	readonly book: RefundedBook;
	/** The reason the refund selected. Null on a row stored before the reason was recorded; the store read types that absence. */
	readonly reason: RefundReason | null;
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
	/**
	 * The visitor that opened this job, or null for the deployment's own seeded world. Frozen at
	 * OpenJob from the actor's tenant, and the only field core's visibility and command gates read.
	 */
	readonly tenant: VisitorId | null;
	readonly title: string;
	readonly contract: AcceptanceContract;
	readonly openedAt: Instant;
	readonly bids: readonly Bid[];
	/**
	 * The note the arbiter sent with its most recent ResolveDispute, whatever the verdict. Absent before
	 * any arbiter decision and on rows stored before F4. The route bounds its length; the domain keeps it.
	 */
	readonly arbiterNote?: string;
	/**
	 * The funding source the job's client chose, read at the store boundary from beside the row. Absent
	 * on a raw row and null on a job nobody chose for, where the deployment's default applies.
	 */
	readonly funding?: JobFundingMode | null;
	/**
	 * The total this job's own clock has been advanced by, in milliseconds. Absent on rows stored before
	 * the lever existed, which is the same as zero; `shiftJobClock` adds to it in the same write that
	 * moves the row's instants.
	 */
	readonly clockShiftMs?: number;
	readonly state: S;
};

// Effects the table asks for. effects.ts derives their keys and PayPal request ids.

export type JobEffect =
	| { readonly kind: "CREATE_ORDER"; readonly jobId: JobId; readonly round: number; readonly payee: MerchantId; readonly quote: FeeQuote; readonly fundingMode?: "checkout" | "card" }
	| { readonly kind: "CAPTURE"; readonly jobId: JobId; readonly round: number; readonly orderId: OrderId; readonly payee: MerchantId }
	| { readonly kind: "CREATE_WORK_REPO"; readonly jobId: JobId; readonly repository: string; readonly frozenCommit: CommitSha }
	| { readonly kind: "RELEASE"; readonly jobId: JobId; readonly captureId: CaptureId; readonly payee: MerchantId }
	| { readonly kind: "REFUND"; readonly jobId: JobId; readonly captureId: CaptureId; readonly payee: MerchantId; readonly amount: UsdCents }
	/** The retained refund fee, paid from the platform's own balance to the operator's merchant. */
	| { readonly kind: "REIMBURSE"; readonly jobId: JobId; readonly merchant: MerchantId; readonly amount: UsdCents }
	| { readonly kind: "START_VERIFIER"; readonly jobId: JobId; readonly attempt: PendingAttempt }
	| { readonly kind: "MERGE"; readonly jobId: JobId; readonly pullRequest: number; readonly mergeCommit: CommitSha; readonly repository: string }
	| {
		readonly kind: "ALERT";
		readonly jobId: JobId;
		readonly reason: "DISPUTE_SLA_MISSED" | "SETTLEMENT_UNCONFIRMED_AT_CUTOFF" | "OPERATOR_REIMBURSEMENT_OWED" | "SETTLEMENT_MISMATCH";
	};

// The table

export type Role = "CLIENT" | "OPERATOR" | "ARBITER" | "SYSTEM";
export type TrustedActor = Actor | { readonly role: "SYSTEM"; readonly source: "PAYPAL" | "VERIFIER" | "TIMER" | "OUTBOX" };

export type DomainFailure =
	| "NOT_FOUND"
	| "NOT_OWNER"
	| "WRONG_STATE"
	| "CONTRACT_NOT_FROZEN"
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
	| { readonly kind: "ACCEPT_BID"; readonly quote: FeeQuote; readonly fundingMode?: "checkout" | "card" }
	| { readonly kind: "BIDDER_CREDITS"; readonly accounts: ReadonlyMap<OperatorId, CreditAccount> };

export type Facts = { readonly actor: TrustedActor; readonly now: Instant; readonly loaded: Loaded };

/** A plan's own word for an observation it did not take. Only a settlement refusal sets it. */
export type Refusal = "SETTLEMENT_MISMATCH";

/** effects.ts commits the row, credit accounts, outbox rows, the request record, and the caps together. */
export type Plan<Next> = {
	readonly next: Next;
	readonly credits: readonly CreditAccount[];
	readonly effects: readonly JobEffect[];
	readonly refused?: Refusal;
	/** The caps this write spends, checked and written in the committing transaction. See caps.ts. */
	readonly reservations?: readonly Reservation[];
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
	VerifierFinished: Edge<Work, JobRef & { readonly report: VerifierReport }, Work | Verified, "SYSTEM">;
	Approve: Edge<Verified, JobRef & { readonly mergeCommit: CommitSha }, Verified, "CLIENT">;
	Dispute: Edge<Verified, JobRef & { readonly mergeCommit: CommitSha; readonly reason: string }, Verified, "CLIENT">;
	ResolveDispute: Edge<Verified, JobRef & { readonly verdict: "UPHOLD" | "REWORK" | "REFUND"; readonly note: string }, Verified | Work, "ARBITER">;
	ReleaseSettled: Edge<JobRow, JobRef & { readonly release: ReleaseEvidence }, JobRow<PaidState> | JobRow, "SYSTEM">;
	RefundSettled: Edge<JobRow, JobRef & { readonly refund: RefundEvidence }, JobRow<RefundedState> | JobRow, "SYSTEM">;
	ReimbursementSettled: Edge<JobRow<RefundedState>, JobRef & { readonly reimbursement: ReimbursementEvidence }, JobRow<RefundedState>, "SYSTEM">;
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
	// TODO 5 VERIFIED DISPUTED past resolveBy releases ARBITER_SLA_MISSED and emits ALERT DISPUTE_SLA_MISSED.
	//      The verifier passed, so a missed arbiter deadline is Acquit's failure and the operator is not made to wait.
	// TODO 6 OPEN FUNDING past checkoutEndsAt and not CAPTURING returns to BIDDING, chosen bid back to PENDING.
	// TODO 7 OPEN past deliveryEndsAt and not CAPTURING enters CLOSED NO_ACCEPT_BY_DEADLINE, Return all open bids.
	// TODO 8 OPEN, PENDING bids past respondBy become RETURNED. Return each with NO_CLIENT_RESPONSE.
	const unimplemented = () => { throw new Error("not implemented"); };
	return {
		OpenJob: { by: "CLIENT", apply: (_row, command, facts) => {
			if (facts.actor.role !== "CLIENT" || facts.loaded.kind !== "OPEN_JOB") return "NOT_OWNER";
			if (command.deliveryEndsAt <= facts.now) return "DEADLINE_PASSED";
			if (command.deliveryEndsAt > addHours(facts.now, hours(14 * 24))) return "DEADLINE_TOO_FAR";
			const id = parseJobId(`job_${randomUUID()}`);
			const tenant = facts.actor.tenant;
			// Judge mode's job caps are reservations: they are checked and written inside the transaction
			// that commits this job, so two opens at once cannot both pass the last slot. A client with no
			// tenant, the deployment's own, opens jobs outside the caps.
			return { next: { id, version: 0 as Version,
				client: facts.actor.clientId, tenant, title: facts.loaded.title, contract: facts.loaded.contract,
				openedAt: facts.now, bids: [], state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } } },
				credits: [], effects: [],
				reservations: tenant === null ? [] : [{ kind: "JOB", scope: tenant, ref: id, cents: command.budget, at: facts.now }] };
		} },
		PlaceBid: { by: "OPERATOR", apply: (row, command, facts) => {
			if (facts.actor.role !== "OPERATOR" || facts.loaded.kind !== "PLACE_BID") return "NOT_OWNER";
			const { operator, agent, credits } = facts.loaded;
			if (operator.id !== facts.actor.operatorId || agent.owner !== operator.id || agent.id !== command.agent) return "NOT_OWNER";
			if (!readyToBid(operator)) return "ONBOARDING_REQUIRED";
			if (facts.now >= row.contract.deliveryEndsAt) return "DEADLINE_PASSED";
			if (row.state.phase.kind === "FUNDING" && row.state.phase.checkout.phase === "REFUND_PENDING") return "WRONG_STATE";
			if (command.price > row.contract.budget) return "PRICE_OVER_BUDGET";
			if (operator.kind === "HOUSE" && row.bids.some(bid => bid.kind === "HOUSE")) return "HOUSE_ALREADY_BID";
			if (row.bids.some(bid => bid.operator === operator.id)) return "ALREADY_BID";
			const bid: Bid = { id: parseBidId(`bid_${randomUUID()}`), operator: operator.id, handle: operator.handle,
				kind: operator.kind, payee: operator.payouts.merchant, agent: agent.id, runner: agent.runner,
				price: command.price, eta: command.eta, pitch: command.pitch, placedAt: facts.now,
				respondBy: addHours(facts.now, hours(TERMS.bidReviewHours)), status: "PENDING" };
			const charged = operator.kind === "HOUSE" ? credits : reduceCredits(credits, { kind: "Spend", bid: bid.id, at: facts.now });
			if (charged === "INSUFFICIENT_CREDITS") return charged;
			return { next: { ...row, version: (row.version + 1) as Version, bids: [...row.bids, bid] },
				credits: operator.kind === "HOUSE" ? [] : [charged], effects: [] };
		} },
		AcceptBid: { by: "CLIENT", apply: (row, command, facts) => {
			if (row.state.phase.kind !== "BIDDING" || facts.loaded.kind !== "ACCEPT_BID") return "WRONG_STATE";
			if (facts.now >= row.contract.deliveryEndsAt) return "DEADLINE_PASSED";
			const bid = row.bids.find(b => b.id === command.bidId && b.status === "PENDING");
			if (!bid) return "NOT_FOUND";
			if (facts.now >= bid.respondBy) return "DEADLINE_PASSED";
			const chosen: LockedBid = { bidId: bid.id, operator: bid.operator, payee: bid.payee,
				agent: bid.agent, price: bid.price, eta: bid.eta };
			const round = row.state.phase.fundingRounds + 1;
			const quote = facts.loaded.quote;
			if (quote.split.price !== bid.price) return "WRONG_STATE";
			return { next: { ...row, version: (row.version + 1) as Version,
				bids: row.bids.map(b => b.id === bid.id ? { ...b, status: "CHOSEN" } : b),
				state: { status: "OPEN", phase: { kind: "FUNDING", round, chosen, quote,
					checkoutEndsAt: addHours(facts.now, hours(TERMS.checkoutHours)), checkout: { phase: "CREATING_ORDER" } } } },
				credits: [], effects: [{ kind: "CREATE_ORDER", jobId: row.id, round, payee: bid.payee, quote, fundingMode: facts.loaded.fundingMode ?? "checkout" }] };
		} },
		CancelJob: { by: "CLIENT", apply: (row, _command, facts) => {
			if (row.state.phase.kind === "FUNDING" && ["CAPTURING", "REFUND_PENDING"].includes(row.state.phase.checkout.phase)) return "PAYMENT_IN_PROGRESS";
			const returned: CreditAccount[] = [];
			if (facts.loaded.kind !== "BIDDER_CREDITS") return "WRONG_STATE";
			for (const bid of row.bids) {
				if (bid.kind === "HOUSE" || !["PENDING", "CHOSEN"].includes(bid.status)) continue;
				const account = returned.find(a => a.operator === bid.operator) ?? facts.loaded.accounts.get(bid.operator);
				if (!account) return "NOT_FOUND";
				const changed = reduceCredits(account, { kind: "Return", bid: bid.id, reason: "CLIENT_CANCEL", at: facts.now });
				if (changed !== "INSUFFICIENT_CREDITS" && changed !== account) {
					const index = returned.findIndex(a => a.operator === bid.operator);
					if (index >= 0) returned[index] = changed; else returned.push(changed);
				}
			}
			return { next: { ...row, version: (row.version + 1) as Version,
				bids: row.bids.map(b => ["PENDING", "CHOSEN"].includes(b.status) ? { ...b, status: "RETURNED" } : b),
				state: { status: "CLOSED", reason: "CLIENT_CANCEL", closedAt: facts.now, book: [] } }, credits: returned, effects: [] };
		} },
		OrderCreated: { by: "SYSTEM", apply: (row, command) => {
			const phase = row.state.phase;
			if (phase.kind !== "FUNDING" || phase.round !== command.round || phase.checkout.phase !== "CREATING_ORDER") return unchanged(row);
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { status: "OPEN", phase: { ...phase, checkout: { phase: "AWAITING_APPROVAL", orderId: command.orderId, approveUrl: command.approveUrl } } } }, credits: [], effects: [] };
		} },
		FundingFailed: { by: "SYSTEM", apply: (row, command) => {
			const phase = row.state.phase;
			if (phase.kind !== "FUNDING" || phase.round !== command.round || phase.checkout.phase === "REFUND_PENDING") return unchanged(row);
			return { next: { ...row, version: (row.version + 1) as Version,
				bids: row.bids.map(b => b.id === phase.chosen.bidId ? { ...b, status: "PENDING" } : b),
				state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: phase.round } } }, credits: [], effects: [] };
		} },
		BuyerApproved: { by: "SYSTEM", apply: (row, command) => {
			const phase = row.state.phase;
			if (phase.kind !== "FUNDING" || phase.checkout.phase !== "AWAITING_APPROVAL" || phase.checkout.orderId !== command.orderId) return unchanged(row);
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { status: "OPEN", phase: { ...phase, checkout: { phase: "CAPTURING", orderId: command.orderId } } } },
				credits: [], effects: [{ kind: "CAPTURE", jobId: row.id, round: phase.round, orderId: command.orderId, payee: phase.chosen.payee }] };
		} },
		CaptureCompleted: { by: "SYSTEM", apply: (row, command) => {
			const phase = row.state.phase;
			if (phase.kind !== "FUNDING" || !("orderId" in phase.checkout) || phase.checkout.orderId !== command.capture.orderId) return unchanged(row);
			const capture = command.capture;
			const book = reduceLedger([], { kind: "Hold", gross: capture.gross, at: capture.capturedAt });
			if ("kind" in book) return "WRONG_STATE";
			const escrow: HeldEscrow = { payee: phase.chosen, quote: phase.quote, capture, book,
				cutoffAt: addHours(capture.capturedAt, hours(TERMS.captureCutoffDays * 24)) };
			if (capture.payee !== phase.chosen.payee || capture.gross !== phase.quote.split.held || capture.platformFee !== phase.quote.platformFeeInstruction) {
				return { next: { ...row, version: (row.version + 1) as Version,
					state: { status: "OPEN", phase: { ...phase, checkout: { phase: "REFUND_PENDING", escrow, refund: { reason: "CAPTURE_MISMATCH", selectedAt: capture.capturedAt } } } } },
					credits: [], effects: [{ kind: "REFUND", jobId: row.id, captureId: capture.captureId, payee: capture.payee, amount: capture.gross }] };
			}
			// A row stored before the freeze has no commit to push. It enters work with no repository, Submit refuses it
			// by CONTRACT_NOT_FROZEN, and the delivery deadline returns the money.
			const done = storedDefinitionOfDone(row);
			return { next: { ...row, version: (row.version + 1) as Version,
				bids: row.bids.map(b => b.id === phase.chosen.bidId ? { ...b, status: "ACCEPTED" } : b.status === "PENDING" ? { ...b, status: "NOT_SELECTED" } : b),
				state: { status: "IN_PROGRESS", escrow, attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } } },
				credits: [], effects: done === null ? [] : [{ kind: "CREATE_WORK_REPO", jobId: row.id,
					repository: done.issue.repository, frozenCommit: done.frozenAt }] };
		} },
		Submit: { by: "OPERATOR", apply: (row, command, facts) => {
			if (facts.actor.role !== "OPERATOR" || row.state.escrow.payee.operator !== facts.actor.operatorId) return "NOT_OWNER";
			// No frozen test list exists for a row stored before F3, so no run can be judged. Refuse by name.
			if (storedDefinitionOfDone(row) === null) return "CONTRACT_NOT_FROZEN";
			const attempts = row.state.attempts;
			if (attempts.phase === "REFUND_PENDING") return "WRONG_STATE";
			// The same commit while a run is pending returns the pending attempt instead of starting a second run.
			if (attempts.phase === "VERIFYING") return attempts.pending.sourceCommit === command.sourceCommit ? unchanged(row) : "VERIFIER_PENDING";
			if (facts.now >= row.contract.deliveryEndsAt) return "DEADLINE_PASSED";
			if (attempts.history.length >= TERMS.maxAttempts) return "ATTEMPTS_EXHAUSTED";
			const ordinal = (attempts.history.length + 1) as Ordinal;
			const run = attempts.runsStarted + 1;
			const runId = verifierRunId(row.id, run);
			const pending: PendingAttempt = { ordinal, run, runId, sourceCommit: command.sourceCommit,
				submittedAt: facts.now, runEndsAt: instant(new Date(Date.parse(facts.now) + VERIFIER_RUN_MINUTES * 60_000).toISOString()) };
			// The run this Submit starts is a reservation too, spent here and never released: a job that later
			// settles, refunds, or moves its clock cannot hand the deployment's free tier a run back.
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { ...row.state, attempts: { phase: "VERIFYING", history: attempts.history, runsStarted: run, pending, failure: attempts.failure } } },
				credits: [], effects: [{ kind: "START_VERIFIER", jobId: row.id, attempt: pending }],
				reservations: [{ kind: "RUN", scope: row.tenant ?? row.client, ref: runId, cents: 0 as UsdCents, at: facts.now }] };
		} },
		VerifierFinished: { by: "SYSTEM", apply: (row, command, facts) => {
			const attempts = row.state.attempts;
			const report = command.report;
			const runId = report.kind === "VERDICT" ? report.verdict.runId : report.failure.runId;
			const sourceCommit = report.kind === "VERDICT" ? report.verdict.sourceCommit : report.failure.sourceCommit;
			// An unmatched run is a no-op, so a redelivered callback cannot burn a second slot.
			if (attempts.phase !== "VERIFYING" || attempts.pending.runId !== runId || attempts.pending.sourceCommit !== sourceCommit) return unchanged(row);
			if (report.kind === "RUN_FAILED") {
				// A run that ended without a verdict is infrastructure, not the worker: the slot returns and the
				// attempt count stays put. A publish that failed after a clean judgment lands here too. A verdict
				// is not usable until it names a published commit, and the operator's resubmit re-judges the same
				// tree while the publisher reuses the branch, the pull request, and the check run it already made.
				return { next: { ...row, version: (row.version + 1) as Version,
					state: { ...row.state, attempts: { phase: "READY", history: attempts.history, runsStarted: attempts.runsStarted,
						failure: report.failure } } }, credits: [], effects: [] };
			}
			const verdict = report.verdict;
			const ordinal = attempts.pending.ordinal;
			if (verdict.result === "VERIFIED") {
				const passed: PassedAttempt = { ordinal, verdict };
				const history = [...attempts.history, passed] as History;
				return { next: { ...row, version: (row.version + 1) as Version,
					state: { status: "VERIFIED", escrow: row.state.escrow, history, passed,
						review: { phase: "AWAITING_CLIENT", endsAt: addHours(facts.now, hours(TERMS.clientReviewHours)) },
						runsStarted: attempts.runsStarted } }, credits: [], effects: [] };
			}
			const rejected: RejectedAttempt = { ordinal, verdict };
			const history = [...attempts.history, rejected] as History;
			if (ordinal === TERMS.maxAttempts) {
				return { next: { ...row, version: (row.version + 1) as Version,
					state: { ...row.state, attempts: { phase: "REFUND_PENDING", history, refund: { reason: "ATTEMPTS_EXHAUSTED", selectedAt: facts.now } } } },
					credits: [], effects: [refundIntent(row.id, row.state.escrow)] };
			}
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { ...row.state, attempts: { phase: "READY", history, runsStarted: attempts.runsStarted, failure: null } } }, credits: [], effects: [] };
		} },
		Approve: { by: "CLIENT", apply: (row, command, facts) => {
			// The client approves the artifact the verifier judged, not a moving pull request head.
			if (row.state.review.phase !== "AWAITING_CLIENT" || facts.now >= row.state.review.endsAt) return "REVIEW_CLOSED";
			if (command.mergeCommit !== row.state.passed.verdict.mergeCommit) return "ARTIFACT_CHANGED";
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { ...row.state, review: { phase: "RELEASE_PENDING", release: { authority: "CLIENT_APPROVAL", selectedAt: facts.now } } } },
				credits: [], effects: [releaseIntent(row.id, row.state.escrow)] };
		} },
		Dispute: { by: "CLIENT", apply: (row, command, facts) => {
			// A dispute names the same judged artifact an approval would: a moved head is refused by name.
			if (row.state.review.phase !== "AWAITING_CLIENT" || facts.now >= row.state.review.endsAt) return "REVIEW_CLOSED";
			if (command.mergeCommit !== row.state.passed.verdict.mergeCommit) return "ARTIFACT_CHANGED";
			// The review clock pauses here: the row keeps no endsAt in DISPUTED, and wakeAt holds the
			// arbiter's resolveBy instead, so the old deadline can never release the escrow.
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { ...row.state, review: { phase: "DISPUTED", reason: command.reason, openedAt: facts.now,
					resolveBy: addHours(facts.now, hours(TERMS.disputeResolutionHours)) } } }, credits: [], effects: [] };
		} },
		ResolveDispute: { by: "ARBITER", apply: (row, command, facts) => {
			if (row.state.review.phase !== "DISPUTED") return "WRONG_STATE";
			// The note rides with the decision, whatever the verdict, so the resolved view can serve it.
			if (command.verdict === "UPHOLD") {
				return { next: { ...row, version: (row.version + 1) as Version, arbiterNote: command.note,
					state: { ...row.state, review: { phase: "RELEASE_PENDING", release: { authority: "ARBITER_UPHELD", selectedAt: facts.now } } } },
					credits: [], effects: [releaseIntent(row.id, row.state.escrow)] };
			}
			if (command.verdict === "REFUND") {
				return { next: { ...row, version: (row.version + 1) as Version, arbiterNote: command.note,
					state: { ...row.state, review: { phase: "REFUND_PENDING", refund: { reason: "ARBITER_REFUND", selectedAt: facts.now } } } },
					credits: [], effects: [refundIntent(row.id, row.state.escrow)] };
			}
			// REWORK hands the work back with the pass kept in history. It needs a slot and a live deadline,
			// because a fourth judged attempt cannot be reserved and a passed deadline refunds, not reworks.
			// A refused rework writes nothing at all, the note included: the refusal stands and the dispute stays open.
			if (facts.now >= row.contract.deliveryEndsAt || row.state.history.length >= TERMS.maxAttempts) return "WRONG_STATE";
			return { next: { ...row, version: (row.version + 1) as Version, arbiterNote: command.note,
				state: { status: "IN_PROGRESS", escrow: row.state.escrow,
					attempts: { phase: "READY", history: row.state.history, runsStarted: row.state.runsStarted, failure: null } } },
				credits: [], effects: [] };
		} },
		ReleaseSettled: { by: "SYSTEM", apply: (row, command) => {
			const release = command.release;
			// One disposition per job: a release is applied only to the release this row selected, and only
			// when its evidence names the held capture and adds up to the held gross.
			if (row.state.status !== "VERIFIED" || row.state.review.phase !== "RELEASE_PENDING" || release.captureId !== row.state.escrow.capture.captureId) return settlementMismatch(row);
			const escrow = row.state.escrow;
			const book = reduceLedger(escrow.book, { kind: "Release", operatorNet: release.paid,
				processorFee: escrow.capture.processorFee, platformFee: escrow.capture.platformFee, at: release.at });
			if ("kind" in book) return settlementMismatch(row);
			const done = storedDefinitionOfDone(row);
			if (done === null) return "CONTRACT_NOT_FROZEN";
			const passed = row.state.passed;
			const receipt = receiptOf({ id: parseReceiptId(`rcpt_${randomUUID()}`), jobId: row.id, operator: escrow.payee.operator,
				agent: escrow.payee.agent, pullRequest: passed.verdict.pullRequest, mergeCommit: passed.verdict.mergeCommit,
				frozen: passed.verdict.frozen, hidden: passed.verdict.hidden, attemptsUsed: passed.ordinal,
				paid: release.paid, releasedAt: release.at });
			const treasury = releaseTreasury({ jobId: row.id, operator: escrow.payee.operator, promisedNet: escrow.quote.split.operatorNet,
				observedNet: release.paid, predictedProcessorFee: escrow.quote.predictedProcessorFee,
				observedProcessorFee: escrow.capture.processorFee, at: release.at });
			const effects: JobEffect[] = [{ kind: "MERGE", jobId: row.id, pullRequest: receipt.pullRequest,
				mergeCommit: receipt.mergeCommit, repository: done.issue.repository }];
			// The money is already out. A shortfall cannot be unwound, so it is owed back and named.
			if (treasury.some(entry => entry.kind === "OPERATOR_REIMBURSEMENT_OWED")) effects.push({ kind: "ALERT", jobId: row.id, reason: "OPERATOR_REIMBURSEMENT_OWED" });
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { status: "PAID", payee: escrow.payee, book, receipt, release, releaseAuthority: row.state.review.release.authority,
					merge: { phase: "PENDING" }, treasury } }, credits: [], effects };
		} },
		RefundSettled: { by: "SYSTEM", apply: (row, command) => {
			const escrow = heldEscrowOf(row);
			const intent = refundIntentOf(row);
			const refund = command.refund;
			if (escrow === null || intent === null || refund.captureId !== escrow.capture.captureId || refund.refunded !== escrow.capture.gross) return settlementMismatch(row);
			// PayPal keeps the capture's own fee, read back from the same capture the job recorded at
			// capture. A refund that reports any other retained amount is a fact this job never settled,
			// so the treasury is never charged a fee the row did not see.
			if (refund.retainedProcessorFee !== escrow.capture.processorFee) return settlementMismatch(row);
			const book = reduceLedger(escrow.book, { kind: "Refund", refunded: refund.refunded, at: refund.at });
			if ("kind" in book) return settlementMismatch(row);
			// PayPal kept the processing fee and debited the operator for it. Acquit owes it back, and the
			// payout that settles the debt is a second money movement with its own effect.
			const owed = refund.retainedProcessorFee > 0;
			const treasury = owed ? refundTreasury({ jobId: row.id, operator: escrow.payee.operator,
				retainedProcessorFee: refund.retainedProcessorFee, at: refund.at }) : [];
			const effects: JobEffect[] = owed ? [{ kind: "REIMBURSE", jobId: row.id, merchant: escrow.payee.payee,
				amount: refund.retainedProcessorFee }] : [];
			const history: History = row.state.status === "IN_PROGRESS" ? row.state.attempts.history
				: row.state.status === "VERIFIED" || row.state.status === "REFUNDED" ? row.state.history : [];
			// The arbiter's note survives the settlement when there was one; a deadline refund has none and
			// the key stays absent, so a row read back from the store deep-equals the row that produced it.
			return { next: { id: row.id, version: (row.version + 1) as Version, client: row.client, tenant: row.tenant, title: row.title,
				contract: row.contract, openedAt: row.openedAt, bids: row.bids,
				...(row.arbiterNote === undefined ? {} : { arbiterNote: row.arbiterNote }),
				state: { status: "REFUNDED", payee: escrow.payee, book, reason: intent.reason, refund,
					history, treasury } }, credits: [], effects };
		} },
		ReimbursementSettled: { by: "SYSTEM", apply: (row, command) => {
			const reimbursement = command.reimbursement;
			// A redelivery of the batch this row already recorded changes nothing.
			const paid = row.state.treasury.find((entry): entry is Extract<TreasuryEntry, { kind: "PAYOUT_FEE_PAID" }> => entry.kind === "PAYOUT_FEE_PAID");
			if (paid !== undefined && paid.batchId === reimbursement.batchId) return unchanged(row);
			const owed = row.state.treasury.find((entry): entry is Extract<TreasuryEntry, { kind: "OPERATOR_REIMBURSEMENT_OWED" }> =>
				entry.kind === "OPERATOR_REIMBURSEMENT_OWED");
			// Only the payout this row owes, to the payee it owes, settles the debt. Another batch is a
			// second payout of a settled debt, and it is a fact a person has to see, not a second line.
			if (paid !== undefined || owed === undefined || reimbursement.merchant !== row.state.payee.payee || reimbursement.paid !== owed.cents)
				return settlementMismatch(row);
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { ...row.state, treasury: [...row.state.treasury, { kind: "PAYOUT_FEE_PAID", jobId: row.id,
					batchId: reimbursement.batchId, paid: reimbursement.paid, fee: reimbursement.fee, at: reimbursement.at }] } }, credits: [], effects: [] };
		} },
		MergeFinished: { by: "SYSTEM", apply: (row, command) => {
			// The merge only ever moves forward. A redelivered observation of an earlier phase is ignored.
			if (row.state.merge.phase !== "PENDING") return unchanged(row);
			return { next: { ...row, version: (row.version + 1) as Version, state: { ...row.state, merge: command.outcome } }, credits: [], effects: [] };
		} },
		TimerDue: { by: "SYSTEM", apply: (row, command, facts) => {
			if (command.expectedWakeAt !== wakeAt(row) || facts.now < command.expectedWakeAt) return unchanged(row);
			// The capture-age watchdog runs first in every state that holds money. Day 21 leaves a week to
			// reconcile before PayPal's day 28. It never switches sides: an unconfirmed settlement is reported.
			const escrow = heldEscrowOf(row);
			if (escrow !== null && facts.now >= escrow.cutoffAt) {
				if (escrow.cutoffHandledAt) return unchanged(row);
				if (row.state.status === "IN_PROGRESS" && row.state.attempts.phase !== "REFUND_PENDING") {
					return { next: { ...row, version: (row.version + 1) as Version,
						state: { ...row.state, escrow: { ...escrow, cutoffHandledAt: facts.now },
							attempts: { phase: "REFUND_PENDING", history: row.state.attempts.history, refund: { reason: "CAPTURE_CUTOFF", selectedAt: facts.now } } } },
						credits: [], effects: [refundIntent(row.id, escrow)] };
				}
				// A row that already selected its disposition is never switched, whether that disposition is a
				// release or a refund. Both are reported as unconfirmed settlements instead.
				if (row.state.status === "VERIFIED" && !["RELEASE_PENDING", "REFUND_PENDING"].includes(row.state.review.phase)) {
					return { next: { ...row, version: (row.version + 1) as Version,
						state: { ...row.state, escrow: { ...escrow, cutoffHandledAt: facts.now },
							review: { phase: "RELEASE_PENDING", release: { authority: "CAPTURE_CUTOFF", selectedAt: facts.now } } } },
						credits: [], effects: [releaseIntent(row.id, escrow)] };
				}
				// A settlement was selected before the cutoff and is still unconfirmed. No new disposition.
				return { next: { ...row, version: (row.version + 1) as Version, state: withEscrow(row.state, { ...escrow, cutoffHandledAt: facts.now }) },
					credits: [], effects: [{ kind: "ALERT", jobId: row.id, reason: "SETTLEMENT_UNCONFIRMED_AT_CUTOFF" }] };
			}
			if (row.state.status === "VERIFIED") {
				const review = row.state.review;
				if (review.phase === "AWAITING_CLIENT" && facts.now >= review.endsAt) {
					return { next: { ...row, version: (row.version + 1) as Version,
						state: { ...row.state, review: { phase: "RELEASE_PENDING", release: { authority: "REVIEW_SILENCE", selectedAt: facts.now } } } },
						credits: [], effects: [releaseIntent(row.id, row.state.escrow)] };
				}
				if (review.phase === "DISPUTED" && facts.now >= review.resolveBy) {
					// The verifier passed, so a missed arbiter deadline is Acquit's failure: release and alert.
					return { next: { ...row, version: (row.version + 1) as Version,
						state: { ...row.state, review: { phase: "RELEASE_PENDING", release: { authority: "ARBITER_SLA_MISSED", selectedAt: facts.now } } } },
						credits: [], effects: [releaseIntent(row.id, row.state.escrow), { kind: "ALERT", jobId: row.id, reason: "DISPUTE_SLA_MISSED" }] };
				}
				return unchanged(row);
			}
			if (row.state.status === "IN_PROGRESS") {
				const attempts = row.state.attempts;
				if (attempts.phase === "VERIFYING" && facts.now >= attempts.pending.runEndsAt) {
					// A run that never reported ended without a verdict: the slot returns, the attempt count stays
					// put, and the job names the step so the CLI prints it instead of waiting out the deadline.
					const failure: RunFailure = { runId: attempts.pending.runId, sourceCommit: attempts.pending.sourceCommit,
						name: "RUN_DEADLINE_EXCEEDED", detail: "", at: facts.now };
					const gave = { phase: "READY" as const, history: attempts.history, runsStarted: attempts.runsStarted, failure };
					if (facts.now < row.contract.deliveryEndsAt) return { next: { ...row, version: (row.version + 1) as Version,
						state: { ...row.state, attempts: gave } }, credits: [], effects: [] };
					return { next: { ...row, version: (row.version + 1) as Version,
						state: { ...row.state, attempts: { phase: "REFUND_PENDING", history: attempts.history, refund: { reason: "DELIVERY_DEADLINE", selectedAt: facts.now } } } },
						credits: [], effects: [refundIntent(row.id, row.state.escrow)] };
				}
				if (attempts.phase === "READY" && facts.now >= row.contract.deliveryEndsAt) {
					return { next: { ...row, version: (row.version + 1) as Version,
						state: { ...row.state, attempts: { phase: "REFUND_PENDING", history: attempts.history, refund: { reason: "DELIVERY_DEADLINE", selectedAt: facts.now } } } },
						credits: [], effects: [refundIntent(row.id, row.state.escrow)] };
				}
				return unchanged(row);
			}
			// Only pre-capture timers belong to this skeleton.
			if (row.state.status !== "OPEN") return unchanged(row);
			const phase = row.state.phase;
			if (phase.kind === "FUNDING") {
				if (["CAPTURING", "REFUND_PENDING"].includes(phase.checkout.phase)) return unchanged(row);
				if (facts.now >= phase.checkoutEndsAt) return { next: { ...row, version: (row.version + 1) as Version,
					bids: row.bids.map(b => b.id === phase.chosen.bidId ? { ...b, status: "PENDING" } : b),
					state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: phase.round } } }, credits: [], effects: [] };
			}
			if (facts.now >= row.contract.deliveryEndsAt) {
				const closed = transitionTable().CancelJob.apply(row as Open, { jobId: row.id }, facts);
				if (typeof closed === "string") return closed;
				return { ...closed, next: { ...closed.next, state: { ...closed.next.state, reason: "NO_ACCEPT_BY_DEADLINE" } } };
			}
			if (facts.loaded.kind !== "BIDDER_CREDITS") return "WRONG_STATE";
			const expired = row.bids.filter(b => b.status === "PENDING" && facts.now >= b.respondBy);
			if (!expired.length) return unchanged(row);
			const credits: CreditAccount[] = [];
			for (const bid of expired) {
				if (bid.kind === "HOUSE") continue;
				const account = facts.loaded.accounts.get(bid.operator);
				if (!account) return "NOT_FOUND";
				const returned = reduceCredits(account, { kind: "Return", bid: bid.id, reason: "NO_CLIENT_RESPONSE", at: facts.now });
				if (returned !== "INSUFFICIENT_CREDITS" && returned !== account) credits.push(returned);
			}
			return { next: { ...row, version: (row.version + 1) as Version,
				bids: row.bids.map(b => expired.some(old => old.id === b.id) ? { ...b, status: "RETURNED" } : b) }, credits, effects: [] };
		} },
	};
}

function unchanged<S extends JobState>(row: JobRow<S>): Plan<JobRow<S>> {
	return { next: row, credits: [], effects: [] };
}

/** Only this module can build a Receipt: the brand has no runtime key, so the cast stays here. */
function receiptOf(fields: Omit<Receipt, typeof receiptBrand>): Receipt {
	return fields as Receipt;
}

/** A settlement observation that does not match the selected disposition is never applied. It is an ALERT. */
function settlementMismatch<S extends JobState>(row: JobRow<S>): Plan<JobRow<S>> {
	return { next: row, credits: [], effects: [{ kind: "ALERT", jobId: row.id, reason: "SETTLEMENT_MISMATCH" }], refused: "SETTLEMENT_MISMATCH" };
}

/**
 * Whether this viewer may drive a job's own controls (its funding source and its clock): its client,
 * and nobody else, the visitor's own operator included. The controls are not table edges, so this is
 * the one rule they share.
 */
export function mayControlJob(row: JobRow, viewer: Actor): boolean {
	return viewer.role === "CLIENT" && viewer.clientId === row.client && (viewer.tenant ?? null) === (row.tenant ?? null);
}

/** The escrow this row still holds, in every state that can hold one. */
function heldEscrowOf(row: JobRow): HeldEscrow | null {	const state = row.state;
	if (state.status === "IN_PROGRESS" || state.status === "VERIFIED") return state.escrow;
	if (state.status === "OPEN" && state.phase.kind === "FUNDING" && state.phase.checkout.phase === "REFUND_PENDING") return state.phase.checkout.escrow;
	return null;
}

/** The merchant this row pays, wherever the row keeps it. Null before a bid is chosen. */
export function payeeMerchantOf(row: JobRow): MerchantId | null {
	const state = row.state;
	if (state.status === "PAID" || state.status === "REFUNDED") return state.payee.payee;
	if (state.status === "IN_PROGRESS" || state.status === "VERIFIED") return state.escrow.payee.payee;
	if (state.status === "OPEN" && state.phase.kind === "FUNDING") return state.phase.chosen.payee;
	return null;
}

/** The state with its held escrow replaced, wherever that state keeps it. */
function withEscrow<S extends JobState>(state: S, escrow: HeldEscrow): S {
	if (state.status === "IN_PROGRESS" || state.status === "VERIFIED") return { ...state, escrow };
	if (state.status === "OPEN" && state.phase.kind === "FUNDING" && state.phase.checkout.phase === "REFUND_PENDING") {
		return { ...state, phase: { ...state.phase, checkout: { ...state.phase.checkout, escrow } } };
	}
	return state;
}

/** The refund this row selected, if it selected one. */
function refundIntentOf(row: JobRow): RefundIntent | null {
	const state = row.state;
	if (state.status === "IN_PROGRESS" && state.attempts.phase === "REFUND_PENDING") return state.attempts.refund;
	if (state.status === "VERIFIED" && state.review.phase === "REFUND_PENDING") return state.review.refund;
	if (state.status === "OPEN" && state.phase.kind === "FUNDING" && state.phase.checkout.phase === "REFUND_PENDING") return state.phase.checkout.refund;
	return null;
}

/** The release a verified job selects. F2 settles it; the intent is durable from the transition itself. */
function releaseIntent(jobId: JobId, escrow: HeldEscrow): JobEffect {
	return { kind: "RELEASE", jobId, captureId: escrow.capture.captureId, payee: escrow.payee.payee };
}

/**
 * Whether this row still holds the disposition an effect belongs to. The outbox asks before it moves
 * money: an effect the row no longer wants is delivered as done, never dispatched. A pending run,
 * repo, verifier, or alert belongs to no disposition and is always wanted.
 */
export function effectWanted(row: JobRow, effect: JobEffect): boolean {
	switch (effect.kind) {
		case "RELEASE":
			return row.state.status === "VERIFIED" && row.state.review.phase === "RELEASE_PENDING" &&
				row.state.escrow.capture.captureId === effect.captureId;
		case "REFUND":
			return refundIntentOf(row) !== null && heldEscrowOf(row)?.capture.captureId === effect.captureId;
		case "REIMBURSE": {
			if (row.state.status !== "REFUNDED") return false;
			const treasury = row.state.treasury;
			return treasury.some(entry => entry.kind === "OPERATOR_REIMBURSEMENT_OWED") &&
				!treasury.some(entry => entry.kind === "PAYOUT_FEE_PAID");
		}
		default: return true;
	}
}

/** Deterministic per job and run, so a retried start reuses one run identity instead of stacking runs. */
export function verifierRunId(jobId: JobId, run: number): VerifierRunId {
	return `${jobId.replace(/^job_/, "run_")}_${run}` as VerifierRunId;
}

/** The refund a failed attempt selects. F2 settles it; the intent is durable from the transition itself. */
function refundIntent(jobId: JobId, escrow: HeldEscrow): JobEffect {
	return { kind: "REFUND", jobId, captureId: escrow.capture.captureId, payee: escrow.payee.payee, amount: escrow.capture.gross };
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
	const table = transitionTable();
	if (facts.actor.role !== table[command.type].by) return "NOT_OWNER";
	if (command.type === "OpenJob") return row === null ? table.OpenJob.apply(null, command, facts) : "WRONG_STATE";
	if (!row || row.id !== command.jobId) return "NOT_FOUND";
	// The tenant gate comes before any edge: a command from another visitor's world is refused whole,
	// whatever the command is and whichever phase the row holds. The arbiter and the system paths
	// (PayPal, verifier, timer, outbox) are the only readers and writers outside a tenant.
	if (facts.actor.role !== "SYSTEM" && facts.actor.role !== "ARBITER" && (facts.actor.tenant ?? null) !== (row.tenant ?? null)) return "NOT_OWNER";
	if (facts.actor.role === "CLIENT" && row.client !== facts.actor.clientId) return "NOT_OWNER";
	if (command.type === "CaptureCompleted" && row.state.status !== "OPEN") return unchanged(row);
	if (command.type === "TimerDue") return table.TimerDue.apply(row, command, facts);
	// Settlement observations are routed from every state. The edge decides whether the observation matches
	// the disposition this row selected; an unmatched one is an alert, never a refusal the outbox would retry.
	if (command.type === "ReleaseSettled") return table.ReleaseSettled.apply(row, command, facts);
	if (command.type === "RefundSettled") return table.RefundSettled.apply(row, command, facts);
	if (row.state.status === "IN_PROGRESS") {
		switch (command.type) {
			case "Submit": return table.Submit.apply(row as Work, command, facts);
			case "VerifierFinished": return table.VerifierFinished.apply(row as Work, command, facts);
			default: return "WRONG_STATE";
		}
	}
	if (row.state.status === "VERIFIED") {
		switch (command.type) {
			case "Approve": return table.Approve.apply(row as Verified, command, facts);
			case "Dispute": return table.Dispute.apply(row as Verified, command, facts);
			case "ResolveDispute": return table.ResolveDispute.apply(row as Verified, command, facts);
			default: return "WRONG_STATE";
		}
	}
	if (row.state.status === "PAID") {
		switch (command.type) {
			case "MergeFinished": return table.MergeFinished.apply(row as JobRow<PaidState>, command, facts);
			default: return "WRONG_STATE";
		}
	}
	if (row.state.status === "REFUNDED") {
		switch (command.type) {
			case "ReimbursementSettled": return table.ReimbursementSettled.apply(row as JobRow<RefundedState>, command, facts);
			default: return "WRONG_STATE";
		}
	}
	if (row.state.status !== "OPEN") return "WRONG_STATE";
	const open = row as Open;
	switch (command.type) {
		case "PlaceBid": return table.PlaceBid.apply(open, command, facts);
		case "AcceptBid": return table.AcceptBid.apply(open, command, facts);
		case "CancelJob": return table.CancelJob.apply(open, command, facts);
		case "OrderCreated": return table.OrderCreated.apply(open, command, facts);
		case "FundingFailed": return table.FundingFailed.apply(open, command, facts);
		case "BuyerApproved": return table.BuyerApproved.apply(open, command, facts);
		case "CaptureCompleted": return table.CaptureCompleted.apply(open, command, facts);
		default: return "WRONG_STATE";
	}
}

/** The earliest instant at which TimerDue would change this row. Stored by the commit for the timer index. */
export function wakeAt(row: JobRow): Instant | null {
	const escrow = heldEscrowOf(row);
	const pendingSettlement = escrow !== null && (
		row.state.status === "IN_PROGRESS" && row.state.attempts.phase === "REFUND_PENDING" ||
		row.state.status === "VERIFIED" && ["RELEASE_PENDING", "REFUND_PENDING"].includes(row.state.review.phase) ||
		row.state.status === "OPEN");
	if (pendingSettlement) {
		// The disposition's own effect settles it. The capture-age cutoff is the only clock left: it reports
		// an unconfirmed settlement once, and never selects another disposition.
		return escrow.cutoffHandledAt === undefined ? escrow.cutoffAt : null;
	}
	if (escrow !== null) {
		// The cutoff acts first. Until it does, the disposition's own clock is what changes the row.
		const own = settlementClock(row);
		return escrow.cutoffHandledAt === undefined ? earlier(escrow.cutoffAt, own) : own;
	}
	if (row.state.status !== "OPEN") return null;
	const candidates = [row.contract.deliveryEndsAt];
	if (row.state.phase.kind === "FUNDING") {
		if (row.state.phase.checkout.phase === "CAPTURING") return null;
		candidates.push(row.state.phase.checkoutEndsAt);
	}
	candidates.push(...row.bids.filter(b => b.status === "PENDING").map(b => b.respondBy));
	return candidates.sort()[0];
}

/** The clock the row's own disposition waits on: a run end, the delivery deadline, review, or the arbiter. */
function settlementClock(row: JobRow): Instant {
	if (row.state.status === "IN_PROGRESS") {
		const attempts = row.state.attempts;
		return attempts.phase === "VERIFYING" ? attempts.pending.runEndsAt : row.contract.deliveryEndsAt;
	}
	if (row.state.status === "VERIFIED") {
		const review = row.state.review;
		return review.phase === "AWAITING_CLIENT" ? review.endsAt : review.phase === "DISPUTED" ? review.resolveBy : row.contract.deliveryEndsAt;
	}
	return row.contract.deliveryEndsAt;
}

function earlier(left: Instant, right: Instant): Instant {
	return left <= right ? left : right;
}

export function rankBids(bids: readonly Bid[], paidReceipts: ReadonlyMap<OperatorId, number>): RankedBids {
	return { operators: bids.filter(b => b.kind === "INDEPENDENT").sort((a, b) =>
		(paidReceipts.get(b.operator) ?? 0) - (paidReceipts.get(a.operator) ?? 0) ||
		a.placedAt.localeCompare(b.placedAt) || a.id.localeCompare(b.id)),
		house: bids.find(b => b.kind === "HOUSE") ?? null };
}

/** The stored book, whatever the reader's role. projectJob serves it through the API; the ctl ledger command reads it straight from the lane database. */
export function storedBook(row: JobRow): readonly LedgerLine[] {
	const state = row.state;
	const funding = state.status === "OPEN" && state.phase.kind === "FUNDING" ? state.phase : null;
	const held = state.status === "IN_PROGRESS" || state.status === "VERIFIED" ? state.escrow
		: funding?.checkout.phase === "REFUND_PENDING" ? funding.checkout.escrow : null;
	return held?.book ?? (state.status === "PAID" || state.status === "REFUNDED" ? state.book : []);
}

/** The definition of done a stored row carries, or null when the row was stored before F3 froze one. SqliteStore parses an absent field to the typed null; a raw row keeps it absent, so every reader comes through here. */
export function storedDefinitionOfDone(row: JobRow): DefinitionOfDone | null {
	const contract: unknown = row.contract;
	if (contract === null || typeof contract !== "object") return null;
	const done = (contract as { readonly definitionOfDone?: unknown }).definitionOfDone;
	return done === null || done === undefined ? null : done as DefinitionOfDone;
}

/** Where a stored row keeps its book and the raw parsed value exactly as stored. NONE means the state cannot hold one yet; UNREADABLE means the state shape is not recognized. The check path judges this value; storedBook above keeps the API projection's defaults for the same rows. */
export type StoredBookRaw =
	| { readonly kind: "NONE" }
	| { readonly kind: "VALUE"; readonly path: "escrow.book" | "checkout.escrow.book" | "book"; readonly value: unknown }
	| { readonly kind: "UNREADABLE"; readonly why: string };

/** The book field of a holder that may be any parsed JSON value. */
function bookAt(holder: unknown): unknown {
	return holder !== null && typeof holder === "object" ? (holder as { readonly book?: unknown }).book : undefined;
}

export function storedBookRaw(row: JobRow): StoredBookRaw {
	const state = row.state as unknown;
	if (state === null || typeof state !== "object") return { kind: "UNREADABLE", why: "state is not an object" };
	const shape = state as { readonly status?: unknown; readonly phase?: unknown; readonly escrow?: unknown; readonly book?: unknown };
	if (shape.status === "OPEN") {
		const phase = shape.phase as { readonly kind?: unknown; readonly checkout?: unknown } | null | undefined;
		if (phase === null || typeof phase !== "object") return { kind: "UNREADABLE", why: "OPEN phase is not an object" };
		if (phase.kind === "BIDDING") return { kind: "NONE" };
		if (phase.kind !== "FUNDING") return { kind: "UNREADABLE", why: "OPEN phase.kind is not a phase kind" };
		const checkout = phase.checkout as { readonly phase?: unknown; readonly escrow?: unknown } | null | undefined;
		if (checkout === null || typeof checkout !== "object") return { kind: "UNREADABLE", why: "OPEN FUNDING checkout is not an object" };
		if (!["CREATING_ORDER", "AWAITING_APPROVAL", "CAPTURING", "REFUND_PENDING"].includes(String(checkout.phase))) return { kind: "UNREADABLE", why: "OPEN FUNDING checkout.phase is not a checkout phase" };
		if (checkout.phase !== "REFUND_PENDING") return { kind: "NONE" };
		return { kind: "VALUE", path: "checkout.escrow.book", value: bookAt(checkout.escrow) };
	}
	if (shape.status === "IN_PROGRESS" || shape.status === "VERIFIED") return { kind: "VALUE", path: "escrow.book", value: bookAt(shape.escrow) };
	if (shape.status === "PAID" || shape.status === "REFUNDED" || shape.status === "CLOSED") return { kind: "VALUE", path: "book", value: shape.book };
	return { kind: "UNREADABLE", why: "state.status is not a job status" };
}

/** One judged attempt, as the API projection and the operator CLI read it. */
export type AttemptView = {
	readonly ordinal: Ordinal;
	readonly result: "REJECTED" | "VERIFIED";
	readonly reasons: readonly string[];
	/** How many reasons the callback's bound dropped from the end of the list. */
	readonly reasonsTruncated: number;
	readonly sourceCommit: CommitSha;
	readonly at: Instant;
	readonly frozen: TestTally | null;
	readonly hidden: TestTally | null;
	readonly pullRequest: number | null;
};

export type PendingRunView = {
	readonly ordinal: Ordinal;
	readonly run: number;
	readonly runId: VerifierRunId;
	readonly sourceCommit: CommitSha;
	readonly submittedAt: Instant;
	readonly runEndsAt: Instant;
};

export type ContractProjection = {
	readonly repository: string;
	readonly frozenAt: CommitSha;
	readonly frozenTests: number;
	readonly hiddenTests: number;
	readonly protectedPaths: readonly string[];
};

/** The projection core adds on top of JobView. The web page and the CLI read it through the API JSON. */
export type JobProjection = JobView & {
	/** Null when the row was stored before F3 froze a definition of done. */
	readonly contract: ContractProjection | null;
	readonly attempts: JobView["attempts"] & {
		readonly history: readonly AttemptView[];
		readonly pending: PendingRunView | null;
		/** The last run that ended without a verdict. It charged no attempt, so it is not in history. */
		readonly failure: RunFailure | null;
	};
};

function attemptView(record: AttemptRecord): AttemptView {
	const verdict = record.verdict;
	return verdict.result === "VERIFIED"
		? { ordinal: record.ordinal, result: "VERIFIED", reasons: [], reasonsTruncated: 0, sourceCommit: verdict.sourceCommit, at: verdict.at,
			frozen: verdict.frozen, hidden: verdict.hidden, pullRequest: verdict.pullRequest }
		: { ordinal: record.ordinal, result: "REJECTED", reasons: verdict.reasons.map(describeRejectReason), reasonsTruncated: verdict.reasonsTruncated,
			sourceCommit: verdict.sourceCommit, at: verdict.at, frozen: null, hidden: null, pullRequest: null };
}

/** Bidding shows proof first. After accept, the ledger spine leads. */
export function projectJob(row: JobRow, viewer: Actor, paidReceipts: ReadonlyMap<OperatorId, number>): JobProjection {
	const ranked = rankBids(row.bids, paidReceipts);
	const viewBid = (bid: Bid) => ({ id: bid.id, operator: bid.operator, handle: bid.handle,
		label: bid.kind, price: bid.price, eta: bid.eta, agent: String(bid.agent), runner: bid.runner,
		pitch: bid.pitch, paidReceipts: paidReceipts.get(bid.operator) ?? 0, status: bid.status });
	const state = row.state;
	const funding = state.status === "OPEN" && state.phase.kind === "FUNDING" ? state.phase : null;
	const held = state.status === "IN_PROGRESS" || state.status === "VERIFIED" ? state.escrow
		: funding?.checkout.phase === "REFUND_PENDING" ? funding.checkout.escrow : null;
	const refund = refundIntentOf(row);
	const ledger = storedBook(row);
	const history = state.status === "IN_PROGRESS" ? state.attempts.history
		: state.status === "VERIFIED" || state.status === "REFUNDED" ? state.history : [];
	const pending = state.status === "IN_PROGRESS" && state.attempts.phase === "VERIFYING" ? state.attempts.pending : null;
	const failure = state.status === "IN_PROGRESS" && state.attempts.phase !== "REFUND_PENDING" ? state.attempts.failure : null;
	// A settled job's attempts live in its receipt or its history, not in the in-flight counter.
	const used = state.status === "PAID" ? state.receipt.attemptsUsed : history.length + (pending ? 1 : 0);
	const judged = history.map(attemptView);
	const done = storedDefinitionOfDone(row);
	return { id: row.id, title: row.title, status: state.status,
		phase: state.status === "OPEN" ? state.phase.kind : state.status === "IN_PROGRESS" ? state.attempts.phase : state.status === "VERIFIED" ? state.review.phase : state.status,
		budget: row.contract.budget, deliveryEndsAt: row.contract.deliveryEndsAt,
		contract: done === null ? null : { repository: done.issue.repository, frozenAt: done.frozenAt, frozenTests: done.frozenTests.length,
			hiddenTests: done.hiddenTests.length, protectedPaths: done.protectedPaths.map(String) },
		bids: { operators: ranked.operators.map(viewBid), house: ranked.house ? viewBid(ranked.house) : null },
		lockedTo: held?.payee.operator ?? (state.status === "PAID" || state.status === "REFUNDED" ? state.payee.operator : null),
		// The owning client is named only to its own session. Everyone else reads null.
		client: viewer.role === "CLIENT" && viewer.clientId === row.client ? row.client : null,
		// The funding source is that client's own choice, so it is served to the same viewer alone.
		funding: viewer.role === "CLIENT" && viewer.clientId === row.client ? row.funding ?? null : null,
		// The clock this client advanced is that client's own lever too, so it reads it and nobody else does.
		clockShiftMs: viewer.role === "CLIENT" && viewer.clientId === row.client ? row.clockShiftMs ?? 0 : null,
		// The page gates Approve on this answer, not on the viewer's role. The edge is still the guard.
		viewerCanApprove: viewer.role === "CLIENT" && viewer.clientId === row.client &&
			state.status === "VERIFIED" && state.review.phase === "AWAITING_CLIENT",
		// The same ownership gate for Dispute: only the owning client, and only while the review is open.
		viewerCanDispute: viewer.role === "CLIENT" && viewer.clientId === row.client &&
			state.status === "VERIFIED" && state.review.phase === "AWAITING_CLIENT",
		// The paused review, served whole so the page can show the reason and the arbiter's deadline.
		dispute: state.status === "VERIFIED" && state.review.phase === "DISPUTED"
			? { reason: state.review.reason, openedAt: state.review.openedAt, resolveBy: state.review.resolveBy } : null,
		// The arbiter's note from the most recent ResolveDispute, whatever the verdict. A row stored before F4 carries none.
		arbiterNote: row.arbiterNote ?? null,
		// What selected the release, while it is pending and after it settles. A row stored before F4 serves null.
		releaseAuthority: state.status === "PAID" ? state.releaseAuthority
			: state.status === "VERIFIED" && state.review.phase === "RELEASE_PENDING" ? state.review.release.authority : null,
		// What selected the refund, while it is pending and after it settles. A row stored before the
		// reason was recorded serves null, as does one that holds no refund at all.
		refundReason: state.status === "REFUNDED" ? state.reason : (refund?.reason ?? null),
		escrow: state.status === "PAID" ? "RELEASED" : state.status === "REFUNDED" ? "REFUNDED" : held ? "HELD" : "NONE",
		approveUrl: funding?.checkout.phase === "AWAITING_APPROVAL" && viewer.role === "CLIENT" && viewer.clientId === row.client ? funding.checkout.approveUrl : null,
		ledger, attempts: { used, left: TERMS.maxAttempts - used, last: state.status === "PAID" ? "VERIFIED" : judged.at(-1)?.result ?? null,
			reasons: state.status === "PAID" ? [] : judged.at(-1)?.reasons ?? [], history: judged, failure,
			pending: pending ? { ordinal: pending.ordinal, run: pending.run, runId: pending.runId, sourceCommit: pending.sourceCommit,
				submittedAt: pending.submittedAt, runEndsAt: pending.runEndsAt } : null },
		reviewEndsAt: state.status === "VERIFIED" && state.review.phase === "AWAITING_CLIENT" ? state.review.endsAt : null,
		pullRequest: state.status === "VERIFIED" ? state.passed.verdict.pullRequest : state.status === "PAID" ? state.receipt.pullRequest : null,
		mergeCommit: state.status === "VERIFIED" ? state.passed.verdict.mergeCommit : state.status === "PAID" ? state.receipt.mergeCommit : null,
		merge: state.status === "PAID" ? state.merge : null,
		release: state.status === "PAID" ? state.release : null,
		receipt: state.status === "PAID" ? state.receipt : null };
}
