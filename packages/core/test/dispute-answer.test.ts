// What Acquit files when PayPal opens a buyer dispute: the receipt as evidence for a paid or verified job, the
// accepted claim for a funded job with no verified attempt, and an alert alone for a job with no held escrow.
// A buyer-favour resolution on a held full-amount escrow settles the job as refunded, with no call to PayPal.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { answerRoundOf, applyJobCommand, effectWanted, projectJob, releaseHeld, storedBook, TERMS, wakeAt } from "../src/job.ts";
import type { JobEffect, JobRow, Plan } from "../src/job.ts";
import { applySystemCommand, executeCommand, operationKey, providerRequestId, runOutboxOnce } from "../src/effects.ts";
import type { OperationKey, Ports } from "../src/effects.ts";
import { SqliteStore } from "../src/store.ts";
import { checkLaws, commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import { hours, instant, parseBidId, parseJobId, parseRequestKey } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, Instant, MerchantId, OperatorId, OrderId, PayoutItemId, RefundId, StaffId, Version } from "../src/ids.ts";
import { createPayPal, DISPUTE_ACCESS_REFUSED, NO_HONEST_EVIDENCE_TYPE, quote } from "../src/paypal.ts";
import type { Bps, DisputeOffer, EvidenceType } from "../src/paypal.ts";
import { manifestOf } from "../src/fixtures.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";
import type { Verdict, VerifierRunId } from "../src/verifier.ts";
import { processLogAlerts } from "../src/acquit.ts";
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
const platform = "LA4PH2WMNKTDN" as MerchantId;
/** The one run a verifying job is waiting for, judged VERIFIED on the same commit it was submitted under. */
const passedVerdict: Extract<Verdict, { result: "VERIFIED" }> = { result: "VERIFIED", runId: "run_dispute_1" as VerifierRunId, sourceCommit, mergeCommit: judgedCommit,
	pullRequest: 13, frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "b".repeat(64) as Digest, at: now };

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
	const passed = { ordinal: 1 as const, verdict: passedVerdict };
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
	assert.deepEqual(opened.effects, [{ kind: "ALERT", jobId, reason: "PROVIDER_DISPUTE_NOT_ANSWERABLE", disputeId: "PP-D-9" }]);
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
	assert.deepEqual(opened.effects[1], { kind: "ALERT", jobId, reason: "PROVIDER_DISPUTE_PARTIAL", disputeId: "PP-D-9" });
	assert.equal(opened.next.state.status, "VERIFIED");
	assert.equal(releaseHeld(opened.next), true);
	const lost = planOf(applyJobCommand(opened.next, dispute("RESOLVED", "RESOLVED_BUYER_FAVOUR", usd("200.00")), paypalFacts(later)));
	assert.equal(lost.next.state.status, "VERIFIED");
	assert.deepEqual(lost.effects, [{ kind: "ALERT", jobId, reason: "PROVIDER_DISPUTE_PARTIAL_LOST", disputeId: "PP-D-9" }]);
	assert.equal(releaseHeld(lost.next), true);
});

test("each dispute id has its own answer key, a repeat of one id has the same key, and evidence and accept keys differ", () => {
	const evidence = (disputeId: string): JobEffect => ({ kind: "DISPUTE_EVIDENCE", jobId, disputeId, payee: merchant, notes: "n", attempt: 1, simulated: false });
	const accept = (disputeId: string): JobEffect => ({ kind: "DISPUTE_ACCEPT", jobId, disputeId, payee: merchant, note: "n", simulated: false });
	assert.equal(operationKey(evidence("PP-D-9")), operationKey(evidence("PP-D-9")));
	assert.notEqual(operationKey(evidence("PP-D-9")), operationKey(evidence("PP-D-10")));
	assert.notEqual(operationKey(evidence("PP-D-9")), operationKey(accept("PP-D-9")));
});

/** A funded job whose one verifier run is in flight, for the verdict to land on. */
function verifyingRow(): JobRow {
	const row = fundedRow();
	if (row.state.status !== "IN_PROGRESS") throw new Error(`expected IN_PROGRESS, got ${row.state.status}`);
	const pending = { ordinal: 1 as const, run: 1, runId: passedVerdict.runId, sourceCommit, submittedAt: now, runEndsAt: later };
	return { ...row, state: { ...row.state, attempts: { phase: "VERIFYING", history: [], runsStarted: 1, pending, failure: null } } };
}

/** The verifier's report of the run verifyingRow() waits for: the same run and commit, judged VERIFIED. */
function verifiedReport() {
	return { type: "VerifierFinished" as const, jobId, report: { kind: "VERDICT" as const, verdict: passedVerdict } };
}

function acceptFrom(plan: Plan<JobRow>): Extract<JobEffect, { kind: "DISPUTE_ACCEPT" }> {
	const [accept] = plan.effects.filter((effect): effect is Extract<JobEffect, { kind: "DISPUTE_ACCEPT" }> => effect.kind === "DISPUTE_ACCEPT");
	if (accept === undefined) throw new Error("expected one DISPUTE_ACCEPT");
	return accept;
}

function evidenceFrom(plan: Plan<JobRow>): Extract<JobEffect, { kind: "DISPUTE_EVIDENCE" }> {
	const [evidence] = evidenceOf(plan);
	if (evidence === undefined) throw new Error("expected one DISPUTE_EVIDENCE");
	return evidence;
}

/** The REFUND a selected refund queues for the captured gross. */
const refundEffect = (): JobEffect => ({ kind: "REFUND", jobId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant, amount: usd("420.00") });

/** Three rows whose refund is already selected: an attempt in flight, a verified review, and a funded checkout whose capture mismatched. */
function refundingRows(): { readonly name: string; readonly row: JobRow }[] {
	const base = verifiedRow();
	if (base.state.status !== "VERIFIED") throw new Error(`expected VERIFIED, got ${base.state.status}`);
	const escrow = base.state.escrow;
	const attempt: JobRow = { ...base, state: { status: "IN_PROGRESS", escrow, attempts: { phase: "REFUND_PENDING", history: [],
		refund: { reason: "CAPTURE_CUTOFF", selectedAt: now } } } };
	const review: JobRow = { ...base, state: { ...base.state, review: { phase: "REFUND_PENDING", refund: { reason: "ARBITER_REFUND", selectedAt: now } } } };
	const checkout: JobRow = { ...base, state: { status: "OPEN", phase: { kind: "FUNDING", round: 1, chosen: lockedPayee, quote: escrow.quote,
		checkoutEndsAt: later, checkout: { phase: "REFUND_PENDING", escrow, refund: { reason: "CAPTURE_MISMATCH", selectedAt: now } } } } };
	return [{ name: "an in-flight attempt whose refund is selected", row: attempt }, { name: "a verified job whose review selected a refund", row: review },
		{ name: "a funded checkout whose capture mismatched and is refunding", row: checkout }];
}

test("a verdict that lands while the claim is accepted turns the answer to evidence once, and the queued accept is never wanted again", () => {
	const accepted = planOf(applyJobCommand(verifyingRow(), dispute("OPEN"), paypalFacts(later)));
	const queued = acceptFrom(accepted);
	assert.equal(accepted.next.providerDispute?.answer, "ACCEPT");
	assert.equal(effectWanted(accepted.next, queued), true);
	const verified = planOf(applyJobCommand(accepted.next, verifiedReport(), paypalFacts(later)));
	assert.equal(verified.next.state.status, "VERIFIED");
	assert.equal(verified.next.providerDispute?.answer, "EVIDENCE");
	assert.deepEqual(verified.effects.map(effect => effect.kind), ["DISPUTE_EVIDENCE"]);
	const evidence = evidenceFrom(verified);
	assert.equal(evidence.disputeId, "PP-D-9");
	assert.equal(evidence.notes, `Verified attempt 1 for job ${jobId} passed run run_dispute_1 on source commit ${sourceCommit} (ordinal, runId, sourceCommit). `
		+ `Frozen tests 48/48 passed (frozen). Hidden tests 6/6 passed (hidden). `
		+ `Pull request #13 is open at judged commit ${judgedCommit} (pullRequest, mergeCommit).`);
	assert.notEqual(operationKey(evidence), operationKey(queued));
	// The queued accept answers a claim the row no longer makes, so it is unwanted; the evidence is wanted.
	assert.equal(effectWanted(verified.next, queued), false);
	assert.equal(effectWanted(verified.next, evidence), true);
	// The verdict is spent: a repeat of it is refused as a wrong state, so the evidence is filed once.
	assert.equal(applyJobCommand(verified.next, verifiedReport(), paypalFacts(later)), "WRONG_STATE");
});

test("an answer is wanted only while its dispute is open under the id it names, and filed as that answer", () => {
	const accepted = planOf(applyJobCommand(fundedRow(), dispute("OPEN"), paypalFacts(later)));
	const accept = acceptFrom(accepted);
	assert.equal(effectWanted(accepted.next, accept), true);
	assert.equal(effectWanted(accepted.next, { ...accept, disputeId: "PP-D-10" }), false);
	const settled = planOf(applyJobCommand(accepted.next, dispute("RESOLVED", "RESOLVED_SELLER_FAVOUR"), paypalFacts(later)));
	assert.equal(effectWanted(settled.next, accept), false);
	const paid = planOf(applyJobCommand(paidRow(), dispute("OPEN"), paypalFacts(later)));
	const evidence = evidenceFrom(paid);
	assert.equal(effectWanted(paid.next, evidence), true);
	assert.equal(effectWanted(paid.next, { ...evidence, disputeId: "PP-D-10" }), false);
	// An accept is never wanted on a dispute the row answers with evidence.
	assert.equal(effectWanted(paid.next, { ...accept, disputeId: "PP-D-9" }), false);
	const paidSettled = planOf(applyJobCommand(paid.next, dispute("RESOLVED", "RESOLVED_SELLER_FAVOUR"), paypalFacts(later)));
	assert.equal(effectWanted(paidSettled.next, evidence), false);
});

test("a buyer-favour resolution settles a row whose refund is already selected as refunded, and its queued refund is no longer wanted", () => {
	for (const { name, row } of refundingRows()) {
		const opened = planOf(applyJobCommand(row, dispute("OPEN"), paypalFacts(later)));
		const refund = refundEffect();
		// Before PayPal's resolution the row still selects the refund, so the queued REFUND is wanted.
		assert.equal(effectWanted(row, refund), true, name);
		const lost = planOf(applyJobCommand(opened.next, dispute("RESOLVED", "RESOLVED_BUYER_FAVOUR"), paypalFacts(later)));
		assert.equal(lost.next.state.status, "REFUNDED", name);
		if (lost.next.state.status !== "REFUNDED") throw new Error("expected REFUNDED");
		assert.equal(lost.next.state.reason, "PROVIDER_DISPUTE", name);
		assert.equal(lost.next.state.refund.refunded, usd("420.00"), name);
		// PayPal already reversed the capture, so no refund call is emitted, and the book holds one REFUND line for the gross.
		assert.deepEqual(lost.effects, [], name);
		assert.deepEqual(storedBook(lost.next).map(line => line.kind), ["HELD", "REFUND"], name);
		assert.equal(checkLaws(storedBook(lost.next)), "REFUNDED", name);
		assert.equal(effectWanted(lost.next, refund), false, name);
	}
});

test("a partial buyer win on a row whose refund is already selected keeps the hold and alerts a person", () => {
	for (const { name, row } of refundingRows()) {
		const opened = planOf(applyJobCommand(row, dispute("OPEN"), paypalFacts(later)));
		const partial = planOf(applyJobCommand(opened.next, dispute("RESOLVED", "RESOLVED_BUYER_FAVOUR", usd("200.00")), paypalFacts(later)));
		assert.equal(partial.next.state.status, row.state.status, name);
		assert.deepEqual(storedBook(partial.next).map(line => line.kind), ["HELD"], name);
		assert.deepEqual(partial.effects, [{ kind: "ALERT", jobId, reason: "PROVIDER_DISPUTE_PARTIAL_LOST", disputeId: "PP-D-9" }], name);
		assert.equal(releaseHeld(partial.next), true, name);
	}
});

test("a dispute against another capture than the one the row holds changes nothing but a settlement alert", () => {
	for (const { name, row } of [{ name: "a funded job", row: fundedRow() }, { name: "a verified job", row: verifiedRow() }]) {
		const elsewhere = { ...dispute("OPEN"), captureId: "OTHER-CAPTURE" as CaptureId };
		const refused = planOf(applyJobCommand(row, elsewhere, paypalFacts(later)));
		assert.equal(refused.refused, "SETTLEMENT_MISMATCH", name);
		assert.deepEqual(refused.next, row, name);
		assert.deepEqual(refused.effects, [{ kind: "ALERT", jobId, reason: "SETTLEMENT_MISMATCH" }], name);
		// The same dispute against the held capture is still filed, as usual.
		const filed = planOf(applyJobCommand(row, dispute("OPEN"), paypalFacts(later)));
		assert.equal(filed.refused, undefined, name);
		assert.equal(filed.next.providerDispute?.id, "PP-D-9", name);
	}
});

/** The alerts a plan raises, typed as the ALERT effect. */
function alertsOf(plan: Plan<JobRow>): Extract<JobEffect, { kind: "ALERT" }>[] {
	return plan.effects.filter((effect): effect is Extract<JobEffect, { kind: "ALERT" }> => effect.kind === "ALERT");
}

/** The lines the process log receives while the body runs. */
async function loggedLines(body: () => Promise<void>): Promise<string[]> {
	const original = console.error;
	const lines: string[] = [];
	console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	try { await body(); } finally { console.error = original; }
	return lines;
}

test("the process log names the buyer dispute a dispute alert is about, and a settlement alert names none", async () => {
	const partial = planOf(applyJobCommand(verifiedRow(), dispute("OPEN", null, usd("200.00")), paypalFacts(later)));
	const unanswerable = planOf(applyJobCommand(refundedRow(), dispute("OPEN"), paypalFacts(later)));
	const mismatch = planOf(applyJobCommand(verifiedRow(), { ...dispute("OPEN"), captureId: "OTHER-CAPTURE" as CaptureId }, paypalFacts(later)));
	const alerts = [...alertsOf(partial), ...alertsOf(unanswerable), ...alertsOf(mismatch)];
	const lines = await loggedLines(async () => {
		for (const alert of alerts) await processLogAlerts.raise(alert);
	});
	assert.deepEqual(lines, [
		`Acquit alert: PROVIDER_DISPUTE_PARTIAL for ${jobId} on dispute "PP-D-9"`,
		`Acquit alert: PROVIDER_DISPUTE_NOT_ANSWERABLE for ${jobId} on dispute "PP-D-9"`,
		`Acquit alert: SETTLEMENT_MISMATCH for ${jobId}`,
	]);
});

/** Routes the real PayPal client's HTTP through a recorder for the body's run. The OAuth token is answered; every other call is recorded. */
type RecordedCall = { readonly path: string; readonly requestId: string | null };
async function withRecordedPayPal(answer: () => Response, body: (calls: RecordedCall[]) => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	const calls: RecordedCall[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "recorded-token", expires_in: 300 });
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ path: new URL(url).pathname, requestId: headers["PayPal-Request-Id"] ?? null });
		return answer();
	}) as typeof fetch;
	try { await body(calls); } finally { globalThis.fetch = original; }
}

/** A store holding the row, so a command applied to it writes its outbox rows the way the deployment does. */
async function withStore(row: JobRow, body: (store: SqliteStore) => Promise<void>): Promise<void> {
	const store = new SqliteStore(":memory:");
	try {
		store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), wakeAt(row));
		await body(store);
	} finally { store.close(); }
}

/** The ports the outbox runs against. PayPal is the real client, so the path and request id are the ones a dispute answer sends. */
function portsOver(store: SqliteStore): Ports {
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	return { store, feeModel: model, fixtures: [demoFixture(exampleContract)], clock: { now: () => later },
		verifier: { start: unimplemented, parseCallback: unimplemented }, github: { merge: unimplemented }, alerts: { raise: unimplemented },
		paypal: createPayPal({ apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: platform, feeModel: model }) };
}

/** What PayPal did with the job's dispute answer, as the job view serves it. */
async function answerStateOf(store: SqliteStore): Promise<unknown> {
	return (await store.readJob(jobId))?.providerDispute?.answerState ?? null;
}

/** The alert effects the outbox holds. */
function queuedAlertsOf(store: SqliteStore): { readonly kind: string; readonly reason?: string; readonly disputeId?: string; readonly detail?: string }[] {
	return store.db.prepare("SELECT json FROM outbox").all()
		.map(row => (JSON.parse(String((row as { json: string }).json)) as { effect: { kind: string; reason?: string; disputeId?: string; detail?: string } }).effect)
		.filter(effect => effect.kind === "ALERT");
}

/** The stored state of one outbox effect, read the way the outbox reads it. */
function outboxStateOf(store: SqliteStore, key: OperationKey): { readonly kind: string; readonly reason?: string } {
	const found = store.db.prepare("SELECT state FROM outbox WHERE key = ?").get(key);
	assert(found !== undefined, "The effect left no outbox row");
	return JSON.parse(String(found.state)) as { readonly kind: string; readonly reason?: string };
}

const evidenceKey = operationKey({ kind: "DISPUTE_EVIDENCE", jobId, disputeId: "PP-D-9", payee: merchant, notes: "n", attempt: 1, simulated: false });
const acceptKey = operationKey({ kind: "DISPUTE_ACCEPT", jobId, disputeId: "PP-D-9", payee: merchant, note: "n", simulated: false });
const evidencePath = "/v1/customer/disputes/PP-D-9/provide-evidence";
const acceptPath = "/v1/customer/disputes/PP-D-9/accept-claim";

test("an open dispute's evidence and its accepted claim each reach PayPal once, at their own path, under their own request id", async () => {
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(verifiedRow(), async store => {
			const ports = portsOver(store);
			assert.equal((await applySystemCommand(ports, dispute("OPEN"), null, "webhook-evidence")).refused, null);
			assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
			assert.equal(outboxStateOf(store, evidenceKey).kind, "CONFIRMED");
		});
		assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(evidenceKey) }]);
	});
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(fundedRow(), async store => {
			const ports = portsOver(store);
			assert.equal((await applySystemCommand(ports, dispute("OPEN"), null, "webhook-accept")).refused, null);
			assert.equal(await runOutboxOnce(ports, acceptKey), "WORKED");
			assert.equal(outboxStateOf(store, acceptKey).kind, "CONFIRMED");
		});
		assert.deepEqual(calls, [{ path: acceptPath, requestId: providerRequestId(acceptKey) }]);
	});
});

test("an answer whose dispute is already resolved when the outbox reaches it is delivered as done, with no call", async () => {
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(verifiedRow(), async store => {
			const ports = portsOver(store);
			await applySystemCommand(ports, dispute("OPEN"), null, "webhook-open");
			assert.equal((await applySystemCommand(ports, dispute("RESOLVED", "RESOLVED_SELLER_FAVOUR"), null, "webhook-resolved")).refused, null);
			assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
			assert.equal(outboxStateOf(store, evidenceKey).kind, "CONFIRMED");
		});
		await withStore(fundedRow(), async store => {
			const ports = portsOver(store);
			await applySystemCommand(ports, dispute("OPEN"), null, "webhook-open");
			assert.equal((await applySystemCommand(ports, dispute("RESOLVED", "RESOLVED_SELLER_FAVOUR"), null, "webhook-resolved")).refused, null);
			assert.equal(await runOutboxOnce(ports, acceptKey), "WORKED");
			assert.equal(outboxStateOf(store, acceptKey).kind, "CONFIRMED");
		});
		assert.deepEqual(calls, []);
	});
});

test("an accepted claim that the verdict superseded is delivered as done with no call, and the evidence that replaces it is sent once", async () => {
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(verifyingRow(), async store => {
			const ports = portsOver(store);
			await applySystemCommand(ports, dispute("OPEN"), null, "webhook-open");
			assert.equal((await applySystemCommand(ports, verifiedReport(), null, "verifier:run_dispute_1")).refused, null);
			assert.equal(await runOutboxOnce(ports, acceptKey), "WORKED");
			assert.equal(outboxStateOf(store, acceptKey).kind, "CONFIRMED");
			assert.deepEqual(calls, []);
			assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
			assert.equal(outboxStateOf(store, evidenceKey).kind, "CONFIRMED");
		});
		assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(evidenceKey) }]);
	});
});

test("a dispute answer PayPal refuses with a 422 that names no settled answer is parked for a person, and is not resent", async () => {
	await withRecordedPayPal(() => Response.json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "EVIDENCE_NOT_ACCEPTED" }] }, { status: 422 }),
		async calls => {
			await withStore(verifiedRow(), async store => {
				const ports = portsOver(store);
				await applySystemCommand(ports, dispute("OPEN"), null, "webhook-open");
				assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
				const state = outboxStateOf(store, evidenceKey);
				assert.equal(state.kind, "NEEDS_HUMAN");
				assert.equal(state.reason, "PAYPAL_422_EVIDENCE_NOT_ACCEPTED");
			});
			assert.equal(calls.length, 1);
		});
});

/** A verified job the client has disputed, so the arbiter has a dispute to rule on. */
function disputedRow(): JobRow {
	return planOf(applyJobCommand(verifiedRow(), { type: "Dispute", jobId, mergeCommit: judgedCommit, reason: "Scripted dispute." }, userFacts(maya))).next;
}

test("evidence queued for an open dispute is never sent once the arbiter rules a refund or a rework, and is delivered as done", async () => {
	const arbiter: Actor = { role: "ARBITER", staffId: "staff-arbiter" as StaffId };
	for (const verdict of ["REFUND", "REWORK"] as const) {
		await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
			await withStore(disputedRow(), async store => {
				const ports = portsOver(store);
				assert.equal((await applySystemCommand(ports, dispute("OPEN"), null, "webhook-open")).refused, null, verdict);
				assert.equal(outboxStateOf(store, evidenceKey).kind, "READY", verdict);
				const ruled = await executeCommand(ports, arbiter, parseRequestKey(randomUUID()),
					{ type: "ResolveDispute", jobId, verdict, note: "Scripted arbiter ruling." });
				assert.equal(ruled.kind, "COMMITTED", verdict);
				assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED", verdict);
				assert.equal(outboxStateOf(store, evidenceKey).kind, "CONFIRMED", verdict);
			});
			// A refund the arbiter selected goes to the capture's refund path. The dispute's evidence path is never reached.
			assert.deepEqual(calls.filter(call => call.path === evidencePath), [], verdict);
		});
	}
});

/** The arbiter who rules a dispute, and the operator who submits the job's work. */
const ruler: Actor = { role: "ARBITER", staffId: "staff-arbiter" as StaffId };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };

test("a rework hands the open dispute's answer back, and the verified attempt after it answers the dispute with its own evidence, once", () => {
	const opened = planOf(applyJobCommand(disputedRow(), dispute("OPEN"), paypalFacts(later)));
	const first = evidenceFrom(opened);
	assert.equal(first.attempt, 1);
	const reworked = planOf(applyJobCommand(opened.next, { type: "ResolveDispute", jobId, verdict: "REWORK", note: "Scripted rework." }, userFacts(ruler)));
	assert.equal(reworked.next.state.status, "IN_PROGRESS");
	assert.equal(reworked.next.providerDispute?.status, "OPEN");
	assert.equal(reworked.next.providerDispute?.answer, undefined);
	assert.deepEqual(reworked.effects, []);
	assert.equal(effectWanted(reworked.next, first), false);
	// The next run is judged VERIFIED on the open dispute: its evidence is the answer, filed for attempt 2 under its own key.
	const submitted = planOf(applyJobCommand(reworked.next, { type: "Submit", jobId, sourceCommit }, userFacts(devon)));
	const attempts = (submitted.next.state as Extract<typeof submitted.next.state, { status: "IN_PROGRESS" }>).attempts;
	if (attempts.phase !== "VERIFYING") throw new Error(`expected VERIFYING, got ${attempts.phase}`);
	const verdict = { ...passedVerdict, runId: attempts.pending.runId, sourceCommit };
	const verified = planOf(applyJobCommand(submitted.next, { type: "VerifierFinished", jobId, report: { kind: "VERDICT", verdict } }, paypalFacts(later)));
	assert.equal(verified.next.state.status, "VERIFIED");
	assert.equal(verified.next.providerDispute?.answer, "EVIDENCE");
	assert.deepEqual(verified.effects.map(effect => effect.kind), ["DISPUTE_EVIDENCE"]);
	const second = evidenceFrom(verified);
	assert.equal(second.attempt, 2);
	assert.equal(effectWanted(verified.next, second), true);
	// Attempt 1's evidence answers a verdict the row no longer holds, so it is not wanted once attempt 2 passed.
	assert.equal(effectWanted(verified.next, first), false);
	assert.notEqual(operationKey(second), operationKey(first));
	// The verdict is spent: a repeat of it is refused, so the evidence is filed once.
	assert.equal(applyJobCommand(verified.next, { type: "VerifierFinished", jobId, report: { kind: "VERDICT", verdict } }, paypalFacts(later)), "WRONG_STATE");
});

test("an evidence answer's key names its dispute and its verified attempt, never the wording of its notes", () => {
	const evidence = (disputeId: string, attempt: 1 | 2, notes: string): JobEffect =>
		({ kind: "DISPUTE_EVIDENCE", jobId, disputeId, payee: merchant, notes, attempt, simulated: false });
	assert.equal(operationKey(evidence("PP-D-9", 1, "first wording")), operationKey(evidence("PP-D-9", 1, "second wording")));
	assert.notEqual(operationKey(evidence("PP-D-9", 1, "n")), operationKey(evidence("PP-D-9", 2, "n")));
	assert.notEqual(operationKey(evidence("PP-D-9", 1, "n")), operationKey(evidence("PP-D-10", 1, "n")));
});

test("a rework, then the verified attempt after it, sends the evidence once through the outbox under a new request id, and a repeat sends nothing", async () => {
	const started: VerifierRunId[] = [];
	const afterRework = operationKey({ kind: "DISPUTE_EVIDENCE", jobId, disputeId: "PP-D-9", payee: merchant, notes: "n", attempt: 2, simulated: false });
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(disputedRow(), async store => {
			// A Submit starts a judged run only over a frozen manifest, so the job's manifest is written the way OpenJob writes it.
			store.db.prepare("INSERT INTO job_manifests VALUES (?, ?)").run(jobId, JSON.stringify(manifestOf(demoFixture(exampleContract), "maya-client/invoice-app")));
			const base = portsOver(store);
			const ports: Ports = { ...base, verifier: { start: async request => { started.push(request.runId); }, parseCallback: async () => null } };
			assert.equal((await applySystemCommand(ports, dispute("OPEN"), null, "webhook-open")).refused, null);
			assert.equal((await executeCommand(ports, ruler, parseRequestKey(randomUUID()),
				{ type: "ResolveDispute", jobId, verdict: "REWORK", note: "Scripted rework." })).kind, "COMMITTED");
			// The rework hands the answer back: the first attempt's evidence is delivered as done, with no call.
			assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
			assert.equal(outboxStateOf(store, evidenceKey).kind, "CONFIRMED");
			assert.deepEqual(calls, []);
			assert.equal((await executeCommand(ports, devon, parseRequestKey(randomUUID()), { type: "Submit", jobId, sourceCommit })).kind, "COMMITTED");
			assert.equal(started.length, 1);
			const verdict = { ...passedVerdict, runId: started[0], sourceCommit };
			assert.equal((await applySystemCommand(ports, { type: "VerifierFinished", jobId, report: { kind: "VERDICT", verdict } }, null,
				`verifier:${started[0]}`)).refused, null);
			assert.equal(await runOutboxOnce(ports, afterRework), "WORKED");
			assert.equal(outboxStateOf(store, afterRework).kind, "CONFIRMED");
			// The same dispute delivered again, and the same attempt's answer again, sends nothing more.
			assert.equal((await applySystemCommand(ports, dispute("OPEN"), null, "webhook-repeat")).refused, null);
			assert.equal(await runOutboxOnce(ports, afterRework), "IDLE");
		});
		assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(afterRework) }]);
	});
	assert.notEqual(providerRequestId(afterRework), providerRequestId(evidenceKey));
});

test("a refund ruled on an open dispute keeps the answer it had, queues only the refund, and files no dispute answer", () => {
	const opened = planOf(applyJobCommand(disputedRow(), dispute("OPEN"), paypalFacts(later)));
	const refund = planOf(applyJobCommand(opened.next, { type: "ResolveDispute", jobId, verdict: "REFUND", note: "Scripted refund." }, userFacts(ruler)));
	assert.deepEqual(refund.effects.map(effect => effect.kind), ["REFUND"]);
	assert.equal(refund.next.providerDispute?.answer, "EVIDENCE");
	assert.equal(effectWanted(refund.next, evidenceFrom(opened)), false);
});

test("attempt 1's evidence still queued when attempt 2 passes after a rework is done with no call, and attempt 2's evidence is sent once", async () => {
	const started: VerifierRunId[] = [];
	const afterRework = operationKey({ kind: "DISPUTE_EVIDENCE", jobId, disputeId: "PP-D-9", payee: merchant, notes: "n", attempt: 2, simulated: false });
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(disputedRow(), async store => {
			store.db.prepare("INSERT INTO job_manifests VALUES (?, ?)").run(jobId, JSON.stringify(manifestOf(demoFixture(exampleContract), "maya-client/invoice-app")));
			const base = portsOver(store);
			const ports: Ports = { ...base, verifier: { start: async request => { started.push(request.runId); }, parseCallback: async () => null } };
			assert.equal((await applySystemCommand(ports, dispute("OPEN"), null, "webhook-open")).refused, null);
			assert.equal((await executeCommand(ports, ruler, parseRequestKey(randomUUID()),
				{ type: "ResolveDispute", jobId, verdict: "REWORK", note: "Scripted rework." })).kind, "COMMITTED");
			// Nothing drained attempt 1's evidence before the rework was verified, so it is still queued when attempt 2 passes.
			assert.equal(outboxStateOf(store, evidenceKey).kind, "READY");
			assert.equal((await executeCommand(ports, devon, parseRequestKey(randomUUID()), { type: "Submit", jobId, sourceCommit })).kind, "COMMITTED");
			assert.equal(started.length, 1);
			const verdict = { ...passedVerdict, runId: started[0], sourceCommit };
			assert.equal((await applySystemCommand(ports, { type: "VerifierFinished", jobId, report: { kind: "VERDICT", verdict } }, null,
				`verifier:${started[0]}`)).refused, null);
			// The queued attempt 1 evidence is done with no call. Attempt 2's evidence is the one PayPal receives.
			assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
			assert.equal(outboxStateOf(store, evidenceKey).kind, "CONFIRMED");
			assert.deepEqual(calls, []);
			assert.equal(await runOutboxOnce(ports, afterRework), "WORKED");
			assert.equal(outboxStateOf(store, afterRework).kind, "CONFIRMED");
		});
		assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(afterRework) }]);
	});
});

test("evidence queued before attempts were recorded, with no attempt on it, is still sent for the answer the row holds", async () => {
	// The key a row queued before this change holds: the old key was the dispute id alone, and its effect names no attempt.
	const legacyKey = `aq-${createHash("sha256").update(`${jobId}:DISPUTE_EVIDENCE:PP-D-9`).digest("hex").slice(0, 32)}` as OperationKey;
	const { attempt: _attempt, ...withoutAttempt } = evidenceFrom(planOf(applyJobCommand(disputedRow(), dispute("OPEN"), paypalFacts(later))));
	const legacy = withoutAttempt as unknown as JobEffect;
	const open = planOf(applyJobCommand(disputedRow(), dispute("OPEN"), paypalFacts(later))).next;
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(open, async store => {
			const ports = portsOver(store);
			await store.commit({ job: null, operator: null, credits: [], settlement: null, request: null, delivery: null,
				outbox: [{ key: legacyKey, effect: legacy, payloadDigest: "0".repeat(64) as Digest, state: { kind: "READY", runAt: later } }] });
			assert.equal(await runOutboxOnce(ports, legacyKey), "WORKED");
			assert.equal(outboxStateOf(store, legacyKey).kind, "CONFIRMED");
		});
		assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(legacyKey) }]);
	});
});

test("a dispute answer PayPal refuses with a 403 ends for a person with the plain reason, is sent once, and the held release stays held", async () => {
	await withRecordedPayPal(() => Response.json({ name: "NOT_AUTHORIZED" }, { status: 403 }), async calls => {
		await withStore(verifiedRow(), async store => {
			const ports = portsOver(store);
			assert.equal((await applySystemCommand(ports, dispute("OPEN"), null, "webhook-evidence-403")).refused, null);
			assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
			assert.deepEqual(outboxStateOf(store, evidenceKey), { kind: "NEEDS_HUMAN", reason: DISPUTE_ACCESS_REFUSED });
			assert.equal(await runOutboxOnce(ports, evidenceKey), "IDLE");
			const row = await store.readJob(jobId);
			if (row === null) throw new Error("the job is missing");
			assert.equal(releaseHeld(row), true);
			assert.deepEqual(await answerStateOf(store), { state: "REFUSED", reason: DISPUTE_ACCESS_REFUSED });
			assert.ok(queuedAlertsOf(store).some(alert => alert.reason === "PROVIDER_DISPUTE_ANSWER_REFUSED" && alert.disputeId === "PP-D-9" &&
				alert.detail === `${DISPUTE_ACCESS_REFUSED}. The payment stays held.`));
		});
		assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(evidenceKey) }]);
	});
});

test("a dispute answer is queued on the job until PayPal takes it, and then recorded as filed", async () => {
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(verifiedRow(), async store => {
			const ports = portsOver(store);
			await applySystemCommand(ports, dispute("OPEN"), null, "webhook-evidence-filed");
			assert.deepEqual(await answerStateOf(store), { state: "QUEUED" });
			assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
			assert.deepEqual(await answerStateOf(store), { state: "FILED" });
			assert.equal(outboxStateOf(store, evidenceKey).kind, "CONFIRMED");
			assert.equal(queuedAlertsOf(store).some(alert => alert.reason === "PROVIDER_DISPUTE_ANSWER_REFUSED"), false);
		});
		assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(evidenceKey) }]);
	});
});

/** A buyer dispute as PayPal reads it at a stage, with the answer links the read names and the time it was stamped. */
const disputeAt = (stage: string, offers: readonly DisputeOffer[], fields: { readonly updatedAt?: Instant } = {}) =>
	({ ...dispute("OPEN"), stage, offers, ...fields });

/** The row with a refusal on its answer, the way the outbox records a 403 for the answer it sent. */
function withRefusal(row: JobRow): JobRow {
	const held = row.providerDispute;
	if (held === undefined) throw new Error("expected a dispute on the row");
	return { ...row, providerDispute: { ...held, answerState: { state: "REFUSED", reason: DISPUTE_ACCESS_REFUSED } } };
}

const messageOf = (plan: Plan<JobRow>): Extract<JobEffect, { kind: "DISPUTE_MESSAGE" }> => {
	const [message] = plan.effects.filter((effect): effect is Extract<JobEffect, { kind: "DISPUTE_MESSAGE" }> => effect.kind === "DISPUTE_MESSAGE");
	if (message === undefined) throw new Error("expected one DISPUTE_MESSAGE");
	return message;
};

const messageKey = operationKey({ kind: "DISPUTE_MESSAGE", jobId, disputeId: "PP-D-9", payee: merchant, message: "n", attempt: 1, simulated: false });
const messagePath = "/v1/customer/disputes/PP-D-9/send-message";
const requeueKey = operationKey({ kind: "DISPUTE_EVIDENCE", jobId, disputeId: "PP-D-9", payee: merchant, notes: "n", attempt: 1, stage: "INQUIRY",
	requeued: true, simulated: false });

test("a verified job whose dispute offers a message and no evidence to provide takes the receipt as a message, not as evidence", () => {
	const opened = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["send_message", "accept_claim"]), paypalFacts(later)));
	assert.deepEqual(opened.effects.map(effect => effect.kind), ["DISPUTE_MESSAGE"]);
	const message = messageOf(opened);
	assert.equal(message.disputeId, "PP-D-9");
	assert.equal(message.payee, merchant);
	assert.equal(message.simulated, false);
	assert.ok(message.message.startsWith(`Verified attempt 1 for job ${jobId} passed run run_dispute_1`), "the message carries the same receipt-cited notes");
	assert.equal(opened.next.providerDispute?.answer, "MESSAGE");
	assert.deepEqual(opened.next.providerDispute?.answerState, { state: "QUEUED" });
	assert.equal(opened.next.providerDispute?.stage, "INQUIRY");
});

test("a dispute that offers evidence is answered with evidence even when it also offers a message, and one that names no links keeps evidence", () => {
	const both = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence", "send_message"]), paypalFacts(later)));
	assert.deepEqual(both.effects.map(effect => effect.kind), ["DISPUTE_EVIDENCE"]);
	assert.equal(both.next.providerDispute?.answer, "EVIDENCE");
	const unnamed = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", []), paypalFacts(later)));
	assert.deepEqual(unnamed.effects.map(effect => effect.kind), ["DISPUTE_EVIDENCE"]);
	assert.equal(unnamed.next.providerDispute?.answer, "EVIDENCE");
});

test("a dispute that escalates to a stage offering evidence is answered with evidence once for that stage, and its message is no longer wanted", () => {
	const inquiry = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["send_message"]), paypalFacts(later)));
	const message = messageOf(inquiry);
	const escalated = planOf(applyJobCommand(inquiry.next, disputeAt("CHARGEBACK", ["provide_evidence", "accept_claim"], { updatedAt: later }),
		paypalFacts(later)));
	assert.deepEqual(escalated.effects.map(effect => effect.kind), ["DISPUTE_EVIDENCE"]);
	const evidence = evidenceFrom(escalated);
	assert.equal(evidence.stage, "CHARGEBACK");
	assert.equal(escalated.next.providerDispute?.answer, "EVIDENCE");
	assert.equal(effectWanted(escalated.next, message), false);
	assert.equal(effectWanted(escalated.next, evidence), true);
	// The same stage again files nothing new: each stage is answered once.
	const repeat = planOf(applyJobCommand(escalated.next, disputeAt("CHARGEBACK", ["provide_evidence", "accept_claim"], { updatedAt: later }),
		paypalFacts(later)));
	assert.deepEqual(repeat.effects, []);
});

test("a refused answer is re-queued once, after a successful read offers its link, and a second refusal of it stays refused", () => {
	const filed = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence"], { updatedAt: now }), paypalFacts(later)));
	const read = planOf(applyJobCommand(withRefusal(filed.next), disputeAt("INQUIRY", ["provide_evidence", "accept_claim"], { updatedAt: later }),
		paypalFacts(later)));
	assert.deepEqual(read.effects.map(effect => effect.kind), ["DISPUTE_EVIDENCE"]);
	const requeued = evidenceFrom(read);
	assert.equal(requeued.requeued, true);
	assert.equal(requeued.stage, "INQUIRY");
	assert.deepEqual(read.next.providerDispute?.answerState, { state: "QUEUED" });
	assert.equal(read.next.providerDispute?.requeued, true);
	assert.equal(operationKey(requeued), requeueKey);
	assert.notEqual(operationKey(requeued), evidenceKey, "the re-queue is its own answer, not a replay of the refused one");
	const again = planOf(applyJobCommand(withRefusal(read.next), disputeAt("INQUIRY", ["provide_evidence", "accept_claim"], { updatedAt: later }),
		paypalFacts(later)));
	assert.deepEqual(again.effects, []);
	assert.deepEqual(again.next.providerDispute?.answerState, { state: "REFUSED", reason: DISPUTE_ACCESS_REFUSED });
});

test("a refused evidence answer is re-queued as a message where the successful read offers only a message", () => {
	const filed = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence"], { updatedAt: now }), paypalFacts(later)));
	const read = planOf(applyJobCommand(withRefusal(filed.next), disputeAt("INQUIRY", ["send_message", "accept_claim"], { updatedAt: later }),
		paypalFacts(later)));
	assert.deepEqual(read.effects.map(effect => effect.kind), ["DISPUTE_MESSAGE"]);
	assert.equal(read.next.providerDispute?.answer, "MESSAGE");
});

test("a read that does not offer the refused answer's link re-queues nothing, and a stand-in never re-queues", () => {
	const filed = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence"], { updatedAt: now }), paypalFacts(later)));
	const unoffered = planOf(applyJobCommand(withRefusal(filed.next), disputeAt("INQUIRY", ["accept_claim"], { updatedAt: later }), paypalFacts(later)));
	assert.deepEqual(unoffered.effects, []);
	const standIn = { ...disputeAt("INQUIRY", ["provide_evidence"], { updatedAt: later }), fromVerifiedBody: true as const };
	const body = planOf(applyJobCommand(withRefusal(filed.next), standIn, paypalFacts(later)));
	assert.deepEqual(body.effects.map(effect => effect.kind), ["ALERT"]);
	assert.equal(body.next.providerDispute?.requeued, undefined);
});

test("a verdict that lands on a claim accepted for a funded job answers with a message where the dispute offers no evidence to provide", () => {
	const accepted = planOf(applyJobCommand(verifyingRow(), disputeAt("INQUIRY", ["send_message", "accept_claim"]), paypalFacts(later)));
	assert.equal(accepted.next.providerDispute?.answer, "ACCEPT");
	const verified = planOf(applyJobCommand(accepted.next, verifiedReport(), paypalFacts(later)));
	assert.deepEqual(verified.effects.map(effect => effect.kind), ["DISPUTE_MESSAGE"]);
	assert.equal(verified.next.providerDispute?.answer, "MESSAGE");
});

test("an escalated answer, a re-queued answer, and a message each key their own round, and a first answer keeps the key it always had", () => {
	const first: Extract<JobEffect, { kind: "DISPUTE_EVIDENCE" }> = { kind: "DISPUTE_EVIDENCE", jobId, disputeId: "PP-D-9", payee: merchant, notes: "n",
		attempt: 1, simulated: false };
	assert.equal(operationKey(first), evidenceKey);
	const staged: Extract<JobEffect, { kind: "DISPUTE_EVIDENCE" }> = { ...first, stage: "CHARGEBACK" };
	assert.notEqual(operationKey(staged), evidenceKey);
	assert.notEqual(operationKey(staged), operationKey({ ...first, stage: "INQUIRY" }));
	assert.notEqual(operationKey({ ...first, requeued: true }), evidenceKey);
	assert.notEqual(operationKey({ ...first, stage: "INQUIRY", requeued: true }), operationKey({ ...first, stage: "INQUIRY" }));
	const message: Extract<JobEffect, { kind: "DISPUTE_MESSAGE" }> = { kind: "DISPUTE_MESSAGE", jobId, disputeId: "PP-D-9", payee: merchant, message: "n",
		attempt: 1, simulated: false };
	assert.equal(operationKey(message), messageKey);
	assert.notEqual(operationKey(message), evidenceKey);
	assert.notEqual(operationKey({ ...acceptEffect(), requeued: true }), acceptKey);
});

/** The accepted claim this file files for PP-D-9 on the test merchant, as the funded job names it. */
const acceptEffect = (): Extract<JobEffect, { kind: "DISPUTE_ACCEPT" }> => ({ kind: "DISPUTE_ACCEPT", jobId, disputeId: "PP-D-9", payee: merchant,
	note: "n", simulated: false });

test("a message answer reaches PayPal at its send-message path under its own request id, and is recorded as filed", async () => {
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(verifiedRow(), async store => {
			const ports = portsOver(store);
			await applySystemCommand(ports, disputeAt("INQUIRY", ["send_message", "accept_claim"]), null, "webhook-message");
			assert.deepEqual(await answerStateOf(store), { state: "QUEUED" });
			assert.equal(await runOutboxOnce(ports, messageKey), "WORKED");
			assert.deepEqual(await answerStateOf(store), { state: "FILED" });
			assert.equal(outboxStateOf(store, messageKey).kind, "CONFIRMED");
		});
		assert.deepEqual(calls, [{ path: messagePath, requestId: providerRequestId(messageKey) }]);
	});
});

test("a dispute answer refused for lack of access is sent again once, under its own request id, after a successful read offers its link", async () => {
	let answers = 0;
	await withRecordedPayPal(() => (answers++ === 0 ? Response.json({ name: "NOT_AUTHORIZED" }, { status: 403 }) : new Response(null, { status: 204 })),
		async calls => {
			await withStore(verifiedRow(), async store => {
				const ports = portsOver(store);
				await applySystemCommand(ports, disputeAt("INQUIRY", ["provide_evidence"], { updatedAt: now }), null, "webhook-refused-first");
				assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
				assert.deepEqual(await answerStateOf(store), { state: "REFUSED", reason: DISPUTE_ACCESS_REFUSED });
				await applySystemCommand(ports, disputeAt("INQUIRY", ["provide_evidence", "accept_claim"], { updatedAt: later }), null, "webhook-read-ok");
				assert.deepEqual(await answerStateOf(store), { state: "QUEUED" });
				assert.equal(await runOutboxOnce(ports, requeueKey), "WORKED");
				assert.deepEqual(await answerStateOf(store), { state: "FILED" });
				assert.equal(queuedAlertsOf(store).filter(alert => alert.reason === "PROVIDER_DISPUTE_ANSWER_REFUSED").length, 1);
			});
			assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(evidenceKey) },
				{ path: evidencePath, requestId: providerRequestId(requeueKey) }]);
		});
});

/** The escalated stage's evidence: the same dispute and attempt as the inquiry's, answered again for the stage it escalated to. */
const escalatedEvidenceKey = operationKey({ kind: "DISPUTE_EVIDENCE", jobId, disputeId: "PP-D-9", payee: merchant, notes: "n", attempt: 1,
	stage: "CHARGEBACK", simulated: false });

test("a late PayPal reply for an earlier round files nothing and alerts nothing on the round the row holds, and that round is not sent", async () => {
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async calls => {
		await withStore(verifiedRow(), async store => {
			const ports = portsOver(store);
			await applySystemCommand(ports, disputeAt("INQUIRY", ["provide_evidence"], { updatedAt: now }), null, "webhook-inquiry");
			// The inquiry's evidence is still queued when the dispute escalates to a stage that offers evidence: the escalation is the round held now.
			await applySystemCommand(ports, disputeAt("CHARGEBACK", ["provide_evidence"], { updatedAt: later }), null, "webhook-chargeback");
			assert.deepEqual(await answerStateOf(store), { state: "QUEUED" });
			// PayPal's reply for the inquiry round lands after the escalation. Neither a filing nor a refusal of it moves the escalated answer.
			assert.equal((await applySystemCommand(ports, { type: "DisputeAnswerFiled", jobId, disputeId: "PP-D-9", answer: "EVIDENCE", round: "PP-D-9:1" },
				null, null)).refused, null);
			assert.deepEqual(await answerStateOf(store), { state: "QUEUED" });
			await applySystemCommand(ports, { type: "DisputeAnswerRefused", jobId, disputeId: "PP-D-9", answer: "EVIDENCE", reason: DISPUTE_ACCESS_REFUSED,
				round: "PP-D-9:1" }, null, null);
			assert.deepEqual(await answerStateOf(store), { state: "QUEUED" });
			assert.equal(queuedAlertsOf(store).some(alert => alert.reason === "PROVIDER_DISPUTE_ANSWER_REFUSED"), false);
			// The inquiry round's evidence is done with no call, and the escalated evidence is the one PayPal receives.
			assert.equal(await runOutboxOnce(ports, evidenceKey), "WORKED");
			assert.equal(outboxStateOf(store, evidenceKey).kind, "CONFIRMED");
			assert.equal(await runOutboxOnce(ports, escalatedEvidenceKey), "WORKED");
			assert.deepEqual(await answerStateOf(store), { state: "FILED" });
		});
		assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(escalatedEvidenceKey) }]);
	});
});

test("a late refusal for the round a re-queue replaced files nothing and alerts nothing on the re-queued round", () => {
	const filed = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence"], { updatedAt: now }), paypalFacts(later)));
	const read = planOf(applyJobCommand(withRefusal(filed.next), disputeAt("INQUIRY", ["provide_evidence", "accept_claim"], { updatedAt: later }),
		paypalFacts(later)));
	assert.equal(read.next.providerDispute?.answerRound, "PP-D-9:1:INQUIRY:requeued");
	const late = planOf(applyJobCommand(read.next, { type: "DisputeAnswerRefused", jobId, disputeId: "PP-D-9", answer: "EVIDENCE",
		reason: DISPUTE_ACCESS_REFUSED, round: "PP-D-9:1" }, paypalFacts(later)));
	assert.deepEqual(late.next.providerDispute?.answerState, { state: "QUEUED" });
	assert.deepEqual(late.effects, []);
});

/** The dispute at CHARGEBACK offering evidence, with the evidence types the read asks the seller for when it names any. */
const chargeback = (fields: { readonly updatedAt?: Instant } = {}, requested?: readonly string[]) =>
	({ ...disputeAt("CHARGEBACK", ["provide_evidence", "accept_claim"], fields), ...(requested === undefined ? {} : { requestedEvidence: requested }) });

/** The row once PayPal refused the evidence answer for its type, with the type it was sent as when that is recorded. */
function refusedAt(row: JobRow, reason: string, evidenceType?: EvidenceType): JobRow {
	const held = row.providerDispute;
	if (held === undefined) throw new Error("expected a dispute on the row");
	return { ...row, providerDispute: { ...held, answerState: { state: "REFUSED", reason, ...(evidenceType === undefined ? {} : { evidenceType }) } } };
}

test("the evidence answer files the type PayPal asks for: OTHER when it asks for OTHER, never PROOF_OF_REFUND", () => {
	const asked = planOf(applyJobCommand(verifiedRow(), chargeback({ updatedAt: now }, ["PROOF_OF_REFUND", "OTHER"]), paypalFacts(later)));
	assert.equal(evidenceFrom(asked).evidenceType, "OTHER");
	assert.equal(asked.next.providerDispute?.requestedEvidence?.join(","), "PROOF_OF_REFUND,OTHER");
	// A read that names no type keeps the type every answer carried before types were read.
	const unnamed = planOf(applyJobCommand(verifiedRow(), chargeback({ updatedAt: now }), paypalFacts(later)));
	assert.equal(evidenceFrom(unnamed).evidenceType, "PROOF_OF_FULFILLMENT");
	assert.equal(unnamed.next.providerDispute?.requestedEvidence, undefined);
});

test("PayPal asks only for evidence types Acquit cannot honestly give: no evidence is filed, the answer is refused, and the hold stays", () => {
	const plan = planOf(applyJobCommand(verifiedRow(), chargeback({ updatedAt: now }, ["PROOF_OF_REFUND"]), paypalFacts(later)));
	assert.deepEqual(evidenceOf(plan), []);
	assert.deepEqual(plan.next.providerDispute?.answerState, { state: "REFUSED", reason: NO_HONEST_EVIDENCE_TYPE });
	assert.deepEqual(alertsOf(plan).map(alert => [alert.reason, alert.detail]),
		[["PROVIDER_DISPUTE_ANSWER_REFUSED", `${NO_HONEST_EVIDENCE_TYPE}. The payment stays held.`]]);
	assert.equal(releaseHeld(plan.next), true);
});

test("PayPal's late filing of an evidence answer sent before the escalation files nothing on the refused escalation", () => {
	// The inquiry's evidence went out, then the dispute escalated to a stage asking only for a type Acquit cannot give. Nothing was sent for it.
	const inquiry = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence", "accept_claim"], { updatedAt: now }), paypalFacts(later)));
	const escalated = planOf(applyJobCommand(inquiry.next, chargeback({ updatedAt: later }, ["PROOF_OF_REFUND"]), paypalFacts(later)));
	assert.deepEqual(escalated.next.providerDispute?.answerState, { state: "REFUSED", reason: NO_HONEST_EVIDENCE_TYPE });
	const late = planOf(applyJobCommand(escalated.next, { type: "DisputeAnswerFiled", jobId, disputeId: "PP-D-9", answer: "EVIDENCE",
		round: "PP-D-9:1" }, paypalFacts(later)));
	assert.deepEqual(late.next.providerDispute?.answerState, { state: "REFUSED", reason: NO_HONEST_EVIDENCE_TYPE });
	assert.deepEqual(late.effects, []);
});

test("an evidence answer PayPal refused for its type is re-queued once as the type the read asks for, under a new request id, and a repeat queues nothing", () => {
	// The live sequence: the dispute opens at INQUIRY, escalates to CHARGEBACK, and the escalated evidence is the one PayPal refuses.
	const inquiry = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence", "accept_claim"], { updatedAt: now }), paypalFacts(later)));
	const filed = planOf(applyJobCommand(inquiry.next, chargeback({ updatedAt: later }), paypalFacts(later)));
	const first = evidenceFrom(filed);
	assert.equal(first.stage, "CHARGEBACK");
	assert.equal(filed.next.providerDispute?.answerRound, "PP-D-9:1:CHARGEBACK");
	const read = chargeback({ updatedAt: later }, ["PROOF_OF_REFUND", "OTHER"]);
	const requeue = planOf(applyJobCommand(refusedAt(filed.next, "PAYPAL_HTTP_400"), read, paypalFacts(later)));
	assert.deepEqual(requeue.effects.map(effect => effect.kind), ["DISPUTE_EVIDENCE"]);
	const retyped = evidenceFrom(requeue);
	assert.equal(retyped.evidenceType, "OTHER");
	assert.equal(retyped.requeued, true);
	assert.equal(retyped.stage, "CHARGEBACK");
	assert.equal(requeue.next.providerDispute?.answerRound, "PP-D-9:1:CHARGEBACK:requeued");
	assert.deepEqual(requeue.next.providerDispute?.answerState, { state: "QUEUED" });
	assert.equal(requeue.next.providerDispute?.requeued, true);
	assert.notEqual(operationKey(retyped), operationKey(first), "the retyped answer is its own request, not a replay of the refused one");
	// The same read again while the re-queue is queued: nothing new. Refused again as OTHER: still nothing, the one re-queue is spent.
	assert.deepEqual(planOf(applyJobCommand(requeue.next, read, paypalFacts(later))).effects, []);
	const again = planOf(applyJobCommand(refusedAt(requeue.next, "PAYPAL_400_EVIDENCE_TYPE_IS_NOT_ALLOWED", "OTHER"), read, paypalFacts(later)));
	assert.deepEqual(again.effects, []);
	assert.deepEqual(again.next.providerDispute?.answerState,
		{ state: "REFUSED", reason: "PAYPAL_400_EVIDENCE_TYPE_IS_NOT_ALLOWED", evidenceType: "OTHER" });
});

test("a refused evidence type is never re-queued as itself: a read that names no type, or the type refused, re-queues nothing", () => {
	const filed = planOf(applyJobCommand(verifiedRow(), chargeback({ updatedAt: now }), paypalFacts(later)));
	const refused = refusedAt(filed.next, "PAYPAL_HTTP_400");
	assert.deepEqual(planOf(applyJobCommand(refused, chargeback({ updatedAt: later }), paypalFacts(later))).effects, []);
	assert.deepEqual(planOf(applyJobCommand(refused, chargeback({ updatedAt: later }, ["PROOF_OF_FULFILLMENT"]), paypalFacts(later))).effects, []);
	const asOther = refusedAt(filed.next, "PAYPAL_400_EVIDENCE_TYPE_IS_NOT_ALLOWED", "OTHER");
	assert.deepEqual(planOf(applyJobCommand(asOther, chargeback({ updatedAt: later }, ["OTHER"]), paypalFacts(later))).effects, []);
});

test("a read that asks only for PROOF_OF_REFUND after a type refusal sends nothing, and the refusal stands for a person", () => {
	const filed = planOf(applyJobCommand(verifiedRow(), chargeback({ updatedAt: now }), paypalFacts(later)));
	const read = planOf(applyJobCommand(refusedAt(filed.next, "PAYPAL_HTTP_400"), chargeback({ updatedAt: later }, ["PROOF_OF_REFUND"]), paypalFacts(later)));
	assert.deepEqual(read.effects, []);
	assert.deepEqual(read.next.providerDispute?.answerState, { state: "REFUSED", reason: "PAYPAL_HTTP_400" });
});

test("the page shows the type an evidence answer filed, not the type a later delivery at the same stage asks for", () => {
	// Filed as OTHER at CHARGEBACK. A later delivery at that stage asks for PROOF_OF_FULFILLMENT: nothing new is filed, so OTHER stays.
	const filed = planOf(applyJobCommand(verifiedRow(), chargeback({ updatedAt: now }, ["PROOF_OF_REFUND", "OTHER"]), paypalFacts(later)));
	assert.equal(evidenceFrom(filed).evidenceType, "OTHER");
	const asked = planOf(applyJobCommand(filed.next, chargeback({ updatedAt: later }, ["PROOF_OF_FULFILLMENT"]), paypalFacts(later)));
	assert.deepEqual(asked.effects, []);
	assert.equal(asked.next.providerDispute?.requestedEvidence?.join(","), "PROOF_OF_FULFILLMENT");
	assert.equal(asked.next.providerDispute?.answerEvidenceType, "OTHER");
	assert.equal(projectJob(asked.next, maya, new Map()).providerDispute?.evidenceType, "OTHER");
	// A record stored before the filed type was kept names none, so the page reads plain evidence, never the type it now asks for.
	const held = asked.next.providerDispute;
	if (held === undefined) throw new Error("expected a dispute on the row");
	const { answerEvidenceType: _filed, ...stored } = held;
	const legacy: JobRow = { ...asked.next, providerDispute: stored };
	assert.equal(projectJob(legacy, maya, new Map()).providerDispute?.requestedEvidence?.join(","), "PROOF_OF_FULFILLMENT");
	assert.equal(projectJob(legacy, maya, new Map()).providerDispute?.evidenceType, null);
});

test("an escalation files the type its own stage asks for, and the record keeps that type for the new round", () => {
	const inquiry = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence", "accept_claim"], { updatedAt: now }), paypalFacts(later)));
	assert.equal(evidenceFrom(inquiry).evidenceType, "PROOF_OF_FULFILLMENT");
	const escalated = planOf(applyJobCommand(inquiry.next, chargeback({ updatedAt: later }, ["PROOF_OF_REFUND", "OTHER"]), paypalFacts(later)));
	assert.equal(evidenceFrom(escalated).evidenceType, "OTHER");
	assert.equal(escalated.next.providerDispute?.answerRound, "PP-D-9:1:CHARGEBACK");
	assert.equal(escalated.next.providerDispute?.answerEvidenceType, "OTHER");
	assert.equal(projectJob(escalated.next, maya, new Map()).providerDispute?.evidenceType, "OTHER");
});

/**
 * A dispute stored with the evidence types the read asks for, taken through the production sequence to a verified attempt 2: the
 * dispute opens, the client disputes the work, the arbiter reworks it, the work is submitted, and the verifier passes it.
 */
function attemptTwoAnswering(requested: readonly string[]): Plan<JobRow> {
	const opened = planOf(applyJobCommand(verifiedRow(), chargeback({ updatedAt: now }, requested), paypalFacts(later)));
	const disputed = planOf(applyJobCommand(opened.next, { type: "Dispute", jobId, mergeCommit: judgedCommit, reason: "Scripted dispute." }, userFacts(maya)));
	const reworked = planOf(applyJobCommand(disputed.next, { type: "ResolveDispute", jobId, verdict: "REWORK", note: "Scripted rework." }, userFacts(ruler)));
	const submitted = planOf(applyJobCommand(reworked.next, { type: "Submit", jobId, sourceCommit }, userFacts(devon)));
	const attempts = (submitted.next.state as Extract<typeof submitted.next.state, { status: "IN_PROGRESS" }>).attempts;
	if (attempts.phase !== "VERIFYING") throw new Error(`expected VERIFYING, got ${attempts.phase}`);
	const verdict = { ...passedVerdict, runId: attempts.pending.runId, sourceCommit };
	return planOf(applyJobCommand(submitted.next, { type: "VerifierFinished", jobId, report: { kind: "VERDICT", verdict } }, paypalFacts(later)));
}

test("a verified attempt 2 that answers a dispute asking for PROOF_OF_REFUND and OTHER files OTHER, never PROOF_OF_FULFILLMENT", () => {
	const verified = attemptTwoAnswering(["PROOF_OF_REFUND", "OTHER"]);
	assert.equal(verified.next.state.status, "VERIFIED");
	const evidence = evidenceFrom(verified);
	assert.equal(evidence.attempt, 2);
	assert.equal(evidence.evidenceType, "OTHER");
	assert.equal(evidence.requeued, undefined);
	assert.equal(effectWanted(verified.next, evidence), true);
	assert.deepEqual(verified.next.providerDispute?.answerState, { state: "QUEUED" });
	assert.equal(verified.next.providerDispute?.requestedEvidence?.join(","), "PROOF_OF_REFUND,OTHER");
	assert.equal(verified.next.providerDispute?.answerEvidenceType, "OTHER");
});

test("a verified attempt 2 that answers a dispute asking only for PROOF_OF_REFUND files no evidence, and the refusal stands for a person", () => {
	const verified = attemptTwoAnswering(["PROOF_OF_REFUND"]);
	assert.equal(verified.next.state.status, "VERIFIED");
	assert.deepEqual(evidenceOf(verified), []);
	assert.deepEqual(verified.next.providerDispute?.answerState, { state: "REFUSED", reason: NO_HONEST_EVIDENCE_TYPE });
	assert.deepEqual(alertsOf(verified).map(alert => [alert.reason, alert.detail]),
		[["PROVIDER_DISPUTE_ANSWER_REFUSED", `${NO_HONEST_EVIDENCE_TYPE}. The payment stays held.`]]);
	assert.equal(releaseHeld(verified.next), true);
});

test("the job keeps every answer PayPal took, in order: the inquiry's message, then the chargeback's evidence that escalated it", async () => {
	await withRecordedPayPal(() => new Response(null, { status: 204 }), async () => {
		await withStore(verifiedRow(), async store => {
			const ports = portsOver(store);
			await applySystemCommand(ports, disputeAt("INQUIRY", ["send_message", "accept_claim"]), null, "webhook-inquiry-message");
			assert.equal(await runOutboxOnce(ports, messageKey), "WORKED");
			await applySystemCommand(ports, disputeAt("CHARGEBACK", ["provide_evidence", "accept_claim"], { updatedAt: later }), null,
				"webhook-chargeback-evidence");
			assert.equal(await runOutboxOnce(ports, escalatedEvidenceKey), "WORKED");
			const history = (await store.readJob(jobId))?.providerDispute?.answerHistory ?? [];
			assert.deepEqual(history.map(entry => [entry.answer, entry.stage ?? null, entry.evidenceType ?? null]),
				[["MESSAGE", "INQUIRY", null], ["EVIDENCE", "CHARGEBACK", "PROOF_OF_FULFILLMENT"]]);
			assert.equal(history[1]?.round, "PP-D-9:1:CHARGEBACK");
			assert.equal((await store.readJob(jobId))?.providerDispute?.answerState?.state, "FILED");
		});
	});
});

test("a repeat filing for a round the history already holds adds nothing, and a refused answer adds nothing", () => {
	const filed = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence"]), paypalFacts(later)));
	const confirm = { type: "DisputeAnswerFiled" as const, jobId, disputeId: "PP-D-9", answer: "EVIDENCE" as const, round: answerRoundOf(evidenceFrom(filed)) };
	const once = planOf(applyJobCommand(filed.next, confirm, paypalFacts(later)));
	assert.equal(once.next.providerDispute?.answerHistory?.length, 1);
	// A repeat of the same confirmation changes nothing at all.
	assert.deepEqual(planOf(applyJobCommand(once.next, confirm, paypalFacts(later))).next, once.next);
	// The round's refusal, then PayPal's confirmation of the same round: the round is kept once, however its answer state reads.
	const again = planOf(applyJobCommand(withRefusal(once.next), confirm, paypalFacts(later)));
	assert.equal(again.next.providerDispute?.answerState?.state, "FILED");
	assert.equal(again.next.providerDispute?.answerHistory?.length, 1);
	// A refusal of a queued answer adds nothing to the history.
	const queued = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence"]), paypalFacts(later)));
	const refusal = { type: "DisputeAnswerRefused" as const, jobId, disputeId: "PP-D-9", answer: "EVIDENCE" as const, reason: DISPUTE_ACCESS_REFUSED,
		round: answerRoundOf(evidenceFrom(queued)) };
	const refused = planOf(applyJobCommand(queued.next, refusal, paypalFacts(later)));
	assert.equal(refused.next.providerDispute?.answerState?.state, "REFUSED");
	assert.equal(refused.next.providerDispute?.answerHistory, undefined);
});

test("the history keeps the newest ten answers, so the eleventh drops the oldest", () => {
	let row = verifiedRow();
	const rounds: string[] = [];
	for (let n = 1; n <= 11; n++) {
		const delivered = planOf(applyJobCommand(row, disputeAt(`STAGE-${n}`, ["provide_evidence", "accept_claim"]), paypalFacts(later)));
		const round = answerRoundOf(evidenceFrom(delivered));
		if (round === undefined) throw new Error("expected the evidence to name a round");
		rounds.push(round);
		row = planOf(applyJobCommand(delivered.next, { type: "DisputeAnswerFiled", jobId, disputeId: "PP-D-9", answer: "EVIDENCE", round }, paypalFacts(later))).next;
	}
	const history = row.providerDispute?.answerHistory ?? [];
	assert.equal(history.length, 10);
	assert.deepEqual(history.map(entry => entry.round), rounds.slice(1));
});

test("a rework keeps the answers the history holds, and hands back only the open answer", () => {
	const arbiter: Actor = { role: "ARBITER", staffId: "staff-arbiter" as StaffId };
	const filed = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence"]), paypalFacts(later)));
	const confirmed = planOf(applyJobCommand(filed.next, { type: "DisputeAnswerFiled", jobId, disputeId: "PP-D-9", answer: "EVIDENCE",
		round: answerRoundOf(evidenceFrom(filed)) }, paypalFacts(later)));
	const disputed = planOf(applyJobCommand(confirmed.next, { type: "Dispute", jobId, mergeCommit: judgedCommit, reason: "Not as described." }, userFacts(maya)));
	const reworked = planOf(applyJobCommand(disputed.next, { type: "ResolveDispute", jobId, verdict: "REWORK", note: "Address the export path." }, userFacts(arbiter)));
	assert.equal(reworked.next.state.status, "IN_PROGRESS");
	assert.equal(reworked.next.providerDispute?.answer, undefined);
	assert.deepEqual((reworked.next.providerDispute?.answerHistory ?? []).map(entry => [entry.answer, entry.round]),
		[["EVIDENCE", "PP-D-9:1"]]);
});

/**
 * PayPal's confirmation of an answer the outbox sent, filed the way the outbox files it: the round, stage, and type the answer was sent
 * under, and the time PayPal took it.
 */
const confirmationOf = (effect: Extract<JobEffect, { kind: "DISPUTE_EVIDENCE" | "DISPUTE_MESSAGE" }>, at: Instant) => {
	const filed = { type: "DisputeAnswerFiled" as const, jobId, disputeId: "PP-D-9", round: answerRoundOf(effect), stage: effect.filedStage, filedAt: at };
	return effect.kind === "DISPUTE_EVIDENCE" ? { ...filed, answer: "EVIDENCE" as const, evidenceType: effect.evidenceType }
		: { ...filed, answer: "MESSAGE" as const };
};

/** The history as the test reads it: answer, stage, round, type, and time of each entry, in the order the record keeps them. */
const historyOf = (row: JobRow) => (row.providerDispute?.answerHistory ?? []).map(entry =>
	[entry.answer, entry.stage ?? null, entry.round, entry.evidenceType ?? null, entry.filedAt]);

/** The inquiry's message queued, then the chargeback escalation queued its evidence: the row, and the two answers PayPal will confirm. */
function messageThenEscalated() {
	const opened = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["send_message", "accept_claim"]), paypalFacts(later)));
	const escalated = planOf(applyJobCommand(opened.next, chargeback({ updatedAt: later }), paypalFacts(later)));
	return { row: escalated.next, message: messageOf(opened), evidence: evidenceFrom(escalated) };
}

const messageAt = instant("2026-10-06T12:10:00Z");
const evidenceAt = instant("2026-10-06T12:20:00Z");

test("the job view serves the round and stage the answer is for and every answer PayPal took, and a record stored before the history serves none", () => {
	const filed = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["provide_evidence"]), paypalFacts(later)));
	const evidence = evidenceFrom(filed);
	const round = answerRoundOf(evidence);
	const confirmed = planOf(applyJobCommand(filed.next, confirmationOf(evidence, later), paypalFacts(later)));
	const view = projectJob(confirmed.next, maya, new Map()).providerDispute;
	assert.equal(view?.answerRound, round);
	assert.equal(view?.answerStage, "INQUIRY");
	assert.deepEqual(view?.answerHistory.map(entry => [entry.answer, entry.stage ?? null, entry.round]), [["EVIDENCE", "INQUIRY", round]]);
	const held = confirmed.next.providerDispute;
	if (held === undefined) throw new Error("expected a dispute on the row");
	const legacy: JobRow = { ...confirmed.next, providerDispute: { ...held, answerRound: undefined, answerHistory: undefined } };
	const legacyView = projectJob(legacy, maya, new Map()).providerDispute;
	assert.equal(legacyView?.answerRound, null);
	assert.deepEqual(legacyView?.answerHistory, []);
});

test("a late message confirmation after the chargeback queued its evidence is kept ahead of the evidence, and files nothing on that round", () => {
	const { row, message, evidence } = messageThenEscalated();
	assert.equal(row.providerDispute?.answerState?.state, "QUEUED");
	const late = planOf(applyJobCommand(row, confirmationOf(message, messageAt), paypalFacts(later))).next;
	assert.equal(late.providerDispute?.answer, "EVIDENCE");
	assert.equal(late.providerDispute?.answerRound, answerRoundOf(evidence));
	assert.equal(late.providerDispute?.answerState?.state, "QUEUED");
	assert.deepEqual(historyOf(late), [["MESSAGE", "INQUIRY", answerRoundOf(message), null, messageAt]]);
	// PayPal's confirmation of the same message again adds nothing.
	assert.deepEqual(planOf(applyJobCommand(late, confirmationOf(message, messageAt), paypalFacts(later))).next, late);
	const filed = planOf(applyJobCommand(late, confirmationOf(evidence, evidenceAt), paypalFacts(later))).next;
	assert.equal(filed.providerDispute?.answerState?.state, "FILED");
	assert.equal(filed.providerDispute?.answerStage, "CHARGEBACK");
	assert.deepEqual(historyOf(filed), [["MESSAGE", "INQUIRY", answerRoundOf(message), null, messageAt],
		["EVIDENCE", "CHARGEBACK", answerRoundOf(evidence), "PROOF_OF_FULFILLMENT", evidenceAt]]);
	assert.equal(projectJob(filed, maya, new Map()).providerDispute?.answerStage, "CHARGEBACK");
});

test("the same two confirmations, the evidence first, leave the history in the order PayPal took the answers", () => {
	const { row, message, evidence } = messageThenEscalated();
	const filed = planOf(applyJobCommand(row, confirmationOf(evidence, evidenceAt), paypalFacts(later))).next;
	assert.equal(filed.providerDispute?.answerState?.state, "FILED");
	assert.deepEqual(historyOf(filed), [["EVIDENCE", "CHARGEBACK", answerRoundOf(evidence), "PROOF_OF_FULFILLMENT", evidenceAt]]);
	const late = planOf(applyJobCommand(filed, confirmationOf(message, messageAt), paypalFacts(later))).next;
	assert.equal(late.providerDispute?.answer, "EVIDENCE");
	assert.equal(late.providerDispute?.answerStage, "CHARGEBACK");
	assert.equal(late.providerDispute?.answerState?.state, "FILED");
	assert.deepEqual(historyOf(late), [["MESSAGE", "INQUIRY", answerRoundOf(message), null, messageAt],
		["EVIDENCE", "CHARGEBACK", answerRoundOf(evidence), "PROOF_OF_FULFILLMENT", evidenceAt]]);
});

test("a late message confirmation over a refusal for no honest evidence type is kept, and the refusal stands", () => {
	const opened = planOf(applyJobCommand(verifiedRow(), disputeAt("INQUIRY", ["send_message", "accept_claim"]), paypalFacts(later)));
	const message = messageOf(opened);
	const refused = planOf(applyJobCommand(opened.next, chargeback({ updatedAt: later }, ["PROOF_OF_REFUND"]), paypalFacts(later)));
	assert.deepEqual(refused.next.providerDispute?.answerState, { state: "REFUSED", reason: NO_HONEST_EVIDENCE_TYPE });
	assert.equal(refused.next.providerDispute?.answerStage, "CHARGEBACK");
	const late = planOf(applyJobCommand(refused.next, confirmationOf(message, messageAt), paypalFacts(later)));
	// PayPal took the message, so it is kept. The refusal for no honest type was never sent, so PayPal's confirmation files nothing on it.
	assert.deepEqual(late.next.providerDispute?.answerState, { state: "REFUSED", reason: NO_HONEST_EVIDENCE_TYPE });
	assert.equal(late.next.providerDispute?.answer, "EVIDENCE");
	assert.deepEqual(historyOf(late.next), [["MESSAGE", "INQUIRY", answerRoundOf(message), null, messageAt]]);
	assert.deepEqual(late.effects, []);
});

test("a confirmation without the stage or type it was sent under keeps only its answer, round, and time", () => {
	const { row, message } = messageThenEscalated();
	const late = planOf(applyJobCommand(row, { type: "DisputeAnswerFiled", jobId, disputeId: "PP-D-9", answer: "MESSAGE", round: answerRoundOf(message) },
		paypalFacts(later))).next;
	assert.deepEqual(late.providerDispute?.answerHistory, [{ answer: "MESSAGE", round: answerRoundOf(message), filedAt: later }]);
});
