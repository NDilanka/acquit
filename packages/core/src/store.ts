import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store, AtomicCommit, OutboxRow, OutboxState, OperationKey, RecordedRequest } from "./effects.ts";
import type { Agent } from "./operator.ts";
import type { CreditAccount } from "./credits.ts";
import { storedDefinitionOfDone } from "./job.ts";
import type { JobRow, JobState, PaidState, ReleaseIntent } from "./job.ts";
import { boundedDetail, isRunFailureName } from "./verifier.ts";
import type { RunFailure } from "./verifier.ts";
import type { OperatorRow } from "./operator.ts";
import type { AgentId, CommitSha, Instant, JobId, OperatorId, PayoutBatchId, RefundId, RequestKey } from "./ids.ts";
import { instant } from "./ids.ts";

export function openDatabase(path: string): DatabaseSync {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	// The lock guard goes on before the first write. The migration below drops a table, and a second
	// process writing the same lane would fail this open with "database is locked" without it.
	db.exec("PRAGMA busy_timeout = 5000");
	// A lane created before the canonical envelope holds raw bodies, payer fields included. Drop that
	// table rather than migrate the bytes: the envelope it should have kept is rebuildable from PayPal.
	const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('webhook_events')").all().map(row => String(row.name)));
	if (columns.has("body")) db.exec("DROP TABLE webhook_events");
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
		INSERT OR IGNORE INTO schema_version VALUES (1);
		CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL, wake_at TEXT);
		CREATE INDEX IF NOT EXISTS jobs_wake ON jobs(wake_at);
		CREATE TABLE IF NOT EXISTS operators (id TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL, paid_receipts INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, json TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS credits (id TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS requests (actor TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor, key));
		CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, json TEXT NOT NULL, state TEXT NOT NULL, due_at TEXT);
		CREATE INDEX IF NOT EXISTS outbox_due ON outbox(due_at);
		CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, job_id TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY);
		CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL, event_type TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, outcome TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, handle TEXT NOT NULL, expires_at TEXT NOT NULL);
	`);
	return db;
}

function parsed<T>(row: Record<string, unknown> | undefined): T | null {
	return row ? JSON.parse(String(row.json)) as T : null;
}
/**
 * A busy or locked database is transient: the same write succeeds once the lock clears. node:sqlite
 * reports it as errcode 5 with a "database is locked" message once busy_timeout has passed.
 */
export function isStoreBusy(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if ((error as Error & { readonly errcode?: unknown }).errcode === 5) return true;
	return /database is locked|database table is locked/i.test(error.message);
}
/** A row stored before F3 carries a contract without a definition of done. Parse that absence to the typed null at the boundary. */
function storedJob(row: JobRow): JobRow {
	const parsed = { ...row, contract: { ...row.contract, definitionOfDone: storedDefinitionOfDone(row) }, state: storedPaid(storedMerge(row.state)) };
	if (parsed.state.status !== "IN_PROGRESS" || parsed.state.attempts.phase === "REFUND_PENDING") return parsed;
	// A row written before a run could fail has no failure field. This read is the boundary that types it.
	const failure = storedFailure((parsed.state.attempts as { readonly failure?: unknown }).failure ?? null);
	return { ...parsed, state: { ...parsed.state, attempts: { ...parsed.state.attempts, failure } } };
}
/** A paid row stored before the merge carried GitHub's commit holds MERGED with no sha. This read types that absence. */
function storedMerge(state: JobState): JobState {
	if (state.status !== "PAID" || state.merge.phase !== "MERGED") return state;
	const merge = state.merge as { readonly at: Instant; readonly sha?: CommitSha | null };
	return { ...state, merge: { phase: "MERGED", at: merge.at, sha: merge.sha ?? null } };
}
/** The five authorities the domain records. Anything else in a row is not an authority this build knows. */
const RELEASE_AUTHORITIES = ["CLIENT_APPROVAL", "REVIEW_SILENCE", "ARBITER_UPHELD", "ARBITER_SLA_MISSED", "CAPTURE_CUTOFF"] as const;
function isReleaseAuthority(value: unknown): value is ReleaseIntent["authority"] {
	return typeof value === "string" && (RELEASE_AUTHORITIES as readonly string[]).includes(value);
}
/**
 * A paid row stored before the release authority was recorded holds none, and a value outside the
 * domain's five is not a stored fact either. This read types both absences as the typed null.
 */
function storedPaid(state: JobState): JobState {
	if (state.status !== "PAID") return state;
	const paid = state as PaidState & { readonly releaseAuthority?: unknown };
	return { ...paid, releaseAuthority: isReleaseAuthority(paid.releaseAuthority) ? paid.releaseAuthority : null };
}
/**
 * A row written before a failure carried its name stored one `reason` string. Split it here, at the
 * read boundary, so nothing downstream has to read prose: the head names the step when the closed set
 * knows it, and a step it does not name keeps its text under the contract-mismatch name.
 */
function storedFailure(value: unknown): RunFailure | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (isRunFailureName(raw.name) && typeof raw.detail === "string") return raw as unknown as RunFailure;
	if (typeof raw.reason !== "string") return null;
	const [head = "", ...rest] = raw.reason.split(": ");
	const named = isRunFailureName(head)
		? { name: head, detail: boundedDetail(rest.join(": ")) }
		: { name: "CONTRACT_MISMATCH" as const, detail: boundedDetail(raw.reason) };
	return { runId: raw.runId, sourceCommit: raw.sourceCommit, at: raw.at, ...named } as unknown as RunFailure;
}
function due(state: OutboxState): string | null {
	return state.kind === "READY" ? state.runAt : state.kind === "LEASED" ? state.leaseUntil : state.kind === "UNCERTAIN" ? state.reconcileAt : null;
}
export class SqliteStore implements Store {
	readonly db: DatabaseSync;
	constructor(path: string) { this.db = openDatabase(path); }
	async readJob(id: JobId): Promise<JobRow | null> { const row = parsed<JobRow>(this.db.prepare("SELECT json FROM jobs WHERE id = ?").get(id)); return row ? storedJob(row) : null; }
	async readOperator(id: OperatorId): Promise<OperatorRow | null> { return parsed(this.db.prepare("SELECT json FROM operators WHERE id = ?").get(id)); }
	async readAgent(id: AgentId): Promise<Agent | null> { return parsed(this.db.prepare("SELECT json FROM agents WHERE id = ?").get(id)); }
	async readCredits(id: OperatorId): Promise<CreditAccount> {
		const account = parsed<CreditAccount>(this.db.prepare("SELECT json FROM credits WHERE id = ?").get(id));
		if (!account) throw new Error("Credit account missing");
		return account;
	}
	async readRequest(actor: string, key: RequestKey): Promise<RecordedRequest | null> {
		const row = this.db.prepare("SELECT digest, result FROM requests WHERE actor = ? AND key = ?").get(actor, key);
		return row ? { actor, key, payloadDigest: String(row.digest) as RecordedRequest["payloadDigest"], result: JSON.parse(String(row.result)) as RecordedRequest["result"] } : null;
	}
	async finishRequest(request: RecordedRequest): Promise<void> {
		this.db.prepare("UPDATE requests SET result = ? WHERE actor = ? AND key = ? AND digest = ?")
			.run(JSON.stringify(request.result), request.actor, request.key, request.payloadDigest);
	}
	async listJobs(): Promise<readonly JobRow[]> { return this.db.prepare("SELECT json FROM jobs ORDER BY rowid DESC").all().map(row => storedJob(JSON.parse(String(row.json)) as JobRow)); }
	async listOperators(): Promise<readonly OperatorRow[]> { return this.db.prepare("SELECT json FROM operators").all().map(row => JSON.parse(String(row.json)) as OperatorRow); }
	async receiptCounts(): Promise<ReadonlyMap<OperatorId, number>> {
		return new Map(this.db.prepare("SELECT id, paid_receipts FROM operators").all().map(row => [String(row.id) as OperatorId, Number(row.paid_receipts)]));
	}
	async jobForResource(resource: string): Promise<JobId | null> {
		const row = this.db.prepare("SELECT job_id FROM resources WHERE id = ?").get(resource);
		return row ? String(row.job_id) as JobId : null;
	}
	/**
	 * The canonical envelope of one delivery, keyed by PayPal's event id. The row keeps the fields of the
	 * latest delivery under that id, never the body. The route is unauthenticated, so the table is
	 * bounded on insert: the newest deliveries by receipt time, and nothing older than the window.
	 */
	async recordWebhookEvent(event: WebhookEventRow): Promise<void> {
		this.db.prepare(`INSERT INTO webhook_events (id, received_at, event_type, resource_type, resource_id, outcome) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET received_at = excluded.received_at, event_type = excluded.event_type,
				resource_type = excluded.resource_type, resource_id = excluded.resource_id, outcome = excluded.outcome`)
			.run(event.id, event.receivedAt, event.eventType, event.resourceType, event.resourceId, event.outcome);
		this.db.prepare("DELETE FROM webhook_events WHERE received_at < ?")
			.run(instant(new Date(Date.parse(event.receivedAt) - WEBHOOK_EVENT_MAX_AGE_MS).toISOString()));
		this.db.prepare("DELETE FROM webhook_events WHERE id NOT IN (SELECT id FROM webhook_events ORDER BY received_at DESC, rowid DESC LIMIT ?)")
			.run(WEBHOOK_EVENT_ROWS);
	}
	async dueJobs(now: Instant): Promise<readonly { jobId: JobId; wakeAt: Instant }[]> {
		return this.db.prepare("SELECT id, wake_at FROM jobs WHERE wake_at <= ?").all(now).map(row => ({ jobId: String(row.id) as JobId, wakeAt: String(row.wake_at) as Instant }));
	}
	async commit(change: AtomicCommit): Promise<"COMMITTED" | "VERSION_CONFLICT" | "REQUEST_REPLAY" | "DELIVERY_REPLAY"> {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (change.request && this.db.prepare("SELECT 1 FROM requests WHERE actor = ? AND key = ?").get(change.request.actor, change.request.key)) {
				this.db.exec("ROLLBACK"); return "REQUEST_REPLAY";
			}
			if (change.delivery && this.db.prepare("SELECT 1 FROM deliveries WHERE id = ?").get(change.delivery)) {
				this.db.exec("ROLLBACK"); return "DELIVERY_REPLAY";
			}
			if (change.operator) throw new Error("not implemented");
			if (change.job) {
				const { row, expectedVersion } = change.job;
				if (expectedVersion === null) {
					const result = this.db.prepare("INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), change.job.wakeAt);
					if (!result.changes) { this.db.exec("ROLLBACK"); return "VERSION_CONFLICT"; }
				} else {
					const result = this.db.prepare("UPDATE jobs SET version = ?, json = ?, wake_at = ? WHERE id = ? AND version = ?")
						.run(row.version, JSON.stringify(row), change.job.wakeAt, row.id, expectedVersion);
					if (!result.changes) { this.db.exec("ROLLBACK"); return "VERSION_CONFLICT"; }
				}
				for (const resource of jobResources(row)) this.db.prepare("INSERT OR IGNORE INTO resources VALUES (?, ?)").run(resource, row.id);
			}
			for (const credit of change.credits) {
				const account = credit.account;
				const updated = this.db.prepare("UPDATE credits SET version = ?, json = ? WHERE id = ? AND version = ?")
					.run(account.version, JSON.stringify(account), account.operator, credit.expectedVersion);
				if (!updated.changes) { this.db.exec("ROLLBACK"); return "VERSION_CONFLICT"; }
			}
			// The count moves with the PAID row or not at all: exactly the write that settles the release
			// sets it, so a redelivery or a refused settlement can never count the receipt twice.
			if (change.paidReceipt) {
				const counted = this.db.prepare("UPDATE operators SET paid_receipts = paid_receipts + 1 WHERE id = ?").run(change.paidReceipt);
				if (!counted.changes) throw new Error("Paid receipt counted no operator");
			}
			for (const row of change.outbox) this.db.prepare("INSERT OR IGNORE INTO outbox VALUES (?, ?, ?, ?)").run(row.key, JSON.stringify(row), JSON.stringify(row.state), due(row.state));
			if (change.settlement) this.updateEffect(change.settlement.key, change.settlement.state);
			if (change.request) this.db.prepare("INSERT INTO requests VALUES (?, ?, ?, ?)").run(change.request.actor, change.request.key, change.request.payloadDigest, JSON.stringify(change.request.result));
			if (change.delivery) this.db.prepare("INSERT INTO deliveries VALUES (?)").run(change.delivery);
			this.db.exec("COMMIT");
			return "COMMITTED";
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	async leaseEffect(now: Instant, until: Instant, key?: OperationKey): Promise<OutboxRow | null> {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const record = key
				? this.db.prepare("SELECT json, state FROM outbox WHERE due_at <= ? AND key = ?").get(now, key)
				: this.db.prepare("SELECT json, state FROM outbox WHERE due_at <= ? ORDER BY due_at, rowid LIMIT 1").get(now);
			if (!record) { this.db.exec("COMMIT"); return null; }
			const row = { ...JSON.parse(String(record.json)) as OutboxRow, state: JSON.parse(String(record.state)) as OutboxState };
			this.updateEffect(row.key, { kind: "LEASED", leaseUntil: until });
			this.db.exec("COMMIT");
			return row; // Return the previous state: the worker knows whether reconciliation is necessary.
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	private updateEffect(key: OperationKey, state: OutboxState): void {
		this.db.prepare("UPDATE outbox SET state = ?, due_at = ? WHERE key = ?").run(JSON.stringify(state), due(state), key);
	}
	async recordEffect(key: OperationKey, state: OutboxState): Promise<void> { this.updateEffect(key, state); }
	close(): void { this.db.close(); }
}

/** One delivery the webhook route received, as its canonical envelope. The outcome is the phrase recorded for it. */
export type WebhookEventRow = {
	/** PayPal's event id, or the digest of a body that names none. */
	readonly id: string;
	readonly receivedAt: Instant;
	readonly eventType: string;
	readonly resourceType: string;
	readonly resourceId: string;
	readonly outcome: string;
};

/** The window of webhook envelopes one lane keeps: the newest deliveries by receipt time, and nothing older than a month. */
const WEBHOOK_EVENT_ROWS = 500;
const WEBHOOK_EVENT_MAX_AGE_MS = 30 * 86_400_000;

function jobResources(row: JobRow): string[] {
	const state = row.state;
	if (state.status === "OPEN" && state.phase.kind === "FUNDING") {
		const checkout = state.phase.checkout;
		if ("orderId" in checkout) return [checkout.orderId];
		if (checkout.phase === "REFUND_PENDING") return [checkout.escrow.capture.orderId, checkout.escrow.capture.captureId];
	}
	if (state.status === "IN_PROGRESS" || state.status === "VERIFIED") return [state.escrow.capture.orderId, state.escrow.capture.captureId];
	// A refunded row stays the index for the refund it recorded and for the reimbursement batches it paid,
	// so a refund or payout webhook resolves to this job. An earlier state's rows are kept: nothing deletes them.
	if (state.status === "REFUNDED") {
		const ids: (RefundId | PayoutBatchId | null)[] = [state.refund.refundId,
			...state.treasury.flatMap(entry => entry.kind === "PAYOUT_FEE_PAID" ? [entry.batchId] : [])];
		return ids.filter((id): id is RefundId | PayoutBatchId => id !== null);
	}
	return [];
}
