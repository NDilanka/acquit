// The buyer dispute webhook when PayPal refuses the dispute read with a 403: the platform holds no dispute permission
// for the merchant. The signed delivery stands in for the read, so the job that holds the capture records the dispute
// and its release stays held. The bodies carry the dispute fields the sandbox sent on 2026-10-22, as the brief lists them;
// names and merchant ids are placeholders.

import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../src/acquit.ts";
import { ingestPayPalWebhook } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { hours, instant, parseBidId, parseJobId } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, Digest, MerchantId, OperatorId, OrderId, Version } from "../src/ids.ts";
import { applyJobCommand, releaseHeld, TERMS, wakeAt } from "../src/job.ts";
import type { JobRow } from "../src/job.ts";
import { commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import { parseWebhookEnvelope, quote } from "../src/paypal.ts";
import type { Bps } from "../src/paypal.ts";
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

async function withVerifiedJob(body: (store: SqliteStore, ports: Ports) => Promise<void>): Promise<void> {
	const store = new SqliteStore(":memory:");
	try {
		const row = verifiedRow();
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
const disputeResource = (fields: { readonly updateTime: string; readonly status: string; readonly outcome?: string; readonly capture?: string }) => ({
	dispute_id: disputeId, create_time: "2026-10-22T10:05:00Z", update_time: fields.updateTime,
	reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", dispute_channel: "INTERNAL", dispute_life_cycle_stage: "INQUIRY",
	status: fields.status, dispute_amount: { currency_code: "USD", value: "21.00" },
	disputed_transactions: [{ buyer_transaction_id: "BUYER-TXN-SCRUBBED", seller_transaction_id: fields.capture ?? captureId,
		transaction_status: "COMPLETED", seller: { merchant_id: "MERCHANT-SCRUBBED" }, items: [], seller_protection_eligible: false }],
	links: [{ href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}`, rel: "self", method: "GET" }],
	...(fields.outcome === undefined ? {} : { dispute_outcome: { outcome_code: fields.outcome } }),
});

const deliver = (ports: Ports, eventId: string, eventType: string, resource: object, devReplay = false): Promise<Response> =>
	ingestPayPalWebhook(ports, new Request("http://acquit.test/paypal/webhook", { method: "POST",
		body: JSON.stringify({ id: eventId, event_type: eventType, resource_type: "dispute", resource }) }), devReplay);

const CREATED = "CUSTOMER.DISPUTE.CREATED";
const UPDATED = "CUSTOMER.DISPUTE.UPDATED";
const RESOLVED = "CUSTOMER.DISPUTE.RESOLVED";

test("a CREATED delivery the read refused records the dispute on the job that holds its capture, and holds the release", async () => {
	await withVerifiedJob(async (store, ports) => {
		assert.equal((await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }))).status, 202);
		assert.equal(outcomeOf(store, "WH-CREATED-403"), "verified, applied");
		const row = await jobOf(store);
		assert.deepEqual(row.providerDispute, { id: disputeId, status: "UNDER_REVIEW", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
			amount: usd("21.00"), openedAt: instant("2026-10-22T10:05:00Z"), updatedAt: instant("2026-10-22T10:05:00Z"), answer: "EVIDENCE" });
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

test("a seller-favour resolution with a newer update time lifts the hold, and the release may proceed", async () => {
	await withVerifiedJob(async (store, ports) => {
		await deliver(ports, "WH-CREATED-403", CREATED, disputeResource({ updateTime: "2026-10-22T10:05:00Z", status: "UNDER_REVIEW" }));
		await deliver(ports, "WH-UPDATED-403", UPDATED, disputeResource({ updateTime: "2026-10-22T11:00:00Z", status: "WAITING_FOR_SELLER_RESPONSE" }));
		await deliver(ports, "WH-RESOLVED-403", RESOLVED, disputeResource({ updateTime: "2026-10-23T09:00:00Z", status: "RESOLVED",
			outcome: "RESOLVED_SELLER_FAVOUR" }));
		const row = await jobOf(store);
		assert.equal(row.providerDispute?.status, "RESOLVED");
		assert.equal(row.providerDispute?.outcome, "RESOLVED_SELLER_FAVOUR");
		assert.equal(releaseHeld(row), false);
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
