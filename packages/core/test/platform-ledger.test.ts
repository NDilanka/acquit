import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAcquit, createAcquit, usd } from "../src/acquit.ts";
import type { Actor } from "../src/acquit.ts";
import { manifestOf } from "../src/fixtures.ts";
import { instant, hours, parseJobId } from "../src/ids.ts";
import type { AgentId, BidId, CaptureId, ClientId, CommitSha, Digest, MerchantId, OrderId, PayoutItemId, Version, VisitorId } from "../src/ids.ts";
import { commercialSplit, quote, reduceLedger } from "../src/ledger.ts";
import type { Bps } from "../src/ledger.ts";
import { TERMS } from "../src/job.ts";
import type { JobRow } from "../src/job.ts";
import { isTestTamper } from "../src/verifier.ts";
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
function paidRow(tenant: VisitorId | null): JobRow {
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at: now });
	if ("kind" in held) throw new Error("law break");
	const paid = reduceLedger(held, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at: later });
	if ("kind" in paid) throw new Error("law break");
	return { id: parseJobId("job_ledger_paid"), version: 1 as Version, client: "maya-client" as ClientId, tenant, title: "paid job",
		contract: contract(), openedAt: now, bids: [acceptedBid()], state: { status: "PAID",
			payee: { bidId: "bid_test-1" as BidId, operator: "devon-ops" as OperatorId, payee: merchant, agent: "ts-bugfixer" as AgentId, price: usd("360.00"), eta: hours(48) },
			book: paid, receipt: { id: "rcpt_ledger-1", jobId: parseJobId("job_ledger_paid"), operator: "devon-ops" as OperatorId,
				agent: "ts-bugfixer" as AgentId, pullRequest: 13, mergeCommit: "5cccb66515313caed72e4af329a62fc011139426" as CommitSha,
				frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, attemptsUsed: 2, paid: usd("360.00"), releasedAt: later },
			release: { payoutItemId: "payout-item-1" as PayoutItemId, captureId: "TESTCAPTURE" as CaptureId, paid: usd("360.00"), at: later },
			releaseAuthority: "CLIENT", merge: { phase: "MERGED", at: later, sha: "d4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1" as CommitSha }, treasury: [] } };
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
				reasons: [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }], reasonsTruncated: 0, at: now } }] } } };
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
	assert.equal(isTestTamper({ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:1"] }), false);
});

test("the platform ledger query returns every tenant's book to the platform role alone", async () => {
	const rows = [paidRow("v_a" as VisitorId), heldTamperRow(), refundedRow()];
	const built = await serviceWith(rows);
	try {
		const allowed = await built.service.query(platform, { type: "PlatformLedger" });
		assert.equal(allowed.kind, "PLATFORM_LEDGER");
		if (allowed.kind !== "PLATFORM_LEDGER") throw new Error("Expected the platform ledger");
		assert.deepEqual(allowed.ledger.jobs.map(job => job.jobId), ["job_ledger_paid", "job_ledger_held", "job_ledger_refunded"]);
		const paid = allowed.ledger.jobs.find(job => job.jobId === "job_ledger_paid");
		assert.ok(paid, "the paid job is in the ledger");
		assert.equal(paid.status, "PAID");
		assert.equal(paid.escrow, "RELEASED");
		assert.equal(paid.operator?.handle, "devon-ops");
		assert.deepEqual(paid.lines, paidRow(null).state.status === "PAID" ? paidRow(null).state.book : []);
		assert.equal(paid.paidCents, 42000);
		assert.deepEqual(paid.fee, { cents: 6000, processor: 1515, acquit: 4485 });
		assert.deepEqual(paid.payout, { paid: 36000, payoutItemId: "payout-item-1", captureId: "TESTCAPTURE", releasedAt: later, authority: "CLIENT" });
		assert.deepEqual(paid.receipt, { id: "rcpt_ledger-1", paid: 36000, releasedAt: later });
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

test("the platform ledger conserves: payout plus fee equals paid over the released jobs", async () => {
	const rows = [paidRow("v_a" as VisitorId), paidRow("v_b" as VisitorId), heldTamperRow(), refundedRow()];
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
