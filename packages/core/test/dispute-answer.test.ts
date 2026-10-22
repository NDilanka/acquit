// What Acquit files when PayPal opens a buyer dispute: the receipt as evidence for a paid or verified job, the
// accepted claim for a funded job with no verified attempt, and an alert alone for a job with no held escrow.
// A buyer-favour resolution on a held full-amount escrow settles the job as refunded, with no call to PayPal.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { applyJobCommand, effectWanted, releaseHeld, storedBook, TERMS, wakeAt } from "../src/job.ts";
import type { JobEffect, JobRow, Plan } from "../src/job.ts";
import { applySystemCommand, executeCommand, operationKey, providerRequestId, runOutboxOnce } from "../src/effects.ts";
import type { OperationKey, Ports } from "../src/effects.ts";
import { SqliteStore } from "../src/store.ts";
import { checkLaws, commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import { hours, instant, parseBidId, parseJobId, parseRequestKey } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, Instant, MerchantId, OperatorId, OrderId, PayoutItemId, RefundId, StaffId, Version } from "../src/ids.ts";
import { createPayPal, DISPUTE_ACCESS_REFUSED, quote } from "../src/paypal.ts";
import type { Bps } from "../src/paypal.ts";
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
		});
		assert.deepEqual(calls, [{ path: evidencePath, requestId: providerRequestId(evidenceKey) }]);
	});
});
