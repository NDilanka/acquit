// The buyer dispute webhook when PayPal refuses the dispute read with a 403: the platform holds no dispute permission
// for the merchant. The signed delivery stands in for the read, so the job that holds the capture records the dispute
// and its release stays held. The bodies carry the dispute fields the sandbox sent on 2026-10-22, as the brief lists them;
// names and merchant ids are placeholders.

import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../src/acquit.ts";
import { ingestPayPalWebhook, providerRequestId, runOutboxOnce } from "../src/effects.ts";
import type { OperationKey, Ports } from "../src/effects.ts";
import { hours, instant, parseBidId, parseJobId } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, MerchantId, OperatorId, OrderId, Version } from "../src/ids.ts";
import { applyJobCommand, releaseHeld, TERMS, wakeAt } from "../src/job.ts";
import type { JobRow, ProviderDispute } from "../src/job.ts";
import { commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import { createPayPal, DISPUTE_ACCESS_REFUSED, parseDispute, parseWebhookEnvelope, quote } from "../src/paypal.ts";
import type { Bps, PayPalConfig } from "../src/paypal.ts";
import { manifestOf } from "../src/fixtures.ts";
import { SqliteStore } from "../src/store.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";
import type { VerifierRunId } from "../src/verifier.ts";

const now = instant("2026-10-22T09:00:00Z");
const received = instant("2026-10-22T11:00:00Z");
const reviewEndsAt = instant("2026-10-25T01:33:00Z");
const cutoff = instant("2026-11-05T09:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "MERCHANT-SCRUBBED" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const jobId = parseJobId("job_dispute_403");
const captureId = "1WL969806P110802T" as CaptureId;
const orderId = "ORDER-DISPUTE-403" as OrderId;
const disputeId = "PP-R-PPB-10194003";
const sourceCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const judgedCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const passedVerdict = { result: "VERIFIED" as const, runId: "run_dispute_403" as VerifierRunId, sourceCommit, mergeCommit: judgedCommit, pullRequest: 13,
	frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "b".repeat(64) as Digest, at: now };
const lockedPayee = { bidId: parseBidId("bid_dispute_403"), operator: "devon-ops" as OperatorId, payee: merchant,
	agent: "ts-bugfixer" as AgentId, price: usd("21.00"), eta: hours(48) };

/** A VERIFIED job awaiting the client's review, holding 21.00 USD on the capture the dispute names. */
function verifiedRow(): JobRow {
	const capture = { orderId, captureId, payee: merchant, disbursement: "DELAYED" as const, gross: usd("21.00"), processorFee: usd("0.93"),
		platformFee: usd("2.10"), sellerNet: usd("17.97"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: capture.gross, at: now });
	if ("kind" in book) throw new Error(book.law);
	const escrow = { payee: lockedPayee, quote: quote(commercialSplit(usd("21.00")), model), capture, book, cutoffAt: cutoff };
	const passed = { ordinal: 1 as const, verdict: passedVerdict };
	return { id: jobId, version: 1 as Version, client: "maya-client" as ClientId, tenant: null, title: "Invoice app", openedAt: now,
		contract: { budget: usd("21.00"), deliveryEndsAt: instant("2026-10-29T09:00:00Z"),
			definitionOfDone: manifestOf(demoFixture(exampleContract), "maya-client/invoice-app"), terms: TERMS },
		bids: [{ id: lockedPayee.bidId, operator: lockedPayee.operator, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: lockedPayee.agent, runner: "claude-code", price: usd("21.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2026-10-23T09:00:00Z"), status: "ACCEPTED" }],
		state: { status: "VERIFIED", escrow, history: [passed], passed, review: { phase: "AWAITING_CLIENT", endsAt: reviewEndsAt }, runsStarted: 1 } };
}

/** The ports the route reads with. The signature check passes, and PayPal refuses every dispute read with a 403. */
function portsOver(store: SqliteStore): Ports {
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const paypal = { parseWebhook: async (raw: string) => parseWebhookEnvelope(raw), verifyWebhookDelivery: async () => ({ kind: "VERIFIED" as const }),
		readResource: async () => ({ kind: "REFUSED" as const, reason: "PAYPAL_HTTP_403" }), dispatch: unimplemented, reconcile: unimplemented,
		getOrder: unimplemented };
	return { store, feeModel: model, fixtures: [demoFixture(exampleContract)], clock: { now: () => received },
		verifier: { start: unimplemented, parseCallback: unimplemented }, github: { merge: unimplemented }, alerts: { raise: unimplemented },
		paypal: paypal as unknown as Ports["paypal"] };
}

async function withVerifiedJob(body: (store: SqliteStore, ports: Ports) => Promise<void>, row: JobRow = verifiedRow()): Promise<void> {
	const store = new SqliteStore(":memory:");
	try {
		store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), wakeAt(row));
		store.db.prepare("INSERT INTO resources VALUES (?, ?)").run(captureId, jobId);
		store.db.prepare("INSERT INTO resources VALUES (?, ?)").run(orderId, jobId);
		await body(store, portsOver(store));
	} finally { store.close(); }
}

async function jobOf(store: SqliteStore): Promise<JobRow> {
	const row = await store.readJob(jobId);
	if (row === null) throw new Error("the job is missing");
	return row;
}

const outcomeOf = (store: SqliteStore, eventId: string): string =>
	String((store.db.prepare("SELECT outcome FROM webhook_events WHERE id = ?").get(eventId) as { outcome: string } | undefined)?.outcome);

/** The dispute resource as the sandbox sends it, with the fields a delivery is judged by. */
const disputeResource = (fields: { readonly updateTime: string; readonly status: string; readonly outcome?: string; readonly capture?: string;
	readonly amount?: string }) => ({
	dispute_id: disputeId, create_time: "2026-10-22T10:05:00Z", update_time: fields.updateTime,
	reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", dispute_channel: "INTERNAL", dispute_life_cycle_stage: "INQUIRY",
	status: fields.status, dispute_amount: { currency_code: "USD", value: fields.amount ?? "21.00" },
	disputed_transactions: [{ buyer_transaction_id: "BUYER-TXN-SCRUBBED", seller_transaction_id: fields.capture ?? captureId,
		transaction_status: "COMPLETED", seller: { merchant_id: "MERCHANT-SCRUBBED" }, items: [], seller_protection_eligible: false }],
	links: [{ href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}`, rel: "self", method: "GET" }],
	...(fields.outcome === undefined ? {} : { dispute_outcome: { outcome_code: fields.outcome } }),
});

const deliver = (ports: Ports, eventId: string, eventType: string, resource: object, devReplay = false): Promise<Response> =>
	ingestPayPalWebhook(ports, new Request("http://acquit.test/paypal/webhook", { method: "POST",
		body: JSON.stringify({ id: eventId, event_type: eventType, resource_type: "dispute", resource }) }), devReplay);

/** The ports for a PayPal whose dispute read succeeds with the body it holds, as a GET returns it. */
function portsReading(store: SqliteStore, body: object): Ports {
	const observation = { kind: "DISPUTE" as const, ...parseDispute(body, captureId) };
	const base = portsOver(store);
	return { ...base, paypal: { ...base.paypal, readResource: async () => ({ kind: "SETTLED" as const, observation }) } as unknown as Ports["paypal"] };
}

/** The effects the outbox holds, by kind, so a test can say which money movement or alert was queued. */
type QueuedEffect = { readonly kind: string; readonly reason?: string; readonly detail?: string; readonly disputeId?: string };
const queuedEffectsOf = (store: SqliteStore): QueuedEffect[] =>
	store.db.prepare("SELECT json FROM outbox").all().map(row => (JSON.parse(String((row as { json: string }).json)) as { effect: QueuedEffect }).effect);

const CREATED = "CUSTOMER.DISPUTE.CREATED";
const UPDATED = "CUSTOMER.DISPUTE.UPDATED";
const RESOLVED = "CUSTOMER.DISPUTE.RESOLVED";
/** The alert an open dispute's stand-in raises. The record says the dispute is open, so no "not confirmed" wording appears. */
const OPEN_READ_REFUSED = "PayPal refused the dispute read. The dispute is open and the payment stays held.";

test("a CREATED delivery the read refused records the dispute on the job that holds its capture, and holds the release", async () => {
	await withVerifiedJob(async (store, ports) => {
		assert.equal((await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }))).status, 202);
		assert.equal(outcomeOf(store, "WH-CREATED-403"), "verified, applied");
		const row = await jobOf(store);
		assert.deepEqual(row.providerDispute, { id: disputeId, status: "UNDER_REVIEW", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
			amount: usd("21.00"), openedAt: instant("2026-10-22T10:05:00Z"), updatedAt: instant("2026-10-22T10:05:00Z"), answer: "EVIDENCE",
			answerState: { state: "QUEUED" }, answerRound: `${disputeId}:1`, stage: "INQUIRY", offers: [], unconfirmed: true });
		assert.equal(releaseHeld(row), true);
	});
});

test("an UPDATED delivery after CREATED moves the dispute to WAITING_FOR_SELLER_RESPONSE, and the hold stands", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		assert.equal((await deliver(ports, "WH-UPDATED-403", UPDATED, disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "WAITING_FOR_SELLER_RESPONSE" }))).status, 202);
		assert.equal(outcomeOf(store, "WH-UPDATED-403"), "verified, applied");
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.status, "WAITING_FOR_SELLER_RESPONSE");
		assert.equal(row.providerDispute?.updatedAt, instant("2026-10-22T11:00:00Z"));
		assert.equal(releaseHeld(row), true);
	});
});

test("an older replayed body after a newer one changes nothing, and the job keeps its version", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		await deliver(ports, "WH-UPDATED-403", UPDATED, disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "WAITING_FOR_SELLER_RESPONSE" }));
		const before = await jobOf(store);
		await deliver(ports, "WH-CREATED-REPLAY", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		const after = await jobOf(store);
		assert.equal(after.version, before.version);
		assert.deepEqual(after.providerDispute, before.providerDispute);
	});
});

test("a body whose seller transaction names no job's capture changes nothing and is recorded as a no-op", async () => {
	await withVerifiedJob(async (store, ports) => {
		const before = await jobOf(store);
		await deliver(ports, "WH-NOBODY-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW", capture: "CAPTURE-NOBODY-HOLDS" }));
		assert.equal(outcomeOf(store, "WH-NOBODY-403"), "verified, no-op, no job holds this resource");
		const after = await jobOf(store);
		assert.equal(after.version, before.version);
		assert.equal(after.providerDispute, undefined);
	});
});

test("a seller-favour resolution from a refused read is recorded but keeps the hold, and says PayPal's read is unconfirmed", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		await deliver(ports, "WH-UPDATED-403", UPDATED, disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "WAITING_FOR_SELLER_RESPONSE" }));
		await deliver(ports, "WH-RESOLVED-403", RESOLVED, disputeResource({ updateTime: "2026-10-23T09:00:00Z", status: "RESOLVED",
			outcome: "RESOLVED_SELLER_FAVOUR" }));
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.status, "RESOLVED");
		assert.equal(row.providerDispute?.outcome, "RESOLVED_SELLER_FAVOUR");
		assert.equal(row.providerDispute?.unconfirmed, true);
		assert.equal(releaseHeld(row), true);
		assert.ok(queuedEffectsOf(store).some(effect => effect.kind === "ALERT" && effect.reason === "PROVIDER_DISPUTE_UNCONFIRMED"));
	});
});

test("a RESOLVED body older than the recorded update cannot lift the hold", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		await deliver(ports, "WH-UPDATED-403", UPDATED, disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "WAITING_FOR_SELLER_RESPONSE" }));
		await deliver(ports, "WH-RESOLVED-STALE", RESOLVED, disputeResource({ updateTime: "2026-10-22T10:30:00Z", status: "RESOLVED",
			outcome: "RESOLVED_SELLER_FAVOUR" }));
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.status, "WAITING_FOR_SELLER_RESPONSE");
		assert.equal(releaseHeld(row), true);
	});
});

test("while the dispute recorded from the body is open, approval and the auto-release emit no release", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		const row = await jobOf(store);
		const approved = applyJobCommand(row, { type: "Approve", jobId, mergeCommit: judgedCommit }, { actor: maya, now: received, loaded: { kind: "NONE" } });
		if (typeof approved === "string") throw new Error(approved);
		assert.equal(approved.effects.some(effect => effect.kind === "RELEASE"), false);
		const timed = applyJobCommand(row, { type: "TimerDue", jobId, expectedWakeAt: reviewEndsAt },
			{ actor: { role: "SYSTEM", source: "TIMER" }, now: reviewEndsAt, loaded: { kind: "NONE" } });
		if (typeof timed === "string") throw new Error(timed);
		assert.equal(timed.effects.some(effect => effect.kind === "RELEASE"), false);
	});
});

test("the unsigned dev replay body never stands in for a refused read", async () => {
	await withVerifiedJob(async (store, ports) => {
		const before = await jobOf(store);
		await deliver(ports, "WH-DEV-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }), true);
		assert.equal(outcomeOf(store, "WH-DEV-403"), "refused, the provider refused this dispute");
		const after = await jobOf(store);
		assert.equal(after.version, before.version);
		assert.equal(after.providerDispute, undefined);
	});
});

test("a record stored with no update time takes no snapshot-driven terminal move, so a dated RESOLVED body changes nothing", () => {
	const legacy: JobRow = { ...verifiedRow(), providerDispute: { id: disputeId, status: "UNDER_REVIEW",
		reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", amount: usd("21.00"), openedAt: now } };
	const standIn = { type: "ProviderDispute" as const, jobId, disputeId, captureId, status: "RESOLVED", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
		amount: usd("21.00"), openedAt: now, updatedAt: instant("2026-10-23T09:00:00Z"), outcome: "RESOLVED_BUYER_FAVOUR", fromVerifiedBody: true as const };
	const plan = applyJobCommand(legacy, standIn, { actor: { role: "SYSTEM", source: "OUTBOX" }, now: received, loaded: { kind: "NONE" } });
	if (typeof plan === "string") throw new Error(plan);
	assert.deepEqual(plan.next, legacy);
	assert.deepEqual(plan.effects, []);
});

test("a same-status body with a newer update time is applied, and the record advances to that time", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		await deliver(ports, "WH-REVIEW-LATER", UPDATED, disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "UNDER_REVIEW" }));
		assert.equal(outcomeOf(store, "WH-REVIEW-LATER"), "verified, applied");
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.status, "UNDER_REVIEW");
		assert.equal(row.providerDispute?.updatedAt, instant("2026-10-22T11:00:00Z"));
	});
});

test("a status may return to one it held, and the record keeps the time of the latest delivery", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CYCLE-1", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		await deliver(ports, "WH-CYCLE-2", UPDATED, disputeResource({ updateTime: "2026-10-22T10:30:00Z", status: "WAITING_FOR_SELLER_RESPONSE" }));
		await deliver(ports, "WH-CYCLE-3", UPDATED, disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "UNDER_REVIEW" }));
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.status, "UNDER_REVIEW");
		assert.equal(row.providerDispute?.updatedAt, instant("2026-10-22T11:00:00Z"));
		assert.equal(releaseHeld(row), true);
	});
});

test("a seller-favour body older than a same-status body the record holds cannot resolve the dispute", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		await deliver(ports, "WH-REVIEW-LATER", UPDATED, disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "UNDER_REVIEW" }));
		await deliver(ports, "WH-RESOLVED-STALE", RESOLVED, disputeResource({ updateTime: "2026-10-22T10:30:00Z", status: "RESOLVED",
			outcome: "RESOLVED_SELLER_FAVOUR" }));
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.status, "UNDER_REVIEW");
		assert.equal(row.providerDispute?.updatedAt, instant("2026-10-22T11:00:00Z"));
		assert.equal(releaseHeld(row), true);
	});
});

test("an outcome PayPal names after an unknown one is recorded, and a successful read of it lifts the hold", async () => {
	await withVerifiedJob(async (store) => {
		const unnamed = disputeResource({ updateTime: "2026-10-22T10:30:00Z", status: "RESOLVED" });
		await deliver(portsReading(store, unnamed), "WH-RESOLVED-UNNAMED", RESOLVED, unnamed);
		assert.equal(releaseHeld(await jobOf(store)), true);
		const named = disputeResource({ updateTime: "2026-10-22T10:40:00Z", status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" });
		await deliver(portsReading(store, named), "WH-RESOLVED-NAMED", RESOLVED, named);
		assert.equal(outcomeOf(store, "WH-RESOLVED-NAMED"), "verified, applied");
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.outcome, "RESOLVED_SELLER_FAVOUR");
		assert.equal(row.providerDispute?.unconfirmed, undefined);
		assert.equal(releaseHeld(row), false);
	});
});

test("a body with no update time places the hold and raises an alert, and settles nothing", async () => {
	await withVerifiedJob(async (store, ports) => {
		const undated = { ...disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }), update_time: undefined };
		await deliver(ports, "WH-UNDATED-403", CREATED, undated);
		assert.equal(outcomeOf(store, "WH-UNDATED-403"), "verified, applied");
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.status, "UNDER_REVIEW");
		assert.equal(row.providerDispute?.updatedAt, undefined);
		assert.equal(releaseHeld(row), true);
		// An open dispute is held, not unconfirmed: its alert says PayPal refused the read, and it does not say "not confirmed".
		assert.ok(queuedEffectsOf(store).some(effect => effect.kind === "ALERT" && effect.reason === "PROVIDER_DISPUTE_READ_REFUSED" &&
			effect.disputeId === disputeId && effect.detail === OPEN_READ_REFUSED));
		assert.equal(queuedEffectsOf(store).some(effect => effect.reason === "PROVIDER_DISPUTE_UNCONFIRMED"), false);
	});
});

test("a successful read of a dispute the stand-in held confirms the record, and the open hold stands", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		assert.equal((await jobOf(store)).providerDispute?.unconfirmed, true);
		const read = disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "WAITING_FOR_SELLER_RESPONSE" });
		await deliver(portsReading(store, read), "WH-READ-OK", UPDATED, read);
		assert.equal(outcomeOf(store, "WH-READ-OK"), "verified, applied");
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.status, "WAITING_FOR_SELLER_RESPONSE");
		assert.equal(row.providerDispute?.unconfirmed, undefined);
		assert.equal(releaseHeld(row), true);
	});
});

test("a stand-in with no update time cannot move a record that holds one", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		const before = await jobOf(store);
		const undatedResolved = { ...disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" }),
			update_time: undefined };
		await deliver(ports, "WH-UNDATED-RESOLVED", RESOLVED, undatedResolved);
		const after = await jobOf(store);
		assert.equal(after.version, before.version);
		assert.equal(after.providerDispute?.status, "UNDER_REVIEW");
	});
});

test("a refused read's buyer win for the whole capture does not refund the job from the body", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-BUYER-403", RESOLVED, disputeResource({ updateTime: "2026-10-23T09:00:00Z", status: "RESOLVED",
			outcome: "RESOLVED_BUYER_FAVOUR" }));
		const row = await jobOf(store);
		assert.equal(row.state.status, "VERIFIED");
		assert.equal(releaseHeld(row), true);
		assert.equal(queuedEffectsOf(store).some(effect => effect.kind === "REFUND" || effect.kind === "RELEASE"), false);
		assert.ok(queuedEffectsOf(store).some(effect => effect.kind === "ALERT" && effect.reason === "PROVIDER_DISPUTE_UNCONFIRMED"));
	});
});

test("a successful read of a buyer win for more than the capture gross stays held and goes to a person", async () => {
	await withVerifiedJob(async (store) => {
		const overGross = disputeResource({ updateTime: "2026-10-23T09:00:00Z", status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR", amount: "22.00" });
		await deliver(portsReading(store, overGross), "WH-OVER-GROSS", RESOLVED, overGross);
		const row = await jobOf(store);
		assert.equal(row.state.status, "VERIFIED");
		assert.equal(releaseHeld(row), true);
		assert.ok(queuedEffectsOf(store).some(effect => effect.kind === "ALERT" && effect.reason === "SETTLEMENT_MISMATCH" && effect.disputeId === disputeId));
	});
});

test("a stand-in resolution never unblocks a release the row already approved", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		const held = await jobOf(store);
		const approved = applyJobCommand(held, { type: "Approve", jobId, mergeCommit: judgedCommit }, { actor: maya, now: received, loaded: { kind: "NONE" } });
		if (typeof approved === "string") throw new Error(approved);
		store.db.prepare("UPDATE jobs SET version = ?, json = ? WHERE id = ?").run(approved.next.version, JSON.stringify(approved.next), jobId);
		await deliver(ports, "WH-RESOLVED-403", RESOLVED, disputeResource({ updateTime: "2026-10-23T09:00:00Z", status: "RESOLVED",
			outcome: "RESOLVED_SELLER_FAVOUR" }));
		const row = await jobOf(store);
		assert.ok(row.state.status === "VERIFIED" && row.state.review.phase === "RELEASE_PENDING");
		assert.equal(releaseHeld(row), true);
		assert.equal(queuedEffectsOf(store).some(effect => effect.kind === "RELEASE"), false);
	});
});

// The live path: the real client on a fake fetch. The platform's own token is refused the dispute read, House's own app reads it, and
// only the signature check is stubbed, as in every route test here. A call's lane is the token it carried, and a token mints per lane.
const PLATFORM_CLIENT = "platform-client";
const HOUSE_CLIENT = "house-client";
const platformMerchant = "LA4PH2WMNKTDN" as MerchantId;
const disputeUrl = `/v1/customer/disputes/${disputeId}`;
const liveConfig: PayPalConfig = { webOrigin: "http://localhost:5243", apiBase: "https://api-m.sandbox.paypal.com", clientId: PLATFORM_CLIENT,
	secret: "platform-secret", webhookId: "", partnerMerchant: platformMerchant, feeModel: model,
	house: { merchant, clientId: HOUSE_CLIENT, secret: "house-secret" } };

/** One call the real client sent, as the fake fetch saw it. */
type SentCall = { readonly method: string; readonly path: string; readonly lane: "PLATFORM" | "HOUSE"; readonly assertion: boolean;
	readonly requestId: string | null; readonly body: string };

/** Routes the real client's HTTP through a fake PayPal for the body's run. Token calls are answered and not recorded. */
async function withFakePayPal(answer: (call: SentCall) => Response, body: (calls: SentCall[]) => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	const calls: SentCall[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = (init?.headers ?? {}) as Record<string, string>;
		if (url.pathname === "/v1/oauth2/token") {
			const clientId = Buffer.from((headers.Authorization ?? "").replace("Basic ", ""), "base64").toString().split(":")[0];
			return Response.json({ access_token: clientId === HOUSE_CLIENT ? "house-token" : "platform-token", expires_in: 300 });
		}
		const call: SentCall = { method: init?.method ?? "GET", path: url.pathname, lane: headers.Authorization === "Bearer house-token" ? "HOUSE" : "PLATFORM",
			assertion: headers["PayPal-Auth-Assertion"] !== undefined, requestId: headers["PayPal-Request-Id"] ?? null,
			body: typeof init?.body === "string" ? init.body : "" };
		calls.push(call);
		return answer(call);
	}) as typeof fetch;
	try { await body(calls); } finally { globalThis.fetch = original; }
}

/** PayPal's answers on the live path: the platform is refused the dispute read, House's app reads it, and an answer post takes `postStatus`. */
function livePayPal(body: object, postStatus: number): (call: SentCall) => Response {
	return call => {
		if (call.method === "GET") return call.lane === "HOUSE" ? Response.json(body) : Response.json({ name: "NOT_AUTHORIZED" }, { status: 403 });
		return postStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ name: "NOT_AUTHORIZED" }, { status: postStatus });
	};
}

/** The ports the route runs with on the real client. Every dispute read and answer is a real call; only the signature is trusted. */
function livePorts(store: SqliteStore, config: PayPalConfig = liveConfig): Ports {
	const paypal = { ...createPayPal(config, { now: () => received }), verifyWebhookDelivery: async () => ({ kind: "VERIFIED" as const }) };
	return { ...portsOver(store), paypal };
}

/** The dispute as the sandbox sends it, with the answer links a read offers, listed the way the sandbox lists them. */
const offering = (fields: Parameters<typeof disputeResource>[0], offers: readonly string[]) => ({ ...disputeResource(fields),
	links: [{ href: `https://api-m.sandbox.paypal.com${disputeUrl}`, rel: "self", method: "GET" },
		...offers.map(rel => ({ href: `https://api-m.sandbox.paypal.com${disputeUrl}/${rel}`, rel, method: "POST" }))] });

/** The row the live delivery found: its dispute recorded from a stand-in, its answer refused for lack of access, and no stage kept. */
function liveRow(): JobRow {
	const dispute: ProviderDispute = { id: disputeId, status: "WAITING_FOR_SELLER_RESPONSE", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
		amount: usd("21.00"), openedAt: instant("2026-10-22T10:05:00Z"), updatedAt: instant("2026-10-22T01:42:24.149Z"), answer: "EVIDENCE",
		answerState: { state: "REFUSED", reason: DISPUTE_ACCESS_REFUSED }, unconfirmed: true };
	return { ...verifiedRow(), providerDispute: dispute };
}

/** The queued outbox rows of one kind, as the drain reads them: each row's key and its effect. */
type OutboxEffect = { readonly kind: string; readonly requeued?: true; readonly stage?: string; readonly message?: string };
const outboxRowsOf = (store: SqliteStore, kind: string): { readonly key: OperationKey; readonly effect: OutboxEffect }[] =>
	store.db.prepare("SELECT key, json FROM outbox").all()
		.map(row => ({ key: String((row as { key: string }).key) as OperationKey,
			effect: (JSON.parse(String((row as { json: string }).json)) as { effect: OutboxEffect }).effect }))
		.filter(row => row.effect.kind === kind);

const answerStateOf = async (store: SqliteStore) => (await jobOf(store)).providerDispute?.answerState;

test("a dispute no index entry names is read with House's own app, its refused answer is re-queued as a message, and an identical resend queues nothing", async () => {
	const body = offering({ updateTime: "2026-10-22T01:42:24.149Z", status: "WAITING_FOR_SELLER_RESPONSE" },
		["accept_claim", "send_message", "make_offer", "escalate"]);
	await withVerifiedJob(async store => {
		const ports = livePorts(store);
		await withFakePayPal(livePayPal(body, 204), async calls => {
			assert.equal((await deliver(ports, "WH-LIVE-READ", UPDATED, body)).status, 202);
			assert.equal(outcomeOf(store, "WH-LIVE-READ"), "verified, applied");
			// The owner resolves before a credential is chosen: the platform never reads House's dispute, and House's own app reads it unasserted.
			assert.deepEqual(calls.map(call => ({ method: call.method, path: call.path, lane: call.lane, assertion: call.assertion })),
				[{ method: "GET", path: disputeUrl, lane: "HOUSE", assertion: false }]);
			const row = await jobOf(store);
			assert.equal(await store.jobForResource(disputeId), jobId, "the dispute id is indexed on the write that records it");
			assert.deepEqual(row.providerDispute, { id: disputeId, status: "WAITING_FOR_SELLER_RESPONSE", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
				amount: usd("21.00"), openedAt: instant("2026-10-22T10:05:00Z"), updatedAt: instant("2026-10-22T01:42:24.149Z"), answer: "MESSAGE",
				answerState: { state: "QUEUED" }, answerRound: `${disputeId}:1:INQUIRY:requeued`, stage: "INQUIRY",
				offers: ["send_message", "accept_claim"], requeued: true });
			assert.equal(releaseHeld(row), true);
			const queued = outboxRowsOf(store, "DISPUTE_MESSAGE");
			assert.equal(queued.length, 1);
			const sent = queued[0];
			if (sent === undefined) throw new Error("expected the queued message");
			// The message is the verified attempt's receipt text. The rest of the effect is exactly the one requeued answer.
			const { message, ...answer } = sent.effect;
			assert.deepEqual(answer, { kind: "DISPUTE_MESSAGE", jobId, requeued: true, stage: "INQUIRY", disputeId, payee: merchant, attempt: 1, simulated: false });
			assert.match(message ?? "", /^Verified attempt 1 for job job_dispute_403 passed/);
			assert.equal(await runOutboxOnce(ports, sent.key), "WORKED");
			// The message goes to PayPal's send-message path from House's own app, with JSON body and no assertion.
			const post = calls.filter(call => call.method === "POST");
			assert.deepEqual(post.map(call => ({ path: call.path, lane: call.lane, assertion: call.assertion, requestId: call.requestId })),
				[{ path: `${disputeUrl}/send-message`, lane: "HOUSE", assertion: false, requestId: providerRequestId(sent.key) }]);
			assert.deepEqual(Object.keys(JSON.parse(post[0]?.body ?? "{}") as object), ["message"]);
			assert.deepEqual(await answerStateOf(store), { state: "FILED" });
			// The identical resend is the same provider fact: it queues nothing, and PayPal is not asked to answer again.
			assert.equal((await deliver(ports, "WH-LIVE-RESEND", UPDATED, body)).status, 202);
			assert.equal(outboxRowsOf(store, "DISPUTE_MESSAGE").length, 1);
			assert.equal(calls.filter(call => call.method === "POST").length, 1);
		});
	}, liveRow());
});

test("a refused evidence answer is re-queued once a repeat of the read it was filed under is delivered after access is granted", async () => {
	const body = offering({ updateTime: "2026-10-22T11:00:00Z", status: "WAITING_FOR_SELLER_RESPONSE" }, ["provide_evidence", "send_message", "accept_claim"]);
	await withVerifiedJob(async store => {
		const ports = livePorts(store);
		let postStatus = 403;
		await withFakePayPal(call => livePayPal(body, postStatus)(call), async calls => {
			// The confirmed read files evidence, and PayPal refuses the answer for lack of access.
			assert.equal((await deliver(ports, "WH-OFFER-1", UPDATED, body)).status, 202);
			const [filed] = outboxRowsOf(store, "DISPUTE_EVIDENCE");
			if (filed === undefined) throw new Error("expected the evidence to be queued");
			assert.equal(await runOutboxOnce(ports, filed.key), "WORKED");
			assert.deepEqual(await answerStateOf(store), { state: "REFUSED", reason: DISPUTE_ACCESS_REFUSED });
			// Access is granted. The same read again, with the same status and time, is the provider fact the refused answer was filed under.
			postStatus = 204;
			assert.equal((await deliver(ports, "WH-OFFER-2", UPDATED, body)).status, 202);
			assert.equal(outcomeOf(store, "WH-OFFER-2"), "verified, applied");
			const requeued = outboxRowsOf(store, "DISPUTE_EVIDENCE").filter(row => row.effect.requeued === true);
			assert.equal(requeued.length, 1, "the refused answer is re-queued once");
			assert.deepEqual(await answerStateOf(store), { state: "QUEUED" });
			const again = requeued[0];
			if (again === undefined) throw new Error("expected the re-queued evidence");
			assert.equal(await runOutboxOnce(ports, again.key), "WORKED");
			assert.deepEqual(await answerStateOf(store), { state: "FILED" });
			// An identical resend after that queues nothing, and PayPal is asked for the evidence exactly twice.
			await deliver(ports, "WH-OFFER-3", UPDATED, body);
			assert.equal(outboxRowsOf(store, "DISPUTE_EVIDENCE").length, 2);
			assert.deepEqual(calls.filter(call => call.method === "POST").map(call => call.requestId),
				[providerRequestId(filed.key), providerRequestId(again.key)]);
		});
	}, verifiedRow());
});

test("a re-queued answer PayPal refuses again is not re-queued, and an identical resend after that queues nothing", async () => {
	const body = offering({ updateTime: "2026-10-22T11:00:00Z", status: "WAITING_FOR_SELLER_RESPONSE" }, ["provide_evidence", "send_message", "accept_claim"]);
	await withVerifiedJob(async store => {
		const ports = livePorts(store);
		await withFakePayPal(livePayPal(body, 403), async calls => {
			await deliver(ports, "WH-OFFER-1", UPDATED, body);
			const [filed] = outboxRowsOf(store, "DISPUTE_EVIDENCE");
			if (filed === undefined) throw new Error("expected the evidence to be queued");
			assert.equal(await runOutboxOnce(ports, filed.key), "WORKED");
			// The same read again re-queues the answer once, and PayPal refuses that too.
			await deliver(ports, "WH-OFFER-2", UPDATED, body);
			const requeued = outboxRowsOf(store, "DISPUTE_EVIDENCE").filter(row => row.effect.requeued === true);
			assert.equal(requeued.length, 1);
			const again = requeued[0];
			if (again === undefined) throw new Error("expected the re-queued evidence");
			assert.equal(await runOutboxOnce(ports, again.key), "WORKED");
			assert.deepEqual(await answerStateOf(store), { state: "REFUSED", reason: DISPUTE_ACCESS_REFUSED });
			// The identical resend queues nothing: the one re-queue of this round is spent.
			await deliver(ports, "WH-OFFER-3", UPDATED, body);
			assert.equal(outboxRowsOf(store, "DISPUTE_EVIDENCE").length, 2);
			assert.equal(calls.filter(call => call.method === "POST").length, 2);
		});
	}, verifiedRow());
});

test("a dispute whose capture the job's stored capture does not match is never read with House's own app", async () => {
	const row = verifiedRow();
	if (row.state.status !== "VERIFIED") throw new Error(`expected VERIFIED, got ${row.state.status}`);
	// The index still names this job for the disputed capture, but the job now holds a different capture: the owner is not validated.
	const other: JobRow = { ...row, state: { ...row.state, escrow: { ...row.state.escrow, capture: { ...row.state.escrow.capture,
		captureId: "OTHER-CAPTURE" as CaptureId } } } };
	const body = offering({ updateTime: "2026-10-22T11:00:00Z", status: "WAITING_FOR_SELLER_RESPONSE" }, ["send_message", "accept_claim"]);
	await withVerifiedJob(async store => {
		const ports = livePorts(store);
		await withFakePayPal(livePayPal(body, 204), async calls => {
			await deliver(ports, "WH-MISMATCH", UPDATED, body);
			assert.deepEqual(calls.filter(call => call.lane === "HOUSE"), []);
			assert.equal((await jobOf(store)).providerDispute, undefined);
		});
	}, other);
});

test("a dispute on a job paid to a merchant other than House is read with the platform's own app, and never with House's", async () => {
	const body = offering({ updateTime: "2026-10-22T11:00:00Z", status: "UNDER_REVIEW" }, ["provide_evidence"]);
	const config: PayPalConfig = { ...liveConfig, house: { merchant: "HOUSE-OTHER" as MerchantId, clientId: HOUSE_CLIENT, secret: "house-secret" } };
	await withVerifiedJob(async store => {
		const ports = livePorts(store, config);
		await withFakePayPal(livePayPal(body, 204), async calls => {
			await deliver(ports, "WH-OTHER-MERCHANT", UPDATED, body);
			assert.deepEqual(calls.map(call => ({ lane: call.lane, assertion: call.assertion })), [{ lane: "PLATFORM", assertion: true }]);
			// The platform's refusal stands in as before: the dispute is recorded unconfirmed and the hold stands.
			assert.equal(outcomeOf(store, "WH-OTHER-MERCHANT"), "verified, applied");
			assert.equal((await jobOf(store)).providerDispute?.unconfirmed, true);
		});
	});
});
