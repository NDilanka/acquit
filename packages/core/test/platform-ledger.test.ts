import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAcquit, createAcquit, usd } from "../src/acquit.ts";
import type { Actor } from "../src/acquit.ts";
import { manifestOf } from "../src/fixtures.ts";
import { instant, hours, parseJobId } from "../src/ids.ts";
import type { AgentId, BidId, CaptureId, ClientId, CommitSha, Digest, MerchantId, OperatorId, OrderId, PayoutItemId, ReceiptId, TestId, Version, VisitorId } from "../src/ids.ts";
import { commercialSplit, reduceLedger } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { quote } from "../src/paypal.ts";
import { TERMS, applyJobCommand } from "../src/job.ts";
import type { JobRow, PassedAttempt, Receipt, RejectedAttempt } from "../src/job.ts";
import { platformJobLedger, platformTables } from "../src/platform.ts";
import type { OperatorRow } from "../src/operator.ts";
import { isTestTamper } from "../src/verifier.ts";
import { platformEscrowTotals } from "../src/platform.ts";
import type { VerifierRunId } from "../src/verifier.ts";
import { SqliteStore } from "../src/store.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";

const now = instant("2026-10-13T12:00:00Z");
const later = instant("2026-10-13T15:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: "v_a" as VisitorId };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
const platform: Actor = { role: "PLATFORM" };
const deploymentContract = { ids: exampleContract.ids, digest: "c0".repeat(32) as Digest };

function contract(deliveryEndsAt = instant("2026-10-27T12:00:00Z")) {
	return { budget: usd("400.00"), deliveryEndsAt, definitionOfDone: manifestOf(demoFixture(deploymentContract), "maya-client/invoice-app"), terms: TERMS };
}
function acceptedBid(price = usd("360.00")) {
	return { id: "bid_test-1" as BidId, operator: "devon-ops" as OperatorId, handle: "devon-ops", kind: "INDEPENDENT" as const,
		payee: merchant, agent: "ts-bugfixer" as AgentId, runner: "claude-code" as const, price, eta: hours(48),
		pitch: "test", placedAt: now, respondBy: now, status: "ACCEPTED" as const };
}
function insert(store: SqliteStore, row: JobRow): void {
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), null);
}

/** A paid job in visitor A's world: the book is held 420.00, released 360.00, fee 60.00. */
function paidRow(tenant: VisitorId | null, id = "job_ledger_paid"): JobRow {
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at: now });
	if ("kind" in held) throw new Error("law break");
	const paid = reduceLedger(held, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at: later });
	if ("kind" in paid) throw new Error("law break");
	return { id: parseJobId(id), version: 1 as Version, client: "maya-client" as ClientId, tenant, title: "paid job",
		contract: contract(), openedAt: now, bids: [acceptedBid()], state: { status: "PAID",
			payee: { bidId: "bid_test-1" as BidId, operator: "devon-ops" as OperatorId, payee: merchant, agent: "ts-bugfixer" as AgentId, price: usd("360.00"), eta: hours(48) },
			book: paid, receipt: { id: `rcpt_${id}` as ReceiptId, jobId: parseJobId(id), operator: "devon-ops" as OperatorId,
				agent: "ts-bugfixer" as AgentId, pullRequest: 13, mergeCommit: "5cccb66515313caed72e4af329a62fc011139426" as CommitSha,
				frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, attemptsUsed: 2, paid: usd("360.00"), releasedAt: later } as Receipt,
			release: { payoutItemId: "payout-item-1" as PayoutItemId, captureId: "TESTCAPTURE" as CaptureId, paid: usd("360.00"), at: later },
			releaseAuthority: "CLIENT_APPROVAL", history: [], merge: { phase: "MERGED", at: later, sha: "d4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1" as CommitSha }, treasury: [] } };
}

/** A held job in visitor B's world whose first attempt was a test tamper the verifier rejected. */
function heldTamperRow(): JobRow {
	const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("378.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
		sellerNet: usd("318.00"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: usd("378.00"), at: now });
	if ("kind" in book) throw new Error("law break");
	return { id: parseJobId("job_ledger_held"), version: 1 as Version, client: "splitter-client" as ClientId, tenant: "v_b" as VisitorId,
		title: "held job", contract: contract(), openedAt: now, bids: [acceptedBid(usd("318.00"))],
		state: { status: "IN_PROGRESS", escrow: { payee: { bidId: "bid_test-1" as BidId, operator: "devon-ops" as OperatorId,
				payee: merchant, agent: "ts-bugfixer" as AgentId, price: usd("318.00"), eta: hours(48) },
			quote: quote(commercialSplit(usd("378.00")), model), capture, book, cutoffAt: instant("2026-11-03T12:00:00Z") },
			attempts: { phase: "READY", runsStarted: 1, failure: null, history: [{ ordinal: 1, verdict: { result: "REJECTED",
				runId: "run_held_1" as VerifierRunId, sourceCommit: "0042bbeb5d1e" as CommitSha,
				reasons: [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }], reasonsTruncated: 0, tallies: null, at: now } }] } } };
}

/** A refunded job in the deployment's own world: the hold went back to the client. */
function refundedRow(): JobRow {
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at: now });
	if ("kind" in held) throw new Error("law break");
	const refunded = reduceLedger(held, { kind: "Refund", refunded: usd("420.00"), at: later });
	if ("kind" in refunded) throw new Error("law break");
	return { id: parseJobId("job_ledger_refunded"), version: 1 as Version, client: "maya-client" as ClientId, tenant: null,
		title: "refunded job", contract: contract(), openedAt: now, bids: [], state: { status: "REFUNDED",
			payee: { bidId: "bid_test-1" as BidId, operator: "devon-ops" as OperatorId, payee: merchant, agent: "ts-bugfixer" as AgentId, price: usd("360.00"), eta: hours(48) },
			book: refunded, reason: "DELIVERY_DEADLINE", refund: { refundId: "REFUND1" as never, captureId: "TESTCAPTURE" as CaptureId,
				refunded: usd("420.00"), retainedProcessorFee: usd("15.15"), at: later }, history: [], treasury: [] } };
}

/**
 * A job whose checkout captured 421.00 against its 420.00 quote. The capture mismatches, so the job
 * enters REFUND_PENDING holding the captured money until the refund settles. Reached through the
 * transition table, so the state is the one the funding path leaves behind.
 */
function captureMismatchRow(): JobRow {
	const id = parseJobId("job_ledger_mismatch");
	const priced = quote(commercialSplit(usd("420.00")), model);
	const bidId = "bid_mismatch-1" as BidId;
	const orderId = "ORDER_MISMATCH" as OrderId;
	const lena: Actor = { role: "CLIENT", clientId: "lena-client" as ClientId, tenant: "v_c" as VisitorId };
	const system = { actor: { role: "SYSTEM", source: "PAYPAL" } as const, now: later, loaded: { kind: "NONE" } as const };
	const bidding: JobRow = { id, version: 1 as Version, client: "lena-client" as ClientId, tenant: "v_c" as VisitorId,
		title: "mismatch job", contract: contract(), openedAt: now, bids: [{ id: bidId, operator: "devon-ops" as OperatorId,
			handle: "devon-ops", kind: "INDEPENDENT", payee: merchant, agent: "ts-bugfixer" as AgentId, runner: "claude-code",
			price: priced.split.price, eta: hours(48), pitch: "test", placedAt: now, respondBy: later, status: "PENDING" }],
		state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } } };
	const accepted = applyJobCommand(bidding, { type: "AcceptBid", jobId: id, bidId },
		{ actor: lena, now, loaded: { kind: "ACCEPT_BID", quote: priced } });
	if (typeof accepted === "string") throw new Error(accepted);
	const ordered = applyJobCommand(accepted.next, { type: "OrderCreated", jobId: id, round: 1, orderId,
		approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER_MISMATCH" }, system);
	if (typeof ordered === "string") throw new Error(ordered);
	const approved = applyJobCommand(ordered.next, { type: "BuyerApproved", jobId: id, orderId }, system);
	if (typeof approved === "string") throw new Error(approved);
	const captured = applyJobCommand(approved.next, { type: "CaptureCompleted", jobId: id, capture: { orderId,
		captureId: "CAP_MISMATCH" as CaptureId, payee: merchant, disbursement: "DELAYED", gross: usd("421.00"),
		processorFee: usd("15.15"), platformFee: priced.platformFeeInstruction, sellerNet: usd("361.00"), capturedAt: later } }, system);
	if (typeof captured === "string") throw new Error(captured);
	const state = captured.next.state;
	if (state.status !== "OPEN" || state.phase.kind !== "FUNDING" || state.phase.checkout.phase !== "REFUND_PENDING") {
		throw new Error("the $421.00 capture did not mismatch its quote");
	}
	return captured.next;
}

async function serviceWith(rows: readonly JobRow[]) {
	const root = await mkdtemp(join(tmpdir(), "acquit-platform-test-"));
	const databaseUrl = join(root, "platform.db");
	const store = new SqliteStore(databaseUrl);
	for (const row of rows) insert(store, row);
	const service = createAcquit({ databaseUrl, fixtures: [demoFixture(deploymentContract)], clock: { now: () => now },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: merchant, feeModel: model },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	return { service, store, close: () => { closeAcquit(service); store.close(); void rm(root, { recursive: true, force: true }); } };
}

test("a test tamper is a rejected attempt that touched the frozen tests, not a failed run", () => {
	assert.equal(isTestTamper({ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }), true);
	assert.equal(isTestTamper({ kind: "PROTECTED_PATH_MODIFIED", path: "src/totals.ts" }), false);
	assert.equal(isTestTamper({ kind: "TEST_FRAMEWORK_IN_SOURCE", path: "src/totals.ts", symbol: "node:test" }), true);
	assert.equal(isTestTamper({ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:1" as TestId] }), false);
});

test("the platform ledger query returns every tenant's book to the platform role alone", async () => {
	const rows = [paidRow("v_a" as VisitorId), heldTamperRow(), refundedRow()];
	const built = await serviceWith(rows);
	try {
		const allowed = await built.service.query(platform, { type: "PlatformLedger" });
		assert.equal(allowed.kind, "PLATFORM_LEDGER");
		if (allowed.kind !== "PLATFORM_LEDGER") throw new Error("Expected the platform ledger");
		assert.deepEqual([...allowed.ledger.jobs.map(job => job.jobId)].sort(), ["job_ledger_held", "job_ledger_paid", "job_ledger_refunded"]);
		const paid = allowed.ledger.jobs.find(job => job.jobId === "job_ledger_paid");
		assert.ok(paid, "the paid job is in the ledger");
		assert.equal(paid.status, "PAID");
		assert.equal(paid.escrow, "RELEASED");
		assert.equal(paid.operator?.handle, "devon-ops");
		const storedPaid = paidRow(null);
		assert.ok(storedPaid.state.status === "PAID");
		assert.deepEqual(paid.lines, storedPaid.state.book);
		assert.equal(paid.paidCents, 42000);
		assert.deepEqual(paid.fee, { cents: 6000, processor: 1515, acquit: 4485 });
		assert.deepEqual(paid.payout, { paid: 36000, payoutItemId: "payout-item-1", captureId: "TESTCAPTURE", releasedAt: later, authority: "CLIENT_APPROVAL" });
		assert.deepEqual(paid.receipt, { id: "rcpt_job_ledger_paid", paid: 36000, releasedAt: later });
		const held = allowed.ledger.jobs.find(job => job.jobId === "job_ledger_held");
		assert.ok(held, "the held job is in the ledger");
		assert.equal(held.escrow, "HELD");
		assert.equal(held.tenant, "v_b");
		assert.deepEqual(held.attempts, [{ ordinal: 1, result: "REJECTED", at: now, tamper: true,
			reasons: ["PR modifies frozen test file tests/totals.test.ts"] }]);
		for (const actor of [maya, devon]) {
			const denied = await built.service.query(actor, { type: "PlatformLedger" });
			assert.equal(denied.kind, "DENIED");
		}
	} finally { built.close(); }
});

test("the platform ledger names the capture a held escrow was funded with", async () => {
	const rows = [paidRow("v_a" as VisitorId), heldTamperRow(), refundedRow()];
	const built = await serviceWith(rows);
	try {
		const allowed = await built.service.query(platform, { type: "PlatformLedger" });
		if (allowed.kind !== "PLATFORM_LEDGER") throw new Error("Expected the platform ledger");
		const held = allowed.ledger.jobs.find(job => job.jobId === "job_ledger_held");
		assert.ok(held, "the held job is in the ledger");
		// The capture's own facts, so a ledger agent can ask PayPal whether it agrees: the order and
		// capture ids, the payee the capture was taken on behalf of, and the gross it held.
		assert.deepEqual(held.capture, { orderId: "TESTORDER", captureId: "TESTCAPTURE", payee: merchant, gross: 37800 });
		const paid = allowed.ledger.jobs.find(job => job.jobId === "job_ledger_paid");
		assert.equal(paid?.capture ?? null, null, "a released job names its payout, not a held capture");
		const refunded = allowed.ledger.jobs.find(job => job.jobId === "job_ledger_refunded");
		assert.equal(refunded?.capture ?? null, null, "a refunded job names its refund, not a held capture");
	} finally { built.close(); }
});

test("the ledger's totals are the ledger's own arithmetic: holds on escrowed jobs, every release, refund, and fee", async () => {
	const rows = [paidRow("v_a" as VisitorId), paidRow("v_b" as VisitorId, "job_ledger_paid_b"), heldTamperRow(), refundedRow()];
	const built = await serviceWith(rows);
	try {
		const allowed = await built.service.query(platform, { type: "PlatformLedger" });
		if (allowed.kind !== "PLATFORM_LEDGER") throw new Error("Expected the platform ledger");
		assert.deepEqual(platformEscrowTotals(allowed.ledger.jobs), { held: 37800, released: 72000, refunded: 42000, fees: 12000 });
	} finally { built.close(); }
});

test("the platform ledger conserves: payout plus fee equals paid over the released jobs", async () => {
	const rows = [paidRow("v_a" as VisitorId), paidRow("v_b" as VisitorId, "job_ledger_paid_b"), heldTamperRow(), refundedRow()];
	const built = await serviceWith(rows);
	try {
		const allowed = await built.service.query(platform, { type: "PlatformLedger" });
		if (allowed.kind !== "PLATFORM_LEDGER") throw new Error("Expected the platform ledger");
		const released = allowed.ledger.jobs.filter(job => job.escrow === "RELEASED");
		assert.equal(released.length, 2);
		for (const job of released) {
			assert.ok(job.payout && job.fee && job.paidCents !== null, "a released job names its payout, fee, and paid");
			assert.equal(job.payout.paid + job.fee.cents, job.paidCents);
		}
	} finally { built.close(); }
});

/** A verified job that got there on its second attempt: the first touched the frozen tests. */
function verifiedRetryRow(): JobRow {
	const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
		sellerNet: usd("360.00"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at: now });
	if ("kind" in book) throw new Error("law break");
	const rejected: RejectedAttempt = { ordinal: 1, verdict: { result: "REJECTED", runId: "run_retry_1" as VerifierRunId,
		sourceCommit: "0042bbeb5d1e" as CommitSha, reasons: [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }],
		reasonsTruncated: 0, tallies: null, at: now } };
	const passed: PassedAttempt = { ordinal: 2, verdict: { result: "VERIFIED", runId: "run_retry_2" as VerifierRunId,
		sourceCommit: "8f3a302b4d6e" as CommitSha, mergeCommit: "5cccb66515313caed72e4af329a62fc011139426" as CommitSha,
		pullRequest: 13, frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 },
		reportDigest: "d0".repeat(32) as Digest, at: now } };
	return { id: parseJobId("job_ledger_retry"), version: 3 as Version, client: "maya-client" as ClientId, tenant: null,
		title: "retry job", contract: contract(), openedAt: now, bids: [acceptedBid()],
		state: { status: "VERIFIED",
			escrow: { payee: { bidId: "bid_test-1" as BidId, operator: "devon-ops" as OperatorId, payee: merchant,
					agent: "ts-bugfixer" as AgentId, price: usd("360.00"), eta: hours(48) },
				quote: quote(commercialSplit(usd("420.00")), model), capture, book, cutoffAt: instant("2026-11-03T12:00:00Z") },
			history: [rejected, passed], passed,
			review: { phase: "RELEASE_PENDING", release: { authority: "CLIENT_APPROVAL", selectedAt: now } }, runsStarted: 2 } };
}

test("a paid job keeps the attempts it settled with: an honest retry's tamper stays on the ledger", () => {
	const row = verifiedRetryRow();
	const before = platformJobLedger(row).attempts;
	assert.deepEqual(before, [
		{ ordinal: 1, result: "REJECTED", at: now, tamper: true, reasons: ["PR modifies frozen test file tests/totals.test.ts"] },
		{ ordinal: 2, result: "VERIFIED", at: now, tamper: false, reasons: [] },
	]);
	const settled = applyJobCommand(row, { type: "ReleaseSettled", jobId: row.id,
		release: { captureId: "TESTCAPTURE" as CaptureId, payoutItemId: "payout-item-1" as PayoutItemId, paid: usd("360.00"), at: later } },
		{ actor: { role: "SYSTEM", source: "PAYPAL" } as const, now: later, loaded: { kind: "NONE" } as const });
	if (typeof settled === "string") throw new Error(`release refused: ${settled}`);
	assert.equal(settled.next.state.status, "PAID");
	assert.ok("history" in settled.next.state, "the paid row keeps its verdict history");
	assert.equal(settled.next.state.history.length, 2);
	assert.deepEqual(platformJobLedger(settled.next).attempts, before);
});

/** The fixture with its capture renamed, so each job's capture id is its own, as PayPal issues them. */
function withCapture(row: JobRow, captureId: string): JobRow {
	return JSON.parse(JSON.stringify(row).replaceAll('"TESTCAPTURE"', `"${captureId}"`)) as JobRow;
}

const devonReady: OperatorRow = { id: "devon-ops" as OperatorId, version: 1 as Version, handle: "devon-ops", kind: "INDEPENDENT",
	payouts: { kind: "READY", merchant, connectedAt: now } };

test("the platform tables project the stored book into seven joined tables with literal values", () => {
	const rows = [withCapture(paidRow("v_a" as VisitorId), "CAP_PAID"), withCapture(heldTamperRow(), "CAP_HELD"),
		withCapture(refundedRow(), "CAP_REFUNDED")];
	const tables = platformTables(rows, [devonReady], new Map([["devon-ops" as OperatorId, 1]]));
	assert.deepEqual(tables.jobs, [
		{ jobId: "job_ledger_paid", title: "paid job", tenant: "v_a", clientId: "maya-client", status: "PAID", escrow: "RELEASED",
			stage: "5 Paid", operatorId: "devon-ops", operatorHandle: "devon-ops", openedAt: "2026-10-13T12:00:00.000Z",
			releasedAt: "2026-10-13T15:00:00.000Z", bidCount: 1, attemptCount: 1, grossCents: 42000, heldCents: 0,
			releasedCents: 36000, feeCents: 6000, refundedCents: 0 },
		{ jobId: "job_ledger_held", title: "held job", tenant: "v_b", clientId: "splitter-client", status: "IN_PROGRESS", escrow: "HELD",
			stage: "3 Funded", operatorId: "devon-ops", operatorHandle: "devon-ops", openedAt: "2026-10-13T12:00:00.000Z",
			releasedAt: null, bidCount: 1, attemptCount: 1, grossCents: 37800, heldCents: 37800, releasedCents: 0, feeCents: 0,
			refundedCents: 0 },
		{ jobId: "job_ledger_refunded", title: "refunded job", tenant: null, clientId: "maya-client", status: "REFUNDED", escrow: "REFUNDED",
			stage: "6 Refunded", operatorId: "devon-ops", operatorHandle: "devon-ops", openedAt: "2026-10-13T12:00:00.000Z",
			releasedAt: null, bidCount: 0, attemptCount: 0, grossCents: 42000, heldCents: 0, releasedCents: 0, feeCents: 0,
			refundedCents: 42000 },
	]);
	assert.deepEqual(tables.bids, [
		{ bidId: "bid_test-1", jobId: "job_ledger_paid", operatorId: "devon-ops", handle: "devon-ops", kind: "INDEPENDENT",
			status: "ACCEPTED", priceCents: 36000, etaHours: 48, placedAt: "2026-10-13T12:00:00.000Z" },
		{ bidId: "bid_test-1", jobId: "job_ledger_held", operatorId: "devon-ops", handle: "devon-ops", kind: "INDEPENDENT",
			status: "ACCEPTED", priceCents: 31800, etaHours: 48, placedAt: "2026-10-13T12:00:00.000Z" },
	]);
	assert.deepEqual(tables.verdicts, [
		{ verdictId: "job_ledger_paid#2", jobId: "job_ledger_paid", ordinal: 2, result: "VERIFIED", verified: 1, tamper: 0, reasonCount: 0,
			at: "2026-10-13T15:00:00.000Z" },
		{ verdictId: "job_ledger_held#1", jobId: "job_ledger_held", ordinal: 1, result: "REJECTED", verified: 0, tamper: 1, reasonCount: 1,
			at: "2026-10-13T12:00:00.000Z" },
	]);
	assert.deepEqual(tables.ledger_entries, [
		{ entryId: "job_ledger_paid#0", jobId: "job_ledger_paid", kind: "HELD", cents: 42000, at: "2026-10-13T12:00:00.000Z",
			captureId: "CAP_PAID", operatorId: "devon-ops", processorCents: null, acquitCents: null },
		{ entryId: "job_ledger_paid#1", jobId: "job_ledger_paid", kind: "RELEASED", cents: 36000, at: "2026-10-13T15:00:00.000Z",
			captureId: "CAP_PAID", operatorId: "devon-ops", processorCents: null, acquitCents: null },
		{ entryId: "job_ledger_paid#2", jobId: "job_ledger_paid", kind: "FEE", cents: 6000, at: "2026-10-13T15:00:00.000Z",
			captureId: "CAP_PAID", operatorId: "devon-ops", processorCents: 1515, acquitCents: 4485 },
		{ entryId: "job_ledger_held#0", jobId: "job_ledger_held", kind: "HELD", cents: 37800, at: "2026-10-13T12:00:00.000Z",
			captureId: "CAP_HELD", operatorId: "devon-ops", processorCents: null, acquitCents: null },
		{ entryId: "job_ledger_refunded#0", jobId: "job_ledger_refunded", kind: "HELD", cents: 42000, at: "2026-10-13T12:00:00.000Z",
			captureId: "CAP_REFUNDED", operatorId: "devon-ops", processorCents: null, acquitCents: null },
		{ entryId: "job_ledger_refunded#1", jobId: "job_ledger_refunded", kind: "REFUND", cents: 42000, at: "2026-10-13T15:00:00.000Z",
			captureId: "CAP_REFUNDED", operatorId: "devon-ops", processorCents: null, acquitCents: null },
	]);
	assert.deepEqual(tables.paypal_events, [
		{ captureId: "CAP_PAID", jobId: "job_ledger_paid", orderId: null, merchant: "sandbox-seller", state: "RELEASED", grossCents: 42000,
			refundId: null, refundedCents: null, payoutItemId: "payout-item-1", releasedAt: "2026-10-13T15:00:00.000Z" },
		{ captureId: "CAP_HELD", jobId: "job_ledger_held", orderId: "TESTORDER", merchant: "sandbox-seller", state: "CAPTURED",
			grossCents: 37800, refundId: null, refundedCents: null, payoutItemId: null, releasedAt: null },
		{ captureId: "CAP_REFUNDED", jobId: "job_ledger_refunded", orderId: null, merchant: "sandbox-seller", state: "REFUNDED",
			grossCents: 42000, refundId: "REFUND1", refundedCents: 42000, payoutItemId: null, releasedAt: null },
	]);
	assert.deepEqual(tables.operators, [
		{ operatorId: "devon-ops", handle: "devon-ops", kind: "INDEPENDENT", payoutReadiness: "READY", paidReceipts: 1 },
	]);
	assert.deepEqual(tables.clients, [{ clientId: "maya-client", jobCount: 2 }, { clientId: "splitter-client", jobCount: 1 }]);
});

test("a capture that mismatches its quote is held escrow until its refund settles", () => {
	const row = captureMismatchRow();
	const view = platformJobLedger(row);
	assert.equal(view.escrow, "HELD");
	assert.deepEqual(view.lines, [{ kind: "HELD", cents: 42100, at: later }]);
	assert.equal(view.paidCents, 42100);
	assert.equal(view.capture?.captureId, "CAP_MISMATCH");
	assert.equal(view.capture?.gross, 42100);
	assert.deepEqual(platformEscrowTotals([view]), { held: 42100, released: 0, refunded: 0, fees: 0 });
	const tables = platformTables([row], [devonReady], new Map());
	assert.deepEqual(tables.jobs.map(job => ({ escrow: job.escrow, grossCents: job.grossCents, heldCents: job.heldCents })),
		[{ escrow: "HELD", grossCents: 42100, heldCents: 42100 }]);
	assert.deepEqual(tables.paypal_events.map(event => ({ state: event.state, grossCents: event.grossCents })),
		[{ state: "CAPTURED", grossCents: 42100 }]);
	assert.deepEqual(tables.ledger_entries.map(entry => ({ kind: entry.kind, cents: entry.cents })), [{ kind: "HELD", cents: 42100 }]);
});

test("the table totals conserve: held, released, refunded, and fees add up to the funded gross", () => {
	const rows = [withCapture(paidRow("v_a" as VisitorId), "CAP_PAID"), withCapture(heldTamperRow(), "CAP_HELD"),
		withCapture(refundedRow(), "CAP_REFUNDED"), captureMismatchRow()];
	const { jobs } = platformTables(rows, [devonReady], new Map());
	const sum = (pick: (job: (typeof jobs)[number]) => number) => jobs.reduce((total, job) => total + pick(job), 0);
	const funded = sum(job => job.grossCents);
	const held = sum(job => job.heldCents);
	const released = sum(job => job.releasedCents);
	const refunded = sum(job => job.refundedCents);
	const fees = sum(job => job.feeCents);
	assert.deepEqual({ funded, held, released, refunded, fees }, { funded: 163900, held: 79900, released: 36000, refunded: 42000, fees: 6000 });
	assert.equal(held + released + refunded + fees, funded);
	assert.deepEqual(platformEscrowTotals(rows.map(platformJobLedger)), { held, released, refunded, fees });
});

test("the platform tables query returns the seven tables to the platform role alone", async () => {
	const rows = [paidRow("v_a" as VisitorId), heldTamperRow(), refundedRow()];
	const built = await serviceWith(rows);
	try {
		const allowed = await built.service.query(platform, { type: "PlatformTables" });
		if (allowed.kind !== "PLATFORM_TABLES") throw new Error("Expected the platform tables");
		assert.deepEqual(Object.keys(allowed.tables).sort(),
			["bids", "clients", "jobs", "ledger_entries", "operators", "paypal_events", "verdicts"]);
		assert.deepEqual(allowed.tables.jobs.map(job => job.jobId).sort(), ["job_ledger_held", "job_ledger_paid", "job_ledger_refunded"]);
		for (const actor of [maya, devon]) {
			assert.deepEqual(await built.service.query(actor, { type: "PlatformTables" }), { kind: "DENIED", reason: "NOT_OWNER" });
		}
	} finally { built.close(); }
});
