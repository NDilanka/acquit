// The impure shell around job.ts. Request keys, the atomic commit, the outbox, reconciliation,
// webhook and verifier ingestion, and the timer scan. No business rule lives here.
// Every rule is a table edge. This file only loads facts, commits plans, and feeds observations back.

import type { CommandOutcome, Actor, PublicResult, UserCommand } from "./acquit";
import type { CreditAccount } from "./credits";
import type { Branded, Digest, Instant, JobId, OperatorId, RequestKey, Version } from "./ids";
import type { JobCommand, JobEffect, JobRow, SystemJobCommand } from "./job";
import type { Agent, OperatorEffect, OperatorRow } from "./operator";
import type { PayPal, PayPalCall, PayPalObservation, RemoteOutcome } from "./paypal";
import type { VerifierPort } from "./verifier";

export type Effect = JobEffect | OperatorEffect;

/** Deterministic, never random. `${jobId}:release`, `${jobId}:capture:${round}`, `${jobId}:verify:${run}`. */
export type OperationKey = Branded<string, "OperationKey">;

export function operationKey(effect: Effect): OperationKey {
	// TODO CREATE_ORDER and CAPTURE use (jobId, kind, round). START_VERIFIER uses (jobId, kind, run).
	// TODO RELEASE, REFUND, MERGE use (jobId, kind). One release and one refund key per job, ever.
	// TODO PAYPAL_ONBOARD uses (operator, kind). ALERT uses (jobId, kind, reason).
	throw new Error("not implemented");
}

/** The PayPal-Request-Id and the verifier run id. The same string as the operation key. */
export function providerRequestId(key: OperationKey): string {
	throw new Error("not implemented");
}

export function toPayPalCall(effect: Effect): PayPalCall | null {
	throw new Error("not implemented");
}

/** Maps a provider observation onto the system edge it feeds. Routing uses stored order and capture ids. */
export function toJobCommand(jobId: JobId, observation: PayPalObservation): SystemJobCommand | null {
	throw new Error("not implemented");
}

export type OutboxState =
	| { readonly kind: "READY"; readonly runAt: Instant }
	| { readonly kind: "LEASED"; readonly leaseUntil: Instant }
	| { readonly kind: "UNCERTAIN"; readonly reconcileAt: Instant }
	| { readonly kind: "CONFIRMED"; readonly at: Instant }
	| { readonly kind: "NEEDS_HUMAN"; readonly reason: string };

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

/** One Postgres database. Private to this package. */
export interface Store {
	readJob(jobId: JobId): Promise<JobRow | null>;
	readOperator(operator: OperatorId): Promise<OperatorRow | null>;
	readCredits(operator: OperatorId): Promise<CreditAccount>;
	readRequest(actor: string, key: RequestKey): Promise<RecordedRequest | null>;
	jobForResource(resource: string): Promise<JobId | null>;
	dueJobs(now: Instant): Promise<readonly { readonly jobId: JobId; readonly wakeAt: Instant }[]>;
	commit(change: AtomicCommit): Promise<"COMMITTED" | "VERSION_CONFLICT" | "REQUEST_REPLAY" | "DELIVERY_REPLAY">;
	leaseEffect(now: Instant, until: Instant): Promise<OutboxRow | null>;
	recordEffect(key: OperationKey, state: OutboxState): Promise<void>;
}

export type Ports = {
	readonly store: Store;
	readonly paypal: PayPal;
	readonly verifier: VerifierPort;
	readonly github: { merge(effect: Extract<JobEffect, { kind: "MERGE" }>, requestId: string): Promise<"MERGED" | "UNKNOWN" | "CONFLICT"> };
	readonly alerts: { raise(effect: Extract<JobEffect, { kind: "ALERT" }>): Promise<void> };
	readonly clock: { now(): Instant };
};

export function executeCommand(ports: Ports, actor: Actor, key: RequestKey, command: UserCommand): Promise<CommandOutcome> {
	// TODO Digest the payload. A recorded (actor, key) with the same digest returns REPLAY with its result.
	//      A different digest returns DENIED KEY_REUSED_WITH_DIFFERENT_PAYLOAD.
	// TODO Load facts for the command, call applyJobCommand or applyOperatorCommand, commit with CAS.
	// TODO VERSION_CONFLICT reruns the table on the fresh row. It never repeats a remote call.
	// TODO After commit, dispatch this commit's own outbox rows inline with a short bound, then re-read.
	//      That is why Accept usually returns the approve URL and Approve usually returns PAID.
	throw new Error("not implemented");
}

export function applySystemCommand(ports: Ports, command: JobCommand, acknowledge: OperationKey | null, delivery: string | null): Promise<void> {
	throw new Error("not implemented");
}

export function runOutboxOnce(ports: Ports): Promise<"IDLE" | "WORKED"> {
	// TODO Lease one row. For a row that was LEASED or UNCERTAIN before, reconcile first.
	// TODO dispatch only when reconcile says NOT_FOUND. CONFIRMED feeds the observation, with acknowledge, in one commit.
	// TODO UNKNOWN or PENDING becomes UNCERTAIN with a backoff. It never selects another disposition.
	// TODO PERMANENT_FAILURE on CREATE_ORDER or CAPTURE feeds FundingFailed. On RELEASE or REFUND it is NEEDS_HUMAN.
	throw new Error("not implemented");
}

export function interpret(outcome: RemoteOutcome, row: OutboxRow): OutboxState {
	throw new Error("not implemented");
}

export function ingestPayPalWebhook(ports: Ports, request: Request): Promise<Response> {
	// TODO paypal.parseWebhook verifies and re-reads. Unknown resource returns 200 and is dropped.
	// TODO Route by stored order or capture id. Commit the delivery id with the transition.
	// TODO A new event id for an already applied capture reaches a no-op edge. The state is the guard.
	throw new Error("not implemented");
}

export function ingestVerifierCallback(ports: Ports, request: Request): Promise<Response> {
	throw new Error("not implemented");
}

export function runDueTimers(ports: Ports): Promise<number> {
	// TODO For each due row, apply TimerDue with the stored wakeAt. A stale wakeAt is a no-op.
	// TODO Monday 00:00 UTC: Grant per operator, keyed grant:${week}, with paid receipts counted at the boundary.
	throw new Error("not implemented");
}
