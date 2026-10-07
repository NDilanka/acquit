// One rule for the API-to-verifier direction: an HMAC over `${timestamp}.${nonce}.${rawBody}`,
// carried in three headers. The timestamp and the nonce are inside the signed text, so a captured
// signature is usable only inside the window and only for its own delivery. The nonce is what
// separates a replay (the same signed request delivered twice, refused) from a retry (a fresh
// signature for the same run id, answered idempotently).

import { createHmac, timingSafeEqual } from "node:crypto";

export const RUN_TIMESTAMP_HEADER = "x-acquit-run-timestamp";
export const RUN_SIGNATURE_HEADER = "x-acquit-run-signature";
export const RUN_NONCE_HEADER = "x-acquit-run-nonce";
/** How far a run request's timestamp may be from this host's clock. */
export const RUN_TIMESTAMP_WINDOW_SECONDS = 300;

export function runSignature(secret: string, timestamp: string, nonce: string, body: string): string {
	return createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
}

/** The header value is `sha256=<hex>`; anything else is not a signature this service accepts. */
export function parseSignatureHeader(header: string | null): string | null {
	if (header === null) return null;
	const value = header.startsWith("sha256=") ? header.slice("sha256=".length) : "";
	return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** 16 bytes of hex or more. A short nonce is not a nonce this service accepts. */
export function parseNonce(header: string | null): string | null {
	return header !== null && /^[0-9a-f]{16,64}$/.test(header) ? header : null;
}

/** Constant-time on equal lengths; a length mismatch is a mismatch. */
export function signatureEquals(provided: string, expected: string): boolean {
	const left = Buffer.from(provided, "utf8");
	const right = Buffer.from(expected, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

/** Unix seconds as the wire carries them: digits only, so a header can never smuggle a payload. */
export function parseTimestamp(header: string | null): number | null {
	if (header === null || !/^\d{1,12}$/.test(header)) return null;
	const seconds = Number(header);
	return Number.isSafeInteger(seconds) ? seconds : null;
}
