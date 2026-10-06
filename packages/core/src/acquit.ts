import { nextCreditGrant, weeklyAllowance } from "./credits.ts";
import type { Credits } from "./credits.ts";
import { confirmFunding, executeCommand, ingestVerifierCallback, runDueTimers, runOutboxOnce } from "./effects.ts";
import type { Ports } from "./effects.ts";
import { createGitHubApp } from "./github.ts";
import { instant } from "./ids.ts";
import type { AgentId, BidId, ClientId, Hours, Instant, JobId, OperatorId, RequestKey, StaffId } from "./ids.ts";
import { projectJob } from "./job.ts";
import type { DomainFailure, JobProjection, JobStatus, Receipt, UserJobCommand } from "./job.ts";
import type { LedgerLine, UsdCents } from "./ledger.ts";
import type { OperatorCommand } from "./operator.ts";
import { createPayPal } from "./paypal.ts";
import type { PayPalConfig } from "./paypal.ts";
import { SqliteStore } from "./store.ts";
import { unconfiguredVerifier } from "./verifier.ts";
import type { VerifierPort } from "./verifier.ts";

export type { AgentId, BidId, ClientId, Hours, Instant, JobId, OperatorId, RequestKey } from "./ids.ts";
export { hours, instant, parseBidId, parseJobId, parseRequestKey } from "./ids.ts";
export type { UsdCents, LedgerLine } from "./ledger.ts";
export { formatUsd, usd } from "./ledger.ts";
export type { Credits } from "./credits.ts";
export type { JobStatus, Receipt } from "./job.ts";
export { ISSUE, SEEDED_USERS } from "./seed-data.ts";

export type Actor =
	| { readonly role: "CLIENT"; readonly clientId: ClientId }
	| { readonly role: "OPERATOR"; readonly operatorId: OperatorId }
	| { readonly role: "ARBITER"; readonly staffId: StaffId };

export type UserCommand = UserJobCommand | OperatorCommand;

export type Failure = DomainFailure | "KEY_REUSED_WITH_DIFFERENT_PAYLOAD" | "BUSY";

export type PublicResult =
	| { readonly kind: "JOB"; readonly job: JobProjection }
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
export interface Clock {
	now(): Instant;
}

export type AcquitConfig = {
	readonly databaseUrl: string;
	readonly clock?: Clock;
	readonly paypal: PayPalConfig;
	readonly verifier: { readonly ciUrl: string; readonly callbackSecret: string };
	/** The App is one operator item: app id, private key, and the organization that holds the work repos. */
	readonly github: { readonly appId: string; readonly privateKey: string; readonly organization: string; readonly apiBase?: string };
	/** The deployment injects the CI adapter. Without one, a start refuses by name and no callback is accepted. */
	readonly verifierPort?: VerifierPort;
};

export function createAcquit(config: AcquitConfig): Acquit {
	const clock = config.clock ?? { now: () => instant(new Date().toISOString()) };
	const store = new SqliteStore(config.databaseUrl, clock);
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, paypal: createPayPal(config.paypal, clock), feeModel: config.paypal.feeModel, fundingMode: config.paypal.fundingMode,
		verifier: config.verifierPort ?? unconfiguredVerifier(),
		github: { merge: unimplemented }, alerts: { raise: unimplemented },
		workRepo: createGitHubApp(config.github),
		clock };
	let ticking: Promise<void> | null = null;
	const service: Acquit = {
		execute: (actor, key, command) => executeCommand(ports, actor, key, command),
		query: async (actor, query) => {
			const counts = await store.receiptCounts();
			switch (query.type) {
				case "Job": {
					const row = await store.readJob(query.jobId);
					if (!row) return { kind: "DENIED", reason: "NOT_FOUND" };
					const mayRead = row.state.status === "OPEN" || actor.role === "CLIENT" && row.client === actor.clientId ||
						actor.role === "OPERATOR" && row.bids.some(bid => bid.operator === actor.operatorId) || actor.role === "ARBITER";
					return mayRead ? { kind: "JOB", job: projectJob(row, actor, counts) } : { kind: "DENIED", reason: "NOT_OWNER" };
				}
				case "OpenJobs": {
					const jobs = (await store.listJobs()).filter(row => row.state.status === "OPEN" ||
						actor.role === "CLIENT" && row.client === actor.clientId ||
						actor.role === "OPERATOR" && row.bids.some(bid => bid.operator === actor.operatorId));
					return { kind: "JOBS", jobs: jobs.map(row => projectJob(row, actor, counts)), nextCursor: null };
				}
				case "Operator": {
					if (actor.role !== "OPERATOR") return { kind: "DENIED", reason: "NOT_OWNER" };
					const row = await store.readOperator(actor.operatorId);
					if (!row) return { kind: "DENIED", reason: "NOT_FOUND" };
					return { kind: "OPERATOR", operator: { id: row.id, handle: row.handle, label: row.kind,
						payouts: row.payouts.kind, onboardingUrl: row.payouts.kind === "AWAITING_CONSENT" ? row.payouts.actionUrl : null,
						paidReceipts: counts.get(row.id) ?? 0 } };
				}
				case "Credits": {
					if (actor.role !== "OPERATOR") return { kind: "DENIED", reason: "NOT_OWNER" };
					const account = await store.readCredits(actor.operatorId);
					return { kind: "CREDITS", credits: { available: (account.balance.allowance + account.balance.purchased) as Credits,
						weeklyAllowance: weeklyAllowance(counts.get(actor.operatorId) ?? 0), nextGrantAt: nextCreditGrant(ports.clock.now()) } };
				}
				default: throw new Error("not implemented");
			}
		},
		handlePayPalWebhook: async () => Response.json({ error: "NOT_IMPLEMENTED", detail: "Signed webhook ingestion is outside the local skeleton; use the checkout return route." }, { status: 501 }),
		handleVerifierCallback: request => ingestVerifierCallback(ports, request),
		tick: () => {
			if (!ticking) ticking = (async () => {
				await runDueTimers(ports);
				for (let i = 0; i < 20; i++) if (await runOutboxOnce(ports) === "IDLE") break;
			})().finally(() => { ticking = null; });
			return ticking;
		},
	};
	runtimes.set(service, { ports, store });
	return service;
}

const runtimes = new WeakMap<Acquit, { ports: Ports; store: SqliteStore }>();
/** HTTP-only checkout boundary: re-read the provider, never trust URL token/PayerID. */
export function handlePayPalReturn(service: Acquit, actor: Actor, jobId: JobId): Promise<boolean> {
	const runtime = runtimes.get(service);
	if (!runtime) throw new Error("Unknown Acquit service");
	return confirmFunding(runtime.ports, actor, jobId);
}
export function closeAcquit(service: Acquit): void {
	runtimes.get(service)?.store.close();
	runtimes.delete(service);
}
