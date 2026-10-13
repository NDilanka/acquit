// Synthetic fetch for the payout-lifecycle stdio test: every PayPal and Acquit API answer is
// local, so the spawned stdio server makes zero real network calls. MCP_LIFECYCLE_SCENARIO=
// "oauth-failure" makes the first OAuth mint answer 503; the stderr JSON lines count the calls.

let oauthCalls = 0;
let payoutCalls = 0;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === "lifecycle.invalid" && url.pathname === "/api/me/payouts") {
    return json({ payouts: [{ jobId: "probe-job", payoutItemId: "probe-item" }] });
  }
  if (url.hostname === "api-m.sandbox.paypal.com" && url.pathname === "/v1/oauth2/token") {
    oauthCalls++;
    console.error(JSON.stringify({ oauthCalls }));
    if (process.env.MCP_LIFECYCLE_SCENARIO === "oauth-failure" && oauthCalls === 1) return json({}, 503);
    return json({ access_token: "synthetic-lifecycle-credential", expires_in: 3600 });
  }
  if (["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"].includes(url.hostname)
    && url.pathname === "/v1/payments/referenced-payouts-items/probe-item") {
    payoutCalls++;
    console.error(JSON.stringify({ payoutCalls }));
    return json({ item_id: "probe-item", processing_state: { status: "SUCCESS" },
      payout_amount: { currency_code: "USD", value: "360.00" } });
  }
  throw new Error("Unexpected lifecycle-test request, refused without network access.");
};
