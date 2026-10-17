// The payout reader's token lifecycle, driven by an injected fetch transport: an aging token
// renews a little before its expires_in, a read refused with 401 re-mints once and retries once,
// and a persistent refusal answers one error without looping. The stdio case at the bottom drives
// the real server with a zero-network preload, because the poisoned-rejection cache lives in
// main.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { paypalReader, referencedPayoutItem } from "../src/paypal.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A synthetic PayPal: every mint answers `token-<n>` with `expiresIn` seconds of life, and every
 * referenced-payout read records the Authorization header it rode and takes the next staged
 * status. The counts are the transport's whole story, so a test can assert exactly one re-mint. */
function syntheticPaypal(expiresIn: number, readStatuses: readonly number[]): {
	readonly transport: typeof fetch;
	readonly calls: { oauth: number; reads: string[] };
} {
	const calls = { oauth: 0, reads: [] as string[] };
	const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/oauth2/token") {
			calls.oauth += 1;
			return json({ access_token: `token-${calls.oauth}`, expires_in: expiresIn });
		}
		calls.reads.push(String((init?.headers as Record<string, string>)["Authorization"]) +
			((init?.headers as Record<string, string>)["PayPal-Auth-Assertion"] ? "|asserted" : ""));
		const status = readStatuses[Math.min(calls.reads.length - 1, readStatuses.length - 1)];
		return json({ item_id: "probe-item", processing_state: { status: "SUCCESS" },
			payout_amount: { currency_code: "USD", value: "360.00" } }, status);
	}) as typeof fetch;
	return { transport, calls };
}

describe("the payout reader's token lifecycle", () => {
	it("renews the minted token a little before its expires_in", async () => {
		let clock = 1_000_000;
		const { transport, calls } = syntheticPaypal(3600, [200, 200, 200]);
		const reader = await paypalReader(
			{ clientId: "probe-id", clientSecret: "probe-value", sandbox: true }, transport, () => clock);
		await reader.get("/v1/payments/referenced-payouts-items/probe-item");
		clock += 3_500_000; // 3500 s in, 100 s of life left: the token still serves.
		await reader.get("/v1/payments/referenced-payouts-items/probe-item");
		clock += 50_000; // 3550 s in, 50 s left: inside the renewal window, mint before the read.
		await reader.get("/v1/payments/referenced-payouts-items/probe-item");
		assert.deepEqual(calls.reads, ["Bearer token-1", "Bearer token-1", "Bearer token-2"]);
		assert.equal(calls.oauth, 2);
	});

	it("a read may assert the merchant the resource belongs to, and the assertion rides the retry", async () => {
		const { transport, calls } = syntheticPaypal(3600, [401, 200]);
		const reader = await paypalReader(
			{ clientId: "probe-id", clientSecret: "probe-value", sandbox: true }, transport);
		const item = await reader.get("/v2/checkout/orders/probe-order", "assertion-jwt");
		assert.deepEqual(calls.reads, ["Bearer token-1|asserted", "Bearer token-2|asserted"],
			"both the refused read and its retry name the merchant");
		assert.equal(calls.oauth, 2);
		assert.equal(referencedPayoutItem(item, "probe-item").status, "SUCCESS");
		const plain = await reader.get("/v2/checkout/orders/probe-order");
		assert.deepEqual(calls.reads.slice(2), ["Bearer token-2"], "a read with no assertion sends none");
	});

	it("re-mints once and retries once when a read answers 401", async () => {
		const { transport, calls } = syntheticPaypal(3600, [401, 200]);
		const reader = await paypalReader(
			{ clientId: "probe-id", clientSecret: "probe-value", sandbox: true }, transport);
		const item = await reader.get("/v1/payments/referenced-payouts-items/probe-item");
		assert.deepEqual(calls.reads, ["Bearer token-1", "Bearer token-2"], "the retry rides the re-minted token");
		assert.equal(calls.oauth, 2);
		assert.equal(referencedPayoutItem(item, "probe-item").status, "SUCCESS");
	});

	it("reads that arrive together share one token mint, and a read after the mint rides the same token", async () => {
		const { transport, calls } = syntheticPaypal(3600, [200]);
		const slowMint = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (new URL(String(input)).pathname === "/v1/oauth2/token") await new Promise(resolve => setTimeout(resolve, 20));
			return transport(input, init);
		}) as typeof fetch;
		const reader = await paypalReader({ clientId: "probe-id", clientSecret: "probe-value", sandbox: true }, slowMint);
		const path = "/v1/payments/referenced-payouts-items/probe-item";
		await Promise.all([reader.get(path), reader.get(path), reader.get(path), reader.get(path)]);
		await reader.get(path);
		assert.equal(calls.oauth, 1, "one token request serves all five reads");
		assert.deepEqual(calls.reads, ["Bearer token-1", "Bearer token-1", "Bearer token-1", "Bearer token-1", "Bearer token-1"]);
	});

	it("answers a persistent 401 with one error, after exactly one re-mint and retry", async () => {
		const { transport, calls } = syntheticPaypal(3600, [401]);
		const reader = await paypalReader(
			{ clientId: "probe-id", clientSecret: "probe-value", sandbox: true }, transport);
		await assert.rejects(reader.get("/v1/payments/referenced-payouts-items/probe-item"), /PayPal answered 401/);
		assert.equal(calls.oauth, 2);
		assert.equal(calls.reads.length, 2);
	});
});

describe("the stdio payout tool's reader lifecycle", () => {
	it("a failed first OAuth mint does not poison later get_payout_status calls", async () => {
		const transport = new StdioClientTransport({
			command: process.execPath,
			// A bare Windows path (D:\...) reads as a URL scheme to --import, so it is passed as a file URL.
			args: ["--import", pathToFileURL(join(ROOT, "packages/mcp/test/payout-lifecycle-preload.mjs")).href, join(ROOT, "packages/mcp/src/main.ts")],
			cwd: ROOT,
			env: { ...process.env, ACQUIT_API: "https://lifecycle.invalid", ACQUIT_TOKEN: "synthetic-lifecycle-token",
				PAYPAL_CLIENT_ID: "lifecycle-id", PAYPAL_CLIENT_SECRET: "lifecycle-value", PAYPAL_ENV: "sandbox",
				MCP_LIFECYCLE_SCENARIO: "oauth-failure" } as Record<string, string>,
			stderr: "pipe",
		});
		let diagnostics = "";
		transport.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
		const client = new Client({ name: "a2-lifecycle-client", version: "0.0.0" });
		await client.connect(transport);
		try {
			const errors: boolean[] = [];
			for (let n = 0; n < 3; n++) {
				const result = await client.callTool({ name: "get_payout_status", arguments: { jobId: "probe-job" } });
				errors.push(Boolean(result.isError));
			}
			assert.deepEqual(errors, [true, false, false], "a failed first mint must not poison later reads");
			const counts = diagnostics.split("\n").filter(line => line.startsWith("{"))
				.map(line => JSON.parse(line) as { oauthCalls?: number });
			assert.equal(Math.max(0, ...counts.map(row => row.oauthCalls ?? 0)), 2);
		} finally {
			await client.close();
			await transport.close();
		}
	});
});
