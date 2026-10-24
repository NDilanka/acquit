import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store, AtomicCommit, CommitResult, OutboxRow, OutboxState, OperationKey, ReceiptRowCounts, RecordedRequest, WorkRepoRecord } from "./effects.ts";
import type { Agent } from "./operator.ts";
import type { CreditAccount } from "./credits.ts";
import { storedDefinitionOfDone } from "./job.ts";
import type { JobRow, JobState, PaidState, ReceiptSource, RefundReason, ReleaseIntent } from "./job.ts";
import { boundedDetail, isRunFailureName } from "./verifier.ts";
import type { DefinitionOfDone, RunFailure } from "./verifier.ts";
import type { OperatorRow } from "./operator.ts";
import type { AgentId, ClientId, CommitSha, Digest, Instant, JobId, OperatorId, PayoutBatchId, ReceiptId, RefundId, RequestKey, TestId } from "./ids.ts";
import { instant } from "./ids.ts";
import { capUsage, capWindowStart, reservationRefusal } from "./caps.ts";
import type { UsdCents } from "./ledger.ts";
import { logBare } from "./log.ts";
import { jobFunding } from "./funding.ts";
import { matchFixture } from "./fixtures.ts";
import type { FixtureRef } from "./fixtures.ts";
import type { JobScopingRow } from "./scoping.ts";
import { SEEDED_USERS } from "./seed-data.ts";

/**
 * The visitors table. A null expires_at is a lasting account. display_name is the account's readable name, and
 * recovery_digest is the SHA-256 of its one live recovery token, never the token.
 */
const VISITORS_SHAPE = `id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT,
	ip_key TEXT NOT NULL, client_handle TEXT NOT NULL, operator_handle TEXT NOT NULL, repository TEXT,
	repository_id INTEGER, state TEXT NOT NULL DEFAULT 'ACTIVE', display_name TEXT, recovery_digest TEXT, recovery_made_at TEXT`;

/**
 * A database from before lasting accounts holds expires_at as NOT NULL, and SQLite cannot drop a column constraint
 * in place, so the table is rebuilt once with every row copied as it was. Each row keeps its expiry: only accounts
 * made from here on last. One transaction, so a crash leaves the old table whole.
 */
function migrateLastingAccounts(db: DatabaseSync): void {
	const expiry = db.prepare("SELECT \"notnull\" AS required FROM pragma_table_info('visitors') WHERE name = 'expires_at'").get();
	if (expiry !== undefined && Number(expiry.required) === 1) {
		const copied = "id, created_at, expires_at, ip_key, client_handle, operator_handle, repository, repository_id, state";
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(`CREATE TABLE visitors_lasting (${VISITORS_SHAPE});
				INSERT INTO visitors_lasting (${copied}) SELECT ${copied} FROM visitors;
				DROP TABLE visitors;
				ALTER TABLE visitors_lasting RENAME TO visitors;
				CREATE INDEX IF NOT EXISTS visitors_expiry ON visitors(expires_at);`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	db.exec("CREATE UNIQUE INDEX IF NOT EXISTS visitors_recovery ON visitors(recovery_digest) WHERE recovery_digest IS NOT NULL");
}

/** The store's own schema. The fixtures drive the M1 manifest backfill; absent, no backfill runs. */
export function openDatabase(path: string, fixtures: readonly FixtureRef[] = []): DatabaseSync {
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
		CREATE TABLE IF NOT EXISTS job_funding (job_id TEXT PRIMARY KEY, mode TEXT NOT NULL, set_at TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, job_id TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY);
		CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL, event_type TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, outcome TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, handle TEXT NOT NULL, expires_at TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS visitors (${VISITORS_SHAPE});
		CREATE INDEX IF NOT EXISTS visitors_expiry ON visitors(expires_at);
		CREATE TABLE IF NOT EXISTS principals (handle TEXT PRIMARY KEY, role TEXT NOT NULL, visitor_id TEXT);
		-- Judge mode's spends, append-only. One row per act, written in the transaction that commits it,
		-- so a cap check and the write it guards cannot be split by another worker.
		CREATE TABLE IF NOT EXISTS cap_reservations (kind TEXT NOT NULL, scope TEXT NOT NULL, ref TEXT NOT NULL,
			cents INTEGER NOT NULL, at_wall TEXT NOT NULL, PRIMARY KEY(kind, ref));
		CREATE INDEX IF NOT EXISTS cap_reservations_window ON cap_reservations(kind, scope, at_wall);
		-- One persisted receipt row per paid job, plus the deployment's seeded history rows. The House
		-- line is counted from these rows, never from a counter; source marks the seeded rows SEED.
		CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, job_id TEXT, operator TEXT NOT NULL,
			source TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0, paid_at TEXT);
		CREATE INDEX IF NOT EXISTS receipts_operator ON receipts(operator);
		-- One frozen manifest per job, written by OpenJob in the job's own transaction. The judge reads
		-- the job's manifest; a registry change after the job is open never moves it.
		CREATE TABLE IF NOT EXISTS job_manifests (job_id TEXT PRIMARY KEY, json TEXT NOT NULL);
		-- One job's AI-scoping state: ids and counts only, never a case value. The issue body lives
		-- here because filter 4 checks every drafted citation against the body it was justified from.
		CREATE TABLE IF NOT EXISTS job_scoping (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, issue_body TEXT,
			ids TEXT NOT NULL, digest TEXT, reason TEXT, counts TEXT, updated_at TEXT NOT NULL);
		-- The judge scenarios' run snapshots, bounded by the run store and written at each progress. Eviction deletes
		-- a row, and the cleanup journal below keeps what the run owns. A row RUNNING when the store opens is marked
		-- FAILED, RESTARTED. Only the snapshot is here: its progress never decides who owns a job.
		CREATE TABLE IF NOT EXISTS scenario_runs (id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, visitor_id TEXT NOT NULL,
			job_id TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, snapshot TEXT NOT NULL);
		-- The cleanup journal: one row per run the run store committed, never evicted with its snapshot. It is written
		-- only by that commit, so job_id is the job the run's own OpenJob committed. finished_at starts the sweep's TTL.
		-- work_swept_at is set once the job's work repository is gone, and cleared again by a record that arrives later.
		CREATE TABLE IF NOT EXISTS scenario_cleanup (run_id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, job_id TEXT NOT NULL,
			finished_at TEXT, work_swept_at TEXT);
		-- A run's identity is set once, by its commit, and a finished run never resumes. The arbiter gate and the cleanup
		-- read these columns, so no UPDATE may change them, whatever code path or hand writes it.
		CREATE TRIGGER IF NOT EXISTS scenario_runs_identity_fixed BEFORE UPDATE ON scenario_runs
			WHEN OLD.id IS NOT NEW.id OR OLD.requester_id IS NOT NEW.requester_id OR OLD.visitor_id IS NOT NEW.visitor_id
				OR OLD.job_id IS NOT NEW.job_id OR OLD.name IS NOT NEW.name
			BEGIN SELECT RAISE(ABORT, 'scenario run identity is write-once'); END;
		CREATE TRIGGER IF NOT EXISTS scenario_runs_no_resume BEFORE UPDATE ON scenario_runs
			WHEN OLD.state <> 'RUNNING' AND NEW.state = 'RUNNING'
			BEGIN SELECT RAISE(ABORT, 'a finished scenario run cannot resume'); END;
		CREATE TRIGGER IF NOT EXISTS scenario_cleanup_identity_fixed BEFORE UPDATE ON scenario_cleanup
			WHEN OLD.run_id IS NOT NEW.run_id OR OLD.visitor_id IS NOT NEW.visitor_id OR OLD.job_id IS NOT NEW.job_id
			BEGIN SELECT RAISE(ABORT, 'scenario cleanup identity is write-once'); END;
		-- The work repository a job's CREATE_WORK_REPO effect made: its full name, GitHub's own id for it, and the
		-- fork it was made from. The cleanup deletes only the repository this row names.
		CREATE TABLE IF NOT EXISTS work_repos (job_id TEXT PRIMARY KEY, repository TEXT NOT NULL, repository_id INTEGER, source TEXT NOT NULL);
	`);
	// The M1 backfill: a database from before per-job manifests holds each job's frozen contract only
	// inside the job row. One manifest row per such job, carrying exactly the contract it was frozen
	// with, plus the frozen test path the registry names for its fixture. The job id is the key, so a
	// second migration inserts nothing new. A job whose fixture the registry does not name is skipped
	// with one log line: it stays as judgeable as it was, and fixing the registry re-runs the backfill.
	for (const row of db.prepare("SELECT id, json FROM jobs WHERE id NOT IN (SELECT job_id FROM job_manifests)").all()) {
		const job = JSON.parse(String(row.json)) as JobRow;
		const done = storedDefinitionOfDone(job);
		if (!done) continue;
		// The stored repository is the visitor context the open validated (a visitor's job sits on the
		// fork its session carried), so a registered demo fork matches; every other job matches exactly.
		const fixture = matchFixture(fixtures, done.issue.repository, done.issue.number, done.issue.repository);
		if (!fixture) { console.warn(`Manifest backfill skipped for ${logBare(String(row.id))}: no registered fixture for ${done.issue.repository}#${done.issue.number}`); continue; }
		db.prepare("INSERT OR IGNORE INTO job_manifests VALUES (?, ?)").run(String(row.id), JSON.stringify({ ...done, frozenTestPath: fixture.frozenTestPath }));
	}
	// The backfill: a database that already settled jobs holds its receipts only inside the PAID rows.
	// One SEED-marked row per PAID job's own receipt, so a line counted from rows sees the whole
	// history the day the migration lands. The receipt id guards the re-run: a second migration
	// inserts nothing new, so no job ever counts twice.
	db.exec(`INSERT INTO receipts (id, job_id, operator, source, paid, paid_at)
		SELECT json_extract(json, '$.state.receipt.id'), id, json_extract(json, '$.state.payee.operator'), 'SEED', 1,
			json_extract(json, '$.state.receipt.releasedAt')
		FROM jobs
		WHERE json_extract(json, '$.state.status') = 'PAID'
			AND json_extract(json, '$.state.receipt.id') IS NOT NULL
			AND json_extract(json, '$.state.payee.operator') IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM receipts WHERE receipts.id = json_extract(json, '$.state.receipt.id'))`);
	// A database that already holds visitor rows keeps them: CREATE TABLE IF NOT EXISTS leaves an old
	// shape alone, so a column added after the fact is added here. A row from before this column is a
	// visitor that was provisioned, so ACTIVE is what it means, and a row with no repository id is swept
	// by the ownership marker alone.
	const visitorColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('visitors')").all().map(row => String(row.name)));
	if (!visitorColumns.has("state")) db.exec("ALTER TABLE visitors ADD COLUMN state TEXT NOT NULL DEFAULT 'ACTIVE'");
	if (!visitorColumns.has("repository_id")) db.exec("ALTER TABLE visitors ADD COLUMN repository_id INTEGER");
	migrateLastingAccounts(db);
	// The seeded handles are principals with no visitor: the rows every session resolves through, so
	// the SEEDED_USERS constant is a seed, never an authentication source. The platform principal is
	// the third such row: the deployment's own reader of the whole book, held by no picker.
	for (const user of SEEDED_USERS) db.prepare("INSERT OR IGNORE INTO principals VALUES (?, ?, NULL)").run(user.handle, user.role);
	db.prepare("INSERT OR IGNORE INTO principals VALUES ('platform', 'PLATFORM', NULL)").run();
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
	const parsed = { ...row, tenant: row.tenant ?? null, contract: { ...row.contract, definitionOfDone: storedDefinitionOfDone(row) },
		state: storedRefund(storedPaid(storedMerge(row.state))) };
	if (parsed.state.status !== "IN_PROGRESS" || parsed.state.attempts.phase === "REFUND_PENDING") return parsed;
	// A row written before a run could fail has no failure field. This read is the boundary that types it.
	const failure = storedFailure((parsed.state.attempts as { readonly failure?: unknown }).failure ?? null);
	return { ...parsed, state: { ...parsed.state, attempts: { ...parsed.state.attempts, failure } } };
}
/** The job's contract with the manifest frozen over it: an approval rewrites the job_manifests row
 * the judge reads, and every reader of the job — the API's projection, the CLI, the command paths —
 * sees the set that froze, never the fixture's curated copy the row was opened with. */
function withFrozenManifest(db: DatabaseSync, row: JobRow): JobRow {
	if (row.contract === null || row.contract === undefined) return row;
	const frozen = db.prepare("SELECT json FROM job_manifests WHERE job_id = ?").get(row.id);
	if (!frozen) return row;
	return { ...row, contract: { ...row.contract, definitionOfDone: JSON.parse(String(frozen.json)) as DefinitionOfDone } };
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
	// A paid row stored before it kept its verdict history holds none: the read types that absence as
	// the empty history, and the projection falls back to the receipt's own verified attempt.
	return { ...paid, releaseAuthority: isReleaseAuthority(paid.releaseAuthority) ? paid.releaseAuthority : null,
		history: Array.isArray(paid.history) ? paid.history : [] };
}
/** The five reasons the domain records. Anything else in a row is not a reason this build knows. */
const REFUND_REASONS = ["DELIVERY_DEADLINE", "ATTEMPTS_EXHAUSTED", "ARBITER_REFUND", "CAPTURE_CUTOFF", "CAPTURE_MISMATCH", "PROVIDER_DISPUTE"] as const;
function isRefundReason(value: unknown): value is RefundReason {
	return typeof value === "string" && (REFUND_REASONS as readonly string[]).includes(value);
}
/**
 * A refund row stored before the reason was recorded holds none, and a value outside the domain's
 * five is not a stored fact either. This read types both absences as the typed null, on the settled
 * row's reason and on the intent every REFUND_PENDING phase keeps.
 */
function storedRefund(state: JobState): JobState {
	const reason = (value: unknown): RefundReason | null => isRefundReason(value) ? value : null;
	if (state.status === "REFUNDED") return { ...state, reason: reason(state.reason) };
	if (state.status === "IN_PROGRESS" && state.attempts.phase === "REFUND_PENDING") {
		return { ...state, attempts: { ...state.attempts, refund: { ...state.attempts.refund, reason: reason(state.attempts.refund.reason) } } };
	}
	if (state.status === "VERIFIED" && state.review.phase === "REFUND_PENDING") {
		return { ...state, review: { ...state.review, refund: { ...state.review.refund, reason: reason(state.review.refund.reason) } } };
	}
	if (state.status === "OPEN" && state.phase.kind === "FUNDING" && state.phase.checkout.phase === "REFUND_PENDING") {
		return { ...state, phase: { ...state.phase, checkout: { ...state.phase.checkout, refund: { ...state.phase.checkout.refund, reason: reason(state.phase.checkout.refund.reason) } } } };
	}
	return state;
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
export function outboxDue(state: OutboxState): string | null {
	return state.kind === "READY" ? state.runAt : state.kind === "LEASED" ? state.leaseUntil : state.kind === "UNCERTAIN" ? state.reconcileAt : null;
}
export class SqliteStore implements Store {
	readonly db: DatabaseSync;
	readonly #fixtures: readonly FixtureRef[];
	constructor(path: string, fixtures: readonly FixtureRef[] = []) {
		this.#fixtures = fixtures;
		this.db = openDatabase(path, fixtures);
	}
	// The job's own funding source lives beside the row, not in it: a command that read a row before a
	// choice was stored must not be able to write a stale copy back over it.
	async readJob(id: JobId): Promise<JobRow | null> {
		const row = parsed<JobRow>(this.db.prepare("SELECT json FROM jobs WHERE id = ?").get(id));
		return row ? storedJob(withFrozenManifest(this.db, { ...row, funding: jobFunding(this.db, id) })) : null;
	}
	/** The manifest frozen at OpenJob, or null for a row that predates the manifest freeze. */
	async readManifest(id: JobId): Promise<DefinitionOfDone | null> {
		const row = this.db.prepare("SELECT json FROM job_manifests WHERE job_id = ?").get(id);
		return row ? JSON.parse(String(row.json)) as DefinitionOfDone : null;
	}
	/** The job's scoping state, or null when no draft was ever started for it. */
	async readScoping(id: JobId): Promise<JobScopingRow | null> {
		const row = this.db.prepare("SELECT job_id, status, issue_body, ids, digest, reason, counts, updated_at FROM job_scoping WHERE job_id = ?").get(id);
		if (!row) return null;
		return { jobId: String(row.job_id) as JobId, status: String(row.status) as JobScopingRow["status"],
			issueBody: row.issue_body === null ? null : String(row.issue_body),
			ids: JSON.parse(String(row.ids)) as JobScopingRow["ids"],
			digest: row.digest === null ? null : String(row.digest) as JobScopingRow["digest"],
			reason: row.reason === null ? null : String(row.reason),
			counts: row.counts === null ? null : JSON.parse(String(row.counts)) as JobScopingRow["counts"],
			updatedAt: String(row.updated_at) as Instant };
	}
	async writeScoping(row: JobScopingRow): Promise<void> {
		this.db.prepare("INSERT OR REPLACE INTO job_scoping VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
			row.jobId, row.status, row.issueBody, JSON.stringify(row.ids), row.digest, row.reason,
			row.counts === null ? null : JSON.stringify(row.counts), row.updatedAt);
	}
	/** Freezes the job's manifest from the client's approved draft: the same row the judge reads,
	 * with the approved case ids and their digest. The frozen commit and the frozen tests never move. */
	async freezeManifest(id: JobId, done: DefinitionOfDone): Promise<void> {
		this.db.prepare("INSERT INTO job_manifests VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET json = excluded.json")
			.run(id, JSON.stringify(done));
	}

	/** The client's approval, claimed in one unit of work on this store's own connection. The job's
	 * row is re-read under the write lock, so an approval only ever lands while the job is still
	 * open for bids: status OPEN with phase BIDDING and no accepted bid. An acceptance keeps the
	 * status OPEN but commits the job to its contract — phase FUNDING, a CHOSEN bid, and every
	 * checkout step after it up to and including CAPTURING — so the claim refuses those for good,
	 * and no later approval can rewrite what the job runs. A permanent funding failure returns the
	 * job to BIDDING with nothing held, and only then the window opens again. The AWAITING_APPROVAL
	 * row then moves to APPROVED by compare-and-set on its status, the manifest freezes with the
	 * approved digest, and the caller's `persist` rewrites the private case file before the commit —
	 * a write that fails rolls the whole claim back, so the state is never approved without its
	 * file. */
	async claimApproval(id: JobId, freeze: { readonly manifest: DefinitionOfDone; readonly ids: readonly TestId[];
		readonly digest: Digest; readonly counts: JobScopingRow["counts"]; readonly persist: () => void },
		at: Instant): Promise<"CLAIMED" | "ALREADY_FROZEN" | "JOB_NOT_OPEN" | "NOT_AWAITING"> {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const job = this.db.prepare("SELECT json FROM jobs WHERE id = ?").get(id);
			const state = job ? (JSON.parse(String(job.json)) as JobRow).state : null;
			const openForBids = state !== null && state.status === "OPEN" && state.phase.kind === "BIDDING";
			if (!openForBids) { this.db.exec("ROLLBACK"); return state === null ? "NOT_AWAITING" : "JOB_NOT_OPEN"; }
			const claimed = this.db.prepare(`UPDATE job_scoping SET status = 'APPROVED', ids = ?, digest = ?, reason = NULL, counts = ?, updated_at = ?
				WHERE job_id = ? AND status = 'AWAITING_APPROVAL'`)
				.run(JSON.stringify(freeze.ids), freeze.digest, freeze.counts === null ? null : JSON.stringify(freeze.counts), at, id);
			if (claimed.changes !== 1) { this.db.exec("ROLLBACK"); return "ALREADY_FROZEN"; }
			this.db.prepare("INSERT INTO job_manifests VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET json = excluded.json")
				.run(id, JSON.stringify(freeze.manifest));
			freeze.persist();
			this.db.exec("COMMIT");
			return "CLAIMED";
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
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
	async listJobs(): Promise<readonly JobRow[]> {
		const modes = new Map(this.db.prepare("SELECT job_id, mode FROM job_funding").all().map(row => [String(row.job_id), String(row.mode)]));
		return this.db.prepare("SELECT json FROM jobs ORDER BY rowid DESC").all().map(row => {
			const job = JSON.parse(String(row.json)) as JobRow;
			const mode = modes.get(String(job.id));
			return storedJob(withFrozenManifest(this.db, { ...job, funding: mode === "checkout" || mode === "card" ? mode : null }));
		});
	}
	async listOperators(): Promise<readonly OperatorRow[]> { return this.db.prepare("SELECT json FROM operators").all().map(row => JSON.parse(String(row.json)) as OperatorRow); }
	async receiptCounts(): Promise<ReadonlyMap<OperatorId, number>> {
		return new Map(this.db.prepare("SELECT id, paid_receipts FROM operators").all().map(row => [String(row.id) as OperatorId, Number(row.paid_receipts)]));
	}
	/** The House line's own source: the real receipt rows per operator — every row the operator
	 * earned and the paid ones among them. The seeded rows (source SEED) are display history the
	 * line never counts; the receipts views label them Seeded instead. */
	async receiptRowCounts(): Promise<ReadonlyMap<OperatorId, ReceiptRowCounts>> {
		return new Map(this.db.prepare("SELECT operator, COUNT(*) AS total, COALESCE(SUM(paid), 0) AS paid FROM receipts WHERE source != 'SEED' GROUP BY operator")
			.all().map(row => [String(row.operator) as OperatorId, { total: Number(row.total), paid: Number(row.paid) }]));
	}
	/** The provenance the receipts table holds, by receipt id: the row a settlement wrote reads JOB
	 * and the F6 backfill's rows read SEED. The job view serves it so every page labels a receipt alike. */
	async receiptSources(): Promise<ReadonlyMap<ReceiptId, ReceiptSource>> {
		return new Map(this.db.prepare("SELECT id, source FROM receipts").all()
			.map(row => [String(row.id) as ReceiptId, (String(row.source) === "SEED" ? "SEED" : "JOB") as ReceiptSource]));
	}
	async receiptCount(id: OperatorId): Promise<number> {
		const row = this.db.prepare("SELECT paid_receipts FROM operators WHERE id = ?").get(id);
		return row ? Number(row.paid_receipts) : 0;
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
	async commit(change: AtomicCommit): Promise<CommitResult> {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (change.request && this.db.prepare("SELECT 1 FROM requests WHERE actor = ? AND key = ?").get(change.request.actor, change.request.key)) {
				this.db.exec("ROLLBACK"); return { kind: "REQUEST_REPLAY" };
			}
			if (change.delivery && this.db.prepare("SELECT 1 FROM deliveries WHERE id = ?").get(change.delivery)) {
				this.db.exec("ROLLBACK"); return { kind: "DELIVERY_REPLAY" };
			}
			// The cap check and its write share this one transaction, so two workers cannot both pass a
			// limit that neither has spent yet. A refusal rolls back before anything else is written.
			for (const reservation of change.reservations ?? []) {
				const refused = reservationRefusal(reservation, capUsage(this.db, { scope: reservation.scope, since: capWindowStart(reservation.at) }));
				if (refused !== null) { this.db.exec("ROLLBACK"); return { kind: "CAPPED", reason: refused }; }
			}
			if (change.operator) throw new Error("not implemented");
			if (change.job) {
				const { row, expectedVersion } = change.job;
				if (expectedVersion === null) {
					const result = this.db.prepare("INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), change.job.wakeAt);
					if (!result.changes) { this.db.exec("ROLLBACK"); return { kind: "VERSION_CONFLICT" }; }
				} else {
					const result = this.db.prepare("UPDATE jobs SET version = ?, json = ?, wake_at = ? WHERE id = ? AND version = ?")
						.run(row.version, JSON.stringify(row), change.job.wakeAt, row.id, expectedVersion);
					if (!result.changes) { this.db.exec("ROLLBACK"); return { kind: "VERSION_CONFLICT" }; }
				}
				for (const resource of jobResources(row)) this.db.prepare("INSERT OR IGNORE INTO resources VALUES (?, ?)").run(resource, row.id);
				// The manifest freeze travels with the job's own transaction on every path that stores a
				// row whose contract carries one. The first write wins, so a later commit never moves it.
				// The frozen contract's own repository is the actor context its open validated: a
				// registered demo fork matches, and every other job matches exactly.
				const frozen = storedDefinitionOfDone(row);
				if (frozen) {
					const fixture = matchFixture(this.#fixtures, frozen.issue.repository, frozen.issue.number, frozen.issue.repository);
					const done = fixture ? { ...frozen, frozenTestPath: fixture.frozenTestPath }
						: frozen.frozenTestPath !== undefined ? frozen : null;
					if (done) this.db.prepare("INSERT OR IGNORE INTO job_manifests VALUES (?, ?)").run(row.id, JSON.stringify(done));
				}
			}
			for (const credit of change.credits) {
				const account = credit.account;
				const updated = this.db.prepare("UPDATE credits SET version = ?, json = ? WHERE id = ? AND version = ?")
					.run(account.version, JSON.stringify(account), account.operator, credit.expectedVersion);
				if (!updated.changes) { this.db.exec("ROLLBACK"); return { kind: "VERSION_CONFLICT" }; }
			}
			// The count moves with the PAID row or not at all: exactly the write that settles the release
			// sets it, so a redelivery or a refused settlement can never count the receipt twice. The id
			// must be the committed PAID job's own payee: a wrong id counts nobody and loses the receipt,
			// so it refuses the write whole. A payee with no operators row is a fact to log, not a reason
			// to refuse the settlement: throwing there would roll the PAID row back, and every webhook
			// delivery of the same release would retry it.
			if (change.paidReceipt) {
				const committed = change.job;
				const payee = committed !== null && committed.row.state.status === "PAID" ? committed.row.state.payee.operator : null;
				if (change.paidReceipt !== payee) throw new Error(`paid receipt ${logBare(change.paidReceipt)} is not the committed PAID job's payee; refusing the write`);
				const counted = this.db.prepare("UPDATE operators SET paid_receipts = paid_receipts + 1 WHERE id = ?").run(change.paidReceipt);
				if (!counted.changes) console.warn(`paid receipt not counted: no operators row for ${logBare(change.paidReceipt)}`);
				// The same write appends the receipt's own row: the House line counts rows, so the row
				// must exist exactly when the counter moves, in the same transaction. The receipt id is
				// the key, so a replayed settlement replaces nothing but itself.
				const receipt = committed !== null && committed.row.state.status === "PAID" ? committed.row.state.receipt : null;
				if (receipt) this.db.prepare("INSERT OR REPLACE INTO receipts VALUES (?, ?, ?, 'JOB', 1, ?)")
					.run(receipt.id, receipt.jobId, receipt.operator, receipt.releasedAt);
			}
			for (const row of change.outbox) this.db.prepare("INSERT OR IGNORE INTO outbox VALUES (?, ?, ?, ?)").run(row.key, JSON.stringify(row), JSON.stringify(row.state), outboxDue(row.state));
			if (change.manifest) this.db.prepare("INSERT OR IGNORE INTO job_manifests VALUES (?, ?)").run(change.manifest.jobId, JSON.stringify(change.manifest.done));
			if (change.settlement) this.updateEffect(change.settlement.key, change.settlement.state);
			if (change.request) this.db.prepare("INSERT INTO requests VALUES (?, ?, ?, ?)").run(change.request.actor, change.request.key, change.request.payloadDigest, JSON.stringify(change.request.result));
			if (change.delivery) this.db.prepare("INSERT INTO deliveries VALUES (?)").run(change.delivery);
			// The act's spend lands with the act. The primary key makes a reservation as idempotent as
			// the commit that carries it: one act can never be counted twice.
			for (const reservation of change.reservations ?? []) {
				this.db.prepare("INSERT OR IGNORE INTO cap_reservations VALUES (?, ?, ?, ?, ?)")
					.run(reservation.kind, reservation.scope, reservation.ref, reservation.cents, reservation.at);
			}
			this.db.exec("COMMIT");
			return { kind: "COMMITTED" };
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
		this.db.prepare("UPDATE outbox SET state = ?, due_at = ? WHERE key = ?").run(JSON.stringify(state), outboxDue(state), key);
	}
	async recordEffect(key: OperationKey, state: OutboxState): Promise<void> { this.updateEffect(key, state); }
	async recordWorkRepo(record: WorkRepoRecord): Promise<void> {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("INSERT OR REPLACE INTO work_repos VALUES (?, ?, ?, ?)").run(record.jobId, record.repository, record.repositoryId, record.source);
			// A record that lands after a cleanup pass has marked the job swept reopens it, so the next pass removes the repository.
			this.db.prepare("UPDATE scenario_cleanup SET work_swept_at = NULL WHERE job_id = ?").run(record.jobId);
			this.db.exec("COMMIT");
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	async readWorkRepo(jobId: JobId): Promise<WorkRepoRecord | null> {
		const row = this.db.prepare("SELECT repository, repository_id, source FROM work_repos WHERE job_id = ?").get(jobId);
		if (row === undefined) return null;
		return { jobId, repository: String(row.repository), repositoryId: typeof row.repository_id === "number" ? row.repository_id : null,
			source: String(row.source) };
	}
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

/** The ids a job's row is indexed under: its money's ids, and its buyer dispute by its own id, so a delivery that names the dispute finds the job. */
function jobResources(row: JobRow): string[] {
	return [...stateResources(row), ...(row.providerDispute === undefined ? [] : [row.providerDispute.id])];
}

function stateResources(row: JobRow): string[] {
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
