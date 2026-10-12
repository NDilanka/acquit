// The A2 MCP server over stdio, driven the way the validation contract drives it: the SDK's stdio
// client against a spawned server, with a recorded API answering the operator's token. The money
// surfaces below it (the payouts route, the PayPal read) keep the ledger's laws testable here.

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CliError } from "../../acquit-cli/src/client.ts";
import type { ApiClient } from "../../acquit-cli/src/client.ts";
import { writeConfirmation } from "../../acquit-cli/src/confirm.ts";
import { claimConfirmation, readRequest, writeRequest } from "../../acquit-cli/src/rendezvous.ts";
import { runConfirmedSubmit } from "../src/submit-tool.ts";
import { referencedPayoutItem } from "../src/paypal.ts";
import { timeoutMs } from "../src/server.ts";
import type { CommitSha } from "../../core/src/ids.ts";

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

	it("submit_attempt's input schema carries no confirmation, approval, or force field", async () => {
		const api = await stubApi({});
		try {
			await withClient({ ACQUIT_API: api.url, ACQUIT_TOKEN: TOKEN }, async client => {
				const tools = await client.listTools();
				const submit = tools.tools.find(tool => tool.name === "submit_attempt");
				const properties = (submit?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
				assert.deepEqual(Object.keys(properties).sort(), ["dir", "jobId"]);
				assert.deepEqual(Object.keys(properties).filter(key => /confirm|approv|force|yes|skip/i.test(key)), [],
					"no argument the model sets can stand in for the operator's typed confirmation");
			});
		} finally { await api.close(); }
	});
});

// The confirmation handshake below the stdio surface, driven with the injected deps the way the
// CLI's own tests drive submit: a fake client records every post, the head factory plays the
// checkout, and the push spy proves what would have been pushed.

const HELD_COMMIT = "c".repeat(40) as CommitSha;
const MOVED = "d".repeat(40) as CommitSha;

type Post = { readonly path: string; readonly payload: Record<string, unknown> };

function fakeClient(view: unknown, mint: unknown): ApiClient & { readonly posts: Post[] } {
	const posts: Post[] = [];
	return {
		baseUrl: "http://stub",
		get: async () => view,
		post: async (path: string, payload: unknown) => {
			posts.push({ path, payload: payload as Record<string, unknown> });
			if (path.endsWith("/work-repo-token")) return { status: 200, body: mint };
			return { status: 200, body: { outcome: { kind: "COMMITTED" } } };
		},
		posts,
	};
}

/** A HELD job whose history already carries the judged attempt, so one poll renders the verdict. */
const HELD_VIEW = {
	job: {
		id: "job_a2held", status: "IN_PROGRESS", escrow: "HELD", lockedTo: "op_devon",
		reviewEndsAt: "2026-10-20T00:00:00.000Z",
		contract: { repository: "maya-client/invoice-app", frozenAt: "20261012.1" },
		attempts: { used: 1, left: 2, reasons: [], history: [{ ordinal: 1, result: "VERIFIED",
			sourceCommit: HELD_COMMIT, frozen: { passed: 48, expected: 48 }, hidden: { passed: 6, expected: 6 },
			pullRequest: 7, reasonsTruncated: 0 }], pending: null, failure: null },
	},
	handles: { op_devon: "devon-ops" },
	now: "2026-10-13T00:00:00.000Z",
};

function submitDeps(confirmDir: string, client: ApiClient, heads: CommitSha[], pushes: unknown[][]) {
	const secret = mkdtempSync(join(tmpdir(), "acquit-mcp-secret-"));
	return {
		client,
		head: () => heads.shift() ?? (MOVED as CommitSha),
		push: (...call: unknown[]) => pushes.push(call),
		confirmDir,
		confirmWaitMs: 40,
		pollMs: 5,
		sleep: async () => {},
		now: (() => { let tick = 0; return () => Date.parse("2026-10-13T00:00:00.000Z") + (tick++) * 1000; })(),
		makeSecretDir: () => ({ path: secret, remove: () => rmSync(secret, { recursive: true, force: true }) }),
	};
}

describe("submit_attempt's confirmation handshake", () => {
	it("pushes nothing and records no Submit while the operator's confirmation is pending", async () => {
		const confirmDir = mkdtempSync(join(tmpdir(), "acquit-mcp-confirm-"));
		const pushes: unknown[][] = [];
		const client = fakeClient(HELD_VIEW, { repository: "acquit-forks/invoice-app-a2x", token: "minted" });
		const outcome = await runConfirmedSubmit({ jobId: "job_a2held", dir: ".", apiUrl: "http://stub",
			token: "session-token", timeoutSeconds: 1 }, submitDeps(confirmDir, client, [HELD_COMMIT], pushes));
		assert.equal(outcome.pending, true);
		assert.equal(outcome.commit, HELD_COMMIT);
		assert.match(outcome.message, /confirmation is pending/);
		assert.match(outcome.message, /confirm-submit/, "the pending message names the operator's confirm command");
		assert.deepEqual(pushes, [], "nothing is pushed before the operator's typed yes");
		assert.equal(client.posts.some(post => post.path === "/api/commands"), false, "no Submit is recorded");
		assert.equal(readRequest(confirmDir, "job_a2held")?.commit, HELD_COMMIT, "the request stays alive for the CLI");
	});

	it("delivers the pinned commit exactly once after the operator's typed confirmation", async () => {
		const confirmDir = mkdtempSync(join(tmpdir(), "acquit-mcp-confirm-"));
		const pushes: unknown[][] = [];
		const client = fakeClient(HELD_VIEW, { repository: "acquit-forks/invoice-app-a2x", token: "minted" });
		// The checkout's HEAD is read once at X; afterwards it "moves" to Y. The pin must hold.
		writeRequest(confirmDir, { jobId: "job_a2held", commit: HELD_COMMIT, requestedAt: "2026-10-13T00:00:00.000Z" });
		writeConfirmation(confirmDir, { jobId: "job_a2held", commit: HELD_COMMIT, confirmedAt: "2026-10-13T00:00:05.000Z" });
		const outcome = await runConfirmedSubmit({ jobId: "job_a2held", dir: ".", apiUrl: "http://stub",
			token: "session-token", timeoutSeconds: 1 }, submitDeps(confirmDir, client, [HELD_COMMIT, MOVED], pushes));
		assert.equal(outcome.pending, false);
		assert.equal(outcome.commit, HELD_COMMIT);
		assert.match(outcome.verdict, /VERIFIED/);
		assert.equal(pushes.length, 1);
		assert.equal(pushes[0]?.[2], HELD_COMMIT, "the pushed commit is the confirmed one, never the moved HEAD");
		const submits = client.posts.filter(post => post.path === "/api/commands");
		assert.equal(submits.length, 1, "exactly one Submit is recorded");
		assert.equal((submits[0]?.payload.command as { sourceCommit?: string }).sourceCommit, HELD_COMMIT);
		assert.equal(claimConfirmation(confirmDir, "job_a2held"), null, "the confirmation is spent");
	});

	it("refuses a confirmation that names another commit and clears the request", async () => {
		const confirmDir = mkdtempSync(join(tmpdir(), "acquit-mcp-confirm-"));
		const pushes: unknown[][] = [];
		const client = fakeClient(HELD_VIEW, { repository: "acquit-forks/invoice-app-a2x", token: "minted" });
		writeRequest(confirmDir, { jobId: "job_a2held", commit: HELD_COMMIT, requestedAt: "2026-10-13T00:00:00.000Z" });
		writeConfirmation(confirmDir, { jobId: "job_a2held", commit: MOVED, confirmedAt: "2026-10-13T00:00:05.000Z" });
		await assert.rejects(
			runConfirmedSubmit({ jobId: "job_a2held", dir: ".", apiUrl: "http://stub", token: "session-token", timeoutSeconds: 1 },
				submitDeps(confirmDir, client, [HELD_COMMIT], pushes)),
			(error: CliError) => error.code === "CONFIRMATION_MISMATCH",
		);
		assert.deepEqual(pushes, []);
		assert.equal(client.posts.some(post => post.path === "/api/commands"), false);
		assert.equal(readRequest(confirmDir, "job_a2held"), null, "the refused request leaves nothing behind");
	});

	it("never spends a confirmation for commit X on a checkout whose HEAD moved to Y", async () => {
		const confirmDir = mkdtempSync(join(tmpdir(), "acquit-mcp-confirm-"));
		const pushes: unknown[][] = [];
		const client = fakeClient(HELD_VIEW, { repository: "acquit-forks/invoice-app-a2x", token: "minted" });
		// First call pins X and lapses pending; the operator confirms X; then the checkout's HEAD moves.
		await runConfirmedSubmit({ jobId: "job_a2held", dir: ".", apiUrl: "http://stub", token: "session-token", timeoutSeconds: 1 },
			submitDeps(confirmDir, client, [HELD_COMMIT], pushes));
		writeConfirmation(confirmDir, { jobId: "job_a2held", commit: HELD_COMMIT, confirmedAt: "2026-10-13T00:00:05.000Z" });
		// The next call reads Y: the stale confirmation for X is dropped, nothing is submitted, and Y
		// is never pushed under the confirmation the operator gave for X.
		const outcome = await runConfirmedSubmit({ jobId: "job_a2held", dir: ".", apiUrl: "http://stub", token: "session-token", timeoutSeconds: 1 },
			submitDeps(confirmDir, client, [MOVED], pushes));
		assert.equal(outcome.pending, true);
		assert.equal(outcome.commit, MOVED, "the new call asks for a fresh confirmation of the new HEAD");
		assert.deepEqual(pushes, []);
		assert.equal(client.posts.some(post => post.path === "/api/commands"), false);
		assert.equal(claimConfirmation(confirmDir, "job_a2held"), null, "the confirmation for X is gone");
	});
});

describe("the payout status read", () => {
	it("reads the sandbox payout item's real field names: item_id, currency_code, processing_state", () => {
		// The shape the sandbox actually answers for GET /v1/payments/referenced-payouts-items/<id>:
		// the id lives in `item_id`, the amount's currency in `currency_code`, and the state in
		// `processing_state.status`. A reader that invents `payout_item_id` or `currency` drops the
		// amount and the id on the floor.
		const item = referencedPayoutItem({
			item_id: "ITEMID==", processing_state: { status: "SUCCESS" },
			payout_amount: { currency_code: "USD", value: "324.00" },
		}, "FALLBACK-ID==");
		assert.equal(item.status, "SUCCESS");
		assert.equal(item.payoutItemId, "ITEMID==");
		assert.deepEqual(item.amount, { currency: "USD", value: "324.00" });
	});
});

describe("the server's environment timeouts", () => {
	it("defaults the confirmation wait to 120 seconds in milliseconds, not 120 milliseconds", () => {
		// The live proof caught this: with no ACQUIT_MCP_CONFIRM_TIMEOUT_SECONDS, the waiting
		// submit_attempt returned pending after about two seconds because the fallback rode in as a
		// bare 120 where the field wanted milliseconds. The operator's confirmation nearly always
		// lands inside the real two-minute window.
		assert.equal(timeoutMs({}, "ACQUIT_MCP_CONFIRM_TIMEOUT_SECONDS", 120), 120_000);
		assert.equal(timeoutMs({ ACQUIT_MCP_CONFIRM_TIMEOUT_SECONDS: "30" }, "ACQUIT_MCP_CONFIRM_TIMEOUT_SECONDS", 120), 30_000);
		assert.equal(timeoutMs({ ACQUIT_MCP_CONFIRM_TIMEOUT_SECONDS: "junk" }, "ACQUIT_MCP_CONFIRM_TIMEOUT_SECONDS", 120), 120_000);
		assert.equal(timeoutMs({}, "ACQUIT_MCP_SUBMIT_TIMEOUT_SECONDS", 600), 600_000);
	});
});
