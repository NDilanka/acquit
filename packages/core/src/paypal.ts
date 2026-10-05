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

import type { Branded, CaptureId, Instant, JobId, MerchantId, OperatorId, OrderId, PayoutItemId, RefundId } from "./ids";
import type { CommercialSplit, UsdCents } from "./ledger";

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
	throw new Error("not implemented");
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
	readonly apiBase: "https://api-m.sandbox.paypal.com";
	readonly clientId: string;
	readonly secret: string;
	readonly webhookId: string;
	readonly partnerMerchant: MerchantId;
	readonly feeModel: ProcessorFeeModel;
};

export interface PayPal {
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
	throw new Error("not implemented");
}

export function authAssertion(clientId: string, payee: MerchantId): string {
	throw new Error("not implemented");
}

export function normalizeLink(href: string, apiBase: PayPalConfig["apiBase"]): URL {
	throw new Error("not implemented");
}

export function parseCapture(json: unknown): CaptureEvidence {
	throw new Error("not implemented");
}

export function parseReferencedPayout(json: unknown): ReleaseEvidence {
	throw new Error("not implemented");
}

export function parseRefund(json: unknown): RefundEvidence {
	throw new Error("not implemented");
}
