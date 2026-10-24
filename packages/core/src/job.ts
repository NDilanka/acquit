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
	Digest,
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
import type { CaptureEvidence, DisputeId, DisputeOffer, EvidenceType, FeeQuote, RefundEvidence, ReimbursementEvidence, ReleaseEvidence } from "./paypal.ts";
import { DISPUTE_ACCESS_REFUSED, EVIDENCE_TYPE_REFUSALS, evidenceTypeFor, NO_HONEST_EVIDENCE_TYPE, refusalWording } from "./paypal.ts";
import { CODE_VERTICAL } from "./outcome.ts";
import type { Vertical } from "./outcome.ts";
import { describeRejectReason, VERIFIER_RUN_MINUTES } from "./verifier.ts";
import type { DefinitionOfDone, RunFailure, SealedHiddenCases, TestTally, Verdict, VerifierReport, VerifierRunId } from "./verifier.ts";
import { resolveHiddenReveal } from "./hidden-seal.ts";
import { isHouseClient, isStarterJob } from "./house-client.ts";
import type { PrivateCaseReader, RevealedHiddenCases } from "./hidden-seal.ts";

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
	| "CAPTURE_MISMATCH"
	/** PayPal resolved a buyer dispute for the buyer on a held, full-amount capture. PayPal already reversed the funds. */
	| "PROVIDER_DISPUTE";

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

/** The receipts table's provenance for a settled job's receipt: a row the settlement wrote reads JOB,
 * and a row the F6 backfill wrote for a PAID job that predates it reads SEED. The pages label a SEED
 * receipt Seeded, on the job page's receipt panel exactly as the receipts views do. */
export type ReceiptSource = "SEED" | "JOB";
/** The projection's receipt: the stored receipt plus the provenance the receipts table holds. */
export type ReceiptView = Receipt & { readonly source: ReceiptSource };

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
	/** Every verdict the row settled with, earlier ones included. A row stored before this field reads as empty at the store boundary. */
	readonly history: History;
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
	 * The PayPal buyer dispute against this job's capture, in any state. It is not the in-app review dispute:
	 * while it is open, no release is emitted, and a release it held proceeds only on a seller-favour resolution.
	 */
	readonly providerDispute?: ProviderDispute;
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
	/** The judge that decides this job's work. A row stored before the registry has none; storedVertical reads it as code. */
	readonly vertical?: Vertical;
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
		readonly reason: "DISPUTE_SLA_MISSED" | "SETTLEMENT_UNCONFIRMED_AT_CUTOFF" | "OPERATOR_REIMBURSEMENT_OWED" | "SETTLEMENT_MISMATCH" | "PROVIDER_DISPUTE_ON_PAID"
			| "PROVIDER_DISPUTE_NOT_ANSWERABLE" | "PROVIDER_DISPUTE_PARTIAL" | "PROVIDER_DISPUTE_PARTIAL_LOST" | "PROVIDER_DISPUTE_LOST_ON_PAID"
			| "PROVIDER_DISPUTE_UNCONFIRMED" | "PROVIDER_DISPUTE_READ_REFUSED" | "PROVIDER_DISPUTE_ANSWER_REFUSED";
		/** The buyer dispute a PROVIDER_DISPUTE alert is about, so the process log names it. No other alert carries one. */
		readonly disputeId?: string;
		/** One plain sentence a person reads beside the reason, when the reason alone does not say what to do. */
		readonly detail?: string;
	}
	/**
	 * Acquit answers a buyer dispute with the job's receipt or its verified attempt. The notes are built when the edge selects it.
	 * `attempt` is the verified attempt the notes describe. It keys the answer, so a later attempt after a rework is a new answer.
	 * `stage` is the dispute stage the answer is for, so an escalated dispute is answered once more. `requeued` marks the one
	 * re-queue after PayPal refused the answer. `evidenceType` is the type PayPal asked for, absent for PROOF_OF_FULFILLMENT.
	 * `filedStage` is the stage the answer files under, for the history. Unlike `stage` it is not part of the round's key, so a first
	 * answer keeps the key it always had.
	 */
	| { readonly kind: "DISPUTE_EVIDENCE"; readonly jobId: JobId; readonly disputeId: string; readonly payee: MerchantId; readonly notes: string;
		readonly attempt: Ordinal; readonly simulated: boolean; readonly stage?: string; readonly requeued?: true; readonly evidenceType?: EvidenceType;
		readonly filedStage?: string }
	/** Acquit sends the same receipt-cited notes as a message, while the dispute is at INQUIRY and offers no evidence to provide. */
	| { readonly kind: "DISPUTE_MESSAGE"; readonly jobId: JobId; readonly disputeId: string; readonly payee: MerchantId; readonly message: string;
		readonly attempt: Ordinal; readonly simulated: boolean; readonly stage?: string; readonly requeued?: true; readonly filedStage?: string }
	/** Acquit accepts the buyer's claim, so PayPal returns the held funds to the buyer. */
	| { readonly kind: "DISPUTE_ACCEPT"; readonly jobId: JobId; readonly disputeId: string; readonly payee: MerchantId; readonly note: string; readonly simulated: boolean;
		readonly requeued?: true; readonly filedStage?: string };

/**
 * What Acquit did about a buyer dispute. EVIDENCE, MESSAGE, and ACCEPT are the answers it filed. NOT_ANSWERABLE means the job
 * had no held escrow left to answer for, so a person has to decide.
 */
export type DisputeAnswer = "EVIDENCE" | "MESSAGE" | "ACCEPT" | "NOT_ANSWERABLE";

/**
 * What PayPal did with the answer Acquit selected. QUEUED until the outbox sends it, FILED once PayPal confirms it, and
 * REFUSED with PayPal's reason when PayPal refuses it for good. A person sees the difference on the job, in plain words.
 * `evidenceType` is the type a refused evidence answer named, absent for PROOF_OF_FULFILLMENT.
 */
export type DisputeAnswerState = { readonly state: "QUEUED" } | { readonly state: "FILED" }
	| { readonly state: "REFUSED"; readonly reason: string; readonly evidenceType?: EvidenceType };

/** An answer PayPal took, as the job keeps it: the answer, the round it answered, the stage and evidence type it went under, and when Acquit queued it. */
export type FiledAnswer = { readonly answer: DisputeAnswer; readonly round: string; readonly stage?: string; readonly evidenceType?: EvidenceType;
	readonly filedAt: Instant };

/** A PayPal buyer dispute, as PayPal last answered for it. `outcome` is PayPal's code once the dispute resolves. */
export type ProviderDispute = {
	readonly id: string;
	readonly status: string;
	readonly reason: string;
	/** Null only when a signed body stood in for a refused read and its amount could not be read. */
	readonly amount: UsdCents | null;
	readonly openedAt: Instant;
	/** PayPal's update_time for the status this record holds. A delivery older than it is a replay and changes nothing. */
	readonly updatedAt?: Instant;
	readonly outcome?: string;
	readonly resolvedAt?: Instant;
	/** Set on the first delivery Acquit saw for this dispute id. Absent on a dispute that reached a resolved state first. */
	readonly answer?: DisputeAnswer;
	readonly answerState?: DisputeAnswerState;
	/** PayPal's dispute_life_cycle_stage on the latest delivery. A change of stage is an escalation, answered once for that stage. */
	readonly stage?: string;
	/** The answer links the latest delivery named. Absent until a delivery names links, so a message is never chosen on a guess. */
	readonly offers?: readonly DisputeOffer[];
	/** The evidence types PayPal asks the seller for on the latest delivery that names any. Absent when it asks for none. */
	readonly requestedEvidence?: readonly string[];
	/** Set once the answer was re-queued after PayPal refused it, for lack of dispute access or for the evidence type it named. The re-queue happens once. */
	readonly requeued?: true;
	/**
	 * The round the answer on this record is for: its dispute and attempt, the stage it was filed for, and the one re-queue.
	 * PayPal's answer to another round files nothing here. Absent on a record stored before rounds were kept, which keeps its rule.
	 */
	readonly answerRound?: string;
	/**
	 * The evidence type the evidence answer on this record filed, for the round it is for. It is the type PayPal received, so a later
	 * delivery that asks for another type changes nothing here. Absent on an answer that is not evidence, and on a record stored before
	 * the type was kept, which the page shows with no type words.
	 */
	readonly answerEvidenceType?: EvidenceType;
	/**
	 * The stage the answer on this record was filed for, kept with its round as its type is, so the history names the stage. Absent
	 * where PayPal named none, and on a record stored before it was kept.
	 */
	readonly answerStage?: string;
	/**
	 * The note PayPal answered with when it did not take the answer on this record: it already held an answer, or the dispute had left
	 * the state that takes one. The answer is still FILED, so the outbox stops retrying, but nothing was taken and no history entry is
	 * kept. A later accepted confirmation for the same answer clears it and keeps the entry. Absent when PayPal took the answer, and on
	 * a record stored before it was kept.
	 */
	readonly answerNote?: string;
	/**
	 * Each answer PayPal took on this dispute, one entry per round, oldest first by when PayPal took it. PayPal's confirmation adds an
	 * entry for its round whether or not the record still holds that round: a late confirmation for an earlier round is kept, and it
	 * changes nothing else on the record. A round the list already holds adds nothing. A rework keeps the list, because those answers
	 * reached PayPal. It holds the newest ANSWER_HISTORY_LIMIT entries. Absent on a record stored before it was kept.
	 */
	readonly answerHistory?: readonly FiledAnswer[];
	/**
	 * The latest delivery is a signed body that stood in for a read PayPal refused. It holds the release whatever its status
	 * says, and settles nothing: a successful read of the dispute replaces it.
	 */
	readonly unconfirmed?: true;
	/** A dispute a judge scenario simulated. PayPal never received an answer for it. */
	readonly simulated?: true;
};

/**
 * The dispute as the job view serves it. Null on a job no buyer dispute has reached. `stage` is PayPal's dispute stage on its
 * latest delivery, and `requestedEvidence` the evidence types it asks for. `evidenceType` is the type the evidence answer filed for
 * its round, null for any other answer, and null where no evidence was filed for the round or the record predates the type.
 * `answerRound` is the round the answer on the record is for, `answerStage` the stage that answer files under, `answerNote` what PayPal
 * answered with when it did not take that answer, and `answerHistory` every answer PayPal took, oldest first.
 */
export type ProviderDisputeView = { readonly id: string; readonly status: string; readonly reason: string; readonly amount: UsdCents | null;
	readonly openedAt: Instant; readonly outcome: string | null; readonly answer: DisputeAnswer | null; readonly answerState: DisputeAnswerState | null;
	readonly stage: string | null; readonly requestedEvidence: readonly string[] | null; readonly evidenceType: EvidenceType | null;
	readonly answerRound: string | null; readonly answerStage: string | null; readonly answerNote: string | null; readonly answerHistory: readonly FiledAnswer[];
	readonly unconfirmed: boolean; readonly simulated: boolean };

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
	/** The observation is the settlement the row already holds: nothing moves and nothing alerts. */
	readonly alreadySettled?: true;
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

/** The judged tree a review names. `artifact` is the name; `mergeCommit` is the alias older callers send. */
type JudgedArtifact = { readonly artifact: CommitSha } | { readonly mergeCommit: CommitSha };

function artifactOf(command: JudgedArtifact): CommitSha {
	return "artifact" in command ? command.artifact : command.mergeCommit;
}

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
	Approve: Edge<Verified, JobRef & JudgedArtifact, Verified, "CLIENT">;
	Dispute: Edge<Verified, JobRef & JudgedArtifact & { readonly reason: string }, Verified, "CLIENT">;
	ResolveDispute: Edge<Verified, JobRef & { readonly verdict: "UPHOLD" | "REWORK" | "REFUND"; readonly note: string }, Verified | Work, "ARBITER">;
	ReleaseSettled: Edge<JobRow, JobRef & { readonly release: ReleaseEvidence }, JobRow<PaidState> | JobRow, "SYSTEM">;
	RefundSettled: Edge<JobRow, JobRef & { readonly refund: RefundEvidence }, JobRow<RefundedState> | JobRow, "SYSTEM">;
	ReimbursementSettled: Edge<JobRow<RefundedState>, JobRef & { readonly reimbursement: ReimbursementEvidence }, JobRow<RefundedState>, "SYSTEM">;
	MergeFinished: Edge<JobRow<PaidState>, JobRef & { readonly outcome: MergeProgress }, JobRow<PaidState>, "SYSTEM">;
	ProviderDispute: Edge<JobRow, JobRef & { readonly disputeId: string; readonly captureId: CaptureId; readonly status: string; readonly reason: string;
		readonly amount: UsdCents | null; readonly openedAt: Instant; readonly updatedAt?: Instant; readonly outcome: string | null; readonly simulated?: true;
		readonly fromVerifiedBody?: true; readonly stage?: string; readonly offers?: readonly DisputeOffer[]; readonly requestedEvidence?: readonly string[] }, JobRow, "SYSTEM">;
	/**
	 * `round` is the answer round PayPal answered, so a late answer to an earlier round of the dispute files nothing on the current one.
	 * `accepted` is true only when PayPal took the answer with a 2xx. An answer PayPal did not take is recorded as filed so the outbox
	 * stops, and `note` names what PayPal answered with. Only an accepted answer enters the history, and only with `filedAt`, the time the
	 * answer was queued, which every dispatch of it shares. An accepted answer that arrives after a settled 422 for the same answer still
	 * enters it, and clears the note. A command without `accepted` is not accepted, because nothing shows PayPal took it. `stage` and
	 * `evidenceType` are what the outbox sent, so the history keeps them for any round.
	 */
	DisputeAnswerFiled: Edge<JobRow, JobRef & { readonly disputeId: string; readonly answer: DisputeAnswer; readonly round?: string;
		readonly stage?: string; readonly evidenceType?: EvidenceType; readonly filedAt?: Instant; readonly accepted?: boolean;
		readonly note?: string }, JobRow, "SYSTEM">;
	/** `evidenceType` is the type an evidence answer was sent as, so a re-queue never sends the same type PayPal refused. */
	DisputeAnswerRefused: Edge<JobRow, JobRef & { readonly disputeId: string; readonly answer: DisputeAnswer; readonly reason: string; readonly round?: string;
		readonly evidenceType?: EvidenceType },
		JobRow, "SYSTEM">;
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
			// tenant, the deployment's own, opens jobs outside the caps. The House client's starter jobs are
			// counted under their own cap, so they never spend the account's own job allowance.
			return { next: { id, version: 0 as Version,
				client: facts.actor.clientId, tenant, title: facts.loaded.title, contract: facts.loaded.contract,
				openedAt: facts.now, bids: [], state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } } },
				credits: [], effects: [],
				reservations: tenant === null ? [] : [{ kind: isHouseClient(facts.actor) ? "STARTER" : "JOB", scope: tenant, ref: id, cents: command.budget, at: facts.now }] };
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
			// settles, refunds, or moves its clock cannot hand the deployment's free tier a run back. Only a
			// visitor's run is capped: the deployment's own client has no visitor allowance to protect.
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { ...row.state, attempts: { phase: "VERIFYING", history: attempts.history, runsStarted: run, pending, failure: attempts.failure } } },
				credits: [], effects: [{ kind: "START_VERIFIER", jobId: row.id, attempt: pending }],
				reservations: row.tenant === null ? [] : [{ kind: "RUN", scope: row.tenant, ref: runId, cents: 0 as UsdCents, at: facts.now }] };
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
				const verified = { ...row, version: (row.version + 1) as Version,
					state: { status: "VERIFIED" as const, escrow: row.state.escrow, history, passed,
						review: { phase: "AWAITING_CLIENT" as const, endsAt: addHours(facts.now, hours(TERMS.clientReviewHours)) },
						runsStarted: attempts.runsStarted } };
				// A buyer dispute this row answered with the claim, or a rework handed back unanswered, now has verified work to defend.
				// The answer turns to evidence once, keyed by the dispute and this attempt. The queued accept no longer belongs to the row, so it is never sent.
				const dispute = row.providerDispute;
				if (dispute === undefined || dispute.status === "RESOLVED" || (dispute.answer !== "ACCEPT" && dispute.answer !== undefined)) {
					return { next: verified, credits: [], effects: [] };
				}
				// The evidence is a new answer, so an earlier answer's refusal or filing does not carry over to it. Where the dispute
				// offers no evidence to provide, the receipt goes as a message instead. The evidence names the type the stored read asks for.
				const defendedWith = answerOf(verified, dispute.offers);
				// The answer files under the stage the dispute is at, as a delivery's answer does, so the history names it once it is taken.
				const filed = answerEffects(verified, dispute.id, defendedWith, dispute.simulated === true, undefined, undefined, dispute.requestedEvidence,
					dispute.stage);
				const round = filed.find(isDisputeAnswer);
				const filedType = filedTypeOf(round);
				// PayPal asks only for evidence types Acquit cannot honestly give: nothing is sent, and the refusal stands for a person.
				const unhonest = defendedWith === "EVIDENCE" && evidenceTypeFor(dispute.requestedEvidence) === null;
				// A refusal for no honest type names no round, but its answer still names the stage it was refused under, as a delivery's does.
				const answerStage = round === undefined && !unhonest ? undefined : dispute.stage;
				const defended: ProviderDispute = { ...withoutAnswer(dispute), answer: defendedWith,
					...(round === undefined ? {} : { answerRound: answerRoundOf(round) }),
					...(filedType === undefined ? {} : { answerEvidenceType: filedType }),
					...(answerStage === undefined ? {} : { answerStage }),
					...(dispute.simulated === true ? {} : { answerState: unhonest ? { state: "REFUSED" as const, reason: NO_HONEST_EVIDENCE_TYPE }
						: { state: "QUEUED" as const } }) };
				return { next: { ...verified, providerDispute: defended }, credits: [], effects: filed };
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
			if (artifactOf(command) !== row.state.passed.verdict.mergeCommit) return "ARTIFACT_CHANGED";
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { ...row.state, review: { phase: "RELEASE_PENDING", release: { authority: "CLIENT_APPROVAL", selectedAt: facts.now } } } },
				credits: [], effects: releaseEffects(row, row.state.escrow) };
		} },
		Dispute: { by: "CLIENT", apply: (row, command, facts) => {
			// A dispute names the same judged artifact an approval would: a moved head is refused by name.
			if (row.state.review.phase !== "AWAITING_CLIENT" || facts.now >= row.state.review.endsAt) return "REVIEW_CLOSED";
			if (artifactOf(command) !== row.state.passed.verdict.mergeCommit) return "ARTIFACT_CHANGED";
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
					credits: [], effects: releaseEffects(row, row.state.escrow) };
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
			// An open dispute gives up its answer with the pass it answered, so neither evidence nor an accept is wanted during the
			// rework. The next verified attempt answers it again, once (VerifierFinished).
			const dispute = row.providerDispute;
			const reopened = dispute !== undefined && dispute.status !== "RESOLVED" ? { providerDispute: withoutAnswer(dispute) } : {};
			return { next: { ...row, ...reopened, version: (row.version + 1) as Version, arbiterNote: command.note,
				state: { status: "IN_PROGRESS", escrow: row.state.escrow,
					attempts: { phase: "READY", history: row.state.history, runsStarted: row.state.runsStarted, failure: null } } },
				credits: [], effects: [] };
		} },
		ReleaseSettled: { by: "SYSTEM", apply: (row, command) => {
			const release = command.release;
			// One disposition per job: a release is applied only to the release this row selected, and only
			// when its evidence names the held capture and adds up to the held gross. The payout a PAID row
			// already holds is a no-op, whichever of the outbox and the webhook lands second.
			const decision = decideRelease(row, release);
			if (decision === "ALREADY_SETTLED") return { ...unchanged(row), alreadySettled: true };
			// The guard repeats decideRelease's APPLY test so the state narrows for the code below.
			if (decision !== "APPLY" || row.state.status !== "VERIFIED" || row.state.review.phase !== "RELEASE_PENDING") return settlementMismatch(row);
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
			// A release that lands under a buyer dispute the row still holds has paid money the dispute claims, so a person is told.
			if (row.providerDispute !== undefined && releaseHeld(row)) effects.push({ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_ON_PAID", disputeId: row.providerDispute.id });
			return { next: { ...row, version: (row.version + 1) as Version,
				state: { status: "PAID", payee: escrow.payee, book, receipt, release, releaseAuthority: row.state.review.release.authority,
					history: row.state.history, merge: { phase: "PENDING" }, treasury } }, credits: [], effects };
		} },
		RefundSettled: { by: "SYSTEM", apply: (row, command) => {
			// The refund a REFUNDED row already holds is a no-op whichever of the outbox and the webhook lands
			// second. A refund that differs in money or refund id is a fact this row never settled.
			if (row.state.status === "REFUNDED") return sameRefund(row.state.refund, command.refund) ? { ...unchanged(row), alreadySettled: true } : settlementMismatch(row);
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
				: row.state.status === "VERIFIED" ? row.state.history : [];
			// The arbiter's note and the buyer dispute survive the settlement when there were any; a deadline refund has
			// neither and the keys stay absent, so a row read back from the store deep-equals the row that produced it.
			return { next: { id: row.id, version: (row.version + 1) as Version, client: row.client, tenant: row.tenant, title: row.title,
				contract: row.contract, openedAt: row.openedAt, bids: row.bids,
				...(row.arbiterNote === undefined ? {} : { arbiterNote: row.arbiterNote }),
				...(row.providerDispute === undefined ? {} : { providerDispute: row.providerDispute }),
				state: { status: "REFUNDED", payee: escrow.payee, book, reason: intent.reason, refund,
					history, treasury } }, credits: [], effects };
		} },
		ReimbursementSettled: { by: "SYSTEM", apply: (row, command) => {
			const reimbursement = command.reimbursement;
			// A redelivery of the payout this row already recorded changes nothing. The same batch with other money,
			// or another batch, is a second payout of a settled debt: a fact a person has to see, not a second line.
			const paid = row.state.treasury.find((entry): entry is Extract<TreasuryEntry, { kind: "PAYOUT_FEE_PAID" }> => entry.kind === "PAYOUT_FEE_PAID");
			if (paid !== undefined) return paid.batchId === reimbursement.batchId && paid.paid === reimbursement.paid && paid.fee === reimbursement.fee
				? { ...unchanged(row), alreadySettled: true } : settlementMismatch(row);
			const owed = row.state.treasury.find((entry): entry is Extract<TreasuryEntry, { kind: "OPERATOR_REIMBURSEMENT_OWED" }> =>
				entry.kind === "OPERATOR_REIMBURSEMENT_OWED");
			// Only the payout this row owes, to the payee it owes, settles the debt.
			if (owed === undefined || reimbursement.merchant !== row.state.payee.payee || reimbursement.paid !== owed.cents)
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
		ProviderDispute: { by: "SYSTEM", apply: (row, command, facts) => {
			// A dispute is against one capture. Another capture, or one this row never recorded, is a fact a person has to see.
			if (captureOf(row) !== command.captureId) return settlementMismatch(row);
			const held = row.providerDispute;
			// One capture carries one buyer dispute on this row. A second dispute id is a fact a person has to see.
			if (held !== undefined && held.id !== command.disputeId) return settlementMismatch(row);
			// PayPal's update_time orders the deliveries of one dispute. A body older than the one recorded is a replay: it changes
			// nothing, so an older OPEN cannot reopen a resolved hold and an older RESOLVED cannot lift a newer hold.
			if (held?.updatedAt !== undefined && command.updatedAt !== undefined && Date.parse(command.updatedAt) < Date.parse(held.updatedAt))
				return unchanged(row);
			// A signed body that stood in for a refused read moves only a record it can order. Without both times it cannot tell a
			// newer delivery from a replay, so the record keeps what it holds, and the hold it already places stands.
			const standIn = command.fromVerifiedBody === true;
			if (standIn && held !== undefined && (held.updatedAt === undefined || command.updatedAt === undefined)) return unchanged(row);
			// A resolved dispute is final. A later delivery of it changes nothing, and a different outcome is a fact this row never settled.
			// The one exception is an outcome PayPal names after an unknown one, which is recorded. A stand-in never settles anything.
			if (held?.status === "RESOLVED" && held.unconfirmed !== true) {
				const names = command.status === "RESOLVED" && held.outcome === undefined && command.outcome !== null;
				if (!names) {
					const same = command.status !== "RESOLVED" || command.outcome === (held.outcome ?? null);
					if (!same) return settlementMismatch(row);
					const latest = latestTimeOf(held, command);
					return latest === held.updatedAt ? { ...unchanged(row), alreadySettled: true }
						: { next: { ...row, version: (row.version + 1) as Version, providerDispute: { ...held, ...(latest === undefined ? {} : { updatedAt: latest }) } },
							credits: [], effects: [], alreadySettled: true };
				}
			}
			// Acquit answers the first delivery it sees for an unresolved dispute, once. A repeat keeps that answer and files nothing new.
			const first = held === undefined;
			// A delivery at a later stage that offers provide-evidence is an escalation: that stage is answered once, with the evidence.
			// The stage a record first saw is its baseline, so a record stored before stages were kept starts one at its next delivery.
			const escalated = held !== undefined && held.stage !== undefined && command.stage !== undefined && command.stage !== held.stage &&
				command.offers?.includes("provide_evidence") === true && command.status !== "RESOLVED" && disputeAnswerOf(row) === "EVIDENCE";
			const stage = command.stage ?? held?.stage;
			const offers = command.offers ?? held?.offers;
			// The evidence types PayPal asks for on the latest delivery that names any. The evidence answer files the type they choose.
			const requestedEvidence = command.requestedEvidence ?? held?.requestedEvidence;
			const answer: DisputeAnswer | undefined = escalated || (first && command.status !== "RESOLVED") ? answerOf(row, offers) : held?.answer;
			const simulated = held?.simulated === true || command.simulated === true;
			const filing = first || escalated ? answerEffects(row, command.disputeId, answer, simulated, escalated ? command.stage : undefined,
				undefined, requestedEvidence, stage) : [];
			// PayPal asks only for evidence types Acquit cannot honestly give. Nothing is sent: the answer is refused, and a person is told.
			const unhonest = (first || escalated) && answer === "EVIDENCE" && evidenceTypeFor(requestedEvidence) === null;
			// PayPal refused the answer for lack of dispute access, or refused the evidence type it was sent as. A successful read that offers
			// the link of the answer the row now selects re-queues it, once: a message where the read offers no evidence to provide. A stand-in
			// is not a successful read. An evidence type refusal re-queues only as a type PayPal did not refuse, so no type is sent twice.
			const refusal = held?.answerState?.state === "REFUSED" ? held.answerState : undefined;
			const refused = refusal?.reason === DISPUTE_ACCESS_REFUSED;
			const typeRefused = held?.answer === "EVIDENCE" && refusal !== undefined && EVIDENCE_TYPE_REFUSALS.includes(refusal.reason);
			const retry = (refused || typeRefused) && !standIn && !escalated && held?.requeued !== true && command.status !== "RESOLVED" && command.offers !== undefined
				? answerOf(row, command.offers) : undefined;
			// An evidence answer is re-queued only as a type Acquit can honestly give. A type refusal is re-queued only as another type.
			// A refusal with no type recorded named PROOF_OF_FULFILLMENT, the type every answer carried before the types were read.
			const refusedType: EvidenceType = refusal?.evidenceType ?? "PROOF_OF_FULFILLMENT";
			const chosen = evidenceTypeFor(requestedEvidence);
			const sendable = retry === "EVIDENCE" ? chosen !== null && (!typeRefused || chosen !== refusedType) : !typeRefused;
			const requeue = retry !== undefined && ANSWER_LINK[retry] !== undefined && command.offers?.includes(ANSWER_LINK[retry]) === true && sendable;
			const requeued: JobEffect[] = requeue ? answerEffects(row, command.disputeId, retry, simulated, stage, true, requestedEvidence, stage) : [];
			const recordedAnswer = requeue ? retry : answer;
			const requeuedFlag = requeue || (!escalated && held?.requeued === true);
			// The answer is queued until the outbox sends it. A simulated answer is never sent, so it carries no queued state.
			const queued = [...filing, ...requeued].some(effect => effect.kind === "DISPUTE_EVIDENCE" || effect.kind === "DISPUTE_MESSAGE" || effect.kind === "DISPUTE_ACCEPT");
			const answerState: DisputeAnswerState | undefined = unhonest && !simulated ? { state: "REFUSED", reason: NO_HONEST_EVIDENCE_TYPE }
				: queued && !simulated ? { state: "QUEUED" } : held?.answerState;
			// The round the row answers in now: the one this delivery filed or re-queued, or the round it already held.
			const newRound = [...filing, ...requeued].find(isDisputeAnswer);
			const answerRound = filing.length > 0 || requeued.length > 0 ? (newRound === undefined ? undefined : answerRoundOf(newRound)) : held?.answerRound;
			// The type the round files is kept with it. A later delivery that asks for another type files nothing, so the type stays as filed.
			const filedType = filedTypeOf(newRound);
			const answerEvidenceType = filing.length > 0 || requeued.length > 0 ? filedType : held?.answerEvidenceType;
			// The stage the round files under is kept with it the same way, so the history names the stage its answer was filed for. A refusal
			// for no honest evidence type names no round, but its answer still names the stage it was refused under.
			const answerStage = filing.length > 0 || requeued.length > 0 ? (newRound === undefined && !unhonest ? undefined : stage) : held?.answerStage;
			// A note names the answer it was sent for. A new answer filed or re-queued names none until PayPal says otherwise.
			const answerNote = filing.length > 0 || requeued.length > 0 ? undefined : held?.answerNote;
			const latest = latestTimeOf(held, command);
			const next: ProviderDispute = { id: command.disputeId, status: command.status, reason: command.reason, amount: command.amount ?? held?.amount ?? null,
				openedAt: held?.openedAt ?? command.openedAt, ...(latest === undefined ? {} : { updatedAt: latest }),
				...(command.outcome === null ? {} : { outcome: command.outcome }),
				...(command.status === "RESOLVED" ? { resolvedAt: held?.resolvedAt ?? facts.now } : {}),
				...(recordedAnswer === undefined ? {} : { answer: recordedAnswer }),
				...(answerState === undefined ? {} : { answerState }),
				...(answerRound === undefined ? {} : { answerRound }),
				...(answerEvidenceType === undefined ? {} : { answerEvidenceType }),
				...(answerStage === undefined ? {} : { answerStage }),
				...(answerNote === undefined ? {} : { answerNote }),
				// The history records answers PayPal took, and no delivery takes one back, so every delivery carries it on.
				...(held?.answerHistory === undefined ? {} : { answerHistory: held.answerHistory }),
				...(stage === undefined ? {} : { stage }),
				...(offers === undefined ? {} : { offers }),
				...(requestedEvidence === undefined ? {} : { requestedEvidence }),
				...(requeuedFlag ? { requeued: true as const } : {}),
				...(standIn ? { unconfirmed: true as const } : {}),
				...(simulated ? { simulated: true as const } : {}) };
			const recorded: Plan<JobRow>["next"] = { ...row, version: (row.version + 1) as Version, providerDispute: next };
			const buyerFavour = command.status === "RESOLVED" && command.outcome === "RESOLVED_BUYER_FAVOUR";
			// A stand-in holds the money and tells a person. It never settles, lifts, or unblocks a release, whatever its outcome says.
			// An open dispute's stand-in says PayPal refused the read and the hold stands. Only a resolved one is "not confirmed".
			const standInAlert: JobEffect[] = !standIn ? []
				: command.status === "RESOLVED"
					? [{ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_UNCONFIRMED", disputeId: next.id, detail: UNCONFIRMED_DETAIL }]
					: [{ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_READ_REFUSED", disputeId: next.id, detail: READ_REFUSED_DETAIL }];
			// A dispute against a paid job moves no money back: the money is already out, so a person is told. The receipt is the answer.
			if (row.state.status === "PAID") {
				const effects: JobEffect[] = [...standInAlert];
				if (first) effects.push({ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_ON_PAID", disputeId: next.id });
				effects.push(...filing, ...requeued);
				if (buyerFavour) effects.push({ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_LOST_ON_PAID", disputeId: next.id });
				return { next: recorded, credits: [], effects };
			}
			const effects: JobEffect[] = [...filing, ...requeued, ...standInAlert];
			if (standIn) return { next: recorded, credits: [], effects };
			const gross = grossOf(row);
			const partial = gross !== null && command.amount !== null && command.amount < gross;
			if (first && partial) effects.push({ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_PARTIAL", disputeId: next.id });
			// PayPal decided for the buyer on the whole held capture: it already reversed the funds, so the book refunds the held gross
			// with no outbound call. A refund this row already selected is settled here too: PayPal's reversal is the refund, and the
			// queued REFUND then has no intent left to send. Only a win for exactly the gross settles; a partial win, or any other
			// amount, stays held and goes to a person.
			const escrow = heldEscrowOf(row);
			if (buyerFavour && escrow !== null) {
				if (command.amount !== escrow.capture.gross) {
					const reason = partial ? "PROVIDER_DISPUTE_PARTIAL_LOST" : "SETTLEMENT_MISMATCH";
					return { next: recorded, credits: [], effects: [...effects, { kind: "ALERT", jobId: row.id, reason, disputeId: next.id }] };
				}
				const book = reduceLedger(escrow.book, { kind: "Refund", refunded: escrow.capture.gross, at: facts.now });
				if ("kind" in book) return settlementMismatch(row);
				const history: History = row.state.status === "IN_PROGRESS" ? row.state.attempts.history
					: row.state.status === "VERIFIED" ? row.state.history : [];
				const refunded: RefundedState = { status: "REFUNDED", payee: escrow.payee, book, reason: "PROVIDER_DISPUTE",
					refund: { refundId: null, captureId: escrow.capture.captureId, refunded: escrow.capture.gross, retainedProcessorFee: 0 as UsdCents, at: facts.now },
					history, treasury: [] };
				return { next: { id: row.id, version: (row.version + 1) as Version, client: row.client, tenant: row.tenant, title: row.title,
					contract: row.contract, openedAt: row.openedAt, bids: row.bids,
					...(row.arbiterNote === undefined ? {} : { arbiterNote: row.arbiterNote }),
					providerDispute: next, state: refunded }, credits: [], effects };
			}
			// The lift: a release this row selected and the dispute held now proceeds, once no dispute holds it.
			if (row.state.status === "VERIFIED" && row.state.review.phase === "RELEASE_PENDING" && releaseHeld(row) && !releaseHeld(recorded)) {
				effects.push(releaseIntent(row.id, row.state.escrow));
			}
			return { next: recorded, credits: [], effects };
		} },
		// PayPal took the answer the row selected. Only the answer this row still holds for that dispute is recorded as filed.
		// PayPal took an answer the row no longer holds: an earlier round, the answer before an escalation, or any answer while the
		// row refuses one for lack of an honest evidence type (that refusal holds no round). Nothing is filed for it. An accepted one is
		// kept in the history under its own round, and the current answer, answer state, and round stay as they are.
		// A settled 422 files the held answer, so the outbox stops, but it is never kept in the history: PayPal took nothing. An accepted
		// confirmation that arrives after it is kept: PayPal took the answer after all, so the entry joins the history and the note goes.
		DisputeAnswerFiled: { by: "SYSTEM", apply: (row, command) => {
			const held = row.providerDispute;
			if (held === undefined || held.id !== command.disputeId) return unchanged(row);
			const noHonest = held.answerState?.state === "REFUSED" && held.answerState.reason === NO_HONEST_EVIDENCE_TYPE;
			const current = !noHonest && held.answer === command.answer && answersRound(held, command.round);
			// Only an answer PayPal took is kept, and only under the time it was queued. A command with no time keeps nothing.
			const appended = command.accepted === true && command.filedAt !== undefined ? filedAnswerHistory(held, command, command.filedAt) : undefined;
			if (!current) {
				if (appended === undefined) return unchanged(row);
				return { next: { ...row, version: (row.version + 1) as Version, providerDispute: { ...held, answerHistory: appended } },
					credits: [], effects: [] };
			}
			// A filed answer changes only for a late acceptance of a settled 422's answer, which clears the note. A repeat, or a 422 for an
			// answer already filed, changes nothing. Money, hold, and requeue state are never written here.
			const lateAcceptance = command.accepted === true && held.answerNote !== undefined;
			if (held.answerState?.state === "FILED" && appended === undefined && !lateAcceptance) return unchanged(row);
			// The note names what PayPal held, and an accepted answer names none. The note of an earlier answer does not carry over.
			const { answerNote: _previous, ...kept } = held;
			const note = command.accepted === true ? undefined : command.note;
			return { next: { ...row, version: (row.version + 1) as Version,
				providerDispute: { ...kept, answerState: { state: "FILED" }, ...(note === undefined ? {} : { answerNote: note }),
					...(appended === undefined ? {} : { answerHistory: appended }) } },
				credits: [], effects: [] };
		} },
		// PayPal refused the answer for good. The job says so, and a person is alerted with the plain reason. The hold stays.
		DisputeAnswerRefused: { by: "SYSTEM", apply: (row, command) => {
			const held = row.providerDispute;
			if (held === undefined || held.id !== command.disputeId || held.answer !== command.answer || held.answerState?.state === "REFUSED") return unchanged(row);
			// A refusal of an earlier round says nothing about the round the row holds now, and it raises no alert for it.
			if (!answersRound(held, command.round)) return unchanged(row);
			// The type is kept only where PayPal refused the type, so a re-queue never sends that type again.
			const typeRefusal = command.evidenceType !== undefined && EVIDENCE_TYPE_REFUSALS.includes(command.reason);
			const answerState: DisputeAnswerState = { state: "REFUSED", reason: command.reason,
				...(typeRefusal ? { evidenceType: command.evidenceType } : {}) };
			return { next: { ...row, version: (row.version + 1) as Version, providerDispute: { ...held, answerState } },
				credits: [], effects: [{ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_ANSWER_REFUSED", disputeId: command.disputeId,
					detail: `${refusalWording(command.reason)}. The payment stays held.` }] };
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
						credits: [], effects: releaseEffects(row, escrow) };
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
						credits: [], effects: releaseEffects(row, row.state.escrow) };
				}
				if (review.phase === "DISPUTED" && facts.now >= review.resolveBy) {
					// The verifier passed, so a missed arbiter deadline is Acquit's failure: release and alert.
					return { next: { ...row, version: (row.version + 1) as Version,
						state: { ...row.state, review: { phase: "RELEASE_PENDING", release: { authority: "ARBITER_SLA_MISSED", selectedAt: facts.now } } } },
						credits: [], effects: [...releaseEffects(row, row.state.escrow), { kind: "ALERT", jobId: row.id, reason: "DISPUTE_SLA_MISSED" }] };
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

/** The alert a stand-in delivery raises: the hold stands, and nothing was confirmed by PayPal's own read. */
const UNCONFIRMED_DETAIL = "PayPal refused the dispute read; release or refund not confirmed. The payment stays held.";

/** The alert an open dispute's stand-in raises: PayPal refused the read, and the dispute is still open with the payment held. */
const READ_REFUSED_DETAIL = "PayPal refused the dispute read. The dispute is open and the payment stays held.";

/** The newer of the record's update time and the delivery's, so a record always holds the highest time it has seen. */
function latestTimeOf(held: ProviderDispute | undefined, command: { readonly updatedAt?: Instant }): Instant | undefined {
	const recorded = held?.updatedAt;
	if (recorded === undefined || command.updatedAt === undefined) return command.updatedAt ?? recorded;
	return Date.parse(command.updatedAt) > Date.parse(recorded) ? command.updatedAt : recorded;
}

/** A settlement observation that does not match the selected disposition is never applied. It is an ALERT. */
function settlementMismatch<S extends JobState>(row: JobRow<S>): Plan<JobRow<S>> {
	return { next: row, credits: [], effects: [{ kind: "ALERT", jobId: row.id, reason: "SETTLEMENT_MISMATCH" }], refused: "SETTLEMENT_MISMATCH" };
}

/**
 * What a release observation means against the row it arrives at. APPLY is the release this row selected.
 * ALREADY_SETTLED is the payout a PAID row already holds. MISMATCH is everything else, and it is an ALERT.
 */
export type ReleaseDecision = "APPLY" | "ALREADY_SETTLED" | "MISMATCH";

export function decideRelease(row: JobRow, release: ReleaseEvidence): ReleaseDecision {
	if (row.state.status === "PAID") return sameRelease(row.state.release, release) ? "ALREADY_SETTLED" : "MISMATCH";
	if (row.state.status !== "VERIFIED" || row.state.review.phase !== "RELEASE_PENDING" || release.captureId !== row.state.escrow.capture.captureId) return "MISMATCH";
	return "APPLY";
}

/** The fields PayPal reported for the payout. `at` is the clock the read ran on, so two reads of one payout can differ in it. */
function sameRelease(held: ReleaseEvidence, observed: ReleaseEvidence): boolean {
	return held.payoutItemId === observed.payoutItemId && held.captureId === observed.captureId && held.paid === observed.paid;
}

/**
 * The fields PayPal reported for the refund. A refund read back from its capture names no refund id, and a capture
 * refunds in full only once, so the money names the same refund then.
 */
function sameRefund(held: RefundEvidence, observed: RefundEvidence): boolean {
	return held.captureId === observed.captureId && held.refunded === observed.refunded && held.retainedProcessorFee === observed.retainedProcessorFee
		&& (held.refundId === null || observed.refundId === null || held.refundId === observed.refundId);
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

/** The capture this row recorded, in every state that keeps one. Null before a capture lands. */
export function captureOf(row: JobRow): CaptureId | null {
	const state = row.state;
	if (state.status === "PAID") return state.release.captureId;
	if (state.status === "REFUNDED") return state.refund.captureId;
	return heldEscrowOf(row)?.capture.captureId ?? null;
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

/** The dispute outcomes PayPal names as the seller's win. A held release proceeds only on one of these. */
const SELLER_FAVOUR_OUTCOMES: readonly string[] = ["RESOLVED_SELLER_FAVOUR", "CANCELED_BY_BUYER"];

/**
 * Whether a PayPal buyer dispute holds this row's money from release. The hold stands while the dispute is open.
 * It also stands on a buyer-favour or unnamed outcome: what becomes of that money is a3-2b's decision. A stand-in delivery
 * that PayPal's read refused holds whatever its outcome says, until a successful read confirms it.
 */
export function releaseHeld(row: JobRow): boolean {
	const dispute = row.providerDispute;
	if (dispute === undefined) return false;
	if (dispute.unconfirmed === true) return true;
	return dispute.status !== "RESOLVED" || !SELLER_FAVOUR_OUTCOMES.includes(dispute.outcome ?? "");
}

/**
 * The release a selection emits, unless a buyer dispute holds it. The selection itself is recorded either way,
 * so a held release is the same disposition the row would have paid, waiting for the hold to lift.
 */
function releaseEffects(row: JobRow, escrow: HeldEscrow): JobEffect[] {
	return releaseHeld(row) ? [] : [releaseIntent(row.id, escrow)];
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
				row.state.escrow.capture.captureId === effect.captureId && !releaseHeld(row);
		case "REFUND":
			return refundIntentOf(row) !== null && heldEscrowOf(row)?.capture.captureId === effect.captureId;
		case "REIMBURSE": {
			if (row.state.status !== "REFUNDED") return false;
			const treasury = row.state.treasury;
			return treasury.some(entry => entry.kind === "OPERATOR_REIMBURSEMENT_OWED") &&
				!treasury.some(entry => entry.kind === "PAYOUT_FEE_PAID");
		}
		// An answer belongs to the dispute it names. It is wanted while that dispute is open under that id and the row still
		// files it this way. A settled dispute, another dispute, or a later verdict that changed the answer leaves it unwanted.
		// The evidence is wanted only while the row still answers with it, so a refund or rework that the arbiter ruled drops it.
		// It is wanted only for the verified attempt the row answers with, so attempt 1's evidence is done once attempt 2 passed.
		// A row queued before attempts were recorded carries none, and keeps the rule it always had.
		// It is wanted only in the round the row holds: an earlier stage's evidence, or the answer a re-queue replaced, is done.
		// Once PayPal refused the answer, or the row refused it for want of an honest type, no evidence is wanted: a refusal with no
		// honest type holds no round, so the round check alone would let an evidence queued before it through.
		case "DISPUTE_EVIDENCE": {
			const dispute = row.providerDispute;
			const attempt: Ordinal | undefined = effect.attempt;
			return dispute !== undefined && dispute.status !== "RESOLVED" && dispute.id === effect.disputeId && dispute.answer === "EVIDENCE" &&
				dispute.answerState?.state !== "REFUSED" && disputeAnswerOf(row) === "EVIDENCE" && (attempt === undefined || attempt === evidenceAttemptOf(row)) &&
				answersRound(dispute, answerRoundOf(effect));
		}
		// The accepted claim is wanted only while the escrow is still held and no verified work is left to defend: the same
		// ACCEPT disputeAnswerOf names for the row now.
		case "DISPUTE_ACCEPT": {
			const dispute = row.providerDispute;
			return dispute !== undefined && dispute.status !== "RESOLVED" && dispute.id === effect.disputeId && dispute.answer === "ACCEPT" &&
				disputeAnswerOf(row) === "ACCEPT" && answersRound(dispute, answerRoundOf(effect));
		}
		// The message is wanted under the same rule as the evidence it stands in for: the row still files a message for this attempt.
		case "DISPUTE_MESSAGE": {
			const dispute = row.providerDispute;
			const attempt: Ordinal | undefined = effect.attempt;
			return dispute !== undefined && dispute.status !== "RESOLVED" && dispute.id === effect.disputeId && dispute.answer === "MESSAGE" &&
				disputeAnswerOf(row) === "EVIDENCE" && (attempt === undefined || attempt === evidenceAttemptOf(row)) && answersRound(dispute, answerRoundOf(effect));
		}
		default: return true;
	}
}

/**
 * What Acquit answers a buyer dispute with, decided from the row the dispute arrives at. A paid job, or a verified job
 * whose release is selected or pending, answers with its evidence. A funded job with no release to defend, or a refund
 * already selected, accepts the claim. A job with no held escrow left cannot answer, so a person decides.
 */
function disputeAnswerOf(row: JobRow): DisputeAnswer {
	const state = row.state;
	if (state.status === "PAID") return "EVIDENCE";
	if (state.status === "VERIFIED" && state.review.phase !== "REFUND_PENDING") return "EVIDENCE";
	if (heldEscrowOf(row) !== null) return "ACCEPT";
	return "NOT_ANSWERABLE";
}

/** The verified attempt an evidence answer is about: the receipt's attempt when paid, the passed attempt when verified. */
function evidenceAttemptOf(row: JobRow): Ordinal | null {
	const state = row.state;
	if (state.status === "PAID") return state.receipt.attemptsUsed;
	if (state.status === "VERIFIED") return state.passed.ordinal;
	return null;
}

/**
 * The answer a dispute gets: the evidence, or a message where PayPal offers a message and no evidence to provide. A delivery
 * that names no links keeps the evidence answer, so a message is never chosen on a guess. The accepted claim is unchanged.
 */
function answerOf(row: JobRow, offers: readonly DisputeOffer[] | undefined): DisputeAnswer {
	const answer = disputeAnswerOf(row);
	if (answer === "EVIDENCE" && offers !== undefined && offers.includes("send_message") && !offers.includes("provide_evidence")) return "MESSAGE";
	return answer;
}

/** The link PayPal names for each answer. A re-queue is sent only where the read offers that link. */
const ANSWER_LINK: Record<DisputeAnswer, DisputeOffer | undefined> = {
	EVIDENCE: "provide_evidence", MESSAGE: "send_message", ACCEPT: "accept_claim", NOT_ANSWERABLE: undefined,
};

/**
 * The dispute with no answer, no answer state, no round, no stage, no note, no filed type, and no re-queue. The history stays, because
 * those answers reached PayPal. A rework hands the open dispute back this way, so the next verified attempt answers it again.
 */
function withoutAnswer(dispute: ProviderDispute): ProviderDispute {
	const { answer: _answer, answerState: _answerState, requeued: _requeued, answerRound: _answerRound, answerStage: _answerStage,
		answerNote: _answerNote, answerEvidenceType: _answerEvidenceType, ...rest } = dispute;
	return rest;
}

/** A dispute answer the outbox sends: the evidence, the message, or the accepted claim. */
export type DisputeAnswerEffect = Extract<JobEffect, { kind: "DISPUTE_EVIDENCE" | "DISPUTE_MESSAGE" | "DISPUTE_ACCEPT" }>;

export function isDisputeAnswer(effect: { readonly kind: string }): effect is DisputeAnswerEffect {
	return effect.kind === "DISPUTE_EVIDENCE" || effect.kind === "DISPUTE_MESSAGE" || effect.kind === "DISPUTE_ACCEPT";
}

/**
 * The round a dispute answer is for: its dispute, its verified attempt (evidence and message), the stage it escalated to, and the
 * one re-queue. An evidence or message queued before attempts were recorded names no attempt, so it names no round at all.
 */
export function answerRoundOf(effect: DisputeAnswerEffect): string | undefined {
	if (effect.kind !== "DISPUTE_ACCEPT" && effect.attempt === undefined) return undefined;
	const base = effect.kind === "DISPUTE_ACCEPT" ? effect.disputeId : `${effect.disputeId}:${effect.attempt}`;
	const staged = effect.kind !== "DISPUTE_ACCEPT" && effect.stage !== undefined ? `${base}:${effect.stage}` : base;
	return effect.requeued === true ? `${staged}:requeued` : staged;
}

/**
 * Whether an answer's round is the one a dispute record holds. A record stored before rounds were kept holds none, and an answer
 * that names no round keeps the rule it always had: neither is held to a round it cannot name.
 */
export function answersRound(dispute: ProviderDispute, round: string | undefined): boolean {
	return dispute.answerRound === undefined || round === undefined || dispute.answerRound === round;
}

/** The most answers PayPal took that a dispute record keeps. The oldest entry drops first. */
const ANSWER_HISTORY_LIMIT = 10;

/**
 * The history once PayPal took an answer: one entry added for its round, in the order PayPal took the answers, and the list kept to
 * its newest ANSWER_HISTORY_LIMIT. The entry takes its stage and type from the command alone, because the record has already
 * overwritten an earlier round's. Undefined when nothing is added: a round the history already holds, an answer that names no round, or,
 * once the history is full, an answer PayPal took no later than the oldest entry it keeps. A replay of an evicted answer is such one.
 */
function filedAnswerHistory(held: ProviderDispute, command: { readonly answer: DisputeAnswer; readonly round?: string; readonly stage?: string;
	readonly evidenceType?: EvidenceType }, filedAt: Instant): readonly FiledAnswer[] | undefined {
	const history = held.answerHistory ?? [];
	if (command.round === undefined || history.some(entry => entry.round === command.round)) return undefined;
	if (history.length >= ANSWER_HISTORY_LIMIT && history.every(entry => Date.parse(filedAt) <= Date.parse(entry.filedAt))) return undefined;
	const entry: FiledAnswer = { answer: command.answer, round: command.round,
		...(command.stage === undefined ? {} : { stage: command.stage }),
		...(command.answer === "EVIDENCE" && command.evidenceType !== undefined ? { evidenceType: command.evidenceType } : {}),
		filedAt };
	// Oldest first by when PayPal took each answer, so a late entry sits where its time puts it. A tie keeps the order it arrived in.
	const ordered = [...history, entry].sort((a, b) => Date.parse(a.filedAt) - Date.parse(b.filedAt));
	return ordered.slice(-ANSWER_HISTORY_LIMIT);
}

/** The evidence type a dispute answer files, for the record of its round. Only an evidence answer carries one. */
function filedTypeOf(effect: DisputeAnswerEffect | undefined): EvidenceType | undefined {
	return effect?.kind === "DISPUTE_EVIDENCE" ? effect.evidenceType : undefined;
}

/**
 * The effects a dispute answer files. The notes are built here, from the row, so the outbox row carries exactly what was decided.
 * `stage` is set only on an escalation, and `requeued` only on the one re-queue of a refused answer, so each keys its own answer.
 * `requested` is the evidence types PayPal asks for: the evidence answer files the type they choose, or nothing when they ask for none
 * Acquit can honestly give.
 */
function answerEffects(row: JobRow, disputeId: string, answer: DisputeAnswer | undefined, simulated: boolean,
	stage?: string, requeued?: true, requested?: readonly string[], filedStage?: string): JobEffect[] {
	const payee = payeeMerchantOf(row);
	const escrow = heldEscrowOf(row);
	const attempt = evidenceAttemptOf(row);
	if (answer === undefined) return [];
	if (answer === "NOT_ANSWERABLE" || payee === null || (answer === "ACCEPT" && escrow === null) || (answer !== "ACCEPT" && attempt === null)) {
		return [{ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_NOT_ANSWERABLE", disputeId }];
	}
	const marks = { ...(stage === undefined ? {} : { stage }), ...(requeued === undefined ? {} : { requeued }) };
	// The stage the answer files under is kept for the history. It is not a mark, so the round key of a first answer does not change.
	const filed = filedStage === undefined ? {} : { filedStage };
	if (answer === "EVIDENCE" && attempt !== null) {
		const evidenceType = evidenceTypeFor(requested);
		// Nothing PayPal asks for is one Acquit can honestly file, so no answer is sent and a person decides.
		if (evidenceType === null) return [{ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_ANSWER_REFUSED", disputeId,
			detail: `${NO_HONEST_EVIDENCE_TYPE}. The payment stays held.` }];
		return [{ kind: "DISPUTE_EVIDENCE", jobId: row.id, disputeId, payee, notes: evidenceNotesOf(row), attempt, simulated, evidenceType, ...marks, ...filed }];
	}
	if (answer === "MESSAGE" && attempt !== null) {
		return [{ kind: "DISPUTE_MESSAGE", jobId: row.id, disputeId, payee, message: evidenceNotesOf(row), attempt, simulated, ...marks, ...filed }];
	}
	return [{ kind: "DISPUTE_ACCEPT", jobId: row.id, disputeId, payee, simulated, ...(requeued === undefined ? {} : { requeued }), ...filed,
		note: `Acquit accepts the buyer's claim on dispute ${disputeId} for capture ${escrow?.capture.captureId ?? "unknown"} on job ${row.id}.` }];
}

/**
 * The evidence the answer files: a fixed template over the receipt (paid) or the passed attempt (held). Each sentence
 * names the record field it reads, so a sentence with no source cannot appear. No model writes it.
 */
function evidenceNotesOf(row: JobRow): string {
	const state = row.state;
	if (state.status === "PAID") {
		const receipt = state.receipt;
		return [
			`Receipt ${receipt.id} (receipt id) records job ${receipt.jobId} as delivered on attempt ${receipt.attemptsUsed} (attemptsUsed).`,
			`Frozen tests ${receipt.frozen.passed}/${receipt.frozen.expected} passed (frozen).`,
			`Hidden tests ${receipt.hidden.passed}/${receipt.hidden.expected} passed (hidden).`,
			`Pull request #${receipt.pullRequest} carries judged commit ${receipt.mergeCommit} (pullRequest, mergeCommit).`,
		].join(" ");
	}
	if (state.status === "VERIFIED") {
		const verdict = state.passed.verdict;
		return [
			`Verified attempt ${state.passed.ordinal} for job ${row.id} passed run ${verdict.runId} on source commit ${verdict.sourceCommit} (ordinal, runId, sourceCommit).`,
			`Frozen tests ${verdict.frozen.passed}/${verdict.frozen.expected} passed (frozen).`,
			`Hidden tests ${verdict.hidden.passed}/${verdict.hidden.expected} passed (hidden).`,
			`Pull request #${verdict.pullRequest} is open at judged commit ${verdict.mergeCommit} (pullRequest, mergeCommit).`,
		].join(" ");
	}
	return `Acquit has no verified attempt for job ${row.id} to show (status ${state.status}).`;
}

/** The UsdCents the row's own held book records, or null when no money is held or recorded. */
function grossOf(row: JobRow): UsdCents | null {
	const line = storedBook(row)[0];
	return line !== undefined && line.kind === "HELD" ? line.cents : null;
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
	// A buyer dispute is recorded from any state, paid or not: the edge decides what it holds.
	if (command.type === "ProviderDispute") return table.ProviderDispute.apply(row, command, facts);
	if (command.type === "TimerDue") return table.TimerDue.apply(row, command, facts);
	// PayPal's answer to a dispute the row selected is recorded from whatever state the row holds now.
	if (command.type === "DisputeAnswerFiled") return table.DisputeAnswerFiled.apply(row, command, facts);
	if (command.type === "DisputeAnswerRefused") return table.DisputeAnswerRefused.apply(row, command, facts);
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

/** The judge a stored row belongs to. A row stored before the registry names none, and it is the code vertical. */
export function storedVertical(row: JobRow): Vertical {
	return row.vertical ?? CODE_VERTICAL;
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
	/** The manifest's own identity: the issue it freezes and the digest it froze, readable by every viewer. */
	readonly issue: number;
	readonly frozenAt: CommitSha;
	readonly frozenTestPath: string;
	readonly frozenTests: number;
	readonly hiddenTests: number;
	readonly hiddenManifest: Digest;
	readonly protectedPaths: readonly string[];
	/** The salted digest of an AI-drafted per-job case set, frozen at approval. Absent on a fixture's curated set, so an unsealed contract keeps its existing shape. The cases and the salt are never projected here. */
	readonly sealedHiddenCases?: SealedHiddenCases;
};

/** The projection core adds on top of JobView. The web page and the CLI read it through the API JSON. */
export type JobProjection = JobView & {
	/** The judge that decides this job's work. The web job page picks its components by it. */
	readonly vertical: Vertical;
	/** Null when the row was stored before F3 froze a definition of done. */
	readonly contract: ContractProjection | null;
	/** The per-job cases and their salt, once the job closed under a seal and its private set opens it. Null otherwise. */
	readonly hiddenReveal: RevealedHiddenCases | null;
	readonly attempts: JobView["attempts"] & {
		readonly history: readonly AttemptView[];
		readonly pending: PendingRunView | null;
		/** The last run that ended without a verdict. It charged no attempt, so it is not in history. */
		readonly failure: RunFailure | null;
	};
};

/** A REJECTED verdict stored before tallies existed has no key, so its counts project as null. */
export function attemptView(record: AttemptRecord): AttemptView {
	const verdict = record.verdict;
	return verdict.result === "VERIFIED"
		? { ordinal: record.ordinal, result: "VERIFIED", reasons: [], reasonsTruncated: 0, sourceCommit: verdict.sourceCommit, at: verdict.at,
			frozen: verdict.frozen, hidden: verdict.hidden, pullRequest: verdict.pullRequest }
		: { ordinal: record.ordinal, result: "REJECTED", reasons: verdict.reasons.map(describeRejectReason), reasonsTruncated: verdict.reasonsTruncated,
			sourceCommit: verdict.sourceCommit, at: verdict.at, frozen: verdict.tallies?.frozen ?? null, hidden: verdict.tallies?.hidden ?? null, pullRequest: null };
}

/** The House bid row's line, counted from the real receipt rows: every row is a fix, the paid ones passed verified CI. Seeded rows are display history the store keeps out of these counts; the receipts views label them Seeded. */
export function houseLine(rows: { readonly total: number; readonly paid: number } | null): string | null {
	if (rows === null) return null;
	return `${rows.total} fixes, ${rows.paid} passed verified CI`;
}

/** Bidding shows proof first. After accept, the ledger spine leads. */
export function projectJob(row: JobRow, viewer: Actor, paidReceipts: ReadonlyMap<OperatorId, number>,
	houseRows?: ReadonlyMap<OperatorId, { readonly total: number; readonly paid: number }>,
	receiptSources?: ReadonlyMap<ReceiptId, ReceiptSource>, privateCases: PrivateCaseReader = () => null): JobProjection {
	const ranked = rankBids(row.bids, paidReceipts);
	const viewBid = (bid: Bid) => ({ id: bid.id, operator: bid.operator, handle: bid.handle,
		label: bid.kind, price: bid.price, eta: bid.eta, agent: String(bid.agent), runner: bid.runner,
		pitch: bid.pitch, paidReceipts: paidReceipts.get(bid.operator) ?? 0, status: bid.status,
		houseLine: bid.kind === "HOUSE" ? houseLine(houseRows?.get(bid.operator) ?? { total: 0, paid: 0 }) : null });
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
	return { id: row.id, title: row.title, status: state.status, vertical: storedVertical(row), starter: isStarterJob(row),
		phase: state.status === "OPEN" ? state.phase.kind : state.status === "IN_PROGRESS" ? state.attempts.phase : state.status === "VERIFIED" ? state.review.phase : state.status,
		// The stored checkout substate while the job waits for its money, so the page names the phase
		// the row holds instead of guessing from side fields. Null once funding is over.
		checkoutPhase: funding ? funding.checkout.phase : null,
		budget: row.contract.budget, deliveryEndsAt: row.contract.deliveryEndsAt,
		contract: done === null ? null : { repository: done.issue.repository, issue: done.issue.number, frozenAt: done.frozenAt,
			frozenTestPath: done.frozenTestPath, frozenTests: done.frozenTests.length,
			hiddenTests: done.hiddenTests.length, hiddenManifest: done.hiddenManifest, protectedPaths: done.protectedPaths.map(String),
			...(done.sealedHiddenCases === undefined ? {} : { sealedHiddenCases: done.sealedHiddenCases }) },
		hiddenReveal: resolveHiddenReveal({ id: row.id, status: state.status, sealed: done?.sealedHiddenCases ?? null }, privateCases),
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
		// The PayPal buyer dispute, served whole so the page and the CLI can say why money is held.
		providerDispute: row.providerDispute === undefined ? null : { id: row.providerDispute.id, status: row.providerDispute.status,
			reason: row.providerDispute.reason, amount: row.providerDispute.amount, openedAt: row.providerDispute.openedAt,
			outcome: row.providerDispute.outcome ?? null, answer: row.providerDispute.answer ?? null,
			answerState: row.providerDispute.answerState ?? null, stage: row.providerDispute.stage ?? null,
			requestedEvidence: row.providerDispute.requestedEvidence ?? null,
			// The type the evidence answer filed for its round. Never a type a later delivery asks for, and none on a record stored before it was kept.
			evidenceType: row.providerDispute.answer === "EVIDENCE" ? (row.providerDispute.answerEvidenceType ?? null) : null,
			// The round the answer on the record is for, and every answer PayPal took, oldest first. A record stored before the history was kept serves none.
			answerRound: row.providerDispute.answerRound ?? null, answerStage: row.providerDispute.answerStage ?? null,
			answerNote: row.providerDispute.answerNote ?? null,
			answerHistory: row.providerDispute.answerHistory ?? [],
			unconfirmed: row.providerDispute.unconfirmed === true, simulated: row.providerDispute.simulated === true },
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
		// The receipt carries the receipts table's own provenance, so every page labels a SEED row
		// alike. The store writes the row in the settlement's transaction, so a settled job's row is
		// always there; without the read (or the row) the receipt reads as the real row it looks like.
		receipt: state.status === "PAID" ? { ...state.receipt, source: receiptSources?.get(state.receipt.id) ?? "JOB" } : null };
}
