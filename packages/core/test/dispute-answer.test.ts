// What Acquit files when PayPal opens a buyer dispute: the receipt as evidence for a paid or verified job, the
// accepted claim for a funded job with no verified attempt, and an alert alone for a job with no held escrow.
// A buyer-favour resolution on a held full-amount escrow settles the job as refunded, with no call to PayPal.

import assert from "node:assert/strict";
import test from "node:test";
import { applyJobCommand, releaseHeld, storedBook, TERMS } from "../src/job.ts";
import type { JobEffect, JobRow, Plan } from "../src/job.ts";
import { operationKey } from "../src/effects.ts";
import { checkLaws, commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import { hours, instant, parseBidId, parseJobId } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, Instant, MerchantId, OperatorId, OrderId, PayoutItemId, RefundId, Version } from "../src/ids.ts";
import { quote } from "../src/paypal.ts";
import type { Bps } from "../src/paypal.ts";
import { manifestOf } from "../src/fixtures.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";
import type { Verdict, VerifierRunId } from "../src/verifier.ts";
import type { Actor } from "../src/acquit.ts";

const now = instant("2026-10-06T12:00:00Z");
const later = instant("2026-10-06T12:30:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const sourceCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const judgedCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const reviewEndsAt = instant("2026-10-09T12:00:00Z");
const cutoff = instant("2026-10-27T12:00:00Z");
const jobId = parseJobId("job_dispute");
const lockedPayee = { bidId: parseBidId("bid_dispute"), operator: "devon-ops" as OperatorId, payee: merchant,
	agent: "ts-bugfixer" as AgentId, price: usd("400.00"), eta: hours(48) };

const paypalFacts = (at: Instant) => ({ actor: { role: "SYSTEM", source: "PAYPAL" } as const, now: at, loaded: { kind: "NONE" } as const });
const userFacts = (actor: Actor, at = now) => ({ actor, now: at, loaded: { kind: "NONE" } as const });

/** A VERIFIED job whose release is open for review, with its gross held in escrow. */
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
	return { id: jobId, version: 1 as Version, client: "maya-client" as ClientId, tenant: null, title: "test", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z"), definitionOfDone: manifestOf(demoFixture(exampleContract), "maya-client/invoice-app"),
			terms: TERMS },
		bids: [{ id: lockedPayee.bidId, operator: lockedPayee.operator, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: lockedPayee.agent, runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2026-10-09T12:00:00Z"), status: "ACCEPTED" }],
		state: { status: "VERIFIED", escrow, history: [passed], passed, review: { phase: "AWAITING_CLIENT", endsAt }, runsStarted: 1 } };
}

/** The same held escrow on a funded job that has no verified attempt yet. */
function fundedRow(): JobRow {
	const row = verifiedRow();
	if (row.state.status !== "VERIFIED") throw new Error(`expected VERIFIED, got ${row.state.status}`);
	return { ...row, state: { status: "IN_PROGRESS", escrow: row.state.escrow, attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } } };
}

/** A paid job: approved, then its release settled. */
function paidRow(): JobRow {
	const approved = planOf(applyJobCommand(verifiedRow(), { type: "Approve", jobId, mergeCommit: judgedCommit }, userFacts(maya)));
	return planOf(applyJobCommand(approved.next, { type: "ReleaseSettled", jobId, release: {
		payoutItemId: "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=" as PayoutItemId,
		captureId: "TESTCAPTURE" as CaptureId, paid: usd("360.00"), at: later } }, paypalFacts(later))).next;
}

/** A refunded job: the refund settled on a verified row whose review had selected one. */
function refundedRow(): JobRow {
	const row = verifiedRow();
	if (row.state.status !== "VERIFIED") throw new Error(`expected VERIFIED, got ${row.state.status}`);
	const refunding: JobRow = { ...row, state: { ...row.state, review: { phase: "REFUND_PENDING", refund: { reason: "DELIVERY_DEADLINE", selectedAt: now } } } };
	return planOf(applyJobCommand(refunding, { type: "RefundSettled", jobId, refund: { refundId: "REFUND-1" as RefundId,
		captureId: "TESTCAPTURE" as CaptureId, refunded: usd("420.00"), retainedProcessorFee: usd("15.15"), at: later } }, paypalFacts(later))).next;
}

/** A buyer dispute as PayPal reports it, against the row's own capture. */
const dispute = (status: string, outcome: string | null = null, amount = usd("420.00")) => ({ type: "ProviderDispute" as const, jobId,
	disputeId: "PP-D-9", captureId: "TESTCAPTURE" as CaptureId, status, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
	amount, openedAt: later, outcome });

function planOf(outcome: ReturnType<typeof applyJobCommand>): Plan<JobRow> {
	if (typeof outcome === "string") throw new Error(outcome);
	return outcome;
}

function evidenceOf(plan: Plan<JobRow>): Extract<JobEffect, { kind: "DISPUTE_EVIDENCE" }>[] {
	return plan.effects.filter((effect): effect is Extract<JobEffect, { kind: "DISPUTE_EVIDENCE" }> => effect.kind === "DISPUTE_EVIDENCE");
}

test("a paid job's open dispute files exactly one evidence, naming its receipt, frozen and hidden counts, pull request, and merge commit", () => {
	const paid = paidRow();
	if (paid.state.status !== "PAID") throw new Error(`expected PAID, got ${paid.state.status}`);
	const opened = planOf(applyJobCommand(paid, dispute("OPEN"), paypalFacts(later)));
	assert.deepEqual(opened.effects.map(effect => effect.kind), ["ALERT", "DISPUTE_EVIDENCE"]);
	const [evidence] = evidenceOf(opened);
	assert.equal(evidenceOf(opened).length, 1);
	assert.equal(evidence?.disputeId, "PP-D-9");
	assert.equal(evidence?.payee, merchant);
	assert.equal(evidence?.simulated, false);
	assert.equal(evidence?.notes, `Receipt ${paid.state.receipt.id} (receipt id) records job ${jobId} as delivered on attempt 1 (attemptsUsed). `
		+ `Frozen tests 48/48 passed (frozen). Hidden tests 6/6 passed (hidden). `
		+ `Pull request #13 carries judged commit ${judgedCommit} (pullRequest, mergeCommit).`);
	assert.equal(opened.next.providerDispute?.answer, "EVIDENCE");
});

test("a verified job whose release is held files its evidence from the verified attempt's tallies, the pull request, and the judged commit", () => {
	const opened = planOf(applyJobCommand(verifiedRow(), dispute("OPEN"), paypalFacts(later)));
	const [evidence] = evidenceOf(opened);
	assert.equal(evidenceOf(opened).length, 1);
	assert.equal(evidence?.notes, `Verified attempt 1 for job ${jobId} passed run run_dispute_1 on source commit ${sourceCommit} (ordinal, runId, sourceCommit). `
		+ `Frozen tests 48/48 passed (frozen). Hidden tests 6/6 passed (hidden). `
		+ `Pull request #13 is open at judged commit ${judgedCommit} (pullRequest, mergeCommit).`);
	assert.equal(releaseHeld(opened.next), true);
});

test("a funded job with no verified attempt accepts the buyer's claim, and files no evidence", () => {
	const opened = planOf(applyJobCommand(fundedRow(), dispute("OPEN"), paypalFacts(later)));
	assert.deepEqual(opened.effects.map(effect => effect.kind), ["DISPUTE_ACCEPT"]);
	const accept = opened.effects[0];
	assert.equal(accept?.kind, "DISPUTE_ACCEPT");
	if (accept?.kind !== "DISPUTE_ACCEPT") throw new Error("expected DISPUTE_ACCEPT");
	assert.equal(accept.disputeId, "PP-D-9");
	assert.equal(accept.payee, merchant);
	assert.equal(accept.simulated, false);
	assert.equal(accept.note, `Acquit accepts the buyer's claim on dispute PP-D-9 for capture TESTCAPTURE on job ${jobId}.`);
	assert.equal(opened.next.providerDispute?.answer, "ACCEPT");
});

test("a refunded job files nothing with PayPal and raises only an alert naming the case", () => {
	const opened = planOf(applyJobCommand(refundedRow(), dispute("OPEN"), paypalFacts(later)));
	assert.deepEqual(opened.effects, [{ kind: "ALERT", jobId, reason: "PROVIDER_DISPUTE_NOT_ANSWERABLE" }]);
	assert.equal(opened.next.providerDispute?.answer, "NOT_ANSWERABLE");
	assert.equal(opened.next.state.status, "REFUNDED");
});

test("a repeat delivery of an open dispute files nothing new, and keeps the answer it filed first", () => {
	const opened = planOf(applyJobCommand(verifiedRow(), dispute("OPEN"), paypalFacts(later)));
	const repeat = planOf(applyJobCommand(opened.next, dispute("OPEN"), paypalFacts(later)));
	assert.deepEqual(repeat.effects, []);
	assert.equal(repeat.next.providerDispute?.answer, "EVIDENCE");
	assert.equal(repeat.next.state.status, opened.next.state.status);
});

test("a buyer-favour resolution on a held full-amount escrow settles the job as refunded, with one REFUND line, no refund effect, and conservation", () => {
	const opened = planOf(applyJobCommand(verifiedRow(), dispute("OPEN"), paypalFacts(later)));
	const approved = planOf(applyJobCommand(opened.next, { type: "Approve", jobId, mergeCommit: judgedCommit }, userFacts(maya)));
	const lost = planOf(applyJobCommand(approved.next, dispute("RESOLVED", "RESOLVED_BUYER_FAVOUR"), paypalFacts(later)));
	assert.equal(lost.next.state.status, "REFUNDED");
	if (lost.next.state.status !== "REFUNDED") throw new Error("expected REFUNDED");
	assert.equal(lost.next.state.reason, "PROVIDER_DISPUTE");
	assert.equal(lost.next.state.refund.refunded, usd("420.00"));
	assert.equal(lost.next.state.refund.refundId, null);
	// PayPal already reversed the funds, so no outbound refund call is emitted.
	assert.deepEqual(lost.effects, []);
	// The book holds the captured gross and one REFUND line for the same gross. Conservation holds: nothing is left held.
	assert.deepEqual(storedBook(lost.next).map(line => line.kind), ["HELD", "REFUND"]);
	assert.equal(storedBook(lost.next).filter(line => line.kind === "REFUND").length, 1);
	assert.equal(checkLaws(storedBook(lost.next)), "REFUNDED");
});

test("a partial dispute alerts a person, still files the answer, and keeps the job held; a partial buyer win keeps the hold too", () => {
	const partial = dispute("OPEN", null, usd("200.00"));
	const opened = planOf(applyJobCommand(verifiedRow(), partial, paypalFacts(later)));
	assert.deepEqual(opened.effects.map(effect => effect.kind), ["DISPUTE_EVIDENCE", "ALERT"]);
	assert.deepEqual(opened.effects[1], { kind: "ALERT", jobId, reason: "PROVIDER_DISPUTE_PARTIAL" });
	assert.equal(opened.next.state.status, "VERIFIED");
	assert.equal(releaseHeld(opened.next), true);
	const lost = planOf(applyJobCommand(opened.next, dispute("RESOLVED", "RESOLVED_BUYER_FAVOUR", usd("200.00")), paypalFacts(later)));
	assert.equal(lost.next.state.status, "VERIFIED");
	assert.deepEqual(lost.effects, [{ kind: "ALERT", jobId, reason: "PROVIDER_DISPUTE_PARTIAL_LOST" }]);
	assert.equal(releaseHeld(lost.next), true);
});

test("each dispute id has its own answer key, a repeat of one id has the same key, and evidence and accept keys differ", () => {
	const evidence = (disputeId: string): JobEffect => ({ kind: "DISPUTE_EVIDENCE", jobId, disputeId, payee: merchant, notes: "n", simulated: false });
	const accept = (disputeId: string): JobEffect => ({ kind: "DISPUTE_ACCEPT", jobId, disputeId, payee: merchant, note: "n", simulated: false });
	assert.equal(operationKey(evidence("PP-D-9")), operationKey(evidence("PP-D-9")));
	assert.notEqual(operationKey(evidence("PP-D-9")), operationKey(evidence("PP-D-10")));
	assert.notEqual(operationKey(evidence("PP-D-9")), operationKey(accept("PP-D-9")));
});
