// The impure shell around job.ts. Request keys, the atomic commit, the outbox, reconciliation,
// webhook and verifier ingestion, and the timer scan. No business rule lives here.
// Every rule is a table edge. This file only loads facts, commits plans, and feeds observations back.

import { createHash } from "node:crypto";
import type { CommandOutcome, Actor, PublicResult, UserCommand } from "./acquit.ts";
import { creditWeek, reduceCredits } from "./credits.ts";
import type { CreditAccount } from "./credits.ts";
import { hours, instant, parseRequestKey } from "./ids.ts";
import type { AgentId, Branded, Digest, Instant, JobId, OperatorId, RequestKey, Version } from "./ids.ts";
import { applyJobCommand, projectJob, TERMS, wakeAt } from "./job.ts";
import type { JobCommand, JobEffect, JobRow, Loaded, SystemJobCommand } from "./job.ts";
import { GitHubAppError, GitHubAppNotConfigured, boundedDetail } from "./github.ts";
import type { GitHubFailureCode, WorkRepoPort } from "./github.ts";
import { commercialSplit } from "./ledger.ts";
import type { Agent, OperatorEffect, OperatorRow } from "./operator.ts";
import { quote } from "./paypal.ts";
import type { PayPal, PayPalCall, PayPalObservation, ProcessorFeeModel, RemoteOutcome } from "./paypal.ts";
import { frozenDefinition, ISSUE } from "./seed-data.ts";
import type { VerifierPort } from "./verifier.ts";

export type Effect = JobEffect | OperatorEffect;

/** Deterministic, never random. `${jobId}:release`, `${jobId}:capture:${round}`, `${jobId}:verify:${run}`. */
export type OperationKey = Branded<string, "OperationKey">;

export function operationKey(effect: Effect): OperationKey {
	// TODO CREATE_ORDER and CAPTURE use (jobId, kind, round). START_VERIFIER uses (jobId, kind, run).
	// TODO RELEASE, REFUND, MERGE use (jobId, kind). One release and one refund key per job, ever.
	// TODO PAYPAL_ONBOARD uses (operator, kind). ALERT uses (jobId, kind, reason).
	const owner = "jobId" in effect ? effect.jobId : effect.operator;
	const round = "round" in effect ? effect.round : effect.kind === "START_VERIFIER" ? effect.attempt.run : effect.kind === "ALERT" ? effect.reason : "";
	// PayPal's request-id has a 38-character limit. This stable key is the same
	// string in the outbox and at the provider, not a random key per attempt.
	return `aq-${createHash("sha256").update(`${owner}:${effect.kind}:${round}`).digest("hex").slice(0, 32)}` as OperationKey;
}

/** The PayPal-Request-Id and the verifier run id. The same string as the operation key. */
export function providerRequestId(key: OperationKey): string {
	return key;
}

export function toPayPalCall(effect: Effect): PayPalCall | null {
	switch (effect.kind) {
		case "CREATE_ORDER": return { kind: effect.kind, jobId: effect.jobId, payee: effect.payee, quote: effect.quote, fundingMode: effect.fundingMode ?? "checkout" };
		case "CAPTURE": return { kind: effect.kind, orderId: effect.orderId, payee: effect.payee };
		case "RELEASE": return { kind: effect.kind, captureId: effect.captureId, payee: effect.payee };
		case "REFUND": return { kind: effect.kind, captureId: effect.captureId, payee: effect.payee, amount: effect.amount };
		case "PAYPAL_ONBOARD": return { kind: "ONBOARD", operator: effect.operator };
		default: return null;
	}
}

/** Maps a provider observation onto the system edge it feeds. Routing uses stored order and capture ids. */
export function toJobCommand(jobId: JobId, observation: PayPalObservation): SystemJobCommand | null {
	switch (observation.kind) {
		case "ORDER_APPROVED": return { type: "BuyerApproved", jobId, orderId: observation.orderId };
		case "CAPTURE_COMPLETED": return { type: "CaptureCompleted", jobId, capture: observation.capture };
		default: return null; // OrderCreated additionally needs the outbox's funding round.
	}
}

export type OutboxState =
	| { readonly kind: "READY"; readonly runAt: Instant }
	| { readonly kind: "LEASED"; readonly leaseUntil: Instant }
	/** A retry can clear it. `attempt` counts the refusals this row has waited out and drives the backoff. */
	| { readonly kind: "UNCERTAIN"; readonly reconcileAt: Instant; readonly attempt?: number }
	| { readonly kind: "CONFIRMED"; readonly at: Instant }
	/** A person has to act. `reason` is the named refusal and `detail` its bounded text, so an operator can read both. */
	| { readonly kind: "NEEDS_HUMAN"; readonly reason: string; readonly detail?: string };

export type OutboxRow = {
	readonly key: OperationKey;
	readonly effect: Effect;
	readonly payloadDigest: Digest;
	readonly state: OutboxState;
};

/** Unique on (actor, key). The digest binds the key to its payload, so a reused key with a new body is refused. */
export type RecordedRequest = {
	readonly actor: string;
	readonly key: RequestKey;
	readonly payloadDigest: Digest;
	readonly result: PublicResult;
};

export type AtomicCommit = {
	readonly job: { readonly expectedVersion: Version | null; readonly row: JobRow; readonly wakeAt: Instant | null } | null;
	readonly operator: { readonly expectedVersion: Version | null; readonly row: OperatorRow; readonly agent: Agent | null } | null;
	readonly credits: readonly { readonly expectedVersion: Version; readonly account: CreditAccount }[];
	readonly outbox: readonly OutboxRow[];
	readonly acknowledge: OperationKey | null;
	readonly request: RecordedRequest | null;
	readonly delivery: string | null;
};

/** One SQLite database. Private to this package. */
export interface Store {
	readAgent(agent: AgentId): Promise<Agent | null>;
	listJobs(): Promise<readonly JobRow[]>;
	listOperators(): Promise<readonly OperatorRow[]>;
	receiptCounts(): Promise<ReadonlyMap<OperatorId, number>>;
	readJob(jobId: JobId): Promise<JobRow | null>;
	readOperator(operator: OperatorId): Promise<OperatorRow | null>;
	readCredits(operator: OperatorId): Promise<CreditAccount>;
	readRequest(actor: string, key: RequestKey): Promise<RecordedRequest | null>;
	finishRequest(request: RecordedRequest): Promise<void>;
	jobForResource(resource: string): Promise<JobId | null>;
	dueJobs(now: Instant): Promise<readonly { readonly jobId: JobId; readonly wakeAt: Instant }[]>;
	commit(change: AtomicCommit): Promise<"COMMITTED" | "VERSION_CONFLICT" | "REQUEST_REPLAY" | "DELIVERY_REPLAY">;
	leaseEffect(now: Instant, until: Instant, key?: OperationKey): Promise<OutboxRow | null>;
	recordEffect(key: OperationKey, state: OutboxState): Promise<void>;
}

export type Ports = {
	readonly fundingMode?: () => "checkout" | "card";
	readonly feeModel: ProcessorFeeModel;
	/** The deployment's client repository: the one OpenJob accepts and freezes into the contract. */
	readonly clientRepository: string;
	readonly store: Store;
	readonly paypal: PayPal;
	readonly verifier: VerifierPort;
	/** The GitHub App's work-repo provisioner. Absent when no App is configured; the outbox then records NEEDS_HUMAN. */
	readonly workRepo?: WorkRepoPort;
	readonly github: { merge(effect: Extract<JobEffect, { kind: "MERGE" }>, requestId: string): Promise<"MERGED" | "UNKNOWN" | "CONFLICT"> };
	readonly alerts: { raise(effect: Extract<JobEffect, { kind: "ALERT" }>): Promise<void> };
	readonly clock: { now(): Instant };
};

export async function executeCommand(ports: Ports, actor: Actor, key: RequestKey, command: UserCommand): Promise<CommandOutcome> {
	// TODO Digest the payload. A recorded (actor, key) with the same digest returns REPLAY with its result.
	//      A different digest returns DENIED KEY_REUSED_WITH_DIFFERENT_PAYLOAD.
	// TODO Load facts for the command, call applyJobCommand or applyOperatorCommand, commit with CAS.
	// TODO VERSION_CONFLICT reruns the table on the fresh row. It never repeats a remote call.
	// TODO After commit, dispatch this commit's own outbox rows inline with a short bound, then re-read.
	//      That is why Accept usually returns the approve URL and Approve usually returns PAID.
	const actorKey = actor.role === "CLIENT" ? `CLIENT:${actor.clientId}` : actor.role === "OPERATOR" ? `OPERATOR:${actor.operatorId}` : `ARBITER:${actor.staffId}`;
	const payloadDigest = digest(command);
	for (let attempt = 0; attempt < 5; attempt++) {
		const previous = await ports.store.readRequest(actorKey, key);
		if (previous) return previous.payloadDigest === payloadDigest ? { kind: "REPLAY", result: previous.result }
			: { kind: "DENIED", reason: "KEY_REUSED_WITH_DIFFERENT_PAYLOAD" };
		if (!["OpenJob", "PlaceBid", "AcceptBid", "CancelJob", "Submit"].includes(command.type)) throw new Error("not implemented");
		const row = "jobId" in command ? await ports.store.readJob(command.jobId) : null;
		const now = ports.clock.now();
		let loaded: Loaded = { kind: "NONE" };
		if (command.type === "OpenJob") {
			if (command.repository !== ports.clientRepository || command.issueNumber !== 12) return { kind: "DENIED", reason: "NOT_FOUND" };
			loaded = { kind: "OPEN_JOB", title: ISSUE.issues[0].title, contract: {
				definitionOfDone: frozenDefinition(ports.clientRepository), budget: command.budget, deliveryEndsAt: command.deliveryEndsAt, terms: TERMS } };
		} else if (command.type === "PlaceBid") {
			if (actor.role !== "OPERATOR") return { kind: "DENIED", reason: "NOT_OWNER" };
			const operator = await ports.store.readOperator(actor.operatorId);
			const agent = await ports.store.readAgent(command.agent);
			if (!operator || !agent) return { kind: "DENIED", reason: "NOT_FOUND" };
			loaded = { kind: "PLACE_BID", operator, agent, credits: await ports.store.readCredits(operator.id) };
		} else if (command.type === "AcceptBid") {
			const bid = row?.bids.find(b => b.id === command.bidId);
			if (!bid) return { kind: "DENIED", reason: "NOT_FOUND" };
			loaded = { kind: "ACCEPT_BID", quote: quote(commercialSplit(bid.price), ports.feeModel), fundingMode: ports.fundingMode?.() ?? "checkout" };
		} else if (command.type === "CancelJob") {
			const accounts = new Map<OperatorId, CreditAccount>();
			for (const bid of row?.bids ?? []) if (bid.kind !== "HOUSE") accounts.set(bid.operator, await ports.store.readCredits(bid.operator));
			loaded = { kind: "BIDDER_CREDITS", accounts };
		}
		const plan = applyJobCommand(row, command as JobCommand, { actor, now, loaded });
		if (typeof plan === "string") return { kind: "DENIED", reason: plan };
		const job = projectJob(plan.next, actor, await ports.store.receiptCounts());
		let result: PublicResult = { kind: "JOB", job };
		if (command.type === "PlaceBid") {
			const bid = plan.next.bids.find(b => !row?.bids.some(old => old.id === b.id))!;
			const account = plan.credits[0] ?? (loaded.kind === "PLACE_BID" ? loaded.credits : null);
			if (!account) throw new Error("Bid account missing");
			result = { kind: "BID", job, bid: bid.id, creditsLeft: (account.balance.allowance + account.balance.purchased) as CreditAccount["balance"]["allowance"] };
		}
		const committed = await ports.store.commit({
			job: { expectedVersion: row?.version ?? null, row: plan.next, wakeAt: wakeAt(plan.next) }, operator: null,
			credits: plan.credits.map(account => ({ account, expectedVersion: (account.version - 1) as Version })),
			outbox: plan.effects.map(effect => outboxRow(effect, now)), acknowledge: null, delivery: null,
			request: { actor: actorKey, key, payloadDigest, result },
		});
		if (committed !== "COMMITTED") continue;
		if (command.type === "OpenJob") await placeHouseBid(ports, plan.next);
		// Drain only this command's own effects, not somebody else's checkout.
		for (const effect of plan.effects.slice(0, 4)) await runOutboxOnce(ports, operationKey(effect));
		if (plan.effects.some(effect => effect.kind === "CREATE_ORDER" && effect.fundingMode === "card")) await confirmFunding(ports, actor, plan.next.id);
		const refreshed = await ports.store.readJob(plan.next.id);
		if (refreshed && (result.kind === "JOB" || result.kind === "BID")) result = { ...result, job: projectJob(refreshed, actor, await ports.store.receiptCounts()) };
		await ports.store.finishRequest({ actor: actorKey, key, payloadDigest, result });
		return { kind: "COMMITTED", result };
	}
	return { kind: "DENIED", reason: "BUSY" };
}

export async function applySystemCommand(ports: Ports, command: JobCommand, acknowledge: OperationKey | null, delivery: string | null): Promise<void> {
	if (!("jobId" in command)) throw new Error("System command requires job");
	for (let attempt = 0; attempt < 5; attempt++) {
		const row = await ports.store.readJob(command.jobId);
		if (!row) throw new Error("System job missing");
		const now = ports.clock.now();
		let loaded: Loaded = { kind: "NONE" };
		if (command.type === "TimerDue") {
			const accounts = new Map<OperatorId, CreditAccount>();
			for (const bid of row.bids) if (bid.kind !== "HOUSE") accounts.set(bid.operator, await ports.store.readCredits(bid.operator));
			loaded = { kind: "BIDDER_CREDITS", accounts };
		}
		const plan = applyJobCommand(row, command, { actor: { role: "SYSTEM", source: "OUTBOX" }, now, loaded });
		if (typeof plan === "string") throw new Error(`System transition refused: ${plan}`);
		const committed = await ports.store.commit({ job: { expectedVersion: row.version, row: plan.next, wakeAt: wakeAt(plan.next) },
			operator: null, credits: plan.credits.map(account => ({ account, expectedVersion: (account.version - 1) as Version })),
			outbox: plan.effects.map(effect => outboxRow(effect, now)), acknowledge, request: null, delivery });
		if (committed !== "VERSION_CONFLICT") return;
	}
	throw new Error("System command busy");
}

export async function runOutboxOnce(ports: Ports, key?: OperationKey): Promise<"IDLE" | "WORKED"> {
	// TODO Lease one row. For a row that was LEASED or UNCERTAIN before, reconcile first.
	// TODO dispatch only when reconcile says NOT_FOUND. CONFIRMED feeds the observation, with acknowledge, in one commit.
	// TODO UNKNOWN or PENDING becomes UNCERTAIN with a backoff. It never selects another disposition.
	// TODO PERMANENT_FAILURE on CREATE_ORDER or CAPTURE feeds FundingFailed. On RELEASE or REFUND it is NEEDS_HUMAN.
	const now = ports.clock.now();
	const row = await ports.store.leaseEffect(now, instant(new Date(Date.parse(now) + 120_000).toISOString()), key);
	if (!row) return "IDLE";
	const effect = row.effect;
	if (effect.kind === "START_VERIFIER") return dispatchVerifierStart(ports, row.key, effect, now);
	if (effect.kind === "CREATE_WORK_REPO") return dispatchWorkRepo(ports, row.key, effect, now, row.state);
	if (effect.kind !== "CREATE_ORDER" && effect.kind !== "CAPTURE") {
		await ports.store.recordEffect(row.key, { kind: "NEEDS_HUMAN", reason: "OUTSIDE_SKELETON" });
		return "WORKED";
	}
	const job = await ports.store.readJob(effect.jobId);
	// A cancelled/expired create must never create a fresh payable order.
	if (!job || job.state.status !== "OPEN" || job.state.phase.kind !== "FUNDING" ||
		job.state.phase.round !== effect.round || (effect.kind === "CREATE_ORDER" && job.state.phase.checkout.phase !== "CREATING_ORDER")) {
		await ports.store.recordEffect(row.key, { kind: "CONFIRMED", at: now }); return "WORKED";
	}
	const call = toPayPalCall(effect)!;
	try {
		let outcome: RemoteOutcome = { kind: "NOT_FOUND" };
		if (row.state.kind !== "READY") outcome = await ports.paypal.reconcile(call, providerRequestId(row.key));
		if (outcome.kind === "NOT_FOUND") outcome = await ports.paypal.dispatch(call, providerRequestId(row.key));
		if (outcome.kind === "CONFIRMED") {
			const observation = outcome.observation;
			const command = observation.kind === "ORDER_CREATED" && effect.kind === "CREATE_ORDER"
				? { type: "OrderCreated" as const, jobId: effect.jobId, round: effect.round, orderId: observation.orderId, approveUrl: observation.approveUrl }
				: toJobCommand(effect.jobId, observation);
			if (!command || (effect.kind === "CAPTURE" && command.type !== "CaptureCompleted")) {
				await ports.store.recordEffect(row.key, { kind: "UNCERTAIN", reconcileAt: instant(new Date(Date.parse(now) + 5000).toISOString()) });
			} else await applySystemCommand(ports, command, row.key, null);
		} else if (outcome.kind === "PERMANENT_FAILURE") {
			await applySystemCommand(ports, { type: "FundingFailed", jobId: effect.jobId, round: effect.round, reason: outcome.reason }, row.key, null);
		} else await ports.store.recordEffect(row.key, interpret(outcome, row, ports.clock.now()));
	} catch {
		await ports.store.recordEffect(row.key, { kind: "UNCERTAIN", reconcileAt: instant(new Date(Date.parse(now) + 5000).toISOString()) });
	}
	return "WORKED";
}

function backoffFrom(now: Instant): Instant {
	return instant(new Date(Date.parse(now) + 5000).toISOString());
}

/** Starts the run the attempt reserved. A run that was already reported, or whose slot was returned, is not started again. */
async function dispatchVerifierStart(ports: Ports, key: OperationKey, effect: Extract<JobEffect, { kind: "START_VERIFIER" }>, now: Instant): Promise<"IDLE" | "WORKED"> {
	const job = await ports.store.readJob(effect.jobId);
	const waiting = job?.state.status === "IN_PROGRESS" && job.state.attempts.phase === "VERIFYING" &&
		job.state.attempts.pending.runId === effect.attempt.runId;
	if (!job || !waiting) {
		await ports.store.recordEffect(key, { kind: "CONFIRMED", at: now });
		return "WORKED";
	}
	const done = job.contract.definitionOfDone;
	if (done === null) {
		// A row stored before the freeze has no test list to judge against. Record it for a human instead of starting a run.
		await ports.store.recordEffect(key, { kind: "NEEDS_HUMAN", reason: "CONTRACT_NOT_FROZEN" });
		return "WORKED";
	}
	try {
		await ports.verifier.start({ runId: effect.attempt.runId, jobId: job.id, ordinal: effect.attempt.ordinal,
			sourceCommit: effect.attempt.sourceCommit, definitionOfDone: done });
	} catch {
		// The run may or may not have started. It is never dispatched twice from here, and the run-end timer returns the slot.
		await ports.store.recordEffect(key, { kind: "UNCERTAIN", reconcileAt: backoffFrom(now) });
		return "WORKED";
	}
	await ports.store.recordEffect(key, { kind: "CONFIRMED", at: now });
	return "WORKED";
}

/** What the outbox does with one refusal from the GitHub App client. One table, one place to read. */
export type GitHubDisposition = { readonly kind: "NEEDS_HUMAN" } | { readonly kind: "UNCERTAIN" };

export const GITHUB_REFUSAL_DISPOSITIONS: Readonly<Record<GitHubFailureCode, GitHubDisposition>> = {
	GITHUB_APP_KEY_INVALID: { kind: "NEEDS_HUMAN" },
	GITHUB_INSTALLATION_MISSING: { kind: "NEEDS_HUMAN" },
	GITHUB_PERMISSION_MISSING: { kind: "NEEDS_HUMAN" },
	GITHUB_FORK_MISMATCH: { kind: "NEEDS_HUMAN" },
	GITHUB_REF_CONFLICT: { kind: "NEEDS_HUMAN" },
	GITHUB_COMMIT_ABSENT: { kind: "NEEDS_HUMAN" },
	GITHUB_NOT_FOUND: { kind: "NEEDS_HUMAN" },
	GITHUB_RESPONSE_INVALID: { kind: "NEEDS_HUMAN" },
	GITHUB_REQUEST_INVALID: { kind: "NEEDS_HUMAN" },
	GITHUB_RATE_LIMITED: { kind: "UNCERTAIN" },
	GITHUB_TIMEOUT: { kind: "UNCERTAIN" },
	GITHUB_NETWORK: { kind: "UNCERTAIN" },
	// GITHUB_HTTP_ERROR is the status GitHub does not name. A 5xx is transient; every other status waits for a person.
	GITHUB_HTTP_ERROR: { kind: "NEEDS_HUMAN" },
};

/** A transient refusal waits 5s, 10s, 20s, and so on, never past five minutes. */
const GITHUB_BACKOFF_BASE_MS = 5_000;
const GITHUB_BACKOFF_CAP_MS = 300_000;

function githubDisposition(error: GitHubAppError): GitHubDisposition {
	if (error.code === "GITHUB_HTTP_ERROR" && error.status !== null && error.status >= 500) return { kind: "UNCERTAIN" };
	return GITHUB_REFUSAL_DISPOSITIONS[error.code];
}

/** The next reconcile time for a transient refusal, doubled per attempt and bounded. */
function backoffFor(now: Instant, attempt: number): Instant {
	const delay = Math.min(GITHUB_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), GITHUB_BACKOFF_CAP_MS);
	return instant(new Date(Date.parse(now) + delay).toISOString());
}

/** Pushes the frozen commit to the per-job work repository. No App means the row waits for a human, by name. */
async function dispatchWorkRepo(ports: Ports, key: OperationKey, effect: Extract<JobEffect, { kind: "CREATE_WORK_REPO" }>,
	now: Instant, previous: OutboxState): Promise<"IDLE" | "WORKED"> {
	const job = await ports.store.readJob(effect.jobId);
	// Work that never started needs no repository.
	if (!job || job.state.status === "OPEN" || job.state.status === "CLOSED") {
		await ports.store.recordEffect(key, { kind: "CONFIRMED", at: now });
		return "WORKED";
	}
	if (!ports.workRepo) {
		await ports.store.recordEffect(key, { kind: "NEEDS_HUMAN", reason: "GITHUB_APP_NOT_CONFIGURED" });
		return "WORKED";
	}
	const attempt = (previous.kind === "UNCERTAIN" ? previous.attempt ?? 0 : 0) + 1;
	try {
		await ports.workRepo.createWorkRepo({ jobId: effect.jobId, repository: effect.repository, frozenCommit: effect.frozenCommit }, providerRequestId(key));
	} catch (error) {
		if (error instanceof GitHubAppNotConfigured) {
			await ports.store.recordEffect(key, { kind: "NEEDS_HUMAN", reason: "GITHUB_APP_NOT_CONFIGURED" });
			return "WORKED";
		}
		if (error instanceof GitHubAppError && githubDisposition(error).kind === "NEEDS_HUMAN") {
			// The operator reads the code and the bounded detail off the row. A retry cannot clear this one.
			await ports.store.recordEffect(key, { kind: "NEEDS_HUMAN", reason: error.code, detail: boundedDetail(error.message) });
			return "WORKED";
		}
		// Transient, or a failure the client did not name: retry later, backing off as the attempts pile up.
		await ports.store.recordEffect(key, { kind: "UNCERTAIN", reconcileAt: backoffFor(now, attempt), attempt });
		return "WORKED";
	}
	await ports.store.recordEffect(key, { kind: "CONFIRMED", at: now });
	return "WORKED";
}

export function interpret(outcome: RemoteOutcome, row: OutboxRow, now: Instant): OutboxState {
	switch (outcome.kind) {
		case "UNKNOWN": case "PENDING": return { kind: "UNCERTAIN", reconcileAt: outcome.checkAt };
		case "PERMANENT_FAILURE": return { kind: "NEEDS_HUMAN", reason: outcome.reason };
		case "NOT_FOUND": return { kind: "READY", runAt: now };
		case "CONFIRMED": return { kind: "CONFIRMED", at: now };
	}
}

export function ingestPayPalWebhook(ports: Ports, request: Request): Promise<Response> {
	// TODO paypal.parseWebhook verifies and re-reads. Unknown resource returns 200 and is dropped.
	// TODO Route by stored order or capture id. Commit the delivery id with the transition.
	// TODO A new event id for an already applied capture reaches a no-op edge. The state is the guard.
	throw new Error("not implemented");
}

export async function ingestVerifierCallback(ports: Ports, request: Request): Promise<Response> {
	// The port authenticates the judge's signed report. Submitted-program output never reaches this path.
	const parsed = await ports.verifier.parseCallback(request);
	if (!parsed) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
	const job = await ports.store.readJob(parsed.jobId);
	const pending = job?.state.status === "IN_PROGRESS" && job.state.attempts.phase === "VERIFYING" ? job.state.attempts.pending : null;
	const report = parsed.report;
	const runId = report.kind === "VERDICT" ? report.verdict.runId : report.failure.runId;
	const sourceCommit = report.kind === "VERDICT" ? report.verdict.sourceCommit : report.failure.sourceCommit;
	const waiting = pending !== null && pending.runId === runId && pending.sourceCommit === sourceCommit;
	// A report for a run the job is not waiting on records nothing: an early report must not block the real one.
	if (!waiting) return Response.json({ ok: true, applied: false });
	// The run id is right but the attempt number is not: the report contradicts the attempt it names.
	if (pending.ordinal !== parsed.ordinal) return Response.json({ error: "ORDINAL_MISMATCH" }, { status: 409 });
	try {
		await applySystemCommand(ports, { type: "VerifierFinished", jobId: parsed.jobId, report }, null, `verifier:${runId}`);
	} catch {
		// The job state is the guard: a report for a job that is not waiting on this run changes nothing.
		return Response.json({ error: "REFUSED" }, { status: 409 });
	}
	return Response.json({ ok: true, applied: true });
}

export async function runDueTimers(ports: Ports): Promise<number> {
	// TODO For each due row, apply TimerDue with the stored wakeAt. A stale wakeAt is a no-op.
	// TODO Monday 00:00 UTC: Grant per operator, keyed grant:${week}, with paid receipts counted at the boundary.
	const now = ports.clock.now();
	const receipts = await ports.store.receiptCounts();
	let changed = 0;
	for (const operator of await ports.store.listOperators()) {
		if (operator.kind === "HOUSE") continue;
		const account = await ports.store.readCredits(operator.id);
		const next = reduceCredits(account, { kind: "Grant", week: creditWeek(now), paidReceipts: receipts.get(operator.id) ?? 0, at: now });
		if (next === "INSUFFICIENT_CREDITS" || next === account) continue;
		const result = await ports.store.commit({ job: null, operator: null, credits: [{ expectedVersion: account.version, account: next }],
			outbox: [], acknowledge: null, request: null, delivery: null });
		if (result === "COMMITTED") changed++;
	}
	for (const row of await ports.store.listJobs()) {
		if (row.state.status === "OPEN" && !row.bids.some(bid => bid.kind === "HOUSE")) await placeHouseBid(ports, row);
		if (row.state.status !== "OPEN" || row.state.phase.kind !== "FUNDING") continue;
		const checkout = row.state.phase.checkout;
		if (!("orderId" in checkout)) continue;
		const observed = await ports.paypal.getOrder(checkout.orderId, row.state.phase.chosen.payee);
		if (observed.kind === "CONFIRMED") {
			const command = toJobCommand(row.id, observed.observation);
			if (command) { await applySystemCommand(ports, command, null, null); changed++; }
		}
	}
	for (const due of await ports.store.dueJobs(now)) {
		await applySystemCommand(ports, { type: "TimerDue", jobId: due.jobId, expectedWakeAt: due.wakeAt }, null, null);
		changed++;
	}
	return changed;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	return JSON.stringify(value);
}
export function digest(value: unknown): Digest { return createHash("sha256").update(canonical(value)).digest("hex") as Digest; }
function outboxRow(effect: Effect, now: Instant): OutboxRow {
	return { key: operationKey(effect), effect, payloadDigest: digest(effect), state: { kind: "READY", runAt: now } };
}
async function placeHouseBid(ports: Ports, job: JobRow): Promise<void> {
	const hex = digest(`house-bid:${job.id}`);
	const key = parseRequestKey(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
	await executeCommand(ports, { role: "OPERATOR", operatorId: "house-tsfix" as OperatorId }, key,
		{ type: "PlaceBid", jobId: job.id, price: job.contract.budget, eta: hours(24),
			agent: "house-ts-fixer" as AgentId, pitch: "House quality bar: focused TypeScript fixes against the frozen suite." });
}

export async function confirmFunding(ports: Ports, actor: Actor, jobId: JobId): Promise<boolean> {
	const job = await ports.store.readJob(jobId);
	if (!job || actor.role !== "CLIENT" || actor.clientId !== job.client) return false;
	if (job.state.status === "IN_PROGRESS") return true;
	if (job.state.status !== "OPEN" || job.state.phase.kind !== "FUNDING" || !("orderId" in job.state.phase.checkout)) return false;
	const observed = await ports.paypal.getOrder(job.state.phase.checkout.orderId, job.state.phase.chosen.payee);
	if (observed.kind !== "CONFIRMED") return false;
	const command = toJobCommand(job.id, observed.observation);
	if (!command) return false;
	await applySystemCommand(ports, command, null, null);
	if (command.type === "BuyerApproved") await runOutboxOnce(ports, operationKey({
		kind: "CAPTURE", jobId, round: job.state.phase.round,
		orderId: job.state.phase.checkout.orderId, payee: job.state.phase.chosen.payee,
	}));
	return (await ports.store.readJob(jobId))?.state.status === "IN_PROGRESS";
}
