// Preloaded into the API server under test with `node --import`. The server reads PayPal only through fetch, so this
// replaces fetch: the sandbox token route and each object GET answer PENDING, carrying the merchant and payee a populated
// book holds. Any other host, method, or path throws before a request leaves the process.

// The token call goes to api-m, and the toolkit's object GETs go to api; both are the PayPal sandbox.
const SANDBOX_HOSTS = new Set(["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]);

const answers = [
	["/v2/payments/captures/", {
		status: "PENDING", amount: { value: "420.00", currency_code: "USD" },
		seller_receivable_breakdown: { paypal_fee: { value: "15.15", currency_code: "USD" } },
		merchant_id: "MERCHANT_PRIVATE_SENTINEL", payee: { email_address: "secret-payee@example.com" },
	}],
	["/v2/payments/refunds/", {
		status: "PENDING", amount: { value: "420.00", currency_code: "USD" }, payee: "secret-payee@example.com",
	}],
	["/v1/payments/referenced-payouts-items/", {
		processing_state: { status: "PENDING" }, payout_amount: { value: "360.00", currency_code: "USD" }, payee: "secret-payee@example.com",
	}],
	["/v1/reporting/transactions", { transaction_details: [], page: 1, total_pages: 1 }],
];

globalThis.fetch = async (input, init = {}) => {
	const request = input instanceof Request ? input : null;
	const url = new URL(request ? request.url : String(input));
	const method = (init.method ?? request?.method ?? "GET").toUpperCase();
	if (!SANDBOX_HOSTS.has(url.hostname)) throw new Error(`fake PayPal refuses host ${url.hostname}`);
	if (url.pathname === "/v1/oauth2/token" && method === "POST") return Response.json({ access_token: "fake-access-token", expires_in: 3600 });
	if (method !== "GET") throw new Error(`fake PayPal refuses ${method} ${url.pathname}`);
	const answer = answers.find(([prefix]) => url.pathname.startsWith(prefix));
	if (answer === undefined) throw new Error(`fake PayPal has no answer for ${url.pathname}`);
	return Response.json(answer[1]);
};
