// The public receipt's read, against literal values. A PAID job answers with its receipt; every other
// row answers null, and nothing private (a merchant id, the scoping citation, a failed test id) reaches the body.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrivateCaseReader } from "../../../packages/core/src/hidden-seal.ts";
import type { ScopeCandidate } from "../../../packages/core/src/scoping.ts";
import { SqliteStore } from "../../../packages/core/src/store.ts";
import { publicReceipt } from "../src/receipts.ts";

const PAID_JOB = "job_publicpaid";
const RECEIPT = "rcpt_publicpaid";
const MERGE = "a".repeat(40);
const SALT = "5a".repeat(32);
// digestOfHiddenCases(revealedCases, SALT) from packages/core/src/hidden-seal.ts, computed once.
const DIGEST = "1764db63ab48ebab5142bfc8275d72ba1b09672157ed55433394445c025bf5a7";
const SEALED_AT = "2026-10-11T23:00:00Z";
const RELEASED_AT = "2026-10-12T00:00:00Z";

const candidates: readonly ScopeCandidate[] = [
	{ id: "per-job-1", target: { module: "src/invoice.ts", export: "totalOf" }, args: [[]], expected: 0, citation: "CITATION-PROSE-NEVER-PUBLIC" },
	{ id: "per-job-2", target: { module: "src/invoice.ts", export: "totalOf" }, args: [[-2, 5]], expected: 3, citation: "CITATION-PROSE-NEVER-PUBLIC" },
];

const revealedCases = [
	{ id: "per-job-1", target: { module: "src/invoice.ts", export: "totalOf" }, args: [[]], expected: 0 },
	{ id: "per-job-2", target: { module: "src/invoice.ts", export: "totalOf" }, args: [[-2, 5]], expected: 3 },
];

const reader: PrivateCaseReader = () => ({ candidates, salt: SALT });

function paidJob(status: string, receiptId: string) {
	return {
		title: "Fix the invoice total",
		contract: { definitionOfDone: { issue: { repository: "maya-client/invoice-app", number: 42, title: "Fix the invoice total" } } },
		bids: [{ id: "bid_devon", handle: "devon-ops", kind: "INDEPENDENT" }],
		state: {
			status,
			payee: { bidId: "bid_devon", operator: "devon-ops", payee: "MERCHANT-PRIVATE-7" },
			book: [
				{ kind: "HELD", cents: 42_000, at: RELEASED_AT },
				{ kind: "RELEASED", cents: 36_000, at: RELEASED_AT },
				{ kind: "FEE", cents: 6_000, processor: 1_515, acquit: 4_485, at: RELEASED_AT },
			],
			receipt: { id: receiptId, jobId: PAID_JOB, operator: "op_internal_devon", agent: "ts-bugfixer", pullRequest: 7, mergeCommit: MERGE,
				frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, attemptsUsed: 2, paid: 36_000, releasedAt: RELEASED_AT },
			release: { payoutItemId: "PAYOUT-ITEM-7", captureId: "CAPTURE-7", paid: 36_000, at: RELEASED_AT },
			releaseAuthority: "CLIENT_APPROVAL",
			history: [
				{ ordinal: 1, verdict: { result: "REJECTED", runId: "run_1", sourceCommit: "b".repeat(40), reasonsTruncated: 0,
					at: "2026-10-11T20:00:00Z", reasons: [{ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden-private-test-id"] }] } },
				{ ordinal: 2, verdict: { result: "VERIFIED", runId: "run_2", sourceCommit: "c".repeat(40), mergeCommit: MERGE, pullRequest: 7,
					frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "d".repeat(64), at: RELEASED_AT } },
			],
			merge: { phase: "MERGED", at: RELEASED_AT, sha: MERGE },
			treasury: [{ kind: "PAYOUT_FEE_PAID", jobId: PAID_JOB, batchId: "PAYOUT-BATCH-9", paid: 0, fee: 25, at: RELEASED_AT }],
		},
	};
}

function seed(store: SqliteStore, sealed: boolean): void {
	store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(PAID_JOB, JSON.stringify(paidJob("PAID", RECEIPT)));
	const manifest = { issue: { repository: "maya-client/invoice-app", number: 42, title: "Fix the invoice total" },
		...(sealed ? { sealedHiddenCases: { digest: DIGEST } } : {}) };
	store.db.prepare("INSERT INTO job_manifests VALUES (?, ?)").run(PAID_JOB, JSON.stringify(manifest));
	store.db.prepare("INSERT INTO receipts VALUES (?, ?, 'devon-ops', 'JOB', 1, ?)").run(RECEIPT, PAID_JOB, RELEASED_AT);
	if (sealed) store.db.prepare("INSERT INTO job_scoping VALUES (?, 'APPROVED', NULL, '[]', ?, NULL, NULL, ?)").run(PAID_JOB, DIGEST, SEALED_AT);
}

test("a PAID job's receipt reads as the literal public body, with its revealed cases and PayPal ids", () => {
	const store = new SqliteStore(":memory:");
	try {
		seed(store, true);
		const body = publicReceipt(store.db, RECEIPT, reader);
		assert.deepEqual(body, { receipt: {
			id: RECEIPT,
			title: "Fix the invoice total",
			issue: 42,
			source: "JOB",
			scripted: false,
			releasedAt: RELEASED_AT,
			releaseAuthority: "CLIENT_APPROVAL",
			operator: { handle: "devon-ops", label: "INDEPENDENT", agent: "ts-bugfixer" },
			money: { heldCents: 42_000, paidCents: 36_000, feeCents: 6_000, processorFeeCents: 1_515, acquitFeeCents: 4_485 },
			verdict: {
				attemptsUsed: 2,
				attemptsAllowed: 3,
				frozen: { expected: 48, passed: 48 },
				hidden: { expected: 6, passed: 6 },
				pullRequest: 7,
				mergeCommit: MERGE,
				history: [
					{ ordinal: 1, result: "REJECTED", at: "2026-10-11T20:00:00Z", frozen: null, hidden: null, reasons: ["TESTS_FAILED:hidden"] },
					{ ordinal: 2, result: "VERIFIED", at: RELEASED_AT, frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reasons: [] },
				],
			},
			paypal: { captureId: "CAPTURE-7", payoutItemId: "PAYOUT-ITEM-7", feeBatchId: "PAYOUT-BATCH-9" },
			hiddenCases: { committedDigest: DIGEST, committedAt: SEALED_AT, revealed: { salt: SALT, cases: revealedCases } },
			scoreCard: { cheatsCaught: 11, cheatsTotal: 11, honestPassed: 20, honestTotal: 20, gaps: [] },
		} });
	} finally { store.close(); }
});

test("only a PAID job answers to its receipt id: an unknown id, a refunded or open row, and the job id all read null", () => {
	const store = new SqliteStore(":memory:");
	try {
		seed(store, true);
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_refunded", JSON.stringify(paidJob("REFUNDED", "rcpt_refunded")));
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_openone", JSON.stringify({ title: "Open", state: { status: "OPEN" } }));
		assert.equal(publicReceipt(store.db, "rcpt_nobody", reader), null, "an unknown receipt id");
		assert.equal(publicReceipt(store.db, "rcpt_refunded", reader), null, "a refunded job's receipt id");
		assert.equal(publicReceipt(store.db, PAID_JOB, reader), null, "the job id is not a receipt id");
		assert.equal(publicReceipt(store.db, "job_openone", reader), null, "an open job has no receipt id");
	} finally { store.close(); }
});

test("a job a judge scenario started reads as scripted, and a job nobody scripted does not", () => {
	const store = new SqliteStore(":memory:");
	try {
		seed(store, true);
		assert.equal(publicReceipt(store.db, RECEIPT, reader)?.receipt.scripted, false);
		store.db.prepare("INSERT INTO scenario_runs (id, requester_id, visitor_id, job_id, name, state, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run("run_1", "visitor_1", "visitor_1", PAID_JOB, "verified-and-paid", "DONE", "{}");
		assert.equal(publicReceipt(store.db, RECEIPT, reader)?.receipt.scripted, true);
	} finally { store.close(); }
});

test("a scripted job stays scripted after its run's snapshot is evicted, because the cleanup journal keeps the run", () => {
	const store = new SqliteStore(":memory:");
	try {
		seed(store, true);
		store.db.prepare("INSERT INTO scenario_runs (id, requester_id, visitor_id, job_id, name, state, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run("run_1", "visitor_1", "visitor_1", PAID_JOB, "verified-and-paid", "DONE", "{}");
		store.db.prepare("INSERT INTO scenario_cleanup (run_id, visitor_id, job_id, finished_at) VALUES (?, ?, ?, ?)")
			.run("run_1", "visitor_1", PAID_JOB, RELEASED_AT);
		store.db.prepare("DELETE FROM scenario_runs WHERE id = ?").run("run_1");
		assert.equal(publicReceipt(store.db, RECEIPT, reader)?.receipt.scripted, true);
	} finally { store.close(); }
});

test("a PAID job whose contract carried no sealed set serves no hidden-case section", () => {
	const store = new SqliteStore(":memory:");
	try {
		seed(store, false);
		const body = publicReceipt(store.db, RECEIPT, reader);
		assert.equal(body?.receipt.hiddenCases, null);
	} finally { store.close(); }
});

test("a private set that does not open the seal, or cannot be read, reveals nothing and keeps the commitment", () => {
	const store = new SqliteStore(":memory:");
	try {
		seed(store, true);
		const tampered: PrivateCaseReader = () => ({ candidates: candidates.map((c, i) => i === 1 ? { ...c, expected: 4 } : c), salt: SALT });
		const tamperedBody = publicReceipt(store.db, RECEIPT, tampered);
		assert.deepEqual(tamperedBody?.receipt.hiddenCases, { committedDigest: DIGEST, committedAt: SEALED_AT, revealed: null });
		const unreadable = publicReceipt(store.db, RECEIPT, () => null);
		assert.deepEqual(unreadable?.receipt.hiddenCases, { committedDigest: DIGEST, committedAt: SEALED_AT, revealed: null });
	} finally { store.close(); }
});

test("nothing private reaches the body: no merchant id, no citation, no failed test id, no verdict internals", () => {
	const store = new SqliteStore(":memory:");
	try {
		seed(store, true);
		const text = JSON.stringify(publicReceipt(store.db, RECEIPT, reader));
		assert.equal(text.includes("MERCHANT-PRIVATE-7"), false);
		assert.equal(text.includes("CITATION-PROSE-NEVER-PUBLIC"), false);
		assert.equal(text.includes("hidden-private-test-id"), false);
		assert.equal(text.includes("op_internal_devon"), false);
		assert.equal(text.includes("run_1"), false);
		assert.equal(text.includes("reportDigest"), false);
	} finally { store.close(); }
});
