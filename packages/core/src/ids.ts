declare const brand: unique symbol;
export type Branded<T, Name extends string> = T & { readonly [brand]: Name };

export type JobId = Branded<string, "JobId">;
export type BidId = Branded<string, "BidId">;
export type ClientId = Branded<string, "ClientId">;
export type OperatorId = Branded<string, "OperatorId">;
export type StaffId = Branded<string, "StaffId">;
export type AgentId = Branded<string, "AgentId">;
export type ReceiptId = Branded<string, "ReceiptId">;
export type RequestKey = Branded<string, "RequestKey">;
export type Version = Branded<number, "Version">;
export type Digest = Branded<string, "Sha256">;
export type CommitSha = Branded<string, "CommitSha">;
export type TestId = Branded<string, "TestId">;

/** UTC ISO-8601. Lexical order equals time order, so wake-time indexes sort correctly. */
export type Instant = Branded<string, "UtcInstant">;
export type Hours = Branded<number, "Hours">;

/** PayPal resource identities. Domain facts carry them. Wire JSON never leaves paypal.ts. */
export type MerchantId = Branded<string, "PayPalMerchantId">;
export type OrderId = Branded<string, "PayPalOrderId">;
export type CaptureId = Branded<string, "PayPalCaptureId">;
export type PayoutItemId = Branded<string, "PayPalPayoutItemId">;
export type RefundId = Branded<string, "PayPalRefundId">;

export function parseJobId(raw: string): JobId {
	throw new Error("not implemented");
}

export function parseBidId(raw: string): BidId {
	throw new Error("not implemented");
}

export function parseRequestKey(raw: string): RequestKey {
	throw new Error("not implemented");
}

export function instant(raw: string): Instant {
	throw new Error("not implemented");
}

export function hours(value: number): Hours {
	throw new Error("not implemented");
}

export function addHours(at: Instant, span: Hours): Instant {
	throw new Error("not implemented");
}
