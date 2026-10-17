import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import { confirmFunding, executeCommand, ingestPayPalWebhook, ingestVerifierCallback, operationKey } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { applyJobCommand, decideRelease } from "../src/job.ts";
import type { JobRow, TrustedActor } from "../src/job.ts";
import { hours, instant, parseRequestKey } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, JobId, MerchantId, OperatorId, OrderId, PayoutBatchId, PayoutItemId, RefundId, StaffId, Version } from "../src/ids.ts";
import { checkLaws, usd } from "../src/ledger.ts";
import { parseWebhookEnvelope } from "../src/paypal.ts";
import type { Bps, PayPal, RefundEvidence, RemoteOutcome, ReimbursementEvidence, ReleaseEvidence, ResourceRead } from "../src/paypal.ts";
import type { HiddenContract } from "../src/fixtures.ts";
import { SqliteStore } from "../src/store.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import type { Verdict, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";

// The payout webhook and the outbox's own RELEASE settle one release in either order. These cases pin both orders.

const now = instant("2026-10-06T12:00:00Z");
const later = instant("2026-10-06T12:30:00Z");
const thirteen = instant("2026-10-06T13:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
const paypalSystem: TrustedActor = { role: "SYSTEM", source: "PAYPAL" };
const requestKey = () => parseRequestKey(randomUUID());
const deploymentContract: HiddenContract = { ids: exampleContract.ids, digest: "c0".repeat(32) as Digest };
const sourceCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const mergeCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const payoutItemId = "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=" as PayoutItemId;
const otherItemId = "OTHERPAYOUTITEM" as PayoutItemId;
const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
	disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
	sellerNet: usd("360.00"), capturedAt: now };
const releaseEvidence: ReleaseEvidence = { payoutItemId, captureId: capture.captureId, paid: usd("360.00"), at: later };
const openCommand: UserCommand = { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
	budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z") };
const acceptance = (runId: VerifierRunId): Verdict => ({ result: "VERIFIED", runId, sourceCommit, mergeCommit, pullRequest: 13,
	frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "b".repeat(64) as Digest, at: now });
const payoutBodyFor = (item: PayoutItemId, event = "WH-PAYOUT-1") => JSON.stringify({ id: event, event_type: "PAYMENT.REFERENCED-PAYOUT-ITEM.COMPLETED",
	resource_type: "referenced_payouts_items", resource: { id: item } });
const payoutBody = payoutBodyFor(payoutItemId);
const releaseKeyOf = (jobId: JobId) => operationKey({ kind: "RELEASE", jobId, captureId: capture.captureId, payee: merchant });
const arbiter: Actor = { role: "ARBITER", staffId: "staff-arbiter" as StaffId };
const payoutBatch = "PAYOUTBATCH1" as PayoutBatchId;
const refundOf = (overrides: Partial<RefundEvidence> = {}): RefundEvidence => ({ refundId: "REFUND1" as RefundId,
	captureId: capture.captureId, refunded: usd("420.00"), retainedProcessorFee: usd("15.15"), at: later, ...overrides });
const reimbursementOf = (overrides: Partial<ReimbursementEvidence> = {}): ReimbursementEvidence => ({ batchId: payoutBatch,
	itemId: "REIMBURSEMENT-ITEM-1" as PayoutItemId, merchant, paid: usd("15.15"), fee: usd("0.25"), at: later, ...overrides });
const refundBodyFor = (id: string, event: string) => JSON.stringify({ id: event, event_type: "PAYMENT.CAPTURE.REFUNDED",
	resource_type: "refund", resource: { id } });
const captureBodyFor = (event: string) => JSON.stringify({ id: event, event_type: "PAYMENT.CAPTURE.COMPLETED",
	resource_type: "capture", resource: { id: capture.captureId } });
const payoutItemBodyFor = (item: string, event: string) => JSON.stringify({ id: event, event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
	resource_type: "payouts_item", resource: { id: item } });

function emptyAccount(operator = "devon-ops" as OperatorId): CreditAccount {
	return { operator, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
}
function grant(operator?: OperatorId): CreditAccount {
	const account = reduceCredits(emptyAccount(operator), { kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
	if (typeof account === "string") throw new Error(account);
	return account;
}
function jobOf(outcome: CommandOutcome) {
	assert.notEqual(outcome.kind, "DENIED");
	if (outcome.kind === "DENIED" || outcome.result.kind !== "JOB" && outcome.result.kind !== "BID") throw new Error("Expected job result");
	return outcome.result.job;
}
function nextOf(result: ReturnType<typeof applyJobCommand>): JobRow {
	if (typeof result === "string") throw new Error(result);
	return result.next;
}
const webhook = (ports: Ports, body: string) => ingestPayPalWebhook(ports, new Request("http://localhost:4310/paypal/webhook", { method: "POST", body }));
const verifierCallback = (ports: Ports) => ingestVerifierCallback(ports, new Request("http://api.test/api/verifier/callback", { method: "POST", body: "verdict" }));
const outboxState = (store: SqliteStore, key: string): unknown => JSON.parse(String(store.db.prepare("SELECT state FROM outbox WHERE key = ?").get(key)?.state));
const outcomeOf = (store: SqliteStore, id: string): string => String(store.db.prepare("SELECT outcome FROM webhook_events WHERE id = ?").get(id)?.outcome);
function alertReasons(store: SqliteStore): string[] {
	return store.db.prepare("SELECT json FROM outbox").all()
		.map(row => (JSON.parse(String(row.json)) as { effect: { kind: string; reason?: string } }).effect)
		.filter(effect => effect.kind === "ALERT").map(effect => String(effect.reason));
}

/**
 * One store, one fake PayPal, and one fake judge. `payout.beforeAnswer` runs inside the RELEASE dispatch,
 * before PayPal answers, so a test can land the payout webhook between the dispatch and the outbox's commit.
 */
function harness() {
	const store = new SqliteStore(":memory:");
	for (const [handle, kind, agentName, receipts] of [
		["devon-ops", "INDEPENDENT", "ts-bugfixer", 0], ["house-tsfix", "HOUSE", "house-ts-fixer", 41],
	] as const) {
		const row: OperatorRow = { id: handle as OperatorId, handle, kind, version: 0 as Version,
			payouts: { kind: "READY", merchant, connectedAt: now } };
		const agent: Agent = { id: agentName as AgentId, owner: row.id, name: agentName,
			runner: "claude-code", promptDigest: "digest" as Agent["promptDigest"], tools: [] };
		const credits = kind === "HOUSE" ? emptyAccount(row.id) : grant(row.id);
		store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), receipts);
		store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(row.id, credits.version, JSON.stringify(credits));
	}
	let approved = false;
	const starts: VerifierRunRequest[] = [];
	const reads = new Map<string, ResourceRead>([
		[capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture } }],
		[payoutItemId, { kind: "SETTLED", observation: { kind: "RELEASE_COMPLETED", release: releaseEvidence } }],
	]);
	const payout = { sent: 0, beforeAnswer: async (): Promise<void> => {} };
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const paypal: PayPal = {
		dispatch: async (call): Promise<RemoteOutcome> => {
			if (call.kind === "CREATE_ORDER") return { kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId: capture.orderId, approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TESTORDER" } };
			if (call.kind === "CAPTURE") return { kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture } };
			if (call.kind !== "RELEASE") throw new Error(`Unexpected ${call.kind}`);
			payout.sent++;
			await payout.beforeAnswer();
			return { kind: "CONFIRMED", observation: { kind: "RELEASE_COMPLETED", release: releaseEvidence } };
		},
		reconcile: async (): Promise<RemoteOutcome> => ({ kind: "NOT_FOUND" }),
		getOrder: async (): Promise<RemoteOutcome> => approved
			? { kind: "CONFIRMED", observation: { kind: "ORDER_APPROVED", orderId: capture.orderId } }
			: { kind: "PENDING", checkAt: now },
		parseWebhook: async raw => parseWebhookEnvelope(raw),
		verifyWebhookDelivery: async () => ({ kind: "VERIFIED" }),
		readResource: async resource => reads.get(resource.id) ?? { kind: "UNKNOWN" },
	};
	const ports: Ports = { store, feeModel: model, fixtures: [demoFixture(deploymentContract)], clock: { now: () => now },
		verifier: { start: async request => { starts.push(request); },
			parseCallback: async () => starts.length === 0 ? null : { jobId: starts[0].jobId, ordinal: 1 as const,
				report: { kind: "VERDICT", verdict: acceptance(starts[0].runId) } } },
		github: { merge: unimplemented }, alerts: { raise: async () => {} }, paypal };
	return { store, ports, reads, payout, approve: () => { approved = true; } };
}
type Harness = ReturnType<typeof harness>;

/** Accepted, funded, and judged: the job is VERIFIED and waiting for the client's review. */
async function verifiedJob(h: Harness): Promise<JobId> {
	const { store, ports } = h;
	const jobId = jobOf(await executeCommand(ports, maya, requestKey(), openCommand)).id;
	const bid = await executeCommand(ports, devon, requestKey(), { type: "PlaceBid", jobId,
		price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
	if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
	await executeCommand(ports, maya, requestKey(), { type: "AcceptBid", jobId, bidId: bid.result.bid });
	h.approve();
	assert.equal(await confirmFunding(ports, maya, jobId), true);
	assert.equal((await executeCommand(ports, devon, requestKey(), { type: "Submit", jobId, sourceCommit })).kind, "COMMITTED");
	await verifierCallback(ports);
	assert.equal((await store.readJob(jobId))?.state.status, "VERIFIED");
	return jobId;
}

/** The client's approval. Its RELEASE dispatch runs inline, before the approval returns. */
const approving = (h: Harness, jobId: JobId) => executeCommand(h.ports, maya, requestKey(), { type: "Approve", jobId, mergeCommit });

/** The client disputes the judged work and the arbiter refunds it: the row now waits on PayPal's refund. */
async function refundPendingJob(h: Harness): Promise<JobId> {
	const jobId = await verifiedJob(h);
	assert.equal((await executeCommand(h.ports, maya, requestKey(), { type: "Dispute", jobId, mergeCommit,
		reason: "The export path regressed." })).kind, "COMMITTED");
	assert.equal((await executeCommand(h.ports, arbiter, requestKey(), { type: "ResolveDispute", jobId, verdict: "REFUND",
		note: "The contract was not met." })).kind, "COMMITTED");
	return jobId;
}

/** The PAID row a settled release leaves: one RELEASED line, one receipt, one payout sent. */
async function assertPaidOnce(h: Harness, jobId: JobId): Promise<void> {
	const paid = await h.store.readJob(jobId);
	if (paid?.state.status !== "PAID") throw new Error(`Expected PAID, got ${paid?.state.status}`);
	assert.deepEqual(paid.state.book, [{ kind: "HELD", cents: 42000, at: now }, { kind: "RELEASED", cents: 36000, at: later },
		{ kind: "FEE", cents: 6000, processor: 1515, acquit: 4485, at: later }]);
	assert.equal(checkLaws(paid.state.book), "PAID");
	assert.equal(Number(h.store.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE job_id = ?").get(jobId)?.n), 1);
	assert.equal(Number(h.store.db.prepare("SELECT paid_receipts AS n FROM operators WHERE id = ?").get("devon-ops")?.n), 1);
	assert.equal(h.payout.sent, 1);
}

test("the release decision: the selected release applies, the payout a paid row holds is a no-op, anything else is a mismatch", async () => {
	const h = harness();
	try {
		const jobId = await verifiedJob(h);
		const verified = await h.store.readJob(jobId);
		if (verified?.state.status !== "VERIFIED") throw new Error("Not verified");
		const pending = nextOf(applyJobCommand(verified, { type: "Approve", jobId, mergeCommit }, { actor: maya, now, loaded: { kind: "NONE" } }));
		const paid = nextOf(applyJobCommand(pending, { type: "ReleaseSettled", jobId, release: releaseEvidence }, { actor: paypalSystem, now, loaded: { kind: "NONE" } }));
		assert.equal(decideRelease(verified, releaseEvidence), "MISMATCH");
		assert.equal(decideRelease(pending, releaseEvidence), "APPLY");
		assert.equal(decideRelease(pending, { ...releaseEvidence, captureId: "OTHERCAPTURE" as CaptureId }), "MISMATCH");
		assert.equal(decideRelease(paid, releaseEvidence), "ALREADY_SETTLED");
		assert.equal(decideRelease(paid, { ...releaseEvidence, at: thirteen }), "ALREADY_SETTLED");
		assert.equal(decideRelease(paid, { ...releaseEvidence, paid: usd("359.00") }), "MISMATCH");
		assert.equal(decideRelease(paid, { ...releaseEvidence, payoutItemId: otherItemId }), "MISMATCH");
		assert.equal(decideRelease(paid, { ...releaseEvidence, captureId: "OTHERCAPTURE" as CaptureId }), "MISMATCH");
	} finally { h.store.close(); }
});

test("the payout webhook lands before the outbox's own settlement: one payout, no alert", async () => {
	const h = harness();
	const { store, ports } = h;
	try {
		const jobId = await verifiedJob(h);
		const answers: number[] = [];
		h.payout.beforeAnswer = async () => { answers.push((await webhook(ports, payoutBody)).status); };
		assert.equal((await approving(h, jobId)).kind, "COMMITTED");
		assert.deepEqual(answers, [202]);
		assert.equal(outcomeOf(store, "WH-PAYOUT-1"), "verified, applied");
		assert.deepEqual(outboxState(store, releaseKeyOf(jobId)), { kind: "CONFIRMED", at: "2026-10-06T12:00:00.000Z" });
		assert.deepEqual(alertReasons(store), []);
		await assertPaidOnce(h, jobId);
	} finally { store.close(); }
});

test("the outbox settles first and the payout webhook is a recorded no-op, not a mismatch", async () => {
	const h = harness();
	const { store, ports } = h;
	try {
		const jobId = await verifiedJob(h);
		assert.equal((await approving(h, jobId)).kind, "COMMITTED");
		assert.equal((await store.readJob(jobId))?.state.status, "PAID");
		assert.deepEqual(outboxState(store, releaseKeyOf(jobId)), { kind: "CONFIRMED", at: "2026-10-06T12:00:00.000Z" });
		assert.equal((await webhook(ports, payoutBody)).status, 202);
		assert.equal(outcomeOf(store, "WH-PAYOUT-1"), "verified, no-op, job already PAID");
		assert.deepEqual(alertReasons(store), []);
		await assertPaidOnce(h, jobId);
	} finally { store.close(); }
});

test("a different payout after a matching payout webhook on a paid job is refused, leaves the job alone, and raises one alert", async () => {
	for (const wrong of [
		{ why: "a different amount", item: payoutItemId, release: { ...releaseEvidence, paid: usd("359.00") } },
		{ why: "a different payout item", item: otherItemId, release: { ...releaseEvidence, payoutItemId: otherItemId } },
	]) {
		const h = harness();
		const { store, ports } = h;
		try {
			const jobId = await verifiedJob(h);
			assert.equal((await approving(h, jobId)).kind, "COMMITTED", wrong.why);
			assert.equal((await webhook(ports, payoutBody)).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-PAYOUT-1"), "verified, no-op, job already PAID", wrong.why);
			const paid = await store.readJob(jobId);
			h.reads.set(wrong.item, { kind: "SETTLED", observation: { kind: "RELEASE_COMPLETED", release: wrong.release } });
			assert.equal((await webhook(ports, payoutBodyFor(wrong.item, "WH-PAYOUT-2"))).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-PAYOUT-2"), "verified, refused, the job did not take this settlement", wrong.why);
			assert.deepEqual(await store.readJob(jobId), paid, wrong.why);
			assert.deepEqual(alertReasons(store), ["SETTLEMENT_MISMATCH"], wrong.why);
			await assertPaidOnce(h, jobId);
		} finally { store.close(); }
	}
});

test("a refund that differs in money from the one a job already refunded is refused with one alert, and its replays are no-ops", async () => {
	for (const wrong of [
		{ why: "a different refunded amount", id: "REFUND-SHORT", refund: refundOf({ refundId: "REFUND-SHORT" as RefundId, refunded: usd("419.00") }) },
		{ why: "a different retained fee", id: "REFUND-FEE", refund: refundOf({ refundId: "REFUND-FEE" as RefundId, retainedProcessorFee: usd("15.16") }) },
		{ why: "another full refund id", id: "REFUND-OTHER", refund: refundOf({ refundId: "REFUND-OTHER" as RefundId }) },
	]) {
		const h = harness();
		const { store, ports, reads } = h;
		try {
			const jobId = await refundPendingJob(h);
			reads.set("REFUND1", { kind: "SETTLED", observation: { kind: "REFUND_COMPLETED", refund: refundOf() } });
			assert.equal((await webhook(ports, refundBodyFor("REFUND1", "WH-REFUND-1"))).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-REFUND-1"), "verified, applied", wrong.why);
			const refunded = await store.readJob(jobId);
			assert.equal(refunded?.state.status, "REFUNDED", wrong.why);
			reads.set(wrong.id, { kind: "SETTLED", observation: { kind: "REFUND_COMPLETED", refund: wrong.refund } });
			assert.equal((await webhook(ports, refundBodyFor(wrong.id, "WH-REFUND-2"))).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-REFUND-2"), "verified, refused, the job did not take this settlement", wrong.why);
			assert.deepEqual(await store.readJob(jobId), refunded, wrong.why);
			assert.deepEqual(alertReasons(store), ["SETTLEMENT_MISMATCH"], wrong.why);
			// The same refund read again at a later time is the same delivery: it finds the key the refusal recorded.
			reads.set(wrong.id, { kind: "SETTLED", observation: { kind: "REFUND_COMPLETED", refund: { ...wrong.refund, at: thirteen } } });
			assert.equal((await webhook(ports, refundBodyFor(wrong.id, "WH-REFUND-3"))).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-REFUND-3"), "verified, no-op, job already REFUNDED", wrong.why);
			assert.deepEqual(alertReasons(store), ["SETTLEMENT_MISMATCH"], wrong.why);
			// An identical replay of the refund the job holds is a no-op too.
			assert.equal((await webhook(ports, refundBodyFor("REFUND1", "WH-REFUND-4"))).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-REFUND-4"), "verified, no-op, job already REFUNDED", wrong.why);
			assert.deepEqual(await store.readJob(jobId), refunded, wrong.why);
			assert.deepEqual(alertReasons(store), ["SETTLEMENT_MISMATCH"], wrong.why);
		} finally { store.close(); }
	}
});

test("a refund read back from its capture without a refund id is the same refund, not a mismatch", async () => {
	const h = harness();
	const { store, ports, reads } = h;
	try {
		const jobId = await refundPendingJob(h);
		reads.set("REFUND1", { kind: "SETTLED", observation: { kind: "REFUND_COMPLETED", refund: refundOf() } });
		assert.equal((await webhook(ports, refundBodyFor("REFUND1", "WH-REFUND-1"))).status, 202);
		const refunded = await store.readJob(jobId);
		// The capture's own event reads the same full refund back from the capture, which names no refund id.
		reads.set(capture.captureId, { kind: "SETTLED", observation: { kind: "REFUND_COMPLETED", refund: refundOf({ refundId: null }) } });
		assert.equal((await webhook(ports, captureBodyFor("WH-CAPTURE-1"))).status, 202);
		assert.equal(outcomeOf(store, "WH-CAPTURE-1"), "verified, no-op, job already REFUNDED");
		assert.deepEqual(await store.readJob(jobId), refunded);
		assert.deepEqual(alertReasons(store), []);
	} finally { store.close(); }
});

test("a payout that differs in money from the one a refunded job recorded is refused with one alert, and its replays are no-ops", async () => {
	for (const wrong of [
		{ why: "a different paid amount", item: "PAYOUT-ITEM-SHORT", reimbursement: reimbursementOf({ paid: usd("10.00") }) },
		{ why: "a different fee", item: "PAYOUT-ITEM-FEE", reimbursement: reimbursementOf({ fee: usd("0.26") }) },
	]) {
		const h = harness();
		const { store, ports, reads } = h;
		try {
			const jobId = await refundPendingJob(h);
			reads.set("REFUND1", { kind: "SETTLED", observation: { kind: "REFUND_COMPLETED", refund: refundOf() } });
			assert.equal((await webhook(ports, refundBodyFor("REFUND1", "WH-REFUND-1"))).status, 202, wrong.why);
			// The outbox's payout indexes its batch on settlement, and this harness does not run that dispatch.
			store.db.prepare("INSERT OR IGNORE INTO resources VALUES (?, ?)").run(payoutBatch, jobId);
			reads.set("REIMBURSEMENT-ITEM-1", { kind: "SETTLED", observation: { kind: "REIMBURSEMENT_COMPLETED", reimbursement: reimbursementOf() } });
			assert.equal((await webhook(ports, payoutItemBodyFor("REIMBURSEMENT-ITEM-1", "WH-PAYOUT-1"))).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-PAYOUT-1"), "verified, applied", wrong.why);
			const reimbursed = await store.readJob(jobId);
			reads.set(wrong.item, { kind: "SETTLED", observation: { kind: "REIMBURSEMENT_COMPLETED", reimbursement: wrong.reimbursement } });
			assert.equal((await webhook(ports, payoutItemBodyFor(wrong.item, "WH-PAYOUT-2"))).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-PAYOUT-2"), "verified, refused, the job did not take this settlement", wrong.why);
			assert.deepEqual(await store.readJob(jobId), reimbursed, wrong.why);
			assert.deepEqual(alertReasons(store), ["SETTLEMENT_MISMATCH"], wrong.why);
			// The same payout read again at a later time is the same delivery: it finds the key the refusal recorded.
			reads.set(wrong.item, { kind: "SETTLED", observation: { kind: "REIMBURSEMENT_COMPLETED", reimbursement: { ...wrong.reimbursement, at: thirteen } } });
			assert.equal((await webhook(ports, payoutItemBodyFor(wrong.item, "WH-PAYOUT-3"))).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-PAYOUT-3"), "verified, no-op, job already REFUNDED", wrong.why);
			assert.deepEqual(alertReasons(store), ["SETTLEMENT_MISMATCH"], wrong.why);
			// An identical replay of the payout the row holds is a no-op too.
			assert.equal((await webhook(ports, payoutItemBodyFor("REIMBURSEMENT-ITEM-1", "WH-PAYOUT-4"))).status, 202, wrong.why);
			assert.equal(outcomeOf(store, "WH-PAYOUT-4"), "verified, no-op, job already REFUNDED", wrong.why);
			assert.deepEqual(await store.readJob(jobId), reimbursed, wrong.why);
			assert.deepEqual(alertReasons(store), ["SETTLEMENT_MISMATCH"], wrong.why);
		} finally { store.close(); }
	}
});
