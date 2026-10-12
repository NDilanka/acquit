// The A2 MCP server over stdio, driven the way the validation contract drives it: the SDK's stdio
// client against a spawned server, with a recorded API answering the operator's token. The money
// surfaces below it (the payouts route, the PayPal read) keep the ledger's laws testable here.

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER = "packages/mcp/src/main.ts";
const TOKEN = "session-token-a2";

/** One recorded JSON route: `GET <path>` or `POST <path>` to the reply. */
type Recorded = { readonly method: string; readonly path: string; readonly body: unknown };

type StubApi = { readonly url: string; readonly requests: readonly Recorded[]; readonly close: () => Promise<void> };

/** A live HTTP stub the spawned server talks to, so the tools are driven through real stdio. */
async function stubApi(routes: Record<string, unknown>): Promise<StubApi> {
	const requests: Recorded[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", chunk => raw += String(chunk));
		req.on("end", () => {
			const path = `${req.method} ${req.url?.split("?")[0] ?? "/"}`;
			requests.push({ method: req.method ?? "GET", path, body: raw === "" ? null : JSON.parse(raw) });
			const reply = routes[path] ?? { error: "NOT_STUBBED" };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(reply));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise(resolve => server.close(() => resolve())),
	};
}

/** Spawns the stdio server against the stub and connects the SDK client the contract names. */
async function withClient(env: Record<string, string>, run: (client: Client) => Promise<void>): Promise<void> {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(ROOT, SERVER)],
		env: { ...process.env, ...env } as Record<string, string>,
	});
	const client = new Client({ name: "a2-contract-client", version: "0.0.0" });
	await client.connect(transport);
	try { await run(client); } finally {
		await client.close();
	}
}

const OPEN_JOB = {
	id: "job_a2open", title: "Totals round wrong for 3-decimal currencies", status: "OPEN", phase: "BIDDING",
	budget: 40000, deliveryEndsAt: "2026-11-08T10:00:00.000Z", contract: null, bids: { operators: [], house: null },
	lockedTo: null, escrow: "NONE", approveUrl: null, ledger: [],
	attempts: { used: 0, left: 3, last: null, reasons: [], history: [], pending: null, failure: null },
	reviewEndsAt: null, pullRequest: null, mergeCommit: null,
};

describe("the A2 MCP server's stdio surface", () => {
	it("exposes exactly the six approved tools", async () => {
		const api = await stubApi({});
		try {
			await withClient({ ACQUIT_API: api.url, ACQUIT_TOKEN: TOKEN }, async client => {
				const tools = await client.listTools();
				assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
					"get_job", "get_payout_status", "get_receipt", "list_jobs", "place_bid", "submit_attempt",
				]);
			});
		} finally { await api.close(); }
	});
});
