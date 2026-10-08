// The review window, the dispute pause, the arbiter's two outcomes, and the missed arbiter deadline.
// Literal states: every assertion names the state the table stored, not a projected sentence.

import assert from "node:assert/strict";
import test from "node:test";
import { applySystemCommand, operationKey, runDueTimers, runOutboxOnce } from "../src/effects.ts";
import type { OperationKey, Ports } from "../src/effects.ts";
import { instant, hours, parseBidId, parseJobId } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, Instant, JobId, MerchantId, OperatorId, OrderId, PayoutItemId, RefundId, StaffId, Version } from "../src/ids.ts";
import { applyJobCommand, projectJob, TERMS, wakeAt } from "../src/job.ts";
import type { JobRow } from "../src/job.ts";
import { commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { quote } from "../src/paypal.ts";
import { frozenDefinition } from "../src/seed-data.ts";
import { exampleContract } from "./hidden-fixture.ts";
import { SqliteStore } from "../src/store.ts";
import type { Verdict, VerifierRunId } from "../src/verifier.ts";
import type { Actor } from "../src/acquit.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import type { OperatorRow } from "../src/operator.ts";

const now = instant("2026-10-06T12:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
const arbiter: Actor = { role: "ARBITER", staffId: "staff-arbiter" as StaffId };
const sourceCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const judgedCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const reviewEndsAt = instant("2026-10-09T12:00:00Z");
const resolveBy = instant("2026-10-08T12:00:00Z");
const cutoff = instant("2026-10-27T12:00:00Z");
const later = instant("2026-10-06T12:30:00Z");
const disputeReason = "The fix regresses the export path the issue names.";
const lockedPayee = { bidId: parseBidId("bid_review"), operator: "devon-ops" as OperatorId, payee: merchant,
	agent: "ts-bugfixer" as AgentId, price: usd("400.00"), eta: hours(48) };

const timerFacts = (at: Instant) => ({ actor: { role: "SYSTEM", source: "TIMER" } as const, now: at, loaded: { kind: "NONE" } as const });
const paypalFacts = (at: Instant) => ({ actor: { role: "SYSTEM", source: "PAYPAL" } as const, now: at, loaded: { kind: "NONE" } as const });
const userFacts = (actor: Actor, at = now) => ({ actor, now: at, loaded: { kind: "NONE" } as const });

function heldRow(deliveryEndsAt = instant("2026-10-13T12:00:00Z")): JobRow {
	const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
		sellerNet: usd("360.00"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: capture.gross, at: now });
	if ("kind" in book) throw new Error(book.law);
	return { id: parseJobId("job_review"), version: 1 as Version, client: "maya-client" as ClientId, tenant: null, title: "test", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt, definitionOfDone: frozenDefinition("maya-client/invoice-app", exampleContract), terms: TERMS },
		bids: [{ id: lockedPayee.bidId, operator: lockedPayee.operator, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: lockedPayee.agent, runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2026-10-09T12:00:00Z"), status: "ACCEPTED" }],
		state: { status: "IN_PROGRESS", escrow: { payee: lockedPayee, quote: quote(commercialSplit(usd("400.00")), model), capture, book,
			cutoffAt: cutoff }, attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } } };
}

function verifiedRow(endsAt = reviewEndsAt): JobRow {
	const held = heldRow();
	if (held.state.status !== "IN_PROGRESS") throw new Error("Expected held work");
	const verdict: Verdict = { result: "VERIFIED", runId: "run_review_1" as VerifierRunId, sourceCommit, mergeCommit: judgedCommit, pullRequest: 13,
		frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "b".repeat(64) as Digest, at: now };
	const passed = { ordinal: 1 as const, verdict };
	return { ...held, state: { status: "VERIFIED", escrow: held.state.escrow, history: [passed], passed,
		review: { phase: "AWAITING_CLIENT", endsAt }, runsStarted: 1 } };
}

/** The paused review, built literally: the clock the timer index holds is resolveBy, never the old endsAt. */
function disputedRow(resolveByAt = resolveBy): JobRow {
	const verified = verifiedRow();
	if (verified.state.status !== "VERIFIED") throw new Error("Expected verified work");
	return { ...verified, version: (verified.version + 1) as Version,
		state: { ...verified.state, review: { phase: "DISPUTED", reason: disputeReason, openedAt: now, resolveBy: resolveByAt } } };
}

const releaseEvidence = { payoutItemId: "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=" as PayoutItemId,
	captureId: "TESTCAPTURE" as CaptureId, paid: usd("360.00"), at: later };
const refundEvidence = { refundId: "REFUND1" as RefundId, captureId: "TESTCAPTURE" as CaptureId,
	refunded: usd("420.00"), retainedProcessorFee: usd("15.15"), at: later };

test("a client dispute pauses the 72-hour clock and gives the arbiter 48 hours", () => {
	const row = verifiedRow();
	assert.equal(wakeAt(row), reviewEndsAt);
	const plan = applyJobCommand(row, { type: "Dispute", jobId: row.id, mergeCommit: judgedCommit, reason: disputeReason }, userFacts(maya));
	if (typeof plan === "string") throw new Error(plan);
	assert.equal(plan.next.version, row.version + 1);
	const state = plan.next.state as Extract<typeof plan.next.state, { status: "VERIFIED" }>;
	assert.deepEqual(state.review, { phase: "DISPUTED", reason: disputeReason, openedAt: now, resolveBy });
	assert.deepEqual(plan.effects, []);
	// The timer index now holds the arbiter's clock. The old review deadline is not a wake instant any
	// more: a due timer that names it is stale, and nothing changes.
	assert.equal(wakeAt(plan.next), resolveBy);
	const stale = applyJobCommand(plan.next, { type: "TimerDue", jobId: row.id, expectedWakeAt: reviewEndsAt }, timerFacts(reviewEndsAt));
	if (typeof stale === "string") throw new Error(stale);
	assert.equal(stale.next.version, plan.next.version);
	assert.deepEqual(stale.effects, []);
});

test("a dispute naming a moved head is ARTIFACT_CHANGED, a closed window is REVIEW_CLOSED, and a stranger is NOT_OWNER", () => {
	const row = verifiedRow();
	assert.equal(applyJobCommand(row, { type: "Dispute", jobId: row.id, mergeCommit: "f".repeat(40) as CommitSha, reason: disputeReason }, userFacts(maya)),
		"ARTIFACT_CHANGED");
	assert.equal(applyJobCommand(row, { type: "Dispute", jobId: row.id, mergeCommit: judgedCommit, reason: disputeReason }, userFacts(maya, reviewEndsAt)),
		"REVIEW_CLOSED");
	assert.equal(applyJobCommand(row, { type: "Dispute", jobId: row.id, mergeCommit: judgedCommit, reason: disputeReason }, userFacts(devon)),
		"NOT_OWNER");
	assert.equal(applyJobCommand(row, { type: "Dispute", jobId: row.id, mergeCommit: judgedCommit, reason: disputeReason },
		userFacts({ role: "CLIENT", clientId: "other-client" as ClientId, tenant: null })), "NOT_OWNER");
});

test("the arbiter upholding a dispute releases with ARBITER_UPHELD and the paid row keeps the authority", () => {
	const row = disputedRow();
	const plan = applyJobCommand(row, { type: "ResolveDispute", jobId: row.id, verdict: "UPHOLD", note: "The artifact met the frozen contract." }, userFacts(arbiter));
	if (typeof plan === "string") throw new Error(plan);
	const state = plan.next.state as Extract<typeof plan.next.state, { status: "VERIFIED" }>;
	assert.deepEqual(state.review, { phase: "RELEASE_PENDING", release: { authority: "ARBITER_UPHELD", selectedAt: now } });
	assert.deepEqual(plan.effects, [{ kind: "RELEASE", jobId: row.id, captureId: "TESTCAPTURE", payee: merchant }]);
	const settled = applyJobCommand(plan.next, { type: "ReleaseSettled", jobId: row.id, release: releaseEvidence }, paypalFacts(later));
	if (typeof settled === "string") throw new Error(settled);
	const paid = settled.next.state as Extract<typeof settled.next.state, { status: "PAID" }>;
	assert.equal(paid.releaseAuthority, "ARBITER_UPHELD");
	assert.equal(projectJob(settled.next, maya, new Map()).releaseAuthority, "ARBITER_UPHELD");
});

test("the arbiter refunding a dispute refunds ARBITER_REFUND through the existing refund effect", () => {
	const row = disputedRow();
	assert.equal(projectJob(row, maya, new Map()).refundReason, null, "no refund is selected before the arbiter answers");
	const plan = applyJobCommand(row, { type: "ResolveDispute", jobId: row.id, verdict: "REFUND", note: "The contract was not met." }, userFacts(arbiter));
	if (typeof plan === "string") throw new Error(plan);
	const state = plan.next.state as Extract<typeof plan.next.state, { status: "VERIFIED" }>;
	assert.deepEqual(state.review, { phase: "REFUND_PENDING", refund: { reason: "ARBITER_REFUND", selectedAt: now } });
	assert.deepEqual(plan.effects, [{ kind: "REFUND", jobId: row.id, captureId: "TESTCAPTURE", payee: merchant, amount: 42000 }]);
	assert.equal(projectJob(plan.next, maya, new Map()).refundReason, "ARBITER_REFUND");
	const settled = applyJobCommand(plan.next, { type: "RefundSettled", jobId: row.id, refund: refundEvidence }, paypalFacts(later));
	if (typeof settled === "string") throw new Error(settled);
	const refunded = settled.next.state as Extract<typeof settled.next.state, { status: "REFUNDED" }>;
	assert.equal(refunded.reason, "ARBITER_REFUND");
	const view = projectJob(settled.next, maya, new Map());
	assert.equal(view.status, "REFUNDED");
	assert.equal(view.refundReason, "ARBITER_REFUND");
});

test("the deadline refund serves DELIVERY_DEADLINE while pending and once settled", () => {
	const row = heldRow();
	assert.equal(projectJob(row, maya, new Map()).refundReason, null, "a job owing no refund serves none");
	const deadline = row.contract.deliveryEndsAt;
	assert.equal(wakeAt(row), deadline, "the delivery deadline is the work's next clock");
	const due = applyJobCommand(row, { type: "TimerDue", jobId: row.id, expectedWakeAt: deadline }, timerFacts(deadline));
	if (typeof due === "string") throw new Error(due);
	const state = due.next.state as Extract<typeof due.next.state, { status: "IN_PROGRESS" }>;
	assert.equal(state.attempts.phase, "REFUND_PENDING");
	assert.equal(projectJob(due.next, maya, new Map()).refundReason, "DELIVERY_DEADLINE");
	const settled = applyJobCommand(due.next, { type: "RefundSettled", jobId: row.id, refund: refundEvidence }, paypalFacts(later));
	if (typeof settled === "string") throw new Error(settled);
	const view = projectJob(settled.next, maya, new Map());
	assert.equal(view.status, "REFUNDED");
	assert.equal(view.refundReason, "DELIVERY_DEADLINE");
});

test("a rework returns the verified work to READY with its history and one slot left", () => {
	const row = disputedRow();
	const plan = applyJobCommand(row, { type: "ResolveDispute", jobId: row.id, verdict: "REWORK", note: "Address the export path." }, userFacts(arbiter));
	if (typeof plan === "string") throw new Error(plan);
	const state = plan.next.state as Extract<typeof plan.next.state, { status: "IN_PROGRESS" }>;
	assert.equal(state.status, "IN_PROGRESS");
	assert.equal(state.attempts.phase, "READY");
	assert.deepEqual(state.attempts.history.map(record => record.ordinal), [1]);
	assert.equal(state.attempts.runsStarted, 1);
	assert.deepEqual(plan.effects, []);
	// The returned slot is real: the operator can submit again and the next run is number two.
	const submitted = applyJobCommand(plan.next, { type: "Submit", jobId: row.id, sourceCommit }, userFacts(devon));
	if (typeof submitted === "string") throw new Error(submitted);
	const attempts = (submitted.next.state as Extract<typeof submitted.next.state, { status: "IN_PROGRESS" }>).attempts;
	assert.equal(attempts.phase === "VERIFYING" ? attempts.pending.ordinal : null, 2);
});

test("a rework past the delivery deadline, or with no slot left, is refused", () => {
	const late = applyJobCommand(disputedRow(), { type: "ResolveDispute", jobId: parseJobId("job_review"), verdict: "REWORK", note: "Again." },
		userFacts(arbiter, instant("2026-10-13T12:00:00Z")));
	assert.equal(late, "WRONG_STATE");
	// Three judged attempts leave no slot, so a pass on the third is the last word.
	const verified = verifiedRow();
	if (verified.state.status !== "VERIFIED") throw new Error("Expected verified work");
	const first = verified.state.history[0];
	if (!first) throw new Error("Expected one attempt");
	const full: JobRow = { ...verified, state: { ...verified.state, history: [first, first, first] } };
	assert.equal(applyJobCommand(full, { type: "ResolveDispute", jobId: full.id, verdict: "REWORK", note: "Again." }, userFacts(arbiter)), "WRONG_STATE");
});

test("ResolveDispute is refused outside DISPUTED and by anyone but an arbiter", () => {
	assert.equal(applyJobCommand(verifiedRow(), { type: "ResolveDispute", jobId: parseJobId("job_review"), verdict: "UPHOLD", note: "x" }, userFacts(arbiter)),
		"WRONG_STATE");
	assert.equal(applyJobCommand(disputedRow(), { type: "ResolveDispute", jobId: parseJobId("job_review"), verdict: "UPHOLD", note: "x" }, userFacts(maya)),
		"NOT_OWNER");
});

test("a review window that closes in silence releases REVIEW_SILENCE", () => {
	const row = verifiedRow();
	const due = applyJobCommand(row, { type: "TimerDue", jobId: row.id, expectedWakeAt: reviewEndsAt }, timerFacts(reviewEndsAt));
	if (typeof due === "string") throw new Error(due);
	const state = due.next.state as Extract<typeof due.next.state, { status: "VERIFIED" }>;
	assert.deepEqual(state.review, { phase: "RELEASE_PENDING", release: { authority: "REVIEW_SILENCE", selectedAt: reviewEndsAt } });
	assert.deepEqual(due.effects, [{ kind: "RELEASE", jobId: row.id, captureId: "TESTCAPTURE", payee: merchant }]);
	assert.equal(projectJob(due.next, maya, new Map()).releaseAuthority, "REVIEW_SILENCE");
});

test("a missed arbiter deadline releases ARBITER_SLA_MISSED and leaves an alert row", () => {
	const row = disputedRow();
	assert.equal(wakeAt(row), resolveBy);
	const due = applyJobCommand(row, { type: "TimerDue", jobId: row.id, expectedWakeAt: resolveBy }, timerFacts(resolveBy));
	if (typeof due === "string") throw new Error(due);
	const state = due.next.state as Extract<typeof due.next.state, { status: "VERIFIED" }>;
	assert.deepEqual(state.review, { phase: "RELEASE_PENDING", release: { authority: "ARBITER_SLA_MISSED", selectedAt: resolveBy } });
	assert.deepEqual(due.effects, [
		{ kind: "RELEASE", jobId: row.id, captureId: "TESTCAPTURE", payee: merchant },
		{ kind: "ALERT", jobId: row.id, reason: "DISPUTE_SLA_MISSED" },
	]);
});

test("a missed arbiter deadline commits the alert row the outbox raises", async () => {
	const store = new SqliteStore(":memory:");
	const row = disputedRow();
	const account: CreditAccount = { operator: "devon-ops" as OperatorId, version: 0 as Version,
		balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), wakeAt(row));
	store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
	const raised: string[] = [];
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, feeModel: model, clientRepository: "maya-client/invoice-app", hiddenContract: exampleContract, clock: { now: () => resolveBy },
		verifier: { start: unimplemented, parseCallback: unimplemented }, github: { merge: unimplemented },
		alerts: { raise: async effect => { raised.push(effect.reason); } },
		paypal: { dispatch: unimplemented, reconcile: unimplemented, getOrder: unimplemented, parseWebhook: unimplemented, readResource: unimplemented } };
	try {
		const committed = await applySystemCommand(ports, { type: "TimerDue", jobId: row.id, expectedWakeAt: resolveBy }, null, null);
		assert.equal(committed.outcome, "COMMITTED");
		assert.equal(committed.refused, null);
		const alertKey: OperationKey = operationKey({ kind: "ALERT", jobId: row.id, reason: "DISPUTE_SLA_MISSED" });
		const stored = store.db.prepare("SELECT json FROM outbox WHERE key = ?").get(alertKey);
		assert(stored !== undefined, "The missed arbiter deadline left no alert row");
		assert.deepEqual((JSON.parse(String(stored.json)) as { effect: unknown }).effect,
			{ kind: "ALERT", jobId: row.id, reason: "DISPUTE_SLA_MISSED" });
		assert.equal(await runOutboxOnce(ports, alertKey), "WORKED");
		assert.deepEqual(raised, ["DISPUTE_SLA_MISSED"]);
		const after = await store.readJob(row.id);
		assert.equal(after?.state.status, "VERIFIED");
	} finally { store.close(); }
});

test("a settled release counts the payee's receipt once, and the Monday grant counts it", async () => {
	const store = new SqliteStore(":memory:");
	const payee = "devon-ops" as OperatorId;
	const operator: OperatorRow = { id: payee, handle: "devon-ops", kind: "INDEPENDENT", version: 0 as Version,
		payouts: { kind: "READY", merchant, connectedAt: now } };
	const empty: CreditAccount = { operator: payee, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
	const account = reduceCredits(empty, { kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
	if (typeof account === "string") throw new Error(account);
	store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(operator.id, operator.version, JSON.stringify(operator), 0);
	store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
	const verified = verifiedRow();
	const approved = applyJobCommand(verified, { type: "Approve", jobId: verified.id, mergeCommit: judgedCommit }, userFacts(maya));
	if (typeof approved === "string") throw new Error(approved);
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(approved.next.id, approved.next.version, JSON.stringify(approved.next), wakeAt(approved.next));
	let current: Instant = now;
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const ports: Ports = { store, feeModel: model, clientRepository: "maya-client/invoice-app", hiddenContract: exampleContract, clock: { now: () => current },
		verifier: { start: unimplemented, parseCallback: unimplemented }, github: { merge: unimplemented },
		alerts: { raise: unimplemented },
		paypal: { dispatch: unimplemented, reconcile: unimplemented, getOrder: unimplemented, parseWebhook: unimplemented, readResource: unimplemented } };
	try {
		const command = { type: "ReleaseSettled" as const, jobId: approved.next.id, release: releaseEvidence };
		const first = await applySystemCommand(ports, command, null, "WH-RELEASE-1");
		assert.equal(first.outcome, "COMMITTED");
		assert.equal(first.refused, null);
		assert.equal((await store.readJob(approved.next.id))?.state.status, "PAID");
		assert.equal((await store.receiptCounts()).get(payee), 1, "the PAID transition counts the payee's receipt");
		// A redelivered settlement is the same delivery, and a fresh event for the settled release is refused:
		// neither counts the receipt a second time.
		assert.deepEqual(await applySystemCommand(ports, command, null, "WH-RELEASE-1"), { outcome: "DELIVERY_REPLAY", refused: null });
		assert.equal((await applySystemCommand(ports, command, null, "WH-RELEASE-2")).refused, "SETTLEMENT_MISMATCH");
		assert.equal((await store.receiptCounts()).get(payee), 1);
		// Monday: the grant counts the one receipt the release earned.
		current = instant("2026-10-12T00:00:00Z");
		await runDueTimers(ports);
		const after = await store.readCredits(payee);
		assert.equal(after.balance.allowance, 40, "30 plus 10 for the receipt the release earned");
		assert.equal((await store.receiptCounts()).get(payee), 1);
	} finally { store.close(); }
});

test("the capture-age cutoff stays first: a dispute past it releases CAPTURE_CUTOFF, not ARBITER_SLA_MISSED", () => {
	// The arbiter's clock runs past day 21, so the escrow's hard stop is the earliest instant that changes the row.
	const row = disputedRow(instant("2026-11-09T12:00:00Z"));
	assert.equal(wakeAt(row), cutoff);
	const due = applyJobCommand(row, { type: "TimerDue", jobId: row.id, expectedWakeAt: cutoff }, timerFacts(cutoff));
	if (typeof due === "string") throw new Error(due);
	const state = due.next.state as Extract<typeof due.next.state, { status: "VERIFIED" }>;
	assert.deepEqual(state.review, { phase: "RELEASE_PENDING", release: { authority: "CAPTURE_CUTOFF", selectedAt: cutoff } });
	assert.deepEqual(due.effects, [{ kind: "RELEASE", jobId: row.id, captureId: "TESTCAPTURE", payee: merchant }]);
});

test("the arbiter's note is kept with the decision and served by the view", () => {
	// No arbiter has decided yet, so the view serves nothing.
	assert.equal(projectJob(disputedRow(), maya, new Map()).arbiterNote, null);
	const upheld = applyJobCommand(disputedRow(), { type: "ResolveDispute", jobId: parseJobId("job_review"), verdict: "UPHOLD", note: "The artifact met the frozen contract." }, userFacts(arbiter));
	if (typeof upheld === "string") throw new Error(upheld);
	assert.equal(projectJob(upheld.next, maya, new Map()).arbiterNote, "The artifact met the frozen contract.");
	const settled = applyJobCommand(upheld.next, { type: "ReleaseSettled", jobId: parseJobId("job_review"), release: releaseEvidence }, paypalFacts(later));
	if (typeof settled === "string") throw new Error(settled);
	assert.equal(projectJob(settled.next, maya, new Map()).arbiterNote, "The artifact met the frozen contract.");
	// The refund settles through a freshly built row, and the rework returns to WORK: both keep the note.
	const refunded = applyJobCommand(disputedRow(), { type: "ResolveDispute", jobId: parseJobId("job_review"), verdict: "REFUND", note: "The contract was not met." }, userFacts(arbiter));
	if (typeof refunded === "string") throw new Error(refunded);
	const refundSettled = applyJobCommand(refunded.next, { type: "RefundSettled", jobId: parseJobId("job_review"), refund: refundEvidence }, paypalFacts(later));
	if (typeof refundSettled === "string") throw new Error(refundSettled);
	assert.equal(projectJob(refundSettled.next, maya, new Map()).arbiterNote, "The contract was not met.");
	const rework = applyJobCommand(disputedRow(), { type: "ResolveDispute", jobId: parseJobId("job_review"), verdict: "REWORK", note: "Address the export path." }, userFacts(arbiter));
	if (typeof rework === "string") throw new Error(rework);
	assert.equal(projectJob(rework.next, maya, new Map()).arbiterNote, "Address the export path.");
});

test("the job view serves the review deadline, the dispute, the release authority, and viewerCanDispute", () => {
	const verified = verifiedRow();
	const asMaya = projectJob(verified, maya, new Map());
	assert.equal(asMaya.viewerCanDispute, true);
	assert.equal(asMaya.viewerCanApprove, true);
	assert.equal(asMaya.reviewEndsAt, reviewEndsAt);
	assert.equal(asMaya.dispute, null);
	assert.equal(asMaya.releaseAuthority, null);
	const asDevon = projectJob(verified, devon, new Map());
	assert.equal(asDevon.viewerCanDispute, false);
	assert.equal(asDevon.viewerCanApprove, false);

	const disputed = disputedRow();
	const paused = projectJob(disputed, maya, new Map());
	assert.equal(paused.phase, "DISPUTED");
	assert.equal(paused.reviewEndsAt, null);
	assert.deepEqual(paused.dispute, { reason: disputeReason, openedAt: now, resolveBy });
	assert.equal(paused.viewerCanDispute, false);
	assert.equal(paused.viewerCanApprove, false);

	const upheld = applyJobCommand(disputed, { type: "ResolveDispute", jobId: disputed.id, verdict: "UPHOLD", note: "x" }, userFacts(arbiter));
	if (typeof upheld === "string") throw new Error(upheld);
	const releasing = projectJob(upheld.next, maya, new Map());
	assert.equal(releasing.phase, "RELEASE_PENDING");
	assert.equal(releasing.releaseAuthority, "ARBITER_UPHELD");
	assert.equal(releasing.dispute, null);
	const settled = applyJobCommand(upheld.next, { type: "ReleaseSettled", jobId: disputed.id, release: releaseEvidence }, paypalFacts(later));
	if (typeof settled === "string") throw new Error(settled);
	assert.equal(projectJob(settled.next, maya, new Map()).releaseAuthority, "ARBITER_UPHELD");
});
