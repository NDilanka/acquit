// The PayPal read the payout tool makes, through `@paypal/agent-toolkit/mcp`. The toolkit has no
// referenced-payout method, so the read follows the toolkit's own tool pattern: its PayPalAPI
// client carries the OAuth token in-process and answers the headers and base URL every call
// uses. The payout item is read per item, because the payout list answers 403.

import { PayPalAPI } from "@paypal/agent-toolkit/mcp";

export type PaypalReader = {
	/** One GET against the sandbox API; the path begins with `/v1/`. A merchant-scoped resource
	 * (an order, a capture) is read under the `PayPal-Auth-Assertion` that names the merchant it
	 * belongs to, or PayPal cannot see it; pass that assertion here. */
	readonly get: (path: string, authAssertion?: string) => Promise<unknown>;
};

export type PaypalConfig = {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly sandbox: boolean;
};

/** The toolkit client built around one minted token, and when that token stops serving. */
type Minted = {
	readonly api: PayPalAPI;
	readonly expiresAt: number;
};

/** A minted token is renewed this long before its `expires_in` runs out, so a read never rides a
 * token that is about to be refused. */
const RENEW_BEFORE_MS = 60_000;

/** The minted-token reader. The token and the client secret never leave this process: they ride
 * the toolkit's client and the Authorization header only, and no log or result ever names them.
 * The token renews a little before its `expires_in`, and a read refused with 401 invalidates the
 * token, re-mints once, and retries once: a bounded recovery, never a loop. */
export async function paypalReader(options: PaypalConfig, fetchImpl: typeof fetch = fetch,
	now: () => number = Date.now): Promise<PaypalReader> {
	if (!options.sandbox) throw new Error("Only the PayPal sandbox is supported.");
	const base = "https://api-m.sandbox.paypal.com";
	let minted: Minted | null = null;
	const mint = async (): Promise<Minted> => {
		const tokenResponse = await fetchImpl(`${base}/v1/oauth2/token`, {
			method: "POST",
			headers: { Authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`,
				"Content-Type": "application/x-www-form-urlencoded" },
			body: "grant_type=client_credentials",
			signal: AbortSignal.timeout(15_000), redirect: "error",
		});
		if (!tokenResponse.ok) throw new Error(`PayPal OAuth answered ${tokenResponse.status}.`);
		const answer = await tokenResponse.json() as { access_token?: unknown; expires_in?: unknown };
		if (typeof answer.access_token !== "string" || answer.access_token === "") throw new Error("PayPal OAuth answered no token.");
		// An unusable or absent expires_in means the token never counts as fresh, so every read renews.
		const lifetime = typeof answer.expires_in === "number" && Number.isFinite(answer.expires_in) && answer.expires_in > 0
			? answer.expires_in * 1000 : 0;
		minted = { api: new PayPalAPI(answer.access_token, { sandbox: true }), expiresAt: now() + lifetime };
		return minted;
	};
	/** The token to read with: the minted one while it still serves, a fresh mint when it nears
	 * its expiry or when nothing is minted yet. */
	const current = async (): Promise<Minted> => {
		if (minted === null || now() >= minted.expiresAt - RENEW_BEFORE_MS) return mint();
		return minted;
	};
	const read = async (path: string, api: PayPalAPI, assertion: string | null): Promise<Response> =>
		fetchImpl(`${api.paypalClient.getBaseUrl()}${path}`,
			{ headers: { ...(await api.paypalClient.getHeaders()), ...(assertion === null ? {} : { "PayPal-Auth-Assertion": assertion }) },
				signal: AbortSignal.timeout(15_000), redirect: "error" });
	return {
		async get(path, assertion) {
			const named = assertion ?? null;
			const first = await current();
			let response = await read(path, first.api, named);
			if (response.status === 401) {
				// The token was refused before its expiry could catch it. Drop it, mint once, retry once.
				minted = null;
				const fresh = await mint();
				response = await read(path, fresh.api, named);
			}
			if (!response.ok) throw new Error(`PayPal answered ${response.status} for ${path.split("?")[0]}.`);
			return response.json();
		},
	};
}

/** One referenced payout item's status and amount, exactly what the sandbox read answers. */
export type ReferencedPayoutItem = {
	readonly payoutItemId: string;
	readonly status: string;
	readonly amount: { readonly currency: string; readonly value: string } | null;
	readonly raw: unknown;
};

export function referencedPayoutItem(item: unknown, payoutItemId: string): ReferencedPayoutItem {
	const body = item && typeof item === "object" ? item as Record<string, unknown> : {};
	const state = body.processing_state && typeof body.processing_state === "object" ? body.processing_state as Record<string, unknown> : {};
	const amount = body.payout_amount && typeof body.payout_amount === "object" ? body.payout_amount as Record<string, unknown> : {};
	// The sandbox names the id `item_id` and the currency `currency_code`; the passed id stands in
	// only when the answer carries none.
	const id = typeof body.item_id === "string" && body.item_id !== "" ? body.item_id : payoutItemId;
	return {
		payoutItemId: id,
		status: typeof state.status === "string" ? state.status : "UNKNOWN",
		amount: typeof amount.value === "string" && typeof amount.currency_code === "string"
			? { currency: amount.currency_code, value: amount.value } : null,
		raw: body,
	};
}
