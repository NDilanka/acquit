// Measured in the sandbox (scratch/paypal-escrow):
//   the payee is named at order creation, with disbursement_mode DELAYED and platform_fees
//   release is POST /v1/payments/referenced-payouts-items with the capture id and no amount field
//   a refund naming platform_fees fails with PLATFORM_FEE_NOT_ENABLED, a plain full refund succeeds
//   held funds auto-disburse after 28 days
//   links point at api.sandbox.paypal.com while the API base is api-m.sandbox.paypal.com
//   platform_fees 44.85 on 420.00 paid the operator exactly 360.00 (processor fee 15.15 on three captures)
//   a full refund debited the operator's balance by the 15.15 processor fee PayPal kept
//   GET order returned a transient 503 mid-poll, so reads retry before reporting UNKNOWN

import { setTimeout as sleep } from "node:timers/promises";
import { instant } from "./ids.ts";
import type { Branded, CaptureId, Instant, JobId, MerchantId, OperatorId, OrderId, PayoutBatchId, PayoutItemId, RefundId } from "./ids.ts";
import { formatUsd, usd } from "./ledger.ts";
import type { CommercialSplit, UsdCents } from "./ledger.ts";
import type { Clock } from "./acquit.ts";

/** Basis points. 349 is 3.49%. */
export type Bps = Branded<number, "Bps">;

/** Three sandbox captures of 420.00 each gave 15.15, which fits 3.49% + 0.49. The rate itself is inferred. */
export type ProcessorFeeModel = { readonly version: string; readonly rateBps: Bps; readonly fixed: UsdCents };

/** Frozen at AcceptBid and sent as the order body. Nobody recomputes it later. */
export type FeeQuote = {
	readonly split: CommercialSplit;
	readonly model: ProcessorFeeModel;
	readonly predictedProcessorFee: UsdCents;
	/** split.fee - predictedProcessorFee. 6000 - 1515 = 4485, so the operator nets 36000. */
	readonly platformFeeInstruction: UsdCents;
};

export function quote(split: CommercialSplit, model: ProcessorFeeModel): FeeQuote {
	if (!Number.isSafeInteger(model.rateBps) || model.rateBps < 0 || !Number.isSafeInteger(model.fixed) || model.fixed < 0) throw new Error("Invalid fee model");
	const predictedProcessorFee = (Number((BigInt(split.held) * BigInt(model.rateBps) + 5000n) / 10000n) + model.fixed) as UsdCents;
	if (predictedProcessorFee > split.fee) throw new Error("Price cannot carry processing fee");
	return { split, model, predictedProcessorFee, platformFeeInstruction: (split.fee - predictedProcessorFee) as UsdCents };
}

/** Read from seller_receivable_breakdown. Observed, never predicted. */
export type CaptureEvidence = {
	readonly orderId: OrderId;
	readonly captureId: CaptureId;
	readonly payee: MerchantId;
	readonly disbursement: "DELAYED";
	readonly gross: UsdCents;
	readonly processorFee: UsdCents;
	readonly platformFee: UsdCents;
	readonly sellerNet: UsdCents;
	readonly capturedAt: Instant;
};

export type ReleaseEvidence = {
	readonly payoutItemId: PayoutItemId;
	readonly captureId: CaptureId;
	readonly paid: UsdCents;
	readonly at: Instant;
};

export type RefundEvidence = {
	/** Null when the refund was read back from the capture: the provider names no refund id in that body. */
	readonly refundId: RefundId | null;
	readonly captureId: CaptureId;
	readonly refunded: UsdCents;
	/** PayPal keeps it and debits the operator (measured). Acquit reimburses the operator from treasury. */
	readonly retainedProcessorFee: UsdCents;
	readonly at: Instant;
};

/** The capture read back for its refund state. A full refund leaves no refund id here. */
export type CaptureRefundState = {
	readonly captureId: CaptureId;
	readonly gross: UsdCents;
	readonly processorFee: UsdCents;
	readonly refunded: boolean;
	readonly at: Instant;
};

/** A settled Standard Payout from the platform to the operator's merchant. */
export type ReimbursementEvidence = {
	readonly batchId: PayoutBatchId;
	readonly itemId: PayoutItemId;
	readonly merchant: MerchantId;
	readonly paid: UsdCents;
	/** PayPal's payout fee, taken from the platform on top of the paid amount (measured: 0.25). */
	readonly fee: UsdCents;
	readonly at: Instant;
};

export type PayPalCall =
	| { readonly kind: "CREATE_ORDER"; readonly jobId: JobId; readonly payee: MerchantId; readonly quote: FeeQuote; readonly fundingMode?: "checkout" | "card" }
	| { readonly kind: "CAPTURE"; readonly orderId: OrderId; readonly payee: MerchantId }
	| { readonly kind: "RELEASE"; readonly captureId: CaptureId; readonly payee: MerchantId }
	/** Full amount only. Never names platform_fees. */
	| { readonly kind: "REFUND"; readonly captureId: CaptureId; readonly payee: MerchantId; readonly amount: UsdCents }
	/** From the platform account to the operator's merchant. No auth assertion: the platform pays its own balance. */
	| { readonly kind: "REIMBURSE"; readonly merchant: MerchantId; readonly amount: UsdCents }
	| { readonly kind: "ONBOARD"; readonly operator: OperatorId };

export type PayPalObservation =
	| { readonly kind: "ORDER_CREATED"; readonly orderId: OrderId; readonly approveUrl: string }
	| { readonly kind: "ORDER_APPROVED"; readonly orderId: OrderId }
	| { readonly kind: "CAPTURE_COMPLETED"; readonly capture: CaptureEvidence }
	| { readonly kind: "RELEASE_COMPLETED"; readonly release: ReleaseEvidence }
	| { readonly kind: "REFUND_COMPLETED"; readonly refund: RefundEvidence }
	| { readonly kind: "REIMBURSEMENT_COMPLETED"; readonly reimbursement: ReimbursementEvidence }
	| { readonly kind: "ONBOARDING_LINK"; readonly operator: OperatorId; readonly actionUrl: string }
	| { readonly kind: "ONBOARDING_COMPLETED"; readonly operator: OperatorId; readonly merchant: MerchantId };

/** UNKNOWN never authorizes the opposite disposition. The outbox reconciles it with the same request id. */
export type RemoteOutcome =
	| { readonly kind: "CONFIRMED"; readonly observation: PayPalObservation }
	| { readonly kind: "PENDING"; readonly checkAt: Instant }
	| { readonly kind: "NOT_FOUND" }
	| { readonly kind: "UNKNOWN"; readonly checkAt: Instant }
	| { readonly kind: "PERMANENT_FAILURE"; readonly reason: string };

/** The resource a webhook names. The core routes by its own order and capture mapping, never by custom_id. */
export type ProviderResource =
	| { readonly kind: "ORDER"; readonly id: OrderId }
	| { readonly kind: "CAPTURE"; readonly id: CaptureId }
	| { readonly kind: "MERCHANT"; readonly operator: OperatorId };

export type WebhookDelivery = {
	readonly deliveryId: string;
	readonly resource: ProviderResource;
	/** Null for event types the core ignores. Built from a fresh GET of the resource, not the event body. */
	readonly observation: PayPalObservation | null;
};

export type PayPalConfig = {
	readonly webOrigin: string;
	readonly fundingMode?: () => "checkout" | "card";
	readonly apiBase: "https://api-m.sandbox.paypal.com";
	readonly clientId: string;
	readonly secret: string;
	readonly webhookId: string;
	readonly partnerMerchant: MerchantId;
	readonly feeModel: ProcessorFeeModel;
};

export interface PayPal {
	/** Fresh Orders v2 read. APPROVED and COMPLETED become trusted observations. */
	getOrder(orderId: OrderId, payee: MerchantId): Promise<RemoteOutcome>;
	/** requestId is sent as PayPal-Request-Id. effects.ts derives it from the job and effect kind. */
	dispatch(call: PayPalCall, requestId: string): Promise<RemoteOutcome>;
	/** Looks the call up by its correlation (order, capture, payout item, refund) before any resend. */
	reconcile(call: PayPalCall, requestId: string): Promise<RemoteOutcome>;
	parseWebhook(request: Request): Promise<WebhookDelivery | null>;
}

export function createPayPal(config: PayPalConfig, clock: Clock = { now: () => instant(new Date().toISOString()) }): PayPal {
	if (config.apiBase !== "https://api-m.sandbox.paypal.com") throw new Error("Only PayPal sandbox is supported");
	let token: string | null = null;
	let tokenExpires = 0;
	async function accessToken(): Promise<string> {
		if (token && Date.parse(clock.now()) < tokenExpires) return token;
		const response = await fetch(`${config.apiBase}/v1/oauth2/token`, {
			method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString("base64")}`,
				"Content-Type": "application/x-www-form-urlencoded" },
			body: "grant_type=client_credentials", signal: AbortSignal.timeout(15_000), redirect: "error",
		});
		if (!response.ok) throw new ProviderError(response.status);
		const body = object(await response.json());
		token = text(body.access_token);
		tokenExpires = Date.parse(clock.now()) + Math.max(0, Number(body.expires_in ?? 300) - 60) * 1000;
		return token;
	}
	async function request(method: "GET" | "POST", path: string, payee: MerchantId | null, body?: unknown, requestId?: string, extra: Record<string, string> = {}): Promise<unknown> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json",
					Prefer: "return=representation", ...extra };
				// A platform call pays from the platform's own balance and names no target merchant.
				if (payee !== null) headers["PayPal-Auth-Assertion"] = authAssertion(config.clientId, payee);
				if (requestId) headers["PayPal-Request-Id"] = requestId;
				if (process.env.PAYPAL_PARTNER_ATTRIBUTION_ID) headers["PayPal-Partner-Attribution-Id"] = process.env.PAYPAL_PARTNER_ATTRIBUTION_ID;
				const response = await fetch(normalizeLink(path, config.apiBase), {
					method, headers, body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(15_000), redirect: "error",
				});
				if (!response.ok) {
					if (response.status === 401) { token = null; tokenExpires = 0; }
					throw new ProviderError(response.status, await errorBody(response));
				}
				return await response.json();
			} catch (error) {
				const retry = method === "GET" && (!(error instanceof ProviderError) || error.status >= 500 || error.status === 429 || error.status === 401);
				if (!retry || attempt === 2) throw error;
				await sleep(150 * 2 ** attempt);
			}
		}
		throw new Error("Unreachable");
	}
	/** PayPal's error body, parsed when it is JSON. The refusal codes and batch links live here. */
	async function errorBody(response: Response): Promise<unknown> {
		try {
			const text = await response.text();
			return text.trim() === "" ? null : JSON.parse(text);
		} catch { return null; }
	}
	const pending = (): Extract<RemoteOutcome, { kind: "UNKNOWN" }> => ({ kind: "UNKNOWN", checkAt: instant(new Date(Date.parse(clock.now()) + 5000).toISOString()) });
	/** A refusal that will never succeed on retry: a 4xx that is not a lock, a timeout, or a rate limit. */
	const refused = (error: unknown): RemoteOutcome => error instanceof ProviderError && error.status >= 400 && error.status < 500 &&
		![401, 408, 409, 429].includes(error.status)
		? { kind: "PERMANENT_FAILURE", reason: `PAYPAL_HTTP_${error.status}` }
		: pending();
	async function guarded(action: () => Promise<RemoteOutcome>, creating = false): Promise<RemoteOutcome> {
		try { return await action(); } catch (error) {
			if (error instanceof ProviderError && error.status >= 400 && error.status < 500 && ![401, 408, 409, 429].includes(error.status) && (creating || error.status !== 422)) {
				return { kind: "PERMANENT_FAILURE", reason: `PAYPAL_HTTP_${error.status}` };
			}
			// A 422 on capture may be ORDER_ALREADY_CAPTURED: never undo uncertain money.
			return pending();
		}
	}
	async function orderObservation(orderId: OrderId, payee: MerchantId): Promise<RemoteOutcome> {
		const json = await request("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`, payee);
		const order = object(json);
		if (order.id !== orderId) throw new Error("Order identity mismatch");
		if (order.status === "COMPLETED") return { kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture: parseCapture(json) } };
		if (order.status === "APPROVED") return { kind: "CONFIRMED", observation: { kind: "ORDER_APPROVED", orderId } };
		if (order.status === "VOIDED") return { kind: "PERMANENT_FAILURE", reason: "ORDER_VOIDED" };
		return { kind: "PENDING", checkAt: instant(new Date(Date.parse(clock.now()) + 5000).toISOString()) };
	}
	/**
	 * The referenced payout for one capture. The deterministic request id is the provider's dedupe key:
	 * a repeat answers 200 with the same item, and a different id answers 422
	 * PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE. The reference is paid at most once, so a resend is the
	 * lookup and never a second payout.
	 */
	async function releaseOutcome(call: Extract<PayPalCall, { kind: "RELEASE" }>, requestId: string): Promise<RemoteOutcome> {
		try {
			const json = object(await request("POST", "/v1/payments/referenced-payouts-items", call.payee,
				{ reference_id: call.captureId, reference_type: "TRANSACTION_ID" }, requestId));
			const status = text(object(json.processing_state).status);
			if (status === "SUCCESS") return { kind: "CONFIRMED", observation: { kind: "RELEASE_COMPLETED", release: parseReferencedPayout(json, clock.now()) } };
			if (["PENDING", "ONHOLD", "CREATED"].includes(status)) return pending();
			return { kind: "PERMANENT_FAILURE", reason: `REFERENCED_PAYOUT_${status}` };
		} catch (error) {
			if (error instanceof ProviderError && error.status === 422 && nameOf(error.body) === "PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE") {
				// The capture's payout completed under a request id this client no longer holds, and the
				// reference list is not permitted for it. The money is out; the item cannot be read back.
				// Never re-pay and never refund: the reason parks the row for a person.
				return { kind: "PERMANENT_FAILURE", reason: "PAYOUT_ALREADY_COMPLETED_FOR_REFERENCE" };
			}
			// Any other 4xx refusal of a referenced payout is the provider saying no. Retrying the same
			// money movement cannot make it safe, so the row parks for a person instead of looping.
			if (error instanceof ProviderError && [400, 422].includes(error.status)) {
				return { kind: "PERMANENT_FAILURE", reason: `REFERENCED_PAYOUT_${nameOf(error.body) ?? error.status}` };
			}
			throw error;
		}
	}
	/** The capture read that carries the refund's retained fee and, after a refund, the refunded state. */
	async function captureRefundState(captureId: CaptureId, payee: MerchantId): Promise<CaptureRefundState> {
		return parseCaptureRefundState(await request("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`, payee));
	}
	/**
	 * The full refund of one capture. The response is read with Prefer: return=representation so the
	 * refund id and amount come back with it; the retained fee is the capture's observed paypal_fee.
	 * A 422 CAPTURE_FULLY_REFUNDED means a prior attempt completed: the capture read settles it.
	 */
	async function refundOutcome(call: Extract<PayPalCall, { kind: "REFUND" }>, requestId: string): Promise<RemoteOutcome> {
		try {
			const json = await request("POST", `/v2/payments/captures/${encodeURIComponent(call.captureId)}/refund`, call.payee,
				{ amount: { currency_code: "USD", value: formatUsd(call.amount) } }, requestId);
			const state = await captureRefundState(call.captureId, call.payee);
			return { kind: "CONFIRMED", observation: { kind: "REFUND_COMPLETED", refund: parseRefund(json, state) } };
		} catch (error) {
			if (error instanceof ProviderError && error.status === 422 && issueOf(error.body) === "CAPTURE_FULLY_REFUNDED") {
				const state = await captureRefundState(call.captureId, call.payee);
				if (!state.refunded) throw error;
				return { kind: "CONFIRMED", observation: { kind: "REFUND_COMPLETED", refund: parseRefundedCapture(state) } };
			}
			throw error;
		}
	}
	/**
	 * The reimbursement of a retained refund fee, as a Standard Payout from the platform's balance.
	 * sender_batch_id is the deterministic effect key, so a repeat answers 400 USER_BUSINESS_ERROR
	 * naming the batch that already carries it, and the batch read settles from there.
	 */
	async function reimburseOutcome(call: Extract<PayPalCall, { kind: "REIMBURSE" }>, requestId: string): Promise<RemoteOutcome> {
		try {
			const created = object(await request("POST", "/v1/payments/payouts", null, {
				sender_batch_header: { sender_batch_id: requestId, email_subject: "Acquit refund fee reimbursement",
					email_message: "Acquit repays the PayPal fee retained on a refund." },
				items: [{ recipient_type: "PAYPAL_ID", receiver: call.merchant, amount: { currency: "USD", value: formatUsd(call.amount) },
					note: "Acquit refund fee reimbursement", sender_item_id: `${requestId}-1` }],
			}, requestId));
			return payoutBatchOutcome(text(object(created.batch_header).payout_batch_id) as PayoutBatchId);
		} catch (error) {
			if (error instanceof ProviderError && error.status === 400 && nameOf(error.body) === "USER_BUSINESS_ERROR") {
				const batchId = batchIdFromDuplicate(error.body);
				if (batchId !== null) return payoutBatchOutcome(batchId);
			}
			// A refusal that names no existing batch is the provider saying no to this payout. Retrying
			// the same sender_batch_id cannot change it, so the row parks for a person.
			if (error instanceof ProviderError && [400, 422].includes(error.status)) {
				return { kind: "PERMANENT_FAILURE", reason: `PAYOUT_${nameOf(error.body) ?? error.status}` };
			}
			throw error;
		}
	}
	/** Reads one payout batch and maps its state. A batch that has not settled yet reports PENDING. */
	async function payoutBatchOutcome(batchId: PayoutBatchId): Promise<RemoteOutcome> {
		const json = object(await request("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`, null));
		const status = text(object(json.batch_header).batch_status);
		const item = array(json.items).map(object)[0] ?? null;
		const itemStatus = item === null ? null : text(item.transaction_status);
		if (status === "SUCCESS" || itemStatus === "SUCCESS") {
			return { kind: "CONFIRMED", observation: { kind: "REIMBURSEMENT_COMPLETED", reimbursement: parseReimbursement(json) } };
		}
		if (TERMINAL_PAYOUT_FAILURES.includes(status) || (itemStatus !== null && TERMINAL_PAYOUT_FAILURES.includes(itemStatus))) {
			return { kind: "PERMANENT_FAILURE", reason: `PAYOUT_${itemStatus ?? status}` };
		}
		return pending();
	}
	return {
		getOrder: (orderId, payee) => guarded(() => orderObservation(orderId, payee)),
		dispatch: (call, requestId) => guarded(async () => {
			if (call.kind === "CREATE_ORDER") {
				// Legacy payloads always mean checkout; runtime toggles cannot change
				// the payment source bound to a queued order/request-id.
				const fundingMode = call.fundingMode ?? "checkout";
				if (fundingMode === "card" && process.env.ACQUIT_DEV !== "1") return { kind: "PERMANENT_FAILURE", reason: "DEV_DISABLED" };
				const json = object(await request("POST", "/v2/checkout/orders", call.payee, {
					intent: "CAPTURE", purchase_units: [{
						reference_id: call.jobId, custom_id: call.jobId, description: "Acquit verified coding work",
						amount: { currency_code: "USD", value: formatUsd(call.quote.split.held) },
						payee: { merchant_id: call.payee },
						payment_instruction: { disbursement_mode: "DELAYED", platform_fees: [
							{ amount: { currency_code: "USD", value: formatUsd(call.quote.platformFeeInstruction) } },
						] },
					}], payment_source: fundingMode === "card" ? { card: {
						number: "4111111111111111", expiry: "2028-12", security_code: "123", name: "Acquit Sandbox Probe",
						billing_address: { address_line_1: "123 Test Street", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
					} } : { paypal: { experience_context: {
						shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW",
						return_url: `${config.webOrigin}/paypal/return?jobId=${encodeURIComponent(call.jobId)}`,
						cancel_url: `${config.webOrigin}/paypal/cancel?jobId=${encodeURIComponent(call.jobId)}`,
					} } },
				}, requestId));
				if (json.status === "COMPLETED") {
					parseCapture(json);
					return { kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId: text(json.id) as OrderId,
						approveUrl: `${config.webOrigin}/paypal/return?jobId=${encodeURIComponent(call.jobId)}` } };
				}
				const link = array(json.links).map(object).find(link => link.rel === "approve" || link.rel === "payer-action");
				const approveUrl = text(link?.href);
				const url = new URL(approveUrl);
				if (url.protocol !== "https:" || url.hostname !== "www.sandbox.paypal.com") throw new Error("Invalid approval host");
				return { kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId: text(json.id) as OrderId, approveUrl } };
			}
			if (call.kind === "CAPTURE") {
				await request("POST", `/v2/checkout/orders/${encodeURIComponent(call.orderId)}/capture`, call.payee, {}, requestId);
				return orderObservation(call.orderId, call.payee);
			}
			if (call.kind === "RELEASE") return releaseOutcome(call, requestId);
			if (call.kind === "REFUND") return refundOutcome(call, requestId);
			if (call.kind === "REIMBURSE") return reimburseOutcome(call, requestId);
			throw new Error("not implemented");
		}, call.kind === "CREATE_ORDER"),
		reconcile: (call, requestId) => guarded(async () => {
			if (call.kind === "CAPTURE") {
				const observed = await orderObservation(call.orderId, call.payee);
				return observed.kind === "CONFIRMED" && observed.observation.kind === "ORDER_APPROVED" ? { kind: "NOT_FOUND" } : observed;
			}
			// Orders v2 has no search-by-request-id. Resending the identical deterministic
			// request id/body recovers a lost create response inside PayPal's dedupe window.
			if (call.kind === "CREATE_ORDER") return { kind: "NOT_FOUND" };
			// Release, refund, and payout carry the deterministic request id as their correlation: a
			// resend with the same id is the lookup, and the provider refuses a second money movement.
			if (call.kind === "RELEASE") return releaseOutcome(call, requestId);
			if (call.kind === "REFUND") return refundOutcome(call, requestId);
			if (call.kind === "REIMBURSE") return reimburseOutcome(call, requestId);
			throw new Error("not implemented");
		}, false),
		parseWebhook: async () => { throw new Error("not implemented"); },
	};
}

/** Payout batch and item states that will never become SUCCESS. */
const TERMINAL_PAYOUT_FAILURES: readonly string[] = ["FAILED", "DENIED", "CANCELED", "RETURNED", "REVERSED", "BLOCKED"];

/** The refusal code PayPal puts in the body's `name`. */
function nameOf(body: unknown): string | null {
	try { return text(object(body).name); } catch { return null; }
}

/** The issue code PayPal puts in the first detail entry. */
function issueOf(body: unknown): string | null {
	try { return text(object(array(object(body).details)[0]).issue); } catch { return null; }
}

/** The batch id PayPal links when a sender_batch_id repeats. */
function batchIdFromDuplicate(body: unknown): PayoutBatchId | null {
	try {
		const link = object(array(object(array(object(body).details)[0]).link)[0]);
		const id = new URL(text(link.href)).pathname.split("/").at(-1);
		return id ? id as PayoutBatchId : null;
	} catch { return null; }
}

export function authAssertion(clientId: string, payee: MerchantId): string {
	return `${Buffer.from('{"alg":"none"}').toString("base64")}.${Buffer.from(JSON.stringify({ iss: clientId, payer_id: payee })).toString("base64")}.`;
}

export function normalizeLink(href: string, apiBase: PayPalConfig["apiBase"]): URL {
	const url = new URL(href, apiBase);
	if (url.hostname === "api.sandbox.paypal.com") url.hostname = "api-m.sandbox.paypal.com";
	if (url.origin !== apiBase || url.username || url.password) throw new Error("Only PayPal sandbox API links are allowed");
	return url;
}

export function parseCapture(json: unknown): CaptureEvidence {
	const order = object(json);
	const units = array(order.purchase_units);
	if (units.length !== 1) throw new Error("Expected one purchase unit");
	const unit = object(units[0]);
	const captures = array(object(unit.payments).captures);
	if (captures.length !== 1) throw new Error("Expected one capture");
	const capture = object(captures[0]);
	if (capture.status !== "COMPLETED") throw new Error("Capture is not completed");
	const instruction = unit.payment_instruction === undefined ? {} : object(unit.payment_instruction);
	if (capture.disbursement_mode !== "DELAYED" && instruction.disbursement_mode !== "DELAYED") throw new Error("Delayed disbursement not confirmed");
	const breakdown = object(capture.seller_receivable_breakdown);
	const fees = array(breakdown.platform_fees);
	if (fees.length !== 1) throw new Error("Expected one observed platform fee");
	const gross = money(capture.amount);
	const processorFee = money(breakdown.paypal_fee);
	const platformFee = money(object(fees[0]).amount);
	const sellerNet = money(breakdown.net_amount);
	if (sellerNet + processorFee + platformFee !== gross) throw new Error("Capture breakdown does not conserve money");
	return { orderId: text(order.id) as OrderId, captureId: text(capture.id) as CaptureId,
		payee: text(object(unit.payee).merchant_id) as MerchantId, disbursement: "DELAYED",
		gross, processorFee, platformFee, sellerNet, capturedAt: instant(text(capture.create_time)) };
}

class ProviderError extends Error {
	readonly status: number;
	/** PayPal's parsed error body. Refusal codes and duplicate-batch links are read from here. */
	readonly body: unknown;
	constructor(status: number, body: unknown = null) { super(`PayPal HTTP ${status}`); this.status = status; this.body = body; }
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected PayPal object");
	return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Expected PayPal array");
	return value;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("Expected PayPal string");
	return value;
}
function money(value: unknown): UsdCents {
	const amount = object(value);
	if (amount.currency_code !== "USD") throw new Error("Expected USD");
	return usd(text(amount.value));
}
/** Payout bodies spell the currency `currency` instead of `currency_code`. */
function payoutMoney(value: unknown): UsdCents {
	const amount = object(value);
	if (amount.currency !== "USD") throw new Error("Expected USD");
	return usd(text(amount.value));
}

/** PayPal stamps some bodies in local time (`-07:00`). Evidence is always a UTC instant. */
function utcInstant(value: unknown): Instant {
	const at = new Date(text(value));
	if (Number.isNaN(at.getTime())) throw new Error("Expected PayPal timestamp");
	return instant(at.toISOString());
}

/**
 * The referenced payout item for a release. The reference id is the capture, and the paid amount is
 * what the operator's merchant received (measured: the capture's net, 363.78 of a 420.00 gross).
 */
export function parseReferencedPayout(json: unknown, at: Instant): ReleaseEvidence {
	const item = object(json);
	if (text(item.reference_type) !== "TRANSACTION_ID") throw new Error("Expected a transaction reference");
	if (text(object(item.processing_state).status) !== "SUCCESS") throw new Error("Referenced payout is not successful");
	return { payoutItemId: text(item.item_id) as PayoutItemId, captureId: text(item.reference_id) as CaptureId,
		paid: money(item.payout_amount), at };
}

/** The capture read back for its refund state. */
export function parseCaptureRefundState(json: unknown): CaptureRefundState {
	const capture = object(json);
	const status = text(capture.status);
	if (status !== "COMPLETED" && status !== "REFUNDED" && status !== "PARTIALLY_REFUNDED") throw new Error("Capture is not refundable");
	const breakdown = object(capture.seller_receivable_breakdown);
	const gross = money(breakdown.gross_amount);
	const processorFee = money(breakdown.paypal_fee);
	if (processorFee > gross) throw new Error("Capture breakdown does not conserve money");
	return { captureId: text(capture.id) as CaptureId, gross, processorFee,
		refunded: status === "REFUNDED" || status === "PARTIALLY_REFUNDED", at: utcInstant(capture.update_time) };
}

/**
 * The refund of one capture. The refund names the refunded gross; the capture names the processor fee
 * PayPal keeps and debits the operator. The recorded refund's create_time carries a local offset, so
 * the evidence time is normalized to UTC.
 */
export function parseRefund(json: unknown, state: CaptureRefundState): RefundEvidence {
	const refund = object(json);
	if (text(refund.status) !== "COMPLETED") throw new Error("Refund is not completed");
	const refunded = money(refund.amount);
	if (refunded !== state.gross) throw new Error("Refund is not the full capture amount");
	return { refundId: text(refund.id) as RefundId, captureId: state.captureId, refunded,
		retainedProcessorFee: state.processorFee, at: utcInstant(refund.create_time) };
}

/** A refund read back from the capture, when the refund id is not held. */
export function parseRefundedCapture(state: CaptureRefundState): RefundEvidence {
	if (!state.refunded) throw new Error("Capture is not refunded");
	return { refundId: null, captureId: state.captureId, refunded: state.gross,
		retainedProcessorFee: state.processorFee, at: state.at };
}

/**
 * The settled reimbursement payout. The fee is PayPal's own payout fee, taken from the platform on
 * top of the paid amount (measured: 0.25 USD). The batch's fee must equal the single item's own fee:
 * this batch carries one job's reimbursement, and a batch whose fee cannot be attributed to that one
 * job would make the treasury line a lie.
 */
export function parseReimbursement(json: unknown): ReimbursementEvidence {
	const batch = object(json);
	const header = object(batch.batch_header);
	const items = array(batch.items);
	if (items.length !== 1) throw new Error("Expected one payout item");
	const item = object(items[0]);
	if (text(item.transaction_status) !== "SUCCESS") throw new Error("Payout item is not successful");
	const recipient = object(item.payout_item);
	const paid = payoutMoney(recipient.amount);
	const fee = payoutMoney(header.fees);
	if (fee !== payoutMoney(item.payout_item_fee)) throw new Error("Payout fee is not attributable to the item");
	return { batchId: text(header.payout_batch_id) as PayoutBatchId, itemId: text(item.payout_item_id) as PayoutItemId,
		merchant: text(recipient.receiver) as MerchantId, paid, fee, at: utcInstant(item.time_processed) };
}
