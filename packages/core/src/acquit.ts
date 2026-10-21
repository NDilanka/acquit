import type { CapRefusal } from "./caps.ts";
import { nextCreditGrant, weeklyAllowance } from "./credits.ts";
import type { Credits } from "./credits.ts";
import { confirmFunding, executeCommand, ingestPayPalWebhook, ingestVerifierCallback, runDueTimers, runOutboxEffect } from "./effects.ts";
import type { OutboxRan, Ports, RanObserver } from "./effects.ts";
import { createGitHubApp } from "./github.ts";
import type { GitHubAppPort } from "./github.ts";
import { instant } from "./ids.ts";
import type { AgentId, BidId, ClientId, CommitSha, Hours, Instant, JobId, MerchantId, OperatorId, RequestKey, StaffId, VisitorId } from "./ids.ts";
import { projectJob } from "./job.ts";
import type { PrivateCaseReader } from "./hidden-seal.ts";
import type { DomainFailure, JobEffect, JobProjection, JobRow, JobStatus, MergeProgress, ProviderDisputeView, Receipt, ReceiptView, RefundReason, ReleaseIntent, UserJobCommand } from "./job.ts";
import type { LedgerLine, UsdCents } from "./ledger.ts";
import type { JobFundingMode } from "./funding.ts";
import { SEEDED_USERS } from "./seed-data.ts";
import type { FixtureContract } from "./fixtures.ts";
import type { OperatorCommand } from "./operator.ts";
import { createPayPal } from "./paypal.ts";
import type { PayPal, PayPalConfig, ReleaseEvidence } from "./paypal.ts";
import { platformJobLedger, platformTables } from "./platform.ts";
import type { PlatformLedgerView, PlatformTables } from "./platform.ts";
import { SqliteStore } from "./store.ts";
import { bindVisitorRepository, failVisitor, reserveVisitor, visitorRepositoryName } from "./visitors.ts";
import type { VisitorRow } from "./visitors.ts";
import { boundedDetail, unconfiguredVerifier } from "./verifier.ts";
import type { VerifierPort } from "./verifier.ts";

export type { AgentId, BidId, ClientId, Hours, Instant, JobId, OperatorId, RequestKey, VisitorId } from "./ids.ts";
export { hours, instant, parseBidId, parseJobId, parseRequestKey } from "./ids.ts";
export type { UsdCents, LedgerLine } from "./ledger.ts";
export { formatUsd, usd } from "./ledger.ts";
export type { Credits } from "./credits.ts";
export type { JobStatus, Receipt } from "./job.ts";
export { SEEDED_USERS } from "./seed-data.ts";
export { matchFixture, manifestOf, fixtureKey } from "./fixtures.ts";
export type { FixtureContract, FixtureEntry, FixtureRef, HiddenContract } from "./fixtures.ts";

export type Actor =
	/**
	 * Every principal carries the visitor it belongs to, or null for the deployment's own seeded world.
	 * Core scopes every read, list, bid, and command to this: an actor with a tenant acts on that
	 * tenant's jobs alone, and a tenant-less actor never reaches a visitor's job.
	 */
	| { readonly role: "CLIENT"; readonly clientId: ClientId; readonly tenant: VisitorId | null; readonly repository?: string }
	| { readonly role: "OPERATOR"; readonly operatorId: OperatorId; readonly tenant: VisitorId | null }
	| { readonly role: "ARBITER"; readonly staffId: StaffId }
	/**
	 * The deployment's own operator of last resort: it reads the whole book for the platform dashboards
	 * (the ledger route) and holds no commands. It is never a job's client, payee, or arbiter.
	 */
	| { readonly role: "PLATFORM" };

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
	| { readonly type: "Credits" }
	| { readonly type: "PlatformLedger" }
	| { readonly type: "PlatformTables" };

export type QueryResult =
	/** A single job carries its full projection, so a reader of one job sees its frozen contract. */
	| { readonly kind: "JOB"; readonly job: JobProjection }
	| { readonly kind: "JOBS"; readonly jobs: readonly JobView[]; readonly nextCursor: string | null }
	| { readonly kind: "RECEIPTS"; readonly receipts: readonly Receipt[]; readonly nextCursor: string | null }
	| { readonly kind: "OPERATOR"; readonly operator: OperatorView }
	| { readonly kind: "CREDITS"; readonly credits: CreditAccountView }
	| { readonly kind: "PLATFORM_LEDGER"; readonly ledger: PlatformLedgerView }
	| { readonly kind: "PLATFORM_TABLES"; readonly tables: PlatformTables }
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
	/** The House line counted from the real receipt rows ("1 fixes, 1 passed verified CI" after the first paid job), on House bids alone. */
	readonly houseLine: string | null;
	readonly status: "PENDING" | "CHOSEN" | "ACCEPTED" | "NOT_SELECTED" | "RETURNED";
}

export interface JobView {
	readonly id: JobId;
	readonly title: string;
	readonly status: JobStatus;
	/** Substate for the UI, such as BIDDING, FUNDING, VERIFYING, AWAITING_CLIENT, DISPUTED, RELEASE_PENDING. */
	readonly phase: string;
	/** The stored checkout substate (CREATING_ORDER, AWAITING_APPROVAL, CAPTURING, REFUND_PENDING) while the job waits for its money. Null outside FUNDING. */
	readonly checkoutPhase: "CREATING_ORDER" | "AWAITING_APPROVAL" | "CAPTURING" | "REFUND_PENDING" | null;
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
	/**
	 * How far this job's own clock has been advanced by its client, in milliseconds: the job's instants
	 * were moved back by this much, so its own now is the deployment's now plus this. Served to the owning
	 * client alone, and 0 there for a job nobody has advanced.
	 */
	readonly clockShiftMs: number | null;
	readonly lockedTo: OperatorId | null;
	/** The owning client's own gate: true exactly when this viewer is that client and the review is open. */
	readonly viewerCanApprove: boolean;
	/** The same ownership gate for Dispute: true exactly when this viewer is that client and the review is open. */
	readonly viewerCanDispute: boolean;
	/** The paused dispute while `phase` is DISPUTED: its reason and the arbiter's deadline. Null otherwise. */
	readonly dispute: { readonly reason: string; readonly openedAt: Instant; readonly resolveBy: Instant } | null;
	/** The note the arbiter sent with its most recent ResolveDispute, whatever the verdict. Null before any arbiter decision and on rows stored before F4. */
	readonly arbiterNote: string | null;
	/** The PayPal buyer dispute against this job's capture, in any state. While it is open, the job's release is held. Null when none has reached the job. */
	readonly providerDispute: ProviderDisputeView | null;
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
	/** The settled receipt, carrying the receipts table's provenance: a migrated row reads SEED and the pages label it Seeded. */
	readonly receipt: ReceiptView | null;
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
	/**
	 * Authenticates ownership and commits one whole domain action. The key is bound to the payload digest. An
	 * observer, when given, is told each outbox effect the command's own drain ran, and its outcome is unchanged.
	 */
	execute(actor: Actor, key: RequestKey, command: UserCommand, observe?: RanObserver): Promise<CommandOutcome>;
	query(actor: Actor, query: Query): Promise<QueryResult>;
	/** Verifies, re-reads the resource, and applies it. Safe to deliver any number of times. */
	handlePayPalWebhook(request: Request): Promise<Response>;
	/** The dev-only replay: delivers an unsigned envelope built on this host. The API serves it under ACQUIT_DEV alone. */
	handlePayPalWebhookDev(request: Request): Promise<Response>;
	handleVerifierCallback(request: Request): Promise<Response>;
	/** Timer worker. Fires due job clocks and the weekly grant, then drains the outbox, and says what the outbox ran. */
	tick(): Promise<TickSummary>;
}
/**
 * What one tick ran. A tick that is already in flight is shared, so every caller that joins it gets the same
 * summary, and `ran` may name effects of other jobs. A caller keeps only the effects of the jobs it owns.
 */
export type TickSummary = { readonly ran: readonly OutboxRan[] };
export interface Clock {
	now(): Instant;
}

export type AcquitConfig = {
	readonly databaseUrl: string;
	/**
	 * The deployment's registered fixtures. OpenJob freezes a job's manifest from the one its command
	 * names; the store backfills manifests for rows that predate the freeze from the same references.
	 */
	readonly fixtures: readonly FixtureContract[];
	readonly clock?: Clock;
	readonly paypal: PayPalConfig;
	readonly verifier: { readonly ciUrl: string; readonly callbackSecret: string };
	/** The App is one operator item: app id, private key, and the organization that holds the work repos. */
	readonly github: { readonly appId: string; readonly privateKey: string; readonly organization: string; readonly apiBase?: string };
	/** The deployment injects the CI adapter. Without one, a start refuses by name and no callback is accepted. */
	readonly verifierPort?: VerifierPort;
	/**
	 * Injected in place of the live PayPal and GitHub clients. A test drives a whole job through them
	 * without a network; a deployment leaves this unset and gets the live clients built from its config.
	 */
	readonly adapters?: { readonly paypal?: PayPal; readonly github?: GitHubAppPort };
	/** Where a row's ALERT effect goes. Without one it is written to the process log. */
	readonly alerts?: { raise(effect: Extract<JobEffect, { kind: "ALERT" }>): Promise<void> };
	/** The AI-scoping kickoff, run when OpenJob commits a fixture that carries a trusted fix. The
	 * deployment owns the model, the phases, and the private store; the open never fails with it. */
	readonly scopeDraft?: Ports["scopeDraft"];
	/** Reads a job's private approved cases when a sealed job closes, for the reveal. Without it no sealed job reveals. */
	readonly privateCases?: PrivateCaseReader;
	/**
	 * Judge mode. The merchant is the sandbox seller a visitor's operator is paid through; without it
	 * the demo route refuses by name, because a visitor that cannot be paid cannot bid.
	 */
	readonly demo?: { readonly merchant: MerchantId };
	/** The deployment's client repository, the root every visitor fork is a fork of. A retry adopts a work repo through it once the visitor fork is gone. */
	readonly clientRepository?: string;
};

export function createAcquit(config: AcquitConfig): Acquit {
	const clock = config.clock ?? { now: () => instant(new Date().toISOString()) };
	const store = new SqliteStore(config.databaseUrl, config.fixtures.map(f => ({ repository: f.repository, issue: { number: f.issue.number }, frozenTestPath: f.frozenTestPath, demoForkPrefix: f.demoForkPrefix })));
	const github = config.adapters?.github ?? createGitHubApp(config.github);
	const ports: Ports = { store, paypal: config.adapters?.paypal ?? createPayPal(config.paypal, clock), feeModel: config.paypal.feeModel, fundingMode: config.paypal.fundingMode,
		fixtures: config.fixtures,
		verifier: config.verifierPort ?? unconfiguredVerifier(),
		github: { merge: (effect, requestId) => github.merge({ jobId: effect.jobId, repository: effect.repository,
			pullRequest: effect.pullRequest, mergeCommit: effect.mergeCommit }, requestId) },
		// An alert nobody receives is lost. Without an operator-supplied sink it goes to the process log,
		// where the deployment's own log handling is the record.
		alerts: config.alerts ?? { raise: async effect => { console.error(`Acquit alert: ${effect.reason} for ${effect.jobId}`); } },
		workRepo: github,
		clientRepository: config.clientRepository,
		scopeDraft: config.scopeDraft,
		privateCases: config.privateCases,
		clock };
	let ticking: Promise<TickSummary> | null = null;
	const service: Acquit = {
		execute: (actor, key, command, observe) => executeCommand(ports, actor, key, command, observe),
		query: async (actor, query) => {
			const counts = await store.receiptCounts();
			const houseRows = await store.receiptRowCounts();
			const sources = await store.receiptSources();
			// One tenant rule for every read: a viewer reaches a job only in its own world. The arbiter
			// and the system paths are the only cross-tenant readers, and they are never a session.
			// The platform role is the other cross-tenant reader, and only through PlatformLedger:
			// a job read or list answers nothing to it, so the dashboards have one door, not two.
			const sameWorld = (row: JobRow) => actor.role === "ARBITER" ||
				(actor.role === "CLIENT" || actor.role === "OPERATOR") && (actor.tenant ?? null) === (row.tenant ?? null);
			switch (query.type) {
				case "Job": {
					const row = await store.readJob(query.jobId);
					if (!row) return { kind: "DENIED", reason: "NOT_FOUND" };
					const mayRead = sameWorld(row) && (row.state.status === "OPEN" || actor.role === "CLIENT" && row.client === actor.clientId ||
						actor.role === "OPERATOR" && row.bids.some(bid => bid.operator === actor.operatorId) || actor.role === "ARBITER");
					return mayRead ? { kind: "JOB", job: projectJob(row, actor, counts, houseRows, sources, ports.privateCases) } : { kind: "DENIED", reason: "NOT_OWNER" };
				}
				case "OpenJobs": {
					const jobs = (await store.listJobs()).filter(row => sameWorld(row) && (row.state.status === "OPEN" ||
						actor.role === "CLIENT" && row.client === actor.clientId ||
						actor.role === "OPERATOR" && row.bids.some(bid => bid.operator === actor.operatorId)));
					return { kind: "JOBS", jobs: jobs.map(row => projectJob(row, actor, counts, houseRows, sources, ports.privateCases)), nextCursor: null };
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
				case "PlatformLedger": {
					if (actor.role !== "PLATFORM") return { kind: "DENIED", reason: "NOT_OWNER" };
					return { kind: "PLATFORM_LEDGER", ledger: { jobs: (await store.listJobs()).map(platformJobLedger) } };
				}
				case "PlatformTables": {
					if (actor.role !== "PLATFORM") return { kind: "DENIED", reason: "NOT_OWNER" };
					const [rows, operators] = await Promise.all([store.listJobs(), store.listOperators()]);
					return { kind: "PLATFORM_TABLES", tables: platformTables(rows, operators, counts) };
				}
				default: throw new Error("not implemented");
			}
		},
		handlePayPalWebhook: request => ingestPayPalWebhook(ports, request),
		handlePayPalWebhookDev: request => ingestPayPalWebhook(ports, request, true),
		handleVerifierCallback: request => ingestVerifierCallback(ports, request),
		tick: () => {
			if (!ticking) ticking = (async (): Promise<TickSummary> => {
				const ran: OutboxRan[] = [];
				await runDueTimers(ports);
				for (let i = 0; i < 20; i++) {
					const sweep = await runOutboxEffect(ports);
					if (sweep.kind === "IDLE") break;
					ran.push(sweep.ran);
				}
				return { ran };
			})().finally(() => { ticking = null; });
			return ticking;
		},
	};
	runtimes.set(service, { ports, store, demo: config.demo, organization: config.github.organization });
	return service;
}

const runtimes = new WeakMap<Acquit, { ports: Ports; store: SqliteStore; demo: AcquitConfig["demo"]; organization: string }>();
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
	| { readonly kind: "FORKED"; readonly repository: string; readonly id: number | null }
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
 * principals written — before the App is asked for anything. The row names the repository the fork will
 * create before the App is asked, because the name is deterministic: a process that dies between the
 * fork and the bind still leaves the sweep a name to remove. Then the fork is made, its answer bound to
 * the row, and the row marked ACTIVE. A fork that refuses marks the row FAILED and keeps the repository
 * name, so the sweep still takes it. The route owns the session; this owns the rows.
 */
export async function provisionDemoVisitor(service: Acquit, input: { readonly id: VisitorId; readonly ipKey: string;
	/** A scenario run's visitor: the requester that started it, whose scenario caps the reservation counts under. */
	readonly scenarioOf?: string; readonly fork: () => Promise<VisitorFork> }): Promise<DemoVisitorResult> {
	const runtime = runtimes.get(service);
	if (!runtime) throw new Error("Unknown Acquit service");
	if (!runtime.demo) return { kind: "NOT_CONFIGURED" };
	// Without an App there is no fork and no repository; the route answers NO_APP and the bind clears it.
	const repository = runtime.organization ? `${runtime.organization}/${visitorRepositoryName(input.id)}` : null;
	const reserved = reserveVisitor(runtime.store.db, { id: input.id, ipKey: input.ipKey, repository,
		merchant: runtime.demo.merchant, now: runtime.ports.clock.now(), ...(input.scenarioOf === undefined ? {} : { scenarioOf: input.scenarioOf }) });
	if (reserved.kind === "CAPPED") return { kind: "CAPPED", reason: reserved.reason };
	let forked: VisitorFork | null = null;
	try {
		forked = await input.fork();
		return { kind: "CREATED", visitor: forked.kind === "NO_APP" ? bindVisitorRepository(runtime.store.db, input.id, null)
			: bindVisitorRepository(runtime.store.db, input.id, forked.repository, forked.id) };
	} catch (error) {
		failVisitor(runtime.store.db, input.id, forked?.kind === "FORKED" ? forked.repository : repository,
			forked?.kind === "FORKED" ? forked.id : null);
		return { kind: "FAILED", detail: boundedDetail(error instanceof Error ? error.message : String(error)) };
	}
}

/** The reserve-then-bind path for a caller that already holds the repository, and for fixtures. */
export async function createDemoVisitor(service: Acquit, input: NewDemoVisitor): Promise<DemoVisitorResult> {
	return provisionDemoVisitor(service, { id: input.id, ipKey: input.ipKey,
		fork: async () => input.repository === null ? { kind: "NO_APP" } : { kind: "FORKED", repository: input.repository, id: null } });
}
export function closeAcquit(service: Acquit): void {
	runtimes.get(service)?.store.close();
	runtimes.delete(service);
}
