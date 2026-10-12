// The PayPal read the payout tool makes, through `@paypal/agent-toolkit/mcp`. The toolkit has no
// referenced-payout method, so the read follows the toolkit's own tool pattern: its PayPalAPI
// client carries the OAuth token in-process and answers the headers and base URL every call
// uses. The payout item is read per item, because the payout list answers 403.

import { PayPalAPI } from "@paypal/agent-toolkit/mcp";

export type PaypalReader = {
	/** One GET against the sandbox API; the path begins with `/v1/`. */
	readonly get: (path: string) => Promise<unknown>;
};

export type PaypalConfig = {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly sandbox: boolean;
};

/** The minted-token reader. The token and the client secret never leave this process: they ride
 * the toolkit's client and the Authorization header only, and no log or result ever names them. */
export async function paypalReader(options: PaypalConfig, fetchImpl: typeof fetch = fetch): Promise<PaypalReader> {
	if (!options.sandbox) throw new Error("Only the PayPal sandbox is supported.");
	const base = "https://api-m.sandbox.paypal.com";
	const tokenResponse = await fetchImpl(`${base}/v1/oauth2/token`, {
		method: "POST",
		headers: { Authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded" },
		body: "grant_type=client_credentials",
		signal: AbortSignal.timeout(15_000), redirect: "error",
	});
	if (!tokenResponse.ok) throw new Error(`PayPal OAuth answered ${tokenResponse.status}.`);
	const token = (await tokenResponse.json() as { access_token?: unknown }).access_token;
	if (typeof token !== "string" || token === "") throw new Error("PayPal OAuth answered no token.");
	const api = new PayPalAPI(token, { sandbox: true });
	return {
		async get(path) {
			const response = await fetchImpl(`${api.paypalClient.getBaseUrl()}${path}`,
				{ headers: await api.paypalClient.getHeaders(), signal: AbortSignal.timeout(15_000), redirect: "error" });
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
