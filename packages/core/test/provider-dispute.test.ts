// A PayPal buyer dispute is recorded on the job beside its state. While it is open, no release is emitted,
// and a release it held proceeds only when PayPal resolves it in the seller's favour.

import assert from "node:assert/strict";
import test from "node:test";
import { applySystemCommand, operationKey, runOutboxOnce } from "../src/effects.ts";
import type { OperationKey, Ports } from "../src/effects.ts";
import { SqliteStore } from "../src/store.ts";
import { parseWebhookEnvelope } from "../src/paypal.ts";
import { disputeOutcomeCode, parseDispute } from "../src/paypal.ts";
import { hours, instant, parseBidId, parseJobId } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, Instant, JobId, MerchantId, OperatorId, OrderId, PayoutItemId, RefundId, Version } from "../src/ids.ts";
import { applyJobCommand, releaseHeld, TERMS, wakeAt } from "../src/job.ts";
import type { JobRow, Plan } from "../src/job.ts";
import { commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { quote } from "../src/paypal.ts";
import { manifestOf } from "../src/fixtures.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";
import type { Verdict, VerifierRunId } from "../src/verifier.ts";
import type { Actor } from "../src/acquit.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import type { OperatorRow } from "../src/operator.ts";

const now = instant("2026-10-06T12:00:00Z");
const later = instant("2026-10-06T12:30:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const sourceCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const judgedCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const reviewEndsAt = instant("2026-10-09T12:00:00Z");
const cutoff = instant("2026-10-27T12:00:00Z");
const lockedPayee = { bidId: parseBidId("bid_dispute"), operator: "devon-ops" as OperatorId, payee: merchant,
	agent: "ts-bugfixer" as AgentId, price: usd("400.00"), eta: hours(48) };

const paypalFacts = (at: Instant) => ({ actor: { role: "SYSTEM", source: "PAYPAL" } as const, now: at, loaded: { kind: "NONE" } as const });
const timerFacts = (at: Instant) => ({ actor: { role: "SYSTEM", source: "TIMER" } as const, now: at, loaded: { kind: "NONE" } as const });
const userFacts = (actor: Actor, at = now) => ({ actor, now: at, loaded: { kind: "NONE" } as const });

function verifiedRow(endsAt = reviewEndsAt): JobRow {
	const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
		sellerNet: usd("360.00"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: capture.gross, at: now });
	if ("kind" in book) throw new Error(book.law);
	const escrow = { payee: lockedPayee, quote: quote(commercialSplit(usd("400.00")), model), capture, book, cutoffAt: cutoff };
	const verdict: Verdict = { result: "VERIFIED", runId: "run_dispute_1" as VerifierRunId, sourceCommit, mergeCommit: judgedCommit, pullRequest: 13,
		frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "b".repeat(64) as Digest, at: now };
	const passed = { ordinal: 1 as const, verdict };
	return { id: parseJobId("job_dispute"), version: 1 as Version, client: "maya-client" as ClientId, tenant: null, title: "test", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z"), definitionOfDone: manifestOf(demoFixture(exampleContract), "maya-client/invoice-app"), terms: TERMS },
		bids: [{ id: lockedPayee.bidId, operator: lockedPayee.operator, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: lockedPayee.agent, runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2026-10-09T12:00:00Z"), status: "ACCEPTED" }],
		state: { status: "VERIFIED", escrow, history: [passed], passed, review: { phase: "AWAITING_CLIENT", endsAt }, runsStarted: 1 } };
}

/** A buyer dispute as PayPal reports it, against the row's own capture. */
const dispute = (jobId: JobId, status: string, outcome: string | null = null) => ({ type: "ProviderDispute" as const, jobId,
	disputeId: "PP-D-9", captureId: "TESTCAPTURE" as CaptureId, status, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
	amount: usd("420.00"), openedAt: later, outcome });

function planOf(outcome: ReturnType<typeof applyJobCommand>): Plan<JobRow> {
	if (typeof outcome === "string") throw new Error(outcome);
	return outcome;
}

function reviewOf(row: JobRow) {
	if (row.state.status !== "VERIFIED") throw new Error(`expected VERIFIED, got ${row.state.status}`);
	return row.state.review;
}

const releaseEffect = (row: JobRow) => ({ kind: "RELEASE" as const, jobId: row.id, captureId: "TESTCAPTURE" as CaptureId, payee: merchant });

test("an open buyer dispute is recorded on an awaiting job without moving its phase or emitting a release", () => {
	const row = verifiedRow();
	const opened = planOf(applyJobCommand(row, dispute(row.id, "OPEN"), paypalFacts(later)));
	assert.deepEqual(opened.next.providerDispute, { id: "PP-D-9", status: "OPEN", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
		amount: usd("420.00"), openedAt: later, answer: "EVIDENCE", answerState: { state: "QUEUED" }, answerRound: "PP-D-9:1",
		answerEvidenceType: "PROOF_OF_FULFILLMENT" });
	assert.deepEqual(reviewOf(opened.next), { phase: "AWAITING_CLIENT", endsAt: reviewEndsAt });
	// The held job files its evidence once. It emits no release, and the dispute still holds the payout.
	assert.deepEqual(opened.effects.map(effect => effect.kind), ["DISPUTE_EVIDENCE"]);
	assert.equal(releaseHeld(opened.next), true);
});

test("a client approval while the dispute is open records the release and emits no RELEASE", () => {
	const opened = planOf(applyJobCommand(verifiedRow(), dispute(verifiedRow().id, "OPEN"), paypalFacts(later)));
	const approved = planOf(applyJobCommand(opened.next, { type: "Approve", jobId: opened.next.id, mergeCommit: judgedCommit }, userFacts(maya)));
	assert.deepEqual(reviewOf(approved.next), { phase: "RELEASE_PENDING", release: { authority: "CLIENT_APPROVAL", selectedAt: now } });
	assert.deepEqual(approved.effects, []);
});

test("the review timeout while the dispute is open records REVIEW_SILENCE and emits no RELEASE", () => {
	const row = verifiedRow();
	const opened = planOf(applyJobCommand(row, dispute(row.id, "OPEN"), paypalFacts(later)));
	assert.equal(wakeAt(opened.next), reviewEndsAt);
	const timed = planOf(applyJobCommand(opened.next, { type: "TimerDue", jobId: row.id, expectedWakeAt: reviewEndsAt }, timerFacts(reviewEndsAt)));
	assert.deepEqual(reviewOf(timed.next), { phase: "RELEASE_PENDING", release: { authority: "REVIEW_SILENCE", selectedAt: reviewEndsAt } });
	assert.deepEqual(timed.effects, []);
});

test("the day-21 capture cutoff while the dispute is open holds the release instead of paying it", () => {
	const row = verifiedRow(instant("2026-10-30T12:00:00Z"));
	const opened = planOf(applyJobCommand(row, dispute(row.id, "OPEN"), paypalFacts(later)));
	assert.equal(wakeAt(opened.next), cutoff);
	const cut = planOf(applyJobCommand(opened.next, { type: "TimerDue", jobId: row.id, expectedWakeAt: cutoff }, timerFacts(cutoff)));
	assert.deepEqual(reviewOf(cut.next), { phase: "RELEASE_PENDING", release: { authority: "CAPTURE_CUTOFF", selectedAt: cutoff } });
	assert.deepEqual(cut.effects, []);
	if (cut.next.state.status !== "VERIFIED") throw new Error("expected VERIFIED");
	assert.equal(cut.next.state.escrow.cutoffHandledAt, cutoff);
});

test("a seller-favour resolution lifts the hold, and the approval held while it was open proceeds", () => {
	const row = verifiedRow();
	const opened = planOf(applyJobCommand(row, dispute(row.id, "OPEN"), paypalFacts(later)));
	const approved = planOf(applyJobCommand(opened.next, { type: "Approve", jobId: row.id, mergeCommit: judgedCommit }, userFacts(maya)));
	const resolved = planOf(applyJobCommand(approved.next, dispute(row.id, "RESOLVED", "RESOLVED_SELLER_FAVOUR"), paypalFacts(later)));
	assert.deepEqual(resolved.effects, [releaseEffect(row)]);
	assert.equal(resolved.next.providerDispute?.resolvedAt, later);
	assert.equal(releaseHeld(resolved.next), false);
	assert.deepEqual(reviewOf(resolved.next), { phase: "RELEASE_PENDING", release: { authority: "CLIENT_APPROVAL", selectedAt: now } });
});

test("a buyer-favour resolution on a held full-amount escrow settles the job as refunded, with no outbound call", () => {
	const row = verifiedRow();
	const opened = planOf(applyJobCommand(row, dispute(row.id, "OPEN"), paypalFacts(later)));
	const approved = planOf(applyJobCommand(opened.next, { type: "Approve", jobId: row.id, mergeCommit: judgedCommit }, userFacts(maya)));
	const lost = planOf(applyJobCommand(approved.next, dispute(row.id, "RESOLVED", "RESOLVED_BUYER_FAVOUR"), paypalFacts(later)));
	assert.equal(lost.next.providerDispute?.outcome, "RESOLVED_BUYER_FAVOUR");
	// PayPal already reversed the funds, so the job settles as refunded and no REFUND effect is emitted.
	assert.equal(lost.next.state.status, "REFUNDED");
	if (lost.next.state.status !== "REFUNDED") throw new Error("expected REFUNDED");
	assert.equal(lost.next.state.reason, "PROVIDER_DISPUTE");
	assert.equal(lost.next.state.refund.refunded, usd("420.00"));
	assert.deepEqual(lost.effects, []);
});

test("a second dispute id on the same job is refused as a settlement mismatch", () => {
	const row = verifiedRow();
	const opened = planOf(applyJobCommand(row, dispute(row.id, "OPEN"), paypalFacts(later)));
	const second = applyJobCommand(opened.next, { ...dispute(row.id, "OPEN"), disputeId: "PP-D-10" }, paypalFacts(later));
	assert.equal(planOf(second).refused, "SETTLEMENT_MISMATCH");
	assert.equal(planOf(second).next, opened.next);
});

test("a resolved dispute is final: its own repeat is already settled and changes nothing", () => {
	const row = verifiedRow();
	const opened = planOf(applyJobCommand(row, dispute(row.id, "OPEN"), paypalFacts(later)));
	const resolved = planOf(applyJobCommand(opened.next, dispute(row.id, "RESOLVED", "RESOLVED_SELLER_FAVOUR"), paypalFacts(later)));
	const repeat = planOf(applyJobCommand(resolved.next, dispute(row.id, "RESOLVED", "RESOLVED_SELLER_FAVOUR"), paypalFacts(later)));
	assert.equal(repeat.alreadySettled, true);
	assert.equal(repeat.next, resolved.next);
	assert.deepEqual(repeat.effects, []);
});

test("a dispute recorded on a paid job alerts a person and files the receipt, and changes no state", () => {
	const row = verifiedRow();
	const approved = planOf(applyJobCommand(row, { type: "Approve", jobId: row.id, mergeCommit: judgedCommit }, userFacts(maya)));
	const paid = planOf(applyJobCommand(approved.next, { type: "ReleaseSettled", jobId: row.id,
		release: { payoutItemId: "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=" as PayoutItemId,
			captureId: "TESTCAPTURE" as CaptureId, paid: usd("360.00"), at: later } }, paypalFacts(later)));
	assert.equal(paid.next.state.status, "PAID");
	const disputed = planOf(applyJobCommand(paid.next, dispute(row.id, "OPEN"), paypalFacts(later)));
	assert.deepEqual(disputed.next.state, paid.next.state);
	assert.equal(disputed.next.providerDispute?.status, "OPEN");
	// The receipt is the answer, filed once. The alert names the paid job for a person; the state is untouched.
	assert.deepEqual(disputed.effects.map(effect => effect.kind), ["ALERT", "DISPUTE_EVIDENCE"]);
	assert.deepEqual(disputed.effects[0], { kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_ON_PAID", disputeId: "PP-D-9" });
});

test("a dispute envelope parses to a DISPUTE resource named by its dispute_id", async () => {
	const envelope = await parseWebhookEnvelope(JSON.stringify({ id: "WH-DISPUTE-1", event_type: "CUSTOMER.DISPUTE.CREATED", resource_type: "dispute",
		resource: { dispute_id: "PP-D-9", status: "OPEN" } }));
	assert.deepEqual(envelope, { kind: "DELIVERY", deliveryId: "WH-DISPUTE-1", eventType: "CUSTOMER.DISPUTE.CREATED", resourceType: "dispute",
		resourceId: "PP-D-9", resource: { kind: "DISPUTE", id: "PP-D-9" } });
});

test("a dispute body parses its status, reason, amount, open time, and capture, and reads the outcome from dispute_outcome", () => {
	const body = { dispute_id: "PP-D-9", status: "RESOLVED", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
		dispute_amount: { currency_code: "USD", value: "420.00" }, create_time: "2026-10-06T12:30:00Z",
		dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" }, disputed_transactions: [{ seller_transaction_id: "TESTCAPTURE" }] };
	assert.deepEqual(parseDispute(body, "TESTCAPTURE" as CaptureId), { disputeId: "PP-D-9", captureId: "TESTCAPTURE", status: "RESOLVED",
		reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount: usd("420.00"), openedAt: later, outcome: "RESOLVED_SELLER_FAVOUR" });
	assert.equal(disputeOutcomeCode({ outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" } }), "RESOLVED_BUYER_FAVOUR");
	assert.equal(disputeOutcomeCode({ dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" }, outcome: { outcome_code: "IGNORED" } }), "RESOLVED_SELLER_FAVOUR");
	assert.equal(disputeOutcomeCode({ status: "OPEN" }), null);
	const open = parseDispute({ ...body, status: "OPEN", dispute_outcome: undefined }, "TESTCAPTURE" as CaptureId);
	assert.equal("outcome" in open, false);
});

test("a refund that settles on a row with an open buyer dispute keeps the dispute on the row", () => {
	const row = verifiedRow();
	if (row.state.status !== "VERIFIED") throw new Error(`expected VERIFIED, got ${row.state.status}`);
	const refunding: JobRow = { ...row, state: { ...row.state, review: { phase: "REFUND_PENDING", refund: { reason: "DELIVERY_DEADLINE", selectedAt: now } } } };
	const opened = planOf(applyJobCommand(refunding, dispute(row.id, "OPEN"), paypalFacts(later)));
	assert.equal(opened.next.providerDispute?.status, "OPEN");
	const settled = planOf(applyJobCommand(opened.next, { type: "RefundSettled", jobId: row.id,
		refund: { refundId: "REFUND-1" as RefundId, captureId: "TESTCAPTURE" as CaptureId, refunded: usd("420.00"), retainedProcessorFee: usd("15.15"), at: later } },
	paypalFacts(later)));
	assert.equal(settled.next.state.status, "REFUNDED");
	assert.deepEqual(settled.next.providerDispute, opened.next.providerDispute);
});

test("a release that lands while a buyer dispute holds it is paid, keeps the dispute on the row, and alerts a person", () => {
	const row = verifiedRow();
	const opened = planOf(applyJobCommand(row, dispute(row.id, "OPEN"), paypalFacts(later)));
	const approved = planOf(applyJobCommand(opened.next, { type: "Approve", jobId: row.id, mergeCommit: judgedCommit }, userFacts(maya)));
	const paid = planOf(applyJobCommand(approved.next, { type: "ReleaseSettled", jobId: row.id,
		release: { payoutItemId: "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=" as PayoutItemId,
			captureId: "TESTCAPTURE" as CaptureId, paid: usd("360.00"), at: later } }, paypalFacts(later)));
	assert.equal(paid.next.state.status, "PAID");
	assert.equal(paid.next.providerDispute?.status, "OPEN");
	assert.deepEqual(paid.effects.filter(effect => effect.kind === "ALERT"), [{ kind: "ALERT", jobId: row.id, reason: "PROVIDER_DISPUTE_ON_PAID", disputeId: "PP-D-9" }]);
});

test("a release the dispute holds stays due in the outbox, and is paid once a seller-favour resolution lifts the hold", async () => {
	const store = new SqliteStore(":memory:");
	const row = verifiedRow();
	const releaseKey: OperationKey = operationKey({ kind: "RELEASE", jobId: row.id, captureId: "TESTCAPTURE" as CaptureId, payee: merchant });
	const releaseEvidence = { payoutItemId: "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=" as PayoutItemId,
		captureId: "TESTCAPTURE" as CaptureId, paid: usd("360.00"), at: later };
	const outboxKind = (): string => {
		const found = store.db.prepare("SELECT state FROM outbox WHERE key = ?").get(releaseKey);
		assert(found !== undefined, "The release left no outbox row");
		return String((JSON.parse(String(found.state)) as { kind: string }).kind);
	};
	const operator: OperatorRow = { id: "devon-ops" as OperatorId, handle: "devon-ops", kind: "INDEPENDENT", version: 0 as Version,
		payouts: { kind: "READY", merchant, connectedAt: now } };
	const account: CreditAccount = { operator: operator.id, version: 0 as Version,
		balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
	store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(operator.id, operator.version, JSON.stringify(operator), 0);
	store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), wakeAt(row));
	const dispatched: string[] = [];
	let current: Instant = reviewEndsAt;
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, feeModel: model, fixtures: [demoFixture(exampleContract)], clock: { now: () => current },
		verifier: { start: unimplemented, parseCallback: unimplemented }, github: { merge: unimplemented },
		alerts: { raise: unimplemented },
		paypal: { dispatch: async call => { dispatched.push(call.kind); return { kind: "CONFIRMED", observation: { kind: "RELEASE_COMPLETED", release: releaseEvidence } }; },
			reconcile: unimplemented, getOrder: unimplemented, parseWebhook: unimplemented, verifyWebhookDelivery: unimplemented, readResource: unimplemented } };
	try {
		// The review window closes with no dispute on file, so the silence release is selected and its effect is due.
		const silent = await applySystemCommand(ports, { type: "TimerDue", jobId: row.id, expectedWakeAt: reviewEndsAt }, null, null);
		assert.equal(silent.refused, null);
		assert.equal(outboxKind(), "READY");
		// The buyer opens a dispute before the outbox moves the money: the due release is held, not confirmed.
		const opened = await applySystemCommand(ports, dispute(row.id, "OPEN"), null, "webhook-open");
		assert.equal(opened.refused, null);
		assert.equal(await runOutboxOnce(ports, releaseKey), "WORKED");
		assert.deepEqual(dispatched, []);
		assert.equal(outboxKind(), "READY");
		// The seller wins the dispute. The deferred row backs off five seconds from its last deferral, so the lift
		// lands after that, and the same key is due again: it dispatches and settles the job.
		current = instant("2026-10-09T12:00:10Z");
		const lifted = await applySystemCommand(ports, dispute(row.id, "RESOLVED", "RESOLVED_SELLER_FAVOUR"), null, "webhook-resolved");
		assert.equal(lifted.refused, null);
		assert.equal(await runOutboxOnce(ports, releaseKey), "WORKED");
		assert.deepEqual(dispatched, ["RELEASE"]);
		assert.equal(outboxKind(), "CONFIRMED");
		assert.equal((await store.readJob(row.id))?.state.status, "PAID");
	} finally { store.close(); }
});
