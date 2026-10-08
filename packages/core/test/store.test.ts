// Opening a lane's database. The pre-envelope migration writes, so it runs under the lock guard: a
// second process writing the same file would otherwise fail the API's start with "database is locked".
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectJob } from "../src/job.ts";
import type { JobRow } from "../src/job.ts";
import { openDatabase, SqliteStore } from "../src/store.ts";
import type { OperationKey, OutboxRow, RecordedRequest } from "../src/effects.ts";
import type { AgentId, ClientId, Digest, Instant, JobId, OperatorId, RequestKey, Version } from "../src/ids.ts";

/** A second process that holds the file's write lock for 600 ms, on a table that predates the envelope. */
const LOCK_HOLDER = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO webhook_events (id, body) VALUES (?, ?)").run("legacy", "raw");
process.stdout.write("locked");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 600);`;

test("a lane opens through the pre-envelope migration while another writer holds the lock", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-store-"));
	const file = join(dir, "lane.db");
	const legacy = new DatabaseSync(file);
	legacy.exec("CREATE TABLE webhook_events (id TEXT PRIMARY KEY, body TEXT)");
	legacy.close();
	const holder = spawn(process.execPath, ["-e", LOCK_HOLDER, file], { stdio: ["ignore", "pipe", "inherit"] });
	try {
		await new Promise<void>((resolve, reject) => {
			holder.stdout.once("data", () => resolve());
			holder.once("exit", code => reject(new Error(`The lock holder exited with code ${code} before locking`)));
		});
		const db = openDatabase(file);
		try {
			assert.equal(Number(db.prepare("PRAGMA busy_timeout").get()?.timeout), 5000);
			const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('webhook_events')").all().map(row => String(row.name)));
			assert.equal(columns.has("body"), false);
			assert.equal(columns.has("outcome"), true);
		} finally { db.close(); }
	} finally {
		holder.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A raw PAID row as a lane stored it. `releaseAuthority` is whatever its bytes carry, or absent. */
function storedPaidRow(id: string, releaseAuthority?: unknown) {
	const at = "2026-10-06T12:00:00.000Z";
	return { id, version: 3, client: "maya-client", title: "stored paid row", openedAt: at,
		contract: { budget: 40000, deliveryEndsAt: "2026-10-13T12:00:00.000Z" },
		bids: [],
		state: { status: "PAID",
			payee: { bidId: "bid_store", operator: "devon-ops", payee: "MERCHANT", agent: "ts-bugfixer", price: 40000, eta: 48 },
			book: [],
			release: { payoutItemId: "ITEM", captureId: "CAPTURE", paid: 36000, at },
			merge: { phase: "PENDING" },
			receipt: { id: `rcpt_${id}`, jobId: id, operator: "devon-ops", agent: "ts-bugfixer", pullRequest: 13,
				mergeCommit: "a".repeat(40), frozen: { expected: 1, passed: 1 }, hidden: { expected: 1, passed: 1 },
				attemptsUsed: 1, paid: 36000, releasedAt: at },
			...(releaseAuthority === undefined ? {} : { releaseAuthority }) } };
}

/** A raw REFUNDED row as a lane stored it. `reason` is whatever its bytes carry, or absent. */
function storedRefundedRow(id: string, reason?: unknown) {
	const at = "2026-10-06T12:00:00.000Z";
	return { id, version: 4, client: "maya-client", title: "stored refunded row", openedAt: at,
		contract: { budget: 40000, deliveryEndsAt: "2026-10-13T12:00:00.000Z" },
		bids: [],
		state: { status: "REFUNDED",
			payee: { bidId: "bid_store", operator: "devon-ops", payee: "MERCHANT", agent: "ts-bugfixer", price: 40000, eta: 48 },
			book: [],
			...(reason === undefined ? {} : { reason }),
			refund: { refundId: "REFUND1", captureId: "CAPTURE", refunded: 42000, retainedProcessorFee: 1515, at },
			history: [],
			treasury: [] } };
}

/** A raw IN_PROGRESS row holding a refund intent. `reason` is whatever the intent's bytes carry, or absent. */
function storedRefundPendingRow(id: string, reason?: unknown) {
	const at = "2026-10-06T12:00:00.000Z";
	return { id, version: 5, client: "maya-client", title: "stored refund pending row", openedAt: at,
		contract: { budget: 40000, deliveryEndsAt: "2026-10-13T12:00:00.000Z" },
		bids: [],
		state: { status: "IN_PROGRESS",
			escrow: { payee: { bidId: "bid_store", operator: "devon-ops", payee: "MERCHANT", agent: "ts-bugfixer", price: 40000, eta: 48 },
				quote: { split: { held: 42000, fee: 6000, operatorNet: 36000, predictedProcessorFee: 1515 }, platformFeeInstruction: 4485, version: "test" },
				capture: { orderId: "ORDER", captureId: "CAPTURE", payee: "MERCHANT", disbursement: "DELAYED", gross: 42000, processorFee: 1515,
					platformFee: 4485, sellerNet: 36000, capturedAt: at },
				book: [], cutoffAt: "2026-10-27T12:00:00.000Z" },
			attempts: { phase: "REFUND_PENDING", history: [],
				refund: { ...(reason === undefined ? {} : { reason }), selectedAt: at } } } };
}

/** A raw VERIFIED row whose review holds a refund intent. `reason` is whatever the intent's bytes carry, or absent. */
function storedVerifiedRefundPendingRow(id: string, reason?: unknown) {
	const at = "2026-10-06T12:00:00.000Z";
	return { id, version: 6, client: "maya-client", title: "stored verified refund pending row", openedAt: at,
		contract: { budget: 40000, deliveryEndsAt: "2026-10-13T12:00:00.000Z" },
		bids: [],
		state: { status: "VERIFIED",
			escrow: { payee: { bidId: "bid_store", operator: "devon-ops", payee: "MERCHANT", agent: "ts-bugfixer", price: 40000, eta: 48 },
				quote: { split: { held: 42000, fee: 6000, operatorNet: 36000, predictedProcessorFee: 1515 }, platformFeeInstruction: 4485, version: "test" },
				capture: { orderId: "ORDER", captureId: "CAPTURE", payee: "MERCHANT", disbursement: "DELAYED", gross: 42000, processorFee: 1515,
					platformFee: 4485, sellerNet: 36000, capturedAt: at },
				book: [], cutoffAt: "2026-10-27T12:00:00.000Z" },
			history: [], passed: { verdict: { pullRequest: null, mergeCommit: null } },
			review: { phase: "REFUND_PENDING", refund: { ...(reason === undefined ? {} : { reason }), selectedAt: at } } } };
}

/** A raw OPEN FUNDING row whose checkout holds a refund intent. `reason` is whatever the intent's bytes carry, or absent. */
function storedOpenCheckoutRefundRow(id: string, reason?: unknown) {
	const at = "2026-10-06T12:00:00.000Z";
	return { id, version: 7, client: "maya-client", title: "stored open checkout refund row", openedAt: at,
		contract: { budget: 40000, deliveryEndsAt: "2026-10-13T12:00:00.000Z" },
		bids: [],
		state: { status: "OPEN",
			phase: { kind: "FUNDING", round: 1,
				chosen: { bidId: "bid_store", operator: "devon-ops", payee: "MERCHANT", agent: "ts-bugfixer", price: 40000, eta: 48 },
				quote: { split: { held: 42000, fee: 6000, operatorNet: 36000, predictedProcessorFee: 1515 }, platformFeeInstruction: 4485, version: "test" },
				checkout: { phase: "REFUND_PENDING",
					escrow: { payee: { bidId: "bid_store", operator: "devon-ops", payee: "MERCHANT", agent: "ts-bugfixer", price: 40000, eta: 48 },
						quote: { split: { held: 42000, fee: 6000, operatorNet: 36000, predictedProcessorFee: 1515 }, platformFeeInstruction: 4485, version: "test" },
						capture: { orderId: "ORDER", captureId: "CAPTURE", payee: "MERCHANT", disbursement: "DELAYED", gross: 42000, processorFee: 1515,
							platformFee: 4485, sellerNet: 36000, capturedAt: at },
						book: [], cutoffAt: "2026-10-27T12:00:00.000Z" },
					refund: { ...(reason === undefined ? {} : { reason }), selectedAt: at } } } } };
}

test("a PAID row's release authority reads as one of the five, or null", async () => {
	const store = new SqliteStore(":memory:");
	const maya = { role: "CLIENT" as const, clientId: "maya-client" as ClientId, tenant: null };
	try {
		for (const [id, authority] of [["job_paid_missing", undefined], ["job_paid_unknown", "NOT_AN_AUTHORITY"], ["job_paid_authority", "REVIEW_SILENCE"]] as const) {
			const row = storedPaidRow(id, authority);
			store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(id, row.version, JSON.stringify(row), null);
		}
		// The bytes a lane stored before F4 named no authority at all.
		const missing = await store.readJob("job_paid_missing" as JobId);
		if (missing?.state.status !== "PAID") throw new Error("Missing the stored paid row");
		assert.equal(missing.state.releaseAuthority, null);
		assert.equal(projectJob(missing, maya, new Map()).releaseAuthority, null);
		// An authority outside the domain's five is not a stored fact: it reads as null too.
		const unknown = await store.readJob("job_paid_unknown" as JobId);
		if (unknown?.state.status !== "PAID") throw new Error("Missing the stored paid row");
		assert.equal(unknown.state.releaseAuthority, null);
		assert.equal(projectJob(unknown, maya, new Map()).releaseAuthority, null);
		// A known authority stays what the row recorded.
		const known = await store.readJob("job_paid_authority" as JobId);
		if (known?.state.status !== "PAID") throw new Error("Missing the stored paid row");
		assert.equal(known.state.releaseAuthority, "REVIEW_SILENCE");
		assert.equal(projectJob(known, maya, new Map()).releaseAuthority, "REVIEW_SILENCE");
	} finally { store.close(); }
});

test("a refund reason reads as one of the five, or null", async () => {
	const store = new SqliteStore(":memory:");
	const maya = { role: "CLIENT" as const, clientId: "maya-client" as ClientId, tenant: null };
	try {
		for (const [id, reason] of [["job_refunded_missing", undefined], ["job_refunded_unknown", "NOT_A_REASON"], ["job_refunded_reason", "DELIVERY_DEADLINE"]] as const) {
			const row = storedRefundedRow(id, reason);
			store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(id, row.version, JSON.stringify(row), null);
		}
		for (const [id, reason] of [["job_pending_missing", undefined], ["job_pending_unknown", "NOT_A_REASON"], ["job_pending_reason", "ARBITER_REFUND"]] as const) {
			const row = storedRefundPendingRow(id, reason);
			store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(id, row.version, JSON.stringify(row), null);
		}
		// The bytes a lane stored before the reason was recorded name none at all: the settled row and
		// the pending intent both read as the typed null, and the view serves null with them.
		const missing = await store.readJob("job_refunded_missing" as JobId);
		if (missing?.state.status !== "REFUNDED") throw new Error("Missing the stored refunded row");
		assert.equal(missing.state.reason, null);
		assert.equal(projectJob(missing, maya, new Map()).refundReason, null);
		const pendingMissing = await store.readJob("job_pending_missing" as JobId);
		if (pendingMissing?.state.status !== "IN_PROGRESS" || pendingMissing.state.attempts.phase !== "REFUND_PENDING") throw new Error("Missing the stored pending row");
		assert.equal(pendingMissing.state.attempts.refund.reason, null);
		assert.equal(projectJob(pendingMissing, maya, new Map()).refundReason, null);
		// A reason outside the domain's five is not a stored fact either: it reads as null too.
		const unknown = await store.readJob("job_refunded_unknown" as JobId);
		if (unknown?.state.status !== "REFUNDED") throw new Error("Missing the stored refunded row");
		assert.equal(unknown.state.reason, null);
		assert.equal(projectJob(unknown, maya, new Map()).refundReason, null);
		const pendingUnknown = await store.readJob("job_pending_unknown" as JobId);
		if (pendingUnknown?.state.status !== "IN_PROGRESS" || pendingUnknown.state.attempts.phase !== "REFUND_PENDING") throw new Error("Missing the stored pending row");
		assert.equal(pendingUnknown.state.attempts.refund.reason, null);
		assert.equal(projectJob(pendingUnknown, maya, new Map()).refundReason, null);
		// A known reason stays what the row recorded, pending and settled.
		const known = await store.readJob("job_refunded_reason" as JobId);
		if (known?.state.status !== "REFUNDED") throw new Error("Missing the stored refunded row");
		assert.equal(known.state.reason, "DELIVERY_DEADLINE");
		assert.equal(projectJob(known, maya, new Map()).refundReason, "DELIVERY_DEADLINE");
		const pendingKnown = await store.readJob("job_pending_reason" as JobId);
		if (pendingKnown?.state.status !== "IN_PROGRESS" || pendingKnown.state.attempts.phase !== "REFUND_PENDING") throw new Error("Missing the stored pending row");
		assert.equal(pendingKnown.state.attempts.refund.reason, "ARBITER_REFUND");
		assert.equal(projectJob(pendingKnown, maya, new Map()).refundReason, "ARBITER_REFUND");
	} finally { store.close(); }
});

test("a refund reason reads as null on a verified review intent and an open checkout intent", async () => {
	const store = new SqliteStore(":memory:");
	const maya = { role: "CLIENT" as const, clientId: "maya-client" as ClientId, tenant: null };
	try {
		for (const [id, reason] of [["job_review_missing", undefined], ["job_review_unknown", "NOT_A_REASON"], ["job_review_reason", "ARBITER_REFUND"]] as const) {
			const row = storedVerifiedRefundPendingRow(id, reason);
			store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(id, row.version, JSON.stringify(row), null);
		}
		for (const [id, reason] of [["job_checkout_missing", undefined], ["job_checkout_unknown", "NOT_A_REASON"], ["job_checkout_reason", "CAPTURE_MISMATCH"]] as const) {
			const row = storedOpenCheckoutRefundRow(id, reason);
			store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(id, row.version, JSON.stringify(row), null);
		}
		// The bytes a lane stored before the reason was recorded name none at all on the review's intent.
		const reviewMissing = await store.readJob("job_review_missing" as JobId);
		if (reviewMissing?.state.status !== "VERIFIED" || reviewMissing.state.review.phase !== "REFUND_PENDING") throw new Error("Missing the stored review intent");
		assert.equal(reviewMissing.state.review.refund.reason, null);
		assert.equal(projectJob(reviewMissing, maya, new Map()).refundReason, null);
		// A reason outside the domain's five is not a stored fact either: it reads as null too.
		const reviewUnknown = await store.readJob("job_review_unknown" as JobId);
		if (reviewUnknown?.state.status !== "VERIFIED" || reviewUnknown.state.review.phase !== "REFUND_PENDING") throw new Error("Missing the stored review intent");
		assert.equal(reviewUnknown.state.review.refund.reason, null);
		assert.equal(projectJob(reviewUnknown, maya, new Map()).refundReason, null);
		// A known reason stays what the row recorded.
		const reviewKnown = await store.readJob("job_review_reason" as JobId);
		if (reviewKnown?.state.status !== "VERIFIED" || reviewKnown.state.review.phase !== "REFUND_PENDING") throw new Error("Missing the stored review intent");
		assert.equal(reviewKnown.state.review.refund.reason, "ARBITER_REFUND");
		assert.equal(projectJob(reviewKnown, maya, new Map()).refundReason, "ARBITER_REFUND");
		// The same boundary holds on the checkout's own refund intent while an OPEN job is FUNDING.
		const checkoutMissing = await store.readJob("job_checkout_missing" as JobId);
		if (checkoutMissing?.state.status !== "OPEN" || checkoutMissing.state.phase.kind !== "FUNDING" || checkoutMissing.state.phase.checkout.phase !== "REFUND_PENDING") throw new Error("Missing the stored checkout intent");
		assert.equal(checkoutMissing.state.phase.checkout.refund.reason, null);
		assert.equal(projectJob(checkoutMissing, maya, new Map()).refundReason, null);
		const checkoutUnknown = await store.readJob("job_checkout_unknown" as JobId);
		if (checkoutUnknown?.state.status !== "OPEN" || checkoutUnknown.state.phase.kind !== "FUNDING" || checkoutUnknown.state.phase.checkout.phase !== "REFUND_PENDING") throw new Error("Missing the stored checkout intent");
		assert.equal(checkoutUnknown.state.phase.checkout.refund.reason, null);
		assert.equal(projectJob(checkoutUnknown, maya, new Map()).refundReason, null);
		const checkoutKnown = await store.readJob("job_checkout_reason" as JobId);
		if (checkoutKnown?.state.status !== "OPEN" || checkoutKnown.state.phase.kind !== "FUNDING" || checkoutKnown.state.phase.checkout.phase !== "REFUND_PENDING") throw new Error("Missing the stored checkout intent");
		assert.equal(checkoutKnown.state.phase.checkout.refund.reason, "CAPTURE_MISMATCH");
		assert.equal(projectJob(checkoutKnown, maya, new Map()).refundReason, "CAPTURE_MISMATCH");
	} finally { store.close(); }
});

test("a PAID commit whose payee has no operators row commits, counts nothing, and says so", async () => {
	const store = new SqliteStore(":memory:");
	const payee = "devon-ops" as OperatorId;
	const row = storedPaidRow("job_paid_no_operator", "REVIEW_SILENCE");
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), null);
	const lines: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	try {
		// A payee whose operators row is missing must not make PAID unreachable: the transition commits,
		// the count stays put, and one line names the operator for the log.
		const committed = await store.commit({ job: { expectedVersion: row.version as Version, row: row as unknown as JobRow, wakeAt: null },
			operator: null, credits: [], paidReceipt: payee, outbox: [], settlement: null, request: null, delivery: null });
		assert.deepEqual(committed, { kind: "COMMITTED" });
		assert.equal((await store.readJob("job_paid_no_operator" as JobId))?.state.status, "PAID");
		assert.equal((await store.receiptCounts()).get(payee), undefined, "no operators row means no receipt to count");
		assert.equal(lines.length, 1);
		assert.match(lines[0], /devon-ops/);
		assert.equal(lines[0].includes("\n"), false, "the line stays one line");
	} finally { console.warn = warn; store.close(); }
});

test("a commit whose paidReceipt names another operator throws and rolls the whole write back", async () => {
	const store = new SqliteStore(":memory:");
	const payee = "devon-ops" as OperatorId;
	const operator = { id: payee, handle: "devon-ops", kind: "INDEPENDENT", version: 0,
		payouts: { kind: "READY", merchant: "sandbox-seller", connectedAt: "2026-10-06T12:00:00.000Z" } };
	store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(operator.id, operator.version, JSON.stringify(operator), 0);
	const row = storedPaidRow("job_paid_wrong_payee", "REVIEW_SILENCE");
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), null);
	const moved = { ...row, version: row.version + 1, title: "the title the refused write would have stored" };
	const outboxKey = "op_wrong_payee" as OperationKey;
	const outbox: OutboxRow = { key: outboxKey,
		effect: { kind: "ALERT", jobId: row.id as JobId, reason: "DISPUTE_SLA_MISSED" },
		payloadDigest: "d".repeat(64) as Digest, state: { kind: "READY", runAt: "2026-10-06T12:00:00.000Z" as Instant } };
	const request: RecordedRequest = { actor: "CLIENT:maya-client", key: "req_wrong_payee" as RequestKey,
		payloadDigest: "d".repeat(64) as Digest, result: { kind: "AGENT", agent: "ts-bugfixer" as AgentId } };
	try {
		// An id that is not the PAID job's payee would count nobody while the job settles, and the receipt
		// is lost forever: the write refuses whole, so the catch rolls back the UPDATE already run.
		await assert.rejects(store.commit({ job: { expectedVersion: row.version as Version, row: moved as unknown as JobRow, wakeAt: null },
			operator: null, credits: [], paidReceipt: "other-ops" as OperatorId, outbox: [outbox],
			settlement: null, request, delivery: "evt_wrong_payee" }), /paid receipt/);
		const stored = await store.readJob("job_paid_wrong_payee" as JobId);
		assert.equal(stored?.version, row.version, "the refused write rolls the job row back");
		assert.equal(stored?.title, row.title);
		assert.equal((await store.receiptCounts()).get(payee), 0, "the PAID job's payee counts nothing");
		assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE key = ?").get(outboxKey)?.n), 0);
		assert.equal(await store.readRequest("CLIENT:maya-client", "req_wrong_payee" as RequestKey), null);
		assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM deliveries").get()?.n), 0);
	} finally { store.close(); }
});

test("a VERSION_CONFLICT commit with a paid receipt set counts no receipt", async () => {
	const store = new SqliteStore(":memory:");
	const payee = "devon-ops" as OperatorId;
	const operator = { id: payee, handle: "devon-ops", kind: "INDEPENDENT", version: 0,
		payouts: { kind: "READY", merchant: "sandbox-seller", connectedAt: "2026-10-06T12:00:00.000Z" } };
	store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(operator.id, operator.version, JSON.stringify(operator), 0);
	const row = storedPaidRow("job_paid_conflict", "REVIEW_SILENCE");
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), null);
	// The stored row moved on since this commit read it, so the job CAS is lost and the whole write,
	// the receipt count included, rolls back.
	store.db.prepare("UPDATE jobs SET version = ? WHERE id = ?").run(row.version + 1, row.id);
	const committed = await store.commit({ job: { expectedVersion: row.version as Version, row: row as unknown as JobRow, wakeAt: null },
		operator: null, credits: [], paidReceipt: payee, outbox: [], settlement: null, request: null, delivery: null });
	assert.deepEqual(committed, { kind: "VERSION_CONFLICT" });
	assert.equal((await store.receiptCounts()).get(payee), 0, "the lost CAS rolls the receipt count back with the row");
});
