// Wire parsing for the money path, pinned against bodies recorded live from the PayPal sandbox on
// 2026-10-07. Ids, amounts, statuses, and times are the recorded ones; the cardholder's name and
// address, the payer email, and the sandbox account's own details were removed before storing them.

import assert from "node:assert/strict";
import test from "node:test";
import { instant } from "../src/ids.ts";
import type { CaptureId, MerchantId, OrderId, PayoutBatchId, PayoutItemId, RefundId } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import { authAssertion, createPayPal, DISPUTE_ACCESS_REFUSED, disputeOfVerifiedDelivery, houseCredentialsFrom, parseCapture, parseCaptureRefundState, parseReferencedPayout, parseRefund, parseRefundedCapture, parseReimbursement, parseWebhookEnvelope } from "../src/paypal.ts";
import type { Bps, DisputeId, PayPalCall } from "../src/paypal.ts";

const devon = "D3SSQU3ZEN7R2" as MerchantId;
const platform = "LA4PH2WMNKTDN" as MerchantId;

/** A card capture of 420.00 with the platform fee instruction. The seller nets 363.78 because the card fee is 11.37. */
const cardOrder = {
	id: "27T27404LP7444538",
	intent: "CAPTURE",
	status: "COMPLETED",
	purchase_units: [{
		reference_id: "f2probe-prefer-1791333255794",
		amount: { currency_code: "USD", value: "420.00" },
		payee: { merchant_id: "D3SSQU3ZEN7R2" },
		payment_instruction: { platform_fees: [{ amount: { currency_code: "USD", value: "44.85" }, payee: { merchant_id: "LA4PH2WMNKTDN" } }], disbursement_mode: "DELAYED" },
		payments: { captures: [{
			id: "2GU594768B218031G",
			status: "COMPLETED",
			amount: { currency_code: "USD", value: "420.00" },
			final_capture: true,
			disbursement_mode: "DELAYED",
			seller_receivable_breakdown: {
				gross_amount: { currency_code: "USD", value: "420.00" },
				paypal_fee: { currency_code: "USD", value: "11.37" },
				platform_fees: [{ amount: { currency_code: "USD", value: "44.85" }, payee: { merchant_id: "LA4PH2WMNKTDN" } }],
				net_amount: { currency_code: "USD", value: "363.78" },
			},
			create_time: "2026-10-07T00:34:19Z",
		}] },
	}],
};

/** The referenced payout item that released capture 4X1725081B3889825. */
const releaseBody = {
	item_id: "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=",
	processing_state: { status: "SUCCESS" },
	reference_id: "4X1725081B3889825",
	reference_type: "TRANSACTION_ID",
	payout_transaction_id: "8J3289658A108104N",
	external_reference_id: "probe-release-tid-1791333008710",
	payout_amount: { currency_code: "USD", value: "363.78" },
	payout_destination: "D3SSQU3ZEN7R2",
	custom: "f2probe-1791332771705",
	last_response_code: 0,
	time_updated: 0,
	links: [{ href: "https://api.sandbox.paypal.com/v1/payments/referenced-payouts-items/9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=", rel: "self", method: "GET" }],
};

/** The full refund of capture 5GT95218NT9294342. Note the local offset in create_time. */
const refundBody = {
	id: "9CD12824GS946934H",
	amount: { currency_code: "USD", value: "420.00" },
	seller_payable_breakdown: {
		gross_amount: { currency_code: "USD", value: "420.00" },
		paypal_fee: { currency_code: "USD", value: "0.00" },
		platform_fees: [{ amount: { currency_code: "USD", value: "44.85" } }],
		net_amount: { currency_code: "USD", value: "375.15" },
		total_refunded_amount: { currency_code: "USD", value: "420.00" },
	},
	status: "COMPLETED",
	create_time: "2026-10-06T17:29:21-07:00",
	update_time: "2026-10-06T17:29:21-07:00",
	links: [
		{ href: "https://api.sandbox.paypal.com/v2/payments/refunds/9CD12824GS946934H", rel: "self", method: "GET" },
		{ href: "https://api.sandbox.paypal.com/v2/payments/captures/5GT95218NT9294342", rel: "up", method: "GET" },
	],
};

/** The same capture read back before the refund: COMPLETED, and supplementary_data names its order. */
const captureCompleted = {
	id: "2GU594768B218031G",
	status: "COMPLETED",
	amount: { currency_code: "USD", value: "420.00" },
	final_capture: true,
	disbursement_mode: "DELAYED",
	seller_receivable_breakdown: {
		gross_amount: { currency_code: "USD", value: "420.00" },
		paypal_fee: { currency_code: "USD", value: "11.37" },
		platform_fees: [{ amount: { currency_code: "USD", value: "44.85" }, payee: { merchant_id: "LA4PH2WMNKTDN" } }],
		net_amount: { currency_code: "USD", value: "363.78" },
	},
	supplementary_data: { related_ids: { order_id: "27T27404LP7444538" } },
	create_time: "2026-10-07T00:34:19Z",
	update_time: "2026-10-07T00:34:19Z",
};

/** The one item of the recorded reimbursement batch, as the payout item read answers it. */
const payoutItem = { payout_item_id: "2H2SYMTX4HLY2", transaction_status: "SUCCESS", payout_batch_id: "7JQW2B7WJJUCN" };

const envelope = (body: Record<string, unknown>) => JSON.stringify(body);

test("a webhook envelope names the resource family it routes and drops the rest", () => {
	const capture = parseWebhookEnvelope(envelope({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: "C1" } }));
	assert.equal(capture.kind, "DELIVERY");
	if (capture.kind !== "DELIVERY") throw new Error("Expected a delivery");
	// The boundary keeps the canonical envelope only: the body itself never leaves this function.
	assert.deepEqual(capture, { kind: "DELIVERY", deliveryId: "WH-1", eventType: "PAYMENT.CAPTURE.COMPLETED",
		resourceType: "capture", resourceId: "C1", resource: { kind: "CAPTURE", id: "C1" } });
	// A refund event shares capture's prefix: the family is the resource_type, and the event is the fallback.
	const refund = parseWebhookEnvelope(envelope({ id: "WH-2", event_type: "PAYMENT.CAPTURE.REFUNDED", resource_type: "refund", resource: { id: "R1" } }));
	assert.equal(refund.kind === "DELIVERY" ? refund.resource.kind : null, "REFUND");
	const release = parseWebhookEnvelope(envelope({ id: "WH-3", event_type: "PAYMENT.REFERENCED-PAYOUT-ITEM.COMPLETED",
		resource_type: "referenced_payouts_items", resource: { id: "P1" } }));
	assert.equal(release.kind === "DELIVERY" ? release.resource.kind : null, "REFERENCED_PAYOUT_ITEM");
	const reimbursement = parseWebhookEnvelope(envelope({ id: "WH-4", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
		resource_type: "payouts_item", resource: { id: "P2" } }));
	assert.equal(reimbursement.kind === "DELIVERY" ? reimbursement.resource.kind : null, "PAYOUT_ITEM");
	const sale = parseWebhookEnvelope(envelope({ id: "WH-5", event_type: "PAYMENT.SALE.COMPLETED", resource_type: "sale", resource: { id: "S1" } }));
	assert.deepEqual(sale, { kind: "UNROUTED", deliveryId: "WH-5", eventType: "PAYMENT.SALE.COMPLETED", resourceType: "sale", resourceId: "S1" });
	const unreadable = parseWebhookEnvelope("not json");
	assert.equal(unreadable.kind, "UNREADABLE");
	assert.match(unreadable.deliveryId, /^unreadable-[0-9a-f]{16}$/);
	assert.equal("raw" in unreadable, false);
	assert.equal(parseWebhookEnvelope(envelope({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "C1" } })).kind, "UNREADABLE");
});

test("a webhook envelope field longer than the bound is unreadable", () => {
	// PayPal's own ids are tens of characters. A field past the bound is attacker-controlled bytes, and
	// the boundary refuses it like any other body it cannot read.
	const over = parseWebhookEnvelope(envelope({ id: "W".repeat(201), event_type: "PAYMENT.CAPTURE.COMPLETED",
		resource_type: "capture", resource: { id: "C1" } }));
	assert.equal(over.kind, "UNREADABLE");
	if (over.kind !== "UNREADABLE") throw new Error("Expected an unreadable envelope");
	assert.equal(over.detail, "An envelope field exceeds 200 characters.");
	assert.match(over.deliveryId, /^unreadable-[0-9a-f]{16}$/);
	// The longest field the boundary keeps still routes.
	const exact = parseWebhookEnvelope(envelope({ id: "W".repeat(200), event_type: "PAYMENT.CAPTURE.COMPLETED",
		resource_type: "capture", resource: { id: "C1" } }));
	assert.equal(exact.kind, "DELIVERY");
	// Every envelope field is bounded, not only the event id.
	for (const body of [
		{ id: "WH-1", event_type: "E".repeat(201), resource_type: "capture", resource: { id: "C1" } },
		{ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "R".repeat(201), resource: { id: "C1" } },
		{ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: "C".repeat(201) } },
	]) {
		assert.equal(parseWebhookEnvelope(envelope(body)).kind, "UNREADABLE");
	}
});

test("a capture envelope's re-read settles the completed capture from its order", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(url => url.includes("/v2/payments/captures/") ? Response.json(captureCompleted) : Response.json(cardOrder));
	try {
		const read = await createPayPal(config).readResource({ kind: "CAPTURE", id: "2GU594768B218031G" as CaptureId }, devon);
		if (read.kind !== "SETTLED" || read.observation.kind !== "CAPTURE_COMPLETED") throw new Error(`Expected a completed capture, got ${JSON.stringify(read)}`);
		assert.equal(read.observation.capture.captureId, "2GU594768B218031G");
		assert.equal(read.observation.capture.gross, 42000);
		assert.equal(read.observation.capture.processorFee, 1137);
		assert.equal(read.observation.capture.platformFee, 4485);
		assert.equal(read.observation.capture.sellerNet, 36378);
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path]), [
			["GET", "/v2/payments/captures/2GU594768B218031G"], ["GET", "/v2/checkout/orders/27T27404LP7444538"]]);
	} finally { globalThis.fetch = original; }
});

test("a refunded capture's re-read settles the refund it carries", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(() => Response.json(captureAfterRefund));
	try {
		const read = await createPayPal(config).readResource({ kind: "CAPTURE", id: "5GT95218NT9294342" as CaptureId }, devon);
		if (read.kind !== "SETTLED" || read.observation.kind !== "REFUND_COMPLETED") throw new Error(`Expected a completed refund, got ${JSON.stringify(read)}`);
		assert.equal(read.observation.refund.refundId, null);
		assert.equal(read.observation.refund.captureId, "5GT95218NT9294342");
		assert.equal(read.observation.refund.refunded, 42000);
		assert.equal(read.observation.refund.retainedProcessorFee, 1137);
		assert.equal(read.observation.refund.at, instant("2026-10-07T00:29:21Z"));
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path]), [["GET", "/v2/payments/captures/5GT95218NT9294342"]]);
	} finally { globalThis.fetch = original; }
});

test("a refund envelope's re-read settles from the refund and the capture it names", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(url => url.includes("/v2/payments/refunds/") ? Response.json(refundBody) : Response.json(captureAfterRefund));
	try {
		const read = await createPayPal(config).readResource({ kind: "REFUND", id: "9CD12824GS946934H" as RefundId }, devon);
		if (read.kind !== "SETTLED" || read.observation.kind !== "REFUND_COMPLETED") throw new Error(`Expected a completed refund, got ${JSON.stringify(read)}`);
		assert.equal(read.observation.refund.refundId, "9CD12824GS946934H");
		assert.equal(read.observation.refund.captureId, "5GT95218NT9294342");
		assert.equal(read.observation.refund.refunded, 42000);
		assert.equal(read.observation.refund.retainedProcessorFee, 1137);
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path]), [
			["GET", "/v2/payments/refunds/9CD12824GS946934H"], ["GET", "/v2/payments/captures/5GT95218NT9294342"]]);
	} finally { globalThis.fetch = original; }
});

test("a refund read without an owning merchant still names the capture it carries", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(url => url.includes("/v2/payments/refunds/") ? Response.json(refundBody) : Response.json(captureAfterRefund));
	try {
		const read = await createPayPal(config).readResource({ kind: "REFUND", id: "9CD12824GS946934H" as RefundId }, null);
		// No merchant to assert, so the refund cannot settle here. The read still names the capture a job
		// can hold, which is what lets the route anchor the job and read again under its payee.
		assert.deepEqual(read, { kind: "HELD", detail: "Refund 9CD12824GS946934H has no owning job", anchor: "5GT95218NT9294342" as CaptureId });
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path]), [["GET", "/v2/payments/refunds/9CD12824GS946934H"]]);
	} finally { globalThis.fetch = original; }
});

test("a referenced payout item's re-read settles the release it recorded", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(() => Response.json(releaseBody));
	try {
		const read = await createPayPal(config).readResource({ kind: "REFERENCED_PAYOUT_ITEM", id: releaseBody.item_id as PayoutItemId }, null);
		if (read.kind !== "SETTLED" || read.observation.kind !== "RELEASE_COMPLETED") throw new Error(`Expected a completed release, got ${JSON.stringify(read)}`);
		assert.equal(read.observation.release.payoutItemId, releaseBody.item_id);
		assert.equal(read.observation.release.captureId, "4X1725081B3889825");
		assert.equal(read.observation.release.paid, 36378);
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path]),
			[["GET", `/v1/payments/referenced-payouts-items/${encodeURIComponent(releaseBody.item_id)}`]]);
	} finally { globalThis.fetch = original; }
});

test("a payout item's re-read settles the reimbursement through its batch", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(url => url.endsWith("/payouts-item/2H2SYMTX4HLY2") ? Response.json(payoutItem) : Response.json(payoutBatch));
	try {
		const read = await createPayPal(config).readResource({ kind: "PAYOUT_ITEM", id: "2H2SYMTX4HLY2" as PayoutItemId }, null);
		if (read.kind !== "SETTLED" || read.observation.kind !== "REIMBURSEMENT_COMPLETED") throw new Error(`Expected a completed reimbursement, got ${JSON.stringify(read)}`);
		assert.equal(read.observation.reimbursement.batchId, "7JQW2B7WJJUCN");
		assert.equal(read.observation.reimbursement.paid, 1515);
		assert.equal(read.observation.reimbursement.fee, 25);
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path]), [
			["GET", "/v1/payments/payouts-item/2H2SYMTX4HLY2"], ["GET", "/v1/payments/payouts/7JQW2B7WJJUCN"]]);
	} finally { globalThis.fetch = original; }
});

test("a resource PayPal does not hold is unknown, not a fact", async () => {
	const original = globalThis.fetch;
	recordedWire(() => Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 }));
	try {
		assert.deepEqual(await createPayPal(config).readResource({ kind: "CAPTURE", id: "CAPTURE_PAYPAL_NEVER_HAD" as CaptureId }, null), { kind: "UNKNOWN" });
	} finally { globalThis.fetch = original; }
});

/** The same capture read back after the refund. The refund's own id is not in this body. */
const captureAfterRefund = {
	id: "5GT95218NT9294342",
	amount: { currency_code: "USD", value: "420.00" },
	final_capture: true,
	disbursement_mode: "DELAYED",
	seller_receivable_breakdown: {
		gross_amount: { currency_code: "USD", value: "420.00" },
		paypal_fee: { currency_code: "USD", value: "11.37" },
		platform_fees: [{ amount: { currency_code: "USD", value: "44.85" }, payee: { merchant_id: "LA4PH2WMNKTDN" } }],
		net_amount: { currency_code: "USD", value: "363.78" },
	},
	status: "REFUNDED",
	create_time: "2026-10-07T00:28:48Z",
	update_time: "2026-10-07T00:29:21Z",
};

/** The same capture read back after a partial refund: PayPal kept it open, so the money is not settled. */
const capturePartiallyRefunded = { ...captureAfterRefund, status: "PARTIALLY_REFUNDED" };

/** The platform's standard payout batch that reimbursed Devon the 15.15 refund fee, settled. */
const payoutBatch = {
	batch_header: {
		payout_batch_id: "7JQW2B7WJJUCN",
		batch_status: "SUCCESS",
		time_created: "2026-10-07T00:31:03Z",
		time_completed: "2026-10-07T00:31:27Z",
		sender_batch_header: { sender_batch_id: "probe-payout-r1", email_subject: "Acquit refund fee reimbursement" },
		funding_source: "BALANCE",
		amount: { currency: "USD", value: "15.15" },
		fees: { currency: "USD", value: "0.25" },
	},
	items: [{
		payout_item_id: "2H2SYMTX4HLY2",
		transaction_id: "6NF56829HA2348238",
		transaction_status: "SUCCESS",
		payout_item_fee: { currency: "USD", value: "0.25" },
		payout_batch_id: "7JQW2B7WJJUCN",
		payout_item: { recipient_type: "PAYPAL_ID", amount: { currency: "USD", value: "15.15" }, note: "Acquit refund fee reimbursement",
			receiver: "D3SSQU3ZEN7R2", sender_item_id: "probe-payout-r1-1", recipient_wallet: "PAYPAL", purpose: "GOODS" },
		time_processed: "2026-10-07T00:31:20Z",
	}],
};

/** A release that a fresh request id refused because the capture's payout already completed. */
const duplicateRelease = { name: "PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE", debug_id: "f84811346ee03", message: "PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE" };

/** A refund that a fresh request id refused because the capture was already fully refunded. */
const duplicateRefund = {
	name: "UNPROCESSABLE_ENTITY",
	message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
	debug_id: "f927194747a70",
	details: [{ issue: "CAPTURE_FULLY_REFUNDED", description: "The capture has already been fully refunded" }],
	links: [{ href: "https://developer.paypal.com/docs/api/payments/v2/#error-CAPTURE_FULLY_REFUNDED", rel: "information_link" }],
};

/** A payout that repeated a sender_batch_id and was told which batch already carries it. */
const duplicatePayout = {
	name: "USER_BUSINESS_ERROR",
	message: "User business error.",
	debug_id: "f965791731e52",
	information_link: "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors",
	details: [{ field: "SENDER_BATCH_ID", location: "body", issue: "Batch with given sender_batch_id already exists",
		link: [{ href: "https://api.sandbox.paypal.com/v1/payments/payouts/7JQW2B7WJJUCN", rel: "self", method: "GET", encType: "application/json" }] }],
	links: [],
};

const config = { apiBase: "https://api-m.sandbox.paypal.com" as const, webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
	webhookId: "", partnerMerchant: platform, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } };

/** Answers the OAuth call, records every API call, and delegates the rest to the given wire. A multipart body is kept as the FormData it was sent as. */
function recordedWire(wire: (url: string, init: RequestInit) => Response): { calls: { readonly method: string; readonly path: string; readonly requestId: string | null;
	readonly body: unknown; readonly headers: Record<string, string> }[] } {
	const calls: { method: string; path: string; requestId: string | null; body: unknown; headers: Record<string, string> }[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "recorded-token", expires_in: 300 });
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ method: init?.method ?? "GET", path: new URL(url).pathname, requestId: headers["PayPal-Request-Id"] ?? null,
			body: init?.body === undefined ? null : init.body instanceof FormData ? init.body : JSON.parse(String(init.body)), headers });
		return wire(url, init ?? {});
	}) as typeof fetch;
	return { calls };
}

test("parseCapture reads the recorded card capture into literal cents", () => {
	const capture = parseCapture(cardOrder);
	assert.deepEqual(capture, { orderId: "27T27404LP7444538", captureId: "2GU594768B218031G", payee: devon, disbursement: "DELAYED",
		gross: 42000, processorFee: 1137, platformFee: 4485, sellerNet: 36378, capturedAt: instant("2026-10-07T00:34:19Z") });
	assert.equal(capture.gross, 42000);
	assert.equal(capture.processorFee + capture.platformFee + capture.sellerNet, capture.gross);
});

test("parseReferencedPayout reads the recorded release as the net paid to the operator", () => {
	const release = parseReferencedPayout(releaseBody, instant("2026-10-07T00:35:00Z"));
	assert.equal(release.captureId, "4X1725081B3889825");
	assert.equal(release.paid, 36378);
	assert.equal(release.payoutItemId, "9qbheqa1MGMRG1pQyIAUjUL5ZVwZZeNBUoKIVYpj5aweGgnHBS20alUfiTIbfQg=" as PayoutItemId);
	assert.equal(release.at, instant("2026-10-07T00:35:00Z"));
});

test("parseRefund takes the refunded gross from the refund and the retained fee from the capture", () => {
	const state = parseCaptureRefundState(captureAfterRefund);
	assert.deepEqual(state, { captureId: "5GT95218NT9294342" as CaptureId, gross: 42000, processorFee: 1137,
		refundState: "REFUNDED", at: instant("2026-10-07T00:29:21Z") });
	const refund = parseRefund(refundBody, state);
	assert.equal(refund.refundId, "9CD12824GS946934H" as RefundId);
	assert.equal(refund.captureId, "5GT95218NT9294342");
	assert.equal(refund.refunded, 42000);
	assert.equal(refund.retainedProcessorFee, 1137);
	// The recorded create_time carries a local offset, so the evidence is normalized to UTC.
	assert.equal(refund.at, instant("2026-10-07T00:29:21Z"));
});

test("a refund read back from the capture has no refund id and the observed cents", () => {
	const refund = parseRefundedCapture(parseCaptureRefundState(captureAfterRefund));
	assert.equal(refund.refundId, null);
	assert.equal(refund.captureId, "5GT95218NT9294342");
	assert.equal(refund.refunded, 42000);
	assert.equal(refund.retainedProcessorFee, 1137);
	assert.equal(refund.at, instant("2026-10-07T00:29:21Z"));
});

test("parseReimbursement reads the recorded payout batch and its 0.25 fee", () => {
	const reimbursement = parseReimbursement(payoutBatch);
	assert.equal(reimbursement.batchId, "7JQW2B7WJJUCN" as PayoutBatchId);
	assert.equal(reimbursement.itemId, "2H2SYMTX4HLY2" as PayoutItemId);
	assert.equal(reimbursement.merchant, devon);
	assert.equal(reimbursement.paid, 1515);
	assert.equal(reimbursement.fee, 25);
	assert.equal(reimbursement.at, instant("2026-10-07T00:31:20Z"));
});

test("a release whose payout already completed parks for a person and never re-pays", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(() => Response.json(duplicateRelease, { status: 422 }));
	try {
		const paypal = createPayPal(config);
		const call: PayPalCall = { kind: "RELEASE", captureId: "4X1725081B3889825" as CaptureId, payee: devon };
		assert.deepEqual(await paypal.dispatch(call, "aq-release"), { kind: "PERMANENT_FAILURE", reason: "PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE" });
		assert.deepEqual(await paypal.reconcile(call, "aq-release"), { kind: "PERMANENT_FAILURE", reason: "PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE" });
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path, entry.requestId, entry.body]), [
			["POST", "/v1/payments/referenced-payouts-items", "aq-release", { reference_id: "4X1725081B3889825", reference_type: "TRANSACTION_ID" }],
			["POST", "/v1/payments/referenced-payouts-items", "aq-release", { reference_id: "4X1725081B3889825", reference_type: "TRANSACTION_ID" }],
		]);
	} finally { globalThis.fetch = original; }
});

test("a fully refunded capture settles from the capture lookup", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(url => url.endsWith("/refund") ? Response.json(duplicateRefund, { status: 422 }) : Response.json(captureAfterRefund));
	try {
		const paypal = createPayPal(config);
		const outcome = await paypal.dispatch({ kind: "REFUND", captureId: "5GT95218NT9294342" as CaptureId, payee: devon, amount: usd("420.00") }, "aq-refund");
		if (outcome.kind !== "CONFIRMED" || outcome.observation.kind !== "REFUND_COMPLETED") throw new Error(`Expected a completed refund, got ${JSON.stringify(outcome)}`);
		assert.equal(outcome.observation.refund.refundId, null);
		assert.equal(outcome.observation.refund.refunded, 42000);
		assert.equal(outcome.observation.refund.retainedProcessorFee, 1137);
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path, entry.requestId, entry.body]), [
			["POST", "/v2/payments/captures/5GT95218NT9294342/refund", "aq-refund", { amount: { currency_code: "USD", value: "420.00" } }],
			["GET", "/v2/payments/captures/5GT95218NT9294342", null, null],
		]);
	} finally { globalThis.fetch = original; }
});

test("a partially refunded capture is money back, never a settled refund", async () => {
	// PayPal's PARTIALLY_REFUNDED leaves a balance on the capture, so it is not the full refund of the
	// held gross: the parser names it, and the re-read holds it for a person instead of settling it.
	const state = parseCaptureRefundState(capturePartiallyRefunded);
	assert.equal(state.refundState, "PARTIALLY_REFUNDED");
	assert.equal(state.gross, 42000);
	assert.throws(() => parseRefundedCapture(state), /not fully refunded/);
	const original = globalThis.fetch;
	const wire = recordedWire(() => Response.json(capturePartiallyRefunded));
	try {
		const read = await createPayPal(config).readResource({ kind: "CAPTURE", id: "5GT95218NT9294342" as CaptureId }, devon);
		if (read.kind !== "HELD") throw new Error(`Expected a held read, got ${JSON.stringify(read)}`);
		assert.match(read.detail, /partially refunded/);
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path]), [["GET", "/v2/payments/captures/5GT95218NT9294342"]]);
	} finally { globalThis.fetch = original; }
});

test("a refund the provider refused on a partially refunded capture parks for a person", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(url => url.endsWith("/refund") ? Response.json(duplicateRefund, { status: 422 }) : Response.json(capturePartiallyRefunded));
	try {
		const paypal = createPayPal(config);
		assert.deepEqual(await paypal.dispatch({ kind: "REFUND", captureId: "5GT95218NT9294342" as CaptureId, payee: devon, amount: usd("420.00") }, "aq-refund"),
			{ kind: "PERMANENT_FAILURE", reason: "CAPTURE_PARTIALLY_REFUNDED" });
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path]), [
			["POST", "/v2/payments/captures/5GT95218NT9294342/refund"], ["GET", "/v2/payments/captures/5GT95218NT9294342"]]);
	} finally { globalThis.fetch = original; }
});

test("a repeated payout sender_batch_id finds the batch PayPal names and settles from it", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(url => url.endsWith("/v1/payments/payouts") ? Response.json(duplicatePayout, { status: 400 }) : Response.json(payoutBatch));
	try {
		const paypal = createPayPal(config);
		const outcome = await paypal.dispatch({ kind: "REIMBURSE", merchant: devon, amount: usd("15.15") }, "aq-reimburse");
		if (outcome.kind !== "CONFIRMED" || outcome.observation.kind !== "REIMBURSEMENT_COMPLETED") throw new Error(`Expected a completed payout, got ${JSON.stringify(outcome)}`);
		assert.equal(outcome.observation.reimbursement.batchId, "7JQW2B7WJJUCN");
		assert.equal(outcome.observation.reimbursement.paid, 1515);
		assert.equal(outcome.observation.reimbursement.fee, 25);
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path, entry.requestId]), [
			["POST", "/v1/payments/payouts", "aq-reimburse"],
			["GET", "/v1/payments/payouts/7JQW2B7WJJUCN", null],
		]);
		assert.deepEqual(wire.calls[0].body, { sender_batch_header: { sender_batch_id: "aq-reimburse", email_subject: "Acquit refund fee reimbursement",
			email_message: "Acquit repays the PayPal fee retained on a refund." },
			items: [{ recipient_type: "PAYPAL_ID", receiver: "D3SSQU3ZEN7R2", amount: { currency: "USD", value: "15.15" },
				note: "Acquit refund fee reimbursement", sender_item_id: "aq-reimburse-1" }] });
	} finally { globalThis.fetch = original; }
});

test("a first release dispatches once and reads back the recorded payout item", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(() => Response.json(releaseBody, { status: 201 }));
	try {
		const paypal = createPayPal(config);
		const outcome = await paypal.dispatch({ kind: "RELEASE", captureId: "4X1725081B3889825" as CaptureId, payee: devon }, "aq-release");
		if (outcome.kind !== "CONFIRMED" || outcome.observation.kind !== "RELEASE_COMPLETED") throw new Error(`Expected a completed release, got ${JSON.stringify(outcome)}`);
		assert.equal(outcome.observation.release.paid, 36378);
		assert.equal(outcome.observation.release.captureId, "4X1725081B3889825");
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path, entry.requestId, entry.body]),
			[["POST", "/v1/payments/referenced-payouts-items", "aq-release", { reference_id: "4X1725081B3889825", reference_type: "TRANSACTION_ID" }]]);
	} finally { globalThis.fetch = original; }
});

test("provide-evidence posts the notes as the multipart input part, under the request id and the payee's assertion", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(() => new Response(null, { status: 204 }));
	try {
		const notes = "Receipt rcpt_1 (receipt id) records job job_1 as delivered on attempt 1 (attemptsUsed).";
		const outcome = await createPayPal(config).dispatch({ kind: "DISPUTE_EVIDENCE", disputeId: "PP-D-9", notes, payee: devon }, "aq-dispute-evidence");
		assert.deepEqual(outcome, { kind: "CONFIRMED", observation: { kind: "DISPUTE_ANSWERED", disputeId: "PP-D-9", answer: "EVIDENCE", note: null } });
		assert.equal(wire.calls.length, 1);
		const [call] = wire.calls;
		assert.equal(call.method, "POST");
		assert.equal(call.path, "/v1/customer/disputes/PP-D-9/provide-evidence");
		assert.equal(call.requestId, "aq-dispute-evidence");
		assert.equal(call.headers["PayPal-Auth-Assertion"], authAssertion("test", devon));
		// A multipart body sends no JSON content type, so fetch writes the multipart boundary itself.
		assert.equal(call.headers["Content-Type"], undefined);
		if (!(call.body instanceof FormData)) throw new Error("Expected the multipart body");
		assert.deepEqual(JSON.parse(await (call.body.get("input") as Blob).text()),
			{ evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", notes, documents: [] }] });
	} finally { globalThis.fetch = original; }
});

test("accept-claim posts the note as JSON under the request id, and a 2xx confirms the answer", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(() => new Response(null, { status: 204 }));
	try {
		const note = "Acquit accepts the buyer's claim on dispute PP-D-9 for capture 4X1725081B3889825 on job job_1.";
		const outcome = await createPayPal(config).dispatch({ kind: "DISPUTE_ACCEPT", disputeId: "PP-D-9", note, payee: devon }, "aq-dispute-accept");
		assert.deepEqual(outcome, { kind: "CONFIRMED", observation: { kind: "DISPUTE_ANSWERED", disputeId: "PP-D-9", answer: "ACCEPT", note: null } });
		assert.deepEqual(wire.calls.map(entry => [entry.method, entry.path, entry.requestId, entry.body]),
			[["POST", "/v1/customer/disputes/PP-D-9/accept-claim", "aq-dispute-accept", { note }]]);
		assert.equal(wire.calls[0].headers["Content-Type"], "application/json");
	} finally { globalThis.fetch = original; }
});

test("a dispute answer PayPal refuses with a 422 confirms with the note it already holds, and is sent once", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(() => Response.json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "DISPUTE_NOT_IN_OPEN_STATE" }] }, { status: 422 }));
	try {
		const paypal = createPayPal(config);
		assert.deepEqual(await paypal.dispatch({ kind: "DISPUTE_EVIDENCE", disputeId: "PP-D-9", notes: "n", payee: devon }, "aq-dispute-evidence"),
			{ kind: "CONFIRMED", observation: { kind: "DISPUTE_ANSWERED", disputeId: "PP-D-9", answer: "EVIDENCE", note: "PAYPAL_422_DISPUTE_NOT_IN_OPEN_STATE" } });
		assert.deepEqual(await paypal.dispatch({ kind: "DISPUTE_ACCEPT", disputeId: "PP-D-9", note: "n", payee: devon }, "aq-dispute-accept"),
			{ kind: "CONFIRMED", observation: { kind: "DISPUTE_ANSWERED", disputeId: "PP-D-9", answer: "ACCEPT", note: "PAYPAL_422_DISPUTE_NOT_IN_OPEN_STATE" } });
		// The 422 is an answer PayPal already holds, so it is never resent by the request layer.
		assert.deepEqual(wire.calls.map(entry => entry.path), ["/v1/customer/disputes/PP-D-9/provide-evidence", "/v1/customer/disputes/PP-D-9/accept-claim"]);
	} finally { globalThis.fetch = original; }
});

test("a dispute 422 that names no settled answer is refused for a person, never confirmed, and a non-retryable 4xx stays permanent", async () => {
	const original = globalThis.fetch;
	try {
		const named = recordedWire(() => Response.json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "EVIDENCE_NOT_ACCEPTED" }] }, { status: 422 }));
		assert.deepEqual(await createPayPal(config).dispatch({ kind: "DISPUTE_EVIDENCE", disputeId: "PP-D-9", notes: "n", payee: devon }, "aq-dispute-evidence"),
			{ kind: "PERMANENT_FAILURE", reason: "PAYPAL_422_EVIDENCE_NOT_ACCEPTED" });
		assert.equal(named.calls.length, 1);
		// A 422 that names no issue is refused too, and the reason says so.
		recordedWire(() => Response.json({ name: "UNPROCESSABLE_ENTITY" }, { status: 422 }));
		assert.deepEqual(await createPayPal(config).dispatch({ kind: "DISPUTE_ACCEPT", disputeId: "PP-D-9", note: "n", payee: devon }, "aq-dispute-accept"),
			{ kind: "PERMANENT_FAILURE", reason: "PAYPAL_422_UNSPECIFIED" });
		// A 400 is a non-retryable refusal, as it is for every other PayPal write.
		recordedWire(() => Response.json({ name: "INVALID_REQUEST" }, { status: 400 }));
		assert.deepEqual(await createPayPal(config).dispatch({ kind: "DISPUTE_ACCEPT", disputeId: "PP-D-9", note: "n", payee: devon }, "aq-dispute-accept"),
			{ kind: "PERMANENT_FAILURE", reason: "PAYPAL_HTTP_400" });
	} finally { globalThis.fetch = original; }
});

test("a dispute answer that fails with a 5xx is unknown, not a refusal, and the write is not re-sent by the request layer", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(() => Response.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }));
	try {
		const outcome = await createPayPal(config).dispatch({ kind: "DISPUTE_ACCEPT", disputeId: "PP-D-9", note: "n", payee: devon }, "aq-dispute-accept");
		assert.equal(outcome.kind, "UNKNOWN");
		assert.equal(wire.calls.length, 1);
	} finally { globalThis.fetch = original; }
});

test("PayPal has no lookup for a dispute answer, so reconcile names it not found without a call", async () => {
	const original = globalThis.fetch;
	const wire = recordedWire(() => new Response(null, { status: 204 }));
	try {
		assert.deepEqual(await createPayPal(config).reconcile({ kind: "DISPUTE_EVIDENCE", disputeId: "PP-D-9", notes: "n", payee: devon }, "aq-dispute-evidence"),
			{ kind: "NOT_FOUND" });
		assert.deepEqual(wire.calls, []);
	} finally { globalThis.fetch = original; }
});

const sandboxDispute = "PP-R-PPB-10194003" as DisputeId;

test("a dispute read PayPal refuses with a 403 is a refusal sent once, and a 5xx is a failure the route never stands in for", async () => {
	const original = globalThis.fetch;
	try {
		const refused = recordedWire(() => Response.json({ name: "NOT_AUTHORIZED" }, { status: 403 }));
		assert.deepEqual(await createPayPal(config).readResource({ kind: "DISPUTE", id: sandboxDispute }, devon), { kind: "REFUSED", reason: "PAYPAL_HTTP_403" });
		assert.equal(refused.calls.length, 1);
		recordedWire(() => Response.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 }));
		await assert.rejects(createPayPal(config).readResource({ kind: "DISPUTE", id: sandboxDispute }, devon));
	} finally { globalThis.fetch = original; }
});

test("a dispute answer PayPal refuses with a 403 is permanent with the plain reason for a person, and is sent once", async () => {
	const original = globalThis.fetch;
	try {
		const evidence = recordedWire(() => Response.json({ name: "NOT_AUTHORIZED" }, { status: 403 }));
		assert.deepEqual(await createPayPal(config).dispatch({ kind: "DISPUTE_EVIDENCE", disputeId: sandboxDispute, notes: "n", payee: devon }, "aq-dispute-evidence"),
			{ kind: "PERMANENT_FAILURE", reason: DISPUTE_ACCESS_REFUSED });
		assert.equal(evidence.calls.length, 1);
		const accept = recordedWire(() => Response.json({ name: "NOT_AUTHORIZED" }, { status: 403 }));
		assert.deepEqual(await createPayPal(config).dispatch({ kind: "DISPUTE_ACCEPT", disputeId: sandboxDispute, note: "n", payee: devon }, "aq-dispute-accept"),
			{ kind: "PERMANENT_FAILURE", reason: DISPUTE_ACCESS_REFUSED });
		assert.equal(accept.calls.length, 1);
	} finally { globalThis.fetch = original; }
});

/** A buyer dispute body with the fields the sandbox sent on 2026-10-22, as the brief lists them. Names and merchant ids are placeholders. */
const verifiedBody = (overrides: Record<string, unknown> = {}) => ({
	dispute_id: "PP-R-PPB-10194003", create_time: "2026-10-22T10:05:00Z", update_time: "2026-10-22T10:05:00Z",
	reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", dispute_channel: "INTERNAL", dispute_life_cycle_stage: "INQUIRY",
	status: "UNDER_REVIEW", dispute_amount: { currency_code: "USD", value: "21.00" },
	disputed_transactions: [{ buyer_transaction_id: "BUYER-TXN-SCRUBBED", seller_transaction_id: "1WL969806P110802T", transaction_status: "COMPLETED",
		seller: { merchant_id: "MERCHANT-SCRUBBED" }, items: [], seller_protection_eligible: false }],
	links: [{ href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-PPB-10194003", rel: "self", method: "GET" }],
	...overrides,
});
const deliveryRaw = (resource: Record<string, unknown>): string => JSON.stringify({ id: "WH-DISPUTE-403", event_type: "CUSTOMER.DISPUTE.CREATED",
	resource_type: "dispute", resource });

test("a verified dispute delivery stands in for a refused read with its capture, amount, status, and update time", () => {
	const received = instant("2026-10-22T11:00:00Z");
	assert.deepEqual(disputeOfVerifiedDelivery(deliveryRaw(verifiedBody()), "PP-R-PPB-10194003", received), { kind: "DISPUTE",
		disputeId: "PP-R-PPB-10194003", captureId: "1WL969806P110802T", status: "UNDER_REVIEW", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
		amount: usd("21.00"), openedAt: instant("2026-10-22T10:05:00Z"), updatedAt: instant("2026-10-22T10:05:00Z"), fromVerifiedBody: true,
		stage: "INQUIRY", offers: [] });
});

test("a delivery stands in for a refused read only when it names that dispute and a seller transaction", () => {
	const received = instant("2026-10-22T11:00:00Z");
	assert.equal(disputeOfVerifiedDelivery(deliveryRaw(verifiedBody()), "PP-D-OTHER", received), null);
	assert.equal(disputeOfVerifiedDelivery(deliveryRaw(verifiedBody({ disputed_transactions: [] })), "PP-R-PPB-10194003", received), null);
	assert.equal(disputeOfVerifiedDelivery("not json", "PP-R-PPB-10194003", received), null);
});

test("a stand-in with no update time or an unreadable amount still names the dispute and its capture, and leaves the rest absent", () => {
	const received = instant("2026-10-22T11:00:00Z");
	assert.deepEqual(disputeOfVerifiedDelivery(deliveryRaw(verifiedBody({ update_time: undefined })), "PP-R-PPB-10194003", received), { kind: "DISPUTE",
		disputeId: "PP-R-PPB-10194003", captureId: "1WL969806P110802T", status: "UNDER_REVIEW", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
		amount: usd("21.00"), openedAt: instant("2026-10-22T10:05:00Z"), fromVerifiedBody: true, stage: "INQUIRY", offers: [] });
	const unreadable = disputeOfVerifiedDelivery(deliveryRaw(verifiedBody({ dispute_amount: { currency_code: "EUR", value: "21.00" },
		create_time: undefined, update_time: "not a time" })), "PP-R-PPB-10194003", received);
	assert.equal(unreadable?.amount, null);
	assert.equal(unreadable?.openedAt, received, "a body with no create time opens at receipt");
	assert.equal(unreadable?.updatedAt, undefined);
});

const houseMerchant = "BJ35XXMMSGTPN" as MerchantId;
const houseConfig = { ...config, house: { merchant: houseMerchant, clientId: "house-client", secret: "house-secret" } };

type WireCall = { readonly method: string; readonly path: string; readonly bearer: string; readonly assertion: string | null; readonly body: unknown };
/**
 * Answers OAuth for each client id and records every API call with the bearer token and PayPal-Auth-Assertion it carried.
 * Each token names the client id it was minted for, so a test sees which credential set a call used. A multipart body is
 * not recorded, and a JSON body is recorded as the object it was sent as.
 */
function laneWire(wire: (url: string) => Response): { readonly tokenClients: string[]; readonly calls: WireCall[] } {
	const tokenClients: string[] = [];
	const calls: WireCall[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		if (url.endsWith("/v1/oauth2/token")) {
			const clientId = Buffer.from(String(headers.Authorization).replace("Basic ", ""), "base64").toString("utf8").split(":")[0] ?? "";
			tokenClients.push(clientId);
			return Response.json({ access_token: `token-of-${clientId}`, expires_in: 300 });
		}
		calls.push({ method: init?.method ?? "GET", path: new URL(url).pathname, bearer: String(headers.Authorization).replace("Bearer ", ""),
			assertion: headers["PayPal-Auth-Assertion"] ?? null, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
		return wire(url);
	}) as typeof fetch;
	return { tokenClients, calls };
}

test("a dispute of any other merchant keeps the platform token and asserts its payee, even with House's app configured", async () => {
	const original = globalThis.fetch;
	try {
		const wire = laneWire(() => Response.json(verifiedBody()));
		assert.equal((await createPayPal(houseConfig).readResource({ kind: "DISPUTE", id: sandboxDispute }, devon)).kind, "SETTLED");
		assert.deepEqual(wire.tokenClients, ["test"]);
		assert.deepEqual(wire.calls.map(call => [call.path, call.bearer, call.assertion]),
			[[`/v1/customer/disputes/${sandboxDispute}`, "token-of-test", authAssertion("test", devon)]]);
	} finally { globalThis.fetch = original; }
});

test("a House dispute read and its answers use House's own token, with no PayPal-Auth-Assertion, and one House token serves them", async () => {
	const original = globalThis.fetch;
	try {
		const wire = laneWire(url => url.endsWith("/accept-claim") || url.endsWith("/send-message") || url.endsWith("/provide-evidence")
			? new Response(null, { status: 204 }) : Response.json(verifiedBody()));
		const paypal = createPayPal(houseConfig);
		assert.equal((await paypal.readResource({ kind: "DISPUTE", id: sandboxDispute }, houseMerchant)).kind, "SETTLED");
		assert.deepEqual(await paypal.dispatch({ kind: "DISPUTE_EVIDENCE", disputeId: sandboxDispute, notes: "n", payee: houseMerchant }, "aq-house-evidence"),
			{ kind: "CONFIRMED", observation: { kind: "DISPUTE_ANSWERED", disputeId: sandboxDispute, answer: "EVIDENCE", note: null } });
		assert.deepEqual(await paypal.dispatch({ kind: "DISPUTE_MESSAGE", disputeId: sandboxDispute, message: "m", payee: houseMerchant }, "aq-house-message"),
			{ kind: "CONFIRMED", observation: { kind: "DISPUTE_ANSWERED", disputeId: sandboxDispute, answer: "MESSAGE", note: null } });
		assert.deepEqual(await paypal.dispatch({ kind: "DISPUTE_ACCEPT", disputeId: sandboxDispute, note: "n", payee: houseMerchant }, "aq-house-accept"),
			{ kind: "CONFIRMED", observation: { kind: "DISPUTE_ANSWERED", disputeId: sandboxDispute, answer: "ACCEPT", note: null } });
		assert.deepEqual(wire.tokenClients, ["house-client"]);
		assert.deepEqual(wire.calls.map(call => [call.method, call.path, call.bearer, call.assertion]), [
			["GET", `/v1/customer/disputes/${sandboxDispute}`, "token-of-house-client", null],
			["POST", `/v1/customer/disputes/${sandboxDispute}/provide-evidence`, "token-of-house-client", null],
			["POST", `/v1/customer/disputes/${sandboxDispute}/send-message`, "token-of-house-client", null],
			["POST", `/v1/customer/disputes/${sandboxDispute}/accept-claim`, "token-of-house-client", null],
		]);
		assert.deepEqual(wire.calls[2]?.body, { message: "m" });
	} finally { globalThis.fetch = original; }
});

test("House's own capture and refund calls keep the platform token and its assertion", async () => {
	const original = globalThis.fetch;
	try {
		const wire = laneWire(url => url.endsWith("/refund") ? Response.json(refundBody) : Response.json(captureAfterRefund));
		const outcome = await createPayPal(houseConfig).dispatch({ kind: "REFUND", captureId: "5GT95218NT9294342" as CaptureId, payee: houseMerchant,
			amount: usd("420.00") }, "aq-house-refund");
		assert.equal(outcome.kind, "CONFIRMED");
		assert.deepEqual(wire.tokenClients, ["test"]);
		assert.deepEqual(wire.calls.map(call => [call.method, call.path, call.bearer, call.assertion]), [
			["POST", "/v2/payments/captures/5GT95218NT9294342/refund", "token-of-test", authAssertion("test", houseMerchant)],
			["GET", "/v2/payments/captures/5GT95218NT9294342", "token-of-test", authAssertion("test", houseMerchant)],
		]);
	} finally { globalThis.fetch = original; }
});

test("without House's credentials a House dispute stays on the platform token and asserts the House payee", async () => {
	const original = globalThis.fetch;
	try {
		const wire = laneWire(() => Response.json(verifiedBody()));
		await createPayPal(config).readResource({ kind: "DISPUTE", id: sandboxDispute }, houseMerchant);
		assert.deepEqual(wire.tokenClients, ["test"]);
		assert.equal(wire.calls[0]?.assertion, authAssertion("test", houseMerchant));
	} finally { globalThis.fetch = original; }
});

test("a message PayPal refuses with a 403 is permanent with the plain reason for a person, and is sent once", async () => {
	const original = globalThis.fetch;
	try {
		const message = recordedWire(() => Response.json({ name: "NOT_AUTHORIZED" }, { status: 403 }));
		assert.deepEqual(await createPayPal(config).dispatch({ kind: "DISPUTE_MESSAGE", disputeId: sandboxDispute, message: "m", payee: devon }, "aq-dispute-message"),
			{ kind: "PERMANENT_FAILURE", reason: DISPUTE_ACCESS_REFUSED });
		assert.equal(message.calls.length, 1);
		assert.equal(message.calls[0]?.path, `/v1/customer/disputes/${sandboxDispute}/send-message`);
	} finally { globalThis.fetch = original; }
});

test("House's own credentials are both or neither, and a lone one names the setting it lacks, never its value", () => {
	assert.equal(houseCredentialsFrom({}), null);
	assert.deepEqual(houseCredentialsFrom({ HOUSE_PAYPAL_CLIENT_ID: "house-client", HOUSE_PAYPAL_CLIENT_SECRET: "house-secret",
		OPERATOR_HOUSE_MERCHANT_ID: "BJ35XXMMSGTPN" }), { merchant: "BJ35XXMMSGTPN", clientId: "house-client", secret: "house-secret" });
	assert.throws(() => houseCredentialsFrom({ HOUSE_PAYPAL_CLIENT_ID: "house-client", OPERATOR_HOUSE_MERCHANT_ID: "BJ35XXMMSGTPN" }),
		{ message: "Missing configuration: HOUSE_PAYPAL_CLIENT_SECRET" });
	assert.throws(() => houseCredentialsFrom({ HOUSE_PAYPAL_CLIENT_SECRET: "house-secret-value", OPERATOR_HOUSE_MERCHANT_ID: "BJ35XXMMSGTPN" }),
		{ message: "Missing configuration: HOUSE_PAYPAL_CLIENT_ID" });
	assert.throws(() => houseCredentialsFrom({ HOUSE_PAYPAL_CLIENT_ID: "house-client", HOUSE_PAYPAL_CLIENT_SECRET: "house-secret" }),
		{ message: "Missing configuration: OPERATOR_HOUSE_MERCHANT_ID" });
});

test("a verified dispute delivery names the answer links it offers, and an answer link it does not name is not offered", () => {
	const received = instant("2026-10-22T11:00:00Z");
	const link = (rel: string) => ({ href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-PPB-10194003/${rel}`, rel, method: "POST" });
	const offering = verifiedBody({ dispute_life_cycle_stage: "CHARGEBACK", links: [link("self"), link("send_message"), link("accept_claim"), link("make_offer")] });
	const standIn = disputeOfVerifiedDelivery(deliveryRaw(offering), "PP-R-PPB-10194003", received);
	assert.equal(standIn?.stage, "CHARGEBACK");
	assert.deepEqual(standIn?.offers, ["send_message", "accept_claim"]);
	const unnamed = disputeOfVerifiedDelivery(deliveryRaw(verifiedBody({ links: undefined })), "PP-R-PPB-10194003", received);
	assert.equal(unnamed !== null && "offers" in unnamed, false, "a body with no links names no offers");
});
