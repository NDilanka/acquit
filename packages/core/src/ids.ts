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
	if (!/^job_[A-Za-z0-9_-]{4,80}$/.test(raw)) throw new Error("Invalid job id");
	return raw as JobId;
}

export function parseBidId(raw: string): BidId {
	if (!/^bid_[A-Za-z0-9_-]{4,80}$/.test(raw)) throw new Error("Invalid bid id");
	return raw as BidId;
}

export function parseRequestKey(raw: string): RequestKey {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) throw new Error("Request key must be a UUID v4");
	return raw as RequestKey;
}

export function instant(raw: string): Instant {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new Error("Invalid UTC instant");
	const normalized = new Date(raw).toISOString();
	if (normalized !== raw && normalized.replace(".000Z", "Z") !== raw) throw new Error("Invalid UTC instant");
	return normalized as Instant;
}

export function hours(value: number): Hours {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Hours must be a positive integer");
	return value as Hours;
}

export function addHours(at: Instant, span: Hours): Instant {
	return instant(new Date(Date.parse(at) + span * 3_600_000).toISOString());
}
