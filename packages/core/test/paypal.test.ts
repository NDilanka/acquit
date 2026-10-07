// Wire parsing for the money path, pinned against bodies recorded live from the PayPal sandbox on
// 2026-10-07. Ids, amounts, statuses, and times are the recorded ones; the cardholder's name and
// address, the payer email, and the sandbox account's own details were removed before storing them.

import assert from "node:assert/strict";
import test from "node:test";
import { instant } from "../src/ids.ts";
import type { CaptureId, MerchantId, OrderId, PayoutBatchId, PayoutItemId, RefundId } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import { createPayPal, parseCapture, parseCaptureRefundState, parseReferencedPayout, parseRefund, parseRefundedCapture, parseReimbursement, parseWebhookEnvelope } from "../src/paypal.ts";
import type { Bps, PayPalCall } from "../src/paypal.ts";

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
	assert.equal(capture.deliveryId, "WH-1");
	assert.deepEqual(capture.resource, { kind: "CAPTURE", id: "C1" });
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
	assert.equal(sale.kind, "UNROUTED");
	assert.equal(parseWebhookEnvelope("not json").kind, "UNREADABLE");
	assert.equal(parseWebhookEnvelope(envelope({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "C1" } })).kind, "UNREADABLE");
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

/** Answers the OAuth call, records every API call, and delegates the rest to the given wire. */
function recordedWire(wire: (url: string, init: RequestInit) => Response): { calls: { readonly method: string; readonly path: string; readonly requestId: string | null; readonly body: unknown }[] } {
	const calls: { method: string; path: string; requestId: string | null; body: unknown }[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "recorded-token", expires_in: 300 });
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ method: init?.method ?? "GET", path: new URL(url).pathname, requestId: headers["PayPal-Request-Id"] ?? null,
			body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
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
	assert.deepEqual(state, { captureId: "5GT95218NT9294342" as CaptureId, gross: 42000, processorFee: 1137, refunded: true, at: instant("2026-10-07T00:29:21Z") });
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
