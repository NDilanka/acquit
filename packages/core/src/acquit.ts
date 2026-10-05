// The package's only entry point. package.json "exports" maps "." to this file and nothing else,
// so an import of job.ts, ledger.ts, or effects.ts from outside the package fails to resolve.

import type { Credits } from "./credits";
import type { AgentId, BidId, ClientId, Hours, Instant, JobId, OperatorId, RequestKey, StaffId } from "./ids";
import type { DomainFailure, JobStatus, Receipt, UserJobCommand } from "./job";
import type { LedgerLine, UsdCents } from "./ledger";
import type { OperatorCommand } from "./operator";
import type { PayPalConfig } from "./paypal";

export type { AgentId, BidId, ClientId, Hours, Instant, JobId, OperatorId, RequestKey } from "./ids";
export { hours, instant, parseBidId, parseJobId, parseRequestKey } from "./ids";
export type { UsdCents, LedgerLine } from "./ledger";
export { formatUsd, usd } from "./ledger";
export type { Credits } from "./credits";
export type { JobStatus, Receipt } from "./job";

export type Actor =
	| { readonly role: "CLIENT"; readonly clientId: ClientId }
	| { readonly role: "OPERATOR"; readonly operatorId: OperatorId }
	| { readonly role: "ARBITER"; readonly staffId: StaffId };

/** Derived from the transition table. Adding a user edge there adds a command here. */
export type UserCommand = UserJobCommand | OperatorCommand;

export type Failure = DomainFailure | "KEY_REUSED_WITH_DIFFERENT_PAYLOAD" | "BUSY";

export type PublicResult =
	| { readonly kind: "JOB"; readonly job: JobView }
	| { readonly kind: "BID"; readonly job: JobView; readonly bid: BidId; readonly creditsLeft: Credits }
	| { readonly kind: "OPERATOR"; readonly operator: OperatorView }
	| { readonly kind: "AGENT"; readonly agent: AgentId };

export type CommandOutcome =
	| { readonly kind: "COMMITTED"; readonly result: PublicResult }
	| { readonly kind: "REPLAY"; readonly result: PublicResult }
	| { readonly kind: "DENIED"; readonly reason: Failure };

export type Query =
	| { readonly type: "Job"; readonly jobId: JobId }
	| { readonly type: "OpenJobs"; readonly cursor: string | null }
	| { readonly type: "Receipts"; readonly operatorId: OperatorId; readonly cursor: string | null }
	| { readonly type: "Operator" }
	| { readonly type: "Credits" };

export type QueryResult =
	| { readonly kind: "JOB"; readonly job: JobView }
	| { readonly kind: "JOBS"; readonly jobs: readonly JobView[]; readonly nextCursor: string | null }
	| { readonly kind: "RECEIPTS"; readonly receipts: readonly Receipt[]; readonly nextCursor: string | null }
	| { readonly kind: "OPERATOR"; readonly operator: OperatorView }
	| { readonly kind: "CREDITS"; readonly credits: CreditAccountView }
	| { readonly kind: "DENIED"; readonly reason: Failure };

export interface BidView {
	readonly id: BidId;
	readonly operator: OperatorId;
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
	readonly id: JobId;
	readonly title: string;
	readonly status: JobStatus;
	/** Substate for the UI, such as BIDDING, FUNDING, VERIFYING, AWAITING_CLIENT, DISPUTED, RELEASE_PENDING. */
	readonly phase: string;
	readonly budget: UsdCents;
	readonly deliveryEndsAt: Instant;
	readonly bids: { readonly operators: readonly BidView[]; readonly house: BidView | null };
	readonly lockedTo: OperatorId | null;
	readonly escrow: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
	/** Set while FUNDING with an order the buyer has not approved yet. */
	readonly approveUrl: string | null;
	readonly ledger: readonly LedgerLine[];
	readonly attempts: { readonly used: number; readonly left: number; readonly last: "REJECTED" | "VERIFIED" | null; readonly reasons: readonly string[] };
	readonly reviewEndsAt: Instant | null;
	readonly pullRequest: number | null;
	readonly receipt: Receipt | null;
}

export interface OperatorView {
	readonly id: OperatorId;
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

export interface Acquit {
	/** Authenticates ownership and commits one whole domain action. The key is bound to the payload digest. */
	execute(actor: Actor, key: RequestKey, command: UserCommand): Promise<CommandOutcome>;
	query(actor: Actor, query: Query): Promise<QueryResult>;
	/** Verifies, re-reads the resource, and applies it. Safe to deliver any number of times. */
	handlePayPalWebhook(request: Request): Promise<Response>;
	handleVerifierCallback(request: Request): Promise<Response>;
	/** Timer worker. Fires due job clocks and the weekly grant, then drains the outbox. */
	tick(): Promise<void>;
}

export type AcquitConfig = {
	readonly databaseUrl: string;
	readonly paypal: PayPalConfig;
	readonly verifier: { readonly ciUrl: string; readonly callbackSecret: string };
	readonly github: { readonly appId: string; readonly privateKey: string };
};

export function createAcquit(config: AcquitConfig): Acquit {
	throw new Error("not implemented");
}
