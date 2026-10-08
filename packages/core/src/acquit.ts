import type { CapRefusal } from "./caps.ts";
import { nextCreditGrant, weeklyAllowance } from "./credits.ts";
import type { Credits } from "./credits.ts";
import { confirmFunding, executeCommand, ingestPayPalWebhook, ingestVerifierCallback, runDueTimers, runOutboxOnce } from "./effects.ts";
import type { Ports } from "./effects.ts";
import { createGitHubApp } from "./github.ts";
import { instant } from "./ids.ts";
import type { AgentId, BidId, ClientId, CommitSha, Hours, Instant, JobId, MerchantId, OperatorId, RequestKey, StaffId, VisitorId } from "./ids.ts";
import { projectJob } from "./job.ts";
import type { DomainFailure, JobEffect, JobProjection, JobRow, JobStatus, MergeProgress, Receipt, RefundReason, ReleaseIntent, UserJobCommand } from "./job.ts";
import type { LedgerLine, UsdCents } from "./ledger.ts";
import type { JobFundingMode } from "./funding.ts";
import { DEMO_CLIENT_REPOSITORY } from "./seed-data.ts";
import type { HiddenContract } from "./seed-data.ts";
import type { OperatorCommand } from "./operator.ts";
import { createPayPal } from "./paypal.ts";
import type { PayPalConfig, ReleaseEvidence } from "./paypal.ts";
import { SqliteStore } from "./store.ts";
import { bindVisitorRepository, failVisitor, reserveVisitor } from "./visitors.ts";
import type { VisitorRow } from "./visitors.ts";
import { boundedDetail, unconfiguredVerifier } from "./verifier.ts";
import type { VerifierPort } from "./verifier.ts";

export type { AgentId, BidId, ClientId, Hours, Instant, JobId, OperatorId, RequestKey, VisitorId } from "./ids.ts";
export { hours, instant, parseBidId, parseJobId, parseRequestKey } from "./ids.ts";
export type { UsdCents, LedgerLine } from "./ledger.ts";
export { formatUsd, usd } from "./ledger.ts";
export type { Credits } from "./credits.ts";
export type { JobStatus, Receipt } from "./job.ts";
export { ISSUE, SEEDED_USERS } from "./seed-data.ts";

export type Actor =
	/**
	 * Every principal carries the visitor it belongs to, or null for the deployment's own seeded world.
	 * Core scopes every read, list, bid, and command to this: an actor with a tenant acts on that
	 * tenant's jobs alone, and a tenant-less actor never reaches a visitor's job.
	 */
	| { readonly role: "CLIENT"; readonly clientId: ClientId; readonly tenant: VisitorId | null; readonly repository?: string }
	| { readonly role: "OPERATOR"; readonly operatorId: OperatorId; readonly tenant: VisitorId | null }
	| { readonly role: "ARBITER"; readonly staffId: StaffId };

export type UserCommand = UserJobCommand | OperatorCommand;

export type Failure = DomainFailure | CapRefusal | "KEY_REUSED_WITH_DIFFERENT_PAYLOAD" | "BUSY";

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
	/** A single job carries its full projection, so a reader of one job sees its frozen contract. */
	| { readonly kind: "JOB"; readonly job: JobProjection }
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
	/** The client that owns the job, served to that client's own session and null to every other viewer. */
	readonly client: ClientId | null;
	/**
	 * The funding source this job's accept will use, served to the owning client and null to every other
	 * viewer. Null for that client too when nobody chose for the job: the deployment's default applies.
	 */
	readonly funding: JobFundingMode | null;
	readonly lockedTo: OperatorId | null;
	/** The owning client's own gate: true exactly when this viewer is that client and the review is open. */
	readonly viewerCanApprove: boolean;
	/** The same ownership gate for Dispute: true exactly when this viewer is that client and the review is open. */
	readonly viewerCanDispute: boolean;
	/** The paused dispute while `phase` is DISPUTED: its reason and the arbiter's deadline. Null otherwise. */
	readonly dispute: { readonly reason: string; readonly openedAt: Instant; readonly resolveBy: Instant } | null;
	/** The note the arbiter sent with its most recent ResolveDispute, whatever the verdict. Null before any arbiter decision and on rows stored before F4. */
	readonly arbiterNote: string | null;
	/** What selected the release, while it is pending and once the job is PAID. Null before any release. */
	readonly releaseAuthority: ReleaseIntent["authority"] | null;
	/** What selected the refund, while it is pending and once the job is REFUNDED. Null before any refund and on rows stored before the reason was recorded. */
	readonly refundReason: RefundReason | null;
	readonly escrow: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
	/** Set while FUNDING with an order the buyer has not approved yet. */
	readonly approveUrl: string | null;
	readonly ledger: readonly LedgerLine[];
	readonly attempts: { readonly used: number; readonly left: number; readonly last: "REJECTED" | "VERIFIED" | null; readonly reasons: readonly string[] };
	readonly reviewEndsAt: Instant | null;
	readonly pullRequest: number | null;
	/** The tree the verifier judged. Approve names it, so a moved head cannot be approved by mistake. */
	readonly mergeCommit: CommitSha | null;
	/** The merge of the verified pull request, once the job is PAID: GitHub's commit, once it landed. */
	readonly merge: MergeProgress | null;
	/** What the release observed: the referenced payout item that paid the operator. Served on a PAID job. */
	readonly release: ReleaseEvidence | null;
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
	/** The repository a job's contract names. Parsed from ACQUIT_CLIENT_REPOSITORY at the deployment boundary. */
	readonly clientRepository?: string;
	/**
	 * The deployment's hidden cases as a contract: their ids and the digest of the cases themselves.
	 * The deployment derives it at boot from its private file; core never holds the cases.
	 */
	readonly hiddenContract: HiddenContract;
	readonly clock?: Clock;
	readonly paypal: PayPalConfig;
	readonly verifier: { readonly ciUrl: string; readonly callbackSecret: string };
	/** The App is one operator item: app id, private key, and the organization that holds the work repos. */
	readonly github: { readonly appId: string; readonly privateKey: string; readonly organization: string; readonly apiBase?: string };
	/** The deployment injects the CI adapter. Without one, a start refuses by name and no callback is accepted. */
	readonly verifierPort?: VerifierPort;
	/** Where a row's ALERT effect goes. Without one it is written to the process log. */
	readonly alerts?: { raise(effect: Extract<JobEffect, { kind: "ALERT" }>): Promise<void> };
	/**
	 * Judge mode. The merchant is the sandbox seller a visitor's operator is paid through; without it
	 * the demo route refuses by name, because a visitor that cannot be paid cannot bid.
	 */
	readonly demo?: { readonly merchant: MerchantId };
};

export function createAcquit(config: AcquitConfig): Acquit {
	const clock = config.clock ?? { now: () => instant(new Date().toISOString()) };
	const store = new SqliteStore(config.databaseUrl);
	const github = createGitHubApp(config.github);
	const ports: Ports = { store, paypal: createPayPal(config.paypal, clock), feeModel: config.paypal.feeModel, fundingMode: config.paypal.fundingMode,
		clientRepository: config.clientRepository ?? DEMO_CLIENT_REPOSITORY, hiddenContract: config.hiddenContract,
		verifier: config.verifierPort ?? unconfiguredVerifier(),
		github: { merge: (effect, requestId) => github.merge({ jobId: effect.jobId, repository: effect.repository,
			pullRequest: effect.pullRequest, mergeCommit: effect.mergeCommit }, requestId) },
		// An alert nobody receives is lost. Without an operator-supplied sink it goes to the process log,
		// where the deployment's own log handling is the record.
		alerts: config.alerts ?? { raise: async effect => { console.error(`Acquit alert: ${effect.reason} for ${effect.jobId}`); } },
		workRepo: github,
		clock };
	let ticking: Promise<void> | null = null;
	const service: Acquit = {
		execute: (actor, key, command) => executeCommand(ports, actor, key, command),
		query: async (actor, query) => {
			const counts = await store.receiptCounts();
			// One tenant rule for every read: a viewer reaches a job only in its own world. The arbiter
			// and the system paths are the only cross-tenant readers, and they are never a session.
			const sameWorld = (row: JobRow) => actor.role === "ARBITER" || (actor.tenant ?? null) === (row.tenant ?? null);
			switch (query.type) {
				case "Job": {
					const row = await store.readJob(query.jobId);
					if (!row) return { kind: "DENIED", reason: "NOT_FOUND" };
					const mayRead = sameWorld(row) && (row.state.status === "OPEN" || actor.role === "CLIENT" && row.client === actor.clientId ||
						actor.role === "OPERATOR" && row.bids.some(bid => bid.operator === actor.operatorId) || actor.role === "ARBITER");
					return mayRead ? { kind: "JOB", job: projectJob(row, actor, counts) } : { kind: "DENIED", reason: "NOT_OWNER" };
				}
				case "OpenJobs": {
					const jobs = (await store.listJobs()).filter(row => sameWorld(row) && (row.state.status === "OPEN" ||
						actor.role === "CLIENT" && row.client === actor.clientId ||
						actor.role === "OPERATOR" && row.bids.some(bid => bid.operator === actor.operatorId)));
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
		handlePayPalWebhook: request => ingestPayPalWebhook(ports, request),
		handleVerifierCallback: request => ingestVerifierCallback(ports, request),
		tick: () => {
			if (!ticking) ticking = (async () => {
				await runDueTimers(ports);
				for (let i = 0; i < 20; i++) if (await runOutboxOnce(ports) === "IDLE") break;
			})().finally(() => { ticking = null; });
			return ticking;
		},
	};
	runtimes.set(service, { ports, store, demo: config.demo });
	return service;
}

const runtimes = new WeakMap<Acquit, { ports: Ports; store: SqliteStore; demo: AcquitConfig["demo"] }>();
/** HTTP-only checkout boundary: re-read the provider, never trust URL token/PayerID. */
export function handlePayPalReturn(service: Acquit, actor: Actor, jobId: JobId): Promise<boolean> {
	const runtime = runtimes.get(service);
	if (!runtime) throw new Error("Unknown Acquit service");
	return confirmFunding(runtime.ports, actor, jobId);
}

/** What the demo route hands the core: the visitor's own id (its repository name derives from it), the request's address digest, and the repository the App forked for it. */
export type NewDemoVisitor = { readonly id: VisitorId; readonly ipKey: string; readonly repository: string | null };
/** What the App answered when it was asked for the visitor's repository, or that there is no App to ask. */
export type VisitorFork =
	| { readonly kind: "FORKED"; readonly repository: string }
	| { readonly kind: "NO_APP" };
export type DemoVisitorResult = { readonly kind: "CREATED"; readonly visitor: VisitorRow }
	| { readonly kind: "NOT_CONFIGURED" }
	/** The caps refused this visitor before anything was forked: one closed code names the allowance. */
	| { readonly kind: "CAPPED"; readonly reason: CapRefusal }
	/** The fork refused: the row is FAILED and kept, with any repository it named, for the sweep. */
	| { readonly kind: "FAILED"; readonly detail: string };

/**
 * Mints one visitor's whole identity in the one order that never leaves a fork untracked: the demo
 * configuration is checked and the visitor is reserved — PROVISIONING, counted by the caps, its row and
 * principals written — before the App is asked for anything. Then the fork is made, its answer bound to
 * the row, and the row marked ACTIVE. A fork that refuses marks the row FAILED and keeps any repository
 * the answer named, so the sweep still takes it. The route owns the session; this owns the rows.
 */
export async function provisionDemoVisitor(service: Acquit, input: { readonly id: VisitorId; readonly ipKey: string;
	readonly fork: () => Promise<VisitorFork> }): Promise<DemoVisitorResult> {
	const runtime = runtimes.get(service);
	if (!runtime) throw new Error("Unknown Acquit service");
	if (!runtime.demo) return { kind: "NOT_CONFIGURED" };
	const reserved = reserveVisitor(runtime.store.db, { id: input.id, ipKey: input.ipKey, repository: null,
		merchant: runtime.demo.merchant, now: runtime.ports.clock.now() });
	if (reserved.kind === "CAPPED") return { kind: "CAPPED", reason: reserved.reason };
	let forked: VisitorFork | null = null;
	try {
		forked = await input.fork();
		return { kind: "CREATED", visitor: bindVisitorRepository(runtime.store.db, input.id,
			forked.kind === "NO_APP" ? null : forked.repository) };
	} catch (error) {
		failVisitor(runtime.store.db, input.id, forked?.kind === "FORKED" ? forked.repository : null);
		return { kind: "FAILED", detail: boundedDetail(error instanceof Error ? error.message : String(error)) };
	}
}

/** The reserve-then-bind path for a caller that already holds the repository, and for fixtures. */
export async function createDemoVisitor(service: Acquit, input: NewDemoVisitor): Promise<DemoVisitorResult> {
	return provisionDemoVisitor(service, { id: input.id, ipKey: input.ipKey,
		fork: async () => input.repository === null ? { kind: "NO_APP" } : { kind: "FORKED", repository: input.repository } });
}
export function closeAcquit(service: Acquit): void {
	runtimes.get(service)?.store.close();
	runtimes.delete(service);
}
