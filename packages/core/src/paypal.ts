// PayPal adapter. The only file that knows Orders v2, referenced payouts, refunds, Partner Referrals,
// PayPal-Auth-Assertion, webhook signatures, and HATEOAS host quirks. Callers get domain observations.
//
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
import type { Branded, CaptureId, Instant, JobId, MerchantId, OperatorId, OrderId, PayoutItemId, RefundId } from "./ids.ts";
import { formatUsd, usd } from "./ledger.ts";
import type { CommercialSplit, UsdCents } from "./ledger.ts";

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
	// TODO predicted = halfUp(split.held * rateBps / 10000) + fixed. 42000 gives 1466 + 49 = 1515.
	// TODO Reject when platformFeeInstruction would be negative. The job price is too small to carry the fee.
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
	readonly refundId: RefundId;
	readonly captureId: CaptureId;
	readonly refunded: UsdCents;
	/** PayPal keeps it and debits the operator (measured). Acquit reimburses the operator from treasury. */
	readonly retainedProcessorFee: UsdCents;
	readonly at: Instant;
};

export type PayPalCall =
	| { readonly kind: "CREATE_ORDER"; readonly jobId: JobId; readonly payee: MerchantId; readonly quote: FeeQuote }
	| { readonly kind: "CAPTURE"; readonly orderId: OrderId; readonly payee: MerchantId }
	| { readonly kind: "RELEASE"; readonly captureId: CaptureId; readonly payee: MerchantId }
	/** Full amount only. Never names platform_fees. */
	| { readonly kind: "REFUND"; readonly captureId: CaptureId; readonly payee: MerchantId; readonly amount: UsdCents }
	| { readonly kind: "ONBOARD"; readonly operator: OperatorId };

export type PayPalObservation =
	| { readonly kind: "ORDER_CREATED"; readonly orderId: OrderId; readonly approveUrl: string }
	| { readonly kind: "ORDER_APPROVED"; readonly orderId: OrderId }
	| { readonly kind: "CAPTURE_COMPLETED"; readonly capture: CaptureEvidence }
	| { readonly kind: "RELEASE_COMPLETED"; readonly release: ReleaseEvidence }
	| { readonly kind: "REFUND_COMPLETED"; readonly refund: RefundEvidence }
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

export function createPayPal(config: PayPalConfig): PayPal {
	// TODO CREATE_ORDER: intent CAPTURE, amount quote.split.held, payee.merchant_id = payee,
	//      payment_instruction.disbursement_mode DELAYED, platform_fees = quote.platformFeeInstruction.
	// TODO CAPTURE, RELEASE, REFUND carry authAssertion(payee).
	// TODO Normalize HATEOAS hosts with normalizeLink before following them.
	// TODO parseWebhook verifies the signature, then re-reads the named resource and builds the observation.
	if (config.apiBase !== "https://api-m.sandbox.paypal.com") throw new Error("Only PayPal sandbox is supported");
	let token: string | null = null;
	let tokenExpires = 0;
	async function accessToken(): Promise<string> {
		if (token && Date.now() < tokenExpires) return token;
		const response = await fetch(`${config.apiBase}/v1/oauth2/token`, {
			method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString("base64")}`,
				"Content-Type": "application/x-www-form-urlencoded" },
			body: "grant_type=client_credentials", signal: AbortSignal.timeout(15_000), redirect: "error",
		});
		if (!response.ok) throw new ProviderError(response.status);
		const body = object(await response.json());
		token = text(body.access_token);
		tokenExpires = Date.now() + Math.max(0, Number(body.expires_in ?? 300) - 60) * 1000;
		return token;
	}
	async function request(method: "GET" | "POST", path: string, payee: MerchantId, body?: unknown, requestId?: string): Promise<unknown> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json",
					"PayPal-Auth-Assertion": authAssertion(config.clientId, payee), Prefer: "return=representation" };
				if (requestId) headers["PayPal-Request-Id"] = requestId;
				if (process.env.PAYPAL_PARTNER_ATTRIBUTION_ID) headers["PayPal-Partner-Attribution-Id"] = process.env.PAYPAL_PARTNER_ATTRIBUTION_ID;
				const response = await fetch(normalizeLink(path, config.apiBase), {
					method, headers, body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(15_000), redirect: "error",
				});
				if (!response.ok) {
					if (response.status === 401) { token = null; tokenExpires = 0; }
					throw new ProviderError(response.status);
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
	const pending = (): Extract<RemoteOutcome, { kind: "UNKNOWN" }> => ({ kind: "UNKNOWN", checkAt: instant(new Date(Date.now() + 5000).toISOString()) });
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
		return { kind: "PENDING", checkAt: instant(new Date(Date.now() + 5000).toISOString()) };
	}
	return {
		getOrder: (orderId, payee) => guarded(() => orderObservation(orderId, payee)),
		dispatch: (call, requestId) => guarded(async () => {
			if (call.kind === "CREATE_ORDER") {
				const json = object(await request("POST", "/v2/checkout/orders", call.payee, {
					intent: "CAPTURE", purchase_units: [{
						reference_id: call.jobId, custom_id: call.jobId, description: "Acquit verified coding work",
						amount: { currency_code: "USD", value: formatUsd(call.quote.split.held) },
						payee: { merchant_id: call.payee },
						payment_instruction: { disbursement_mode: "DELAYED", platform_fees: [
							{ amount: { currency_code: "USD", value: formatUsd(call.quote.platformFeeInstruction) } },
						] },
					}], payment_source: config.fundingMode?.() === "card" ? { card: {
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
			throw new Error("not implemented");
		}, call.kind === "CREATE_ORDER"),
		reconcile: (call, _requestId) => guarded(async () => {
			if (call.kind === "CAPTURE") {
				const observed = await orderObservation(call.orderId, call.payee);
				return observed.kind === "CONFIRMED" && observed.observation.kind === "ORDER_APPROVED" ? { kind: "NOT_FOUND" } : observed;
			}
			// Orders v2 has no search-by-request-id. Resending the identical deterministic
			// request id/body recovers a lost create response inside PayPal's dedupe window.
			if (call.kind === "CREATE_ORDER") return { kind: "NOT_FOUND" };
			throw new Error("not implemented");
		}),
		parseWebhook: async () => { throw new Error("not implemented"); },
	};
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
	constructor(status: number) { super(`PayPal HTTP ${status}`); this.status = status; }
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

export function parseReferencedPayout(json: unknown): ReleaseEvidence {
	throw new Error("not implemented");
}

export function parseRefund(json: unknown): RefundEvidence {
	throw new Error("not implemented");
}
