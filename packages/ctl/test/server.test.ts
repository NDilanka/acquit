import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reachable, releaseSpawned, sleep } from "../src/process.ts";

/** A module the isolated API loads before anything else, so a test can stub the clock and the network. */
const preload = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
/**
 * The one network boundary of the isolated API. Every fetch the process makes is answered here and
 * appended to the lane's log, so the suite never reaches PayPal and a test can read back what the
 * release path asked for. Any other host is answered too, and so recorded, and the fixture fails on it.
 */
const fetchStub = `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init) => {
	const url = String(input);
	appendFileSync(process.env.STUB_FETCH_LOG, JSON.stringify({ method: init?.method ?? "GET", url }) + "\\n");
	if (url.startsWith("https://api-m.sandbox.paypal.com/v1/oauth2/token")) return Response.json({ access_token: "isolated-test-token", expires_in: 300 });
	return Response.json({ name: "RESOURCE_NOT_FOUND", debug_id: "isolated" }, { status: 404 });
};
`;
type RecordedCall = { readonly method: string; readonly url: string };
async function recordedCalls(path: string): Promise<readonly RecordedCall[]> {
	try { return (await readFile(path, "utf8")).trim().split("\n").filter(line => line !== "").map(line => JSON.parse(line) as RecordedCall); }
	catch { return []; }
}
async function apiFixture(dev: boolean, run: (url: string, databasePath: string, calls: () => Promise<readonly RecordedCall[]>) => Promise<void>): Promise<void> {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "acquit-api-test-"));
	const log = join(dir, "fetch.log");
	const listener = createServer();
	await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as { port: number }).port;
	await new Promise<void>(resolve => listener.close(() => resolve()));
	// Inject a frozen wall clock and the stubbed network before importing the server. No timing tolerance
	// or one-sided assertion can accidentally accept an ignored offset, and no delivery leaves the machine.
	const child = spawn(process.execPath, ["--import", preload("Date.now=()=>1760000000000"), "--import", preload(fetchStub), "apps/api/src/server.ts"],
		{ cwd: root, stdio: "ignore", env: {
			...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: dev ? "1" : "0", PORT: String(port), WEB_ORIGIN: "http://localhost:5213",
			// A non-dev boot needs a hidden-case file that is not the public example. The test fixture stands in with its own cases.
			ACQUIT_HIDDEN_CASES: fileURLToPath(new URL("../../verifier/fixtures/hidden-cases.test.json", import.meta.url)),
			DATABASE_PATH: join(dir, "acquit.db"), PAYPAL_CLIENT_ID: "unit-test", PAYPAL_CLIENT_SECRET: "unit-test", STUB_FETCH_LOG: log,
		} });
	try {
		const deadline = Date.now() + 15_000;
		const url = `http://127.0.0.1:${port}`;
		while (!(await reachable(`${url}/api/session`))) {
			assert.equal(child.exitCode, null, "The isolated test API exited early.");
			assert(Date.now() < deadline, "The isolated test API failed readiness.");
			await sleep(50);
		}
		await run(url, join(dir, "acquit.db"), () => recordedCalls(log));
		// The process reached no host but the sandbox API. The stub answers anything, so a call to another
		// host would still be recorded here and fail this check rather than silently reach the network.
		const calls = await recordedCalls(log);
		assert.equal(calls.every(call => call.url.startsWith("https://api-m.sandbox.paypal.com/")), true,
			`The isolated test API reached ${calls.map(call => call.url).join(", ")}`);
	} finally {
		await releaseSpawned(child);
		await rm(dir, { recursive: true, force: true });
	}
}
/**
 * The stored VERIFIED AWAITING_CLIENT row the review routes serve: one judged pass, the held escrow,
 * and a review window the frozen clock has not reached.
 */
function verifiedFixture(mergeCommit: string, at: string) {
	const verdict = { result: "VERIFIED", runId: "run_test_1", sourceCommit: "a3b6ead29f4e367d1871e753b516cc9e832871e4",
		mergeCommit, pullRequest: 13, frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 },
		reportDigest: "b".repeat(64), at };
	return { id: "job_7Q2K", version: 1, client: "maya-client", title: "Fixture", openedAt: at,
		contract: { budget: 40000, deliveryEndsAt: "2026-11-08T11:12:00.000Z", definitionOfDone: null },
		bids: [{ id: "bid_test", operator: "devon-ops", handle: "devon-ops", kind: "INDEPENDENT", payee: "D3SSQU3ZEN7R2",
			agent: "ts-bugfixer", runner: "claude-code", price: 40000, eta: 48, pitch: "test", placedAt: at,
			respondBy: at, status: "ACCEPTED" }],
		state: { status: "VERIFIED",
			escrow: { payee: { bidId: "bid_test", operator: "devon-ops", payee: "D3SSQU3ZEN7R2", agent: "ts-bugfixer", price: 40000, eta: 48 },
				quote: { split: { price: 40000, clientFee: 2000, operatorFee: 4000, held: 42000, operatorNet: 36000, fee: 6000 },
					model: { version: "test", rateBps: 349, fixed: 49 }, predictedProcessorFee: 1515, platformFeeInstruction: 4485 },
				capture: { orderId: "ORDER1", captureId: "CAPTURE1", payee: "D3SSQU3ZEN7R2", disbursement: "DELAYED", gross: 42000,
					processorFee: 1515, platformFee: 4485, sellerNet: 36000, capturedAt: at },
				book: [{ kind: "HELD", cents: 42000, at }], cutoffAt: "2026-11-28T11:12:00.000Z" },
			history: [], passed: { ordinal: 1, verdict },
			review: { phase: "AWAITING_CLIENT", endsAt: "2026-11-04T11:12:00.000Z" }, runsStarted: 1 } };
}
test("development routes require the flag and the configured lane origin", async () => {
	await apiFixture(false, async url => {
		for (const path of ["clock", "fund-mode", "tick", "arbiter"]) {
			const response = await fetch(`${url}/api/dev/${path}`, { method: "POST", body: "{}" });
			assert.equal(response.status, 403);
			const error = await response.json() as { error: string; detail: string };
			assert.equal(error.error, "DEV_DISABLED");
			assert.match(error.detail, /ACQUIT_DEV=1/);
		}
	});
	await apiFixture(true, async url => {
		const denied = await fetch(`${url}/api/session`, { method: "POST", headers: { Origin: "http://localhost:5203" }, body: JSON.stringify({ handle: "maya-client" }) });
		assert.equal(denied.status, 403);
		assert.equal((await denied.json() as { error: string }).error, "ORIGIN_DENIED");
		const signedIn = await fetch(`${url}/api/session`, { method: "POST", headers: { Origin: "http://localhost:5213" }, body: JSON.stringify({ handle: "maya-client" }) });
		assert.equal(signedIn.status, 200);
		const auth = await signedIn.json() as { token: string };
		const post = (path: string, body: unknown) => fetch(`${url}/api/dev/${path}`, { method: "POST",
			headers: { Authorization: `Bearer ${auth.token}`, Origin: "http://localhost:5213", "Content-Type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await fetch(`${url}/api/dev/clock`, { method: "POST", body: '{"advanceMs":1}' })).status, 401);
		assert.equal((await post("clock", { advanceMs: -1 })).status, 400);
		assert.equal((await post("clock", { advanceMs: 1, unexpected: true })).status, 400);
		const advanced = await post("clock", { advanceMs: 14_400_000 });
		assert.equal(advanced.status, 200);
		const now = Date.parse((await advanced.json() as { now: string }).now);
		assert.equal(now, 1760000000000 + 14_400_000);
		const mode = await post("fund-mode", { mode: "card" });
		assert.equal(mode.status, 200);
		assert.deepEqual(await mode.json(), { mode: "card" });
		assert.equal((await post("fund-mode", { mode: "production" })).status, 400);
		// Sessions use the same clock for both issuance and expiry, including
		// sessions created after a development-time jump.
		const fresh = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle: "maya-client" }) });
		const freshAuth = await fresh.json() as { token: string };
		assert.equal((await post("clock", { advanceMs: 7 * 86400000 - 1 })).status, 200);
		assert.equal((await fetch(`${url}/api/me/credits`, { headers: { Authorization: `Bearer ${freshAuth.token}` } })).status, 403);
		assert.equal((await fetch(`${url}/api/me/credits`, { headers: { Authorization: `Bearer ${auth.token}` } })).status, 401);
		assert.equal((await fetch(`${url}/api/dev/clock`, { method: "POST", headers: { Authorization: `Bearer ${freshAuth.token}` }, body: '{"advanceMs":1}' })).status, 200);
		assert.equal((await fetch(`${url}/api/me/credits`, { headers: { Authorization: `Bearer ${freshAuth.token}` } })).status, 401);
	});
});
test("a job stored before the frozen contract serves through GET /api/jobs/:id", async () => {
	// Public mode refuses seeded sign-in, so every fixture whose subject is not the mode boots dev.
	await apiFixture(true, async (url, databasePath) => {
		const { DatabaseSync } = await import("node:sqlite");
		const at = "2026-11-01T11:12:00.000Z";
		const held = [{ kind: "HELD", cents: 42000, at }];
		const row = { id: "job_7Q2K", version: 1, client: "maya-client", title: "Fixture",
			contract: { budget: 40000, deliveryEndsAt: "2026-11-08T11:12:00.000Z" },
			bids: [{ id: "bid_test", operator: "devon-ops", agent: "ts-bugfixer", kind: "INDEPENDENT", price: 40000, status: "ACCEPTED" }],
			state: { status: "IN_PROGRESS", escrow: { book: held, payee: { operator: "devon-ops" } }, attempts: { phase: "WORKING", history: [] } } };
		const db = new DatabaseSync(databasePath);
		db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(row.id, JSON.stringify(row));
		db.close();
		const signedIn = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle: "maya-client" }) });
		assert.equal(signedIn.status, 200);
		const auth = await signedIn.json() as { token: string };
		const response = await fetch(`${url}/api/jobs/${row.id}`, { headers: { Authorization: `Bearer ${auth.token}` } });
		assert.equal(response.status, 200);
		const { job } = await response.json() as { job: { id: string; status: string; escrow: string; contract: unknown; budget: number; ledger: unknown } };
		assert.equal(job.id, row.id);
		assert.equal(job.status, "IN_PROGRESS");
		assert.equal(job.escrow, "HELD");
		assert.equal(job.budget, 40000);
		assert.equal(job.contract, null);
		assert.deepEqual(job.ledger, held);
	});
});
test("the Approve command releases for the client and is denied to the operator", async () => {
	await apiFixture(true, async (url, databasePath, calls) => {
		const { DatabaseSync } = await import("node:sqlite");
		const at = "2026-11-01T11:12:00.000Z";
		const mergeCommit = "5cccb66515313caed72e4af329a62fc011139426";
		const row = verifiedFixture(mergeCommit, at);
		const db = new DatabaseSync(databasePath);
		db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(row.id, JSON.stringify(row));
		db.close();
		const token = async (handle: string): Promise<string> => {
			const signedIn = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle }) });
			assert.equal(signedIn.status, 200);
			return ((await signedIn.json()) as { token: string }).token;
		};
		const approve = (auth: string, key: string, command: unknown) => fetch(`${url}/api/commands`, { method: "POST",
			headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify({ key, command }) });
		const operator = await token("devon-ops");
		const denied = await approve(operator, "4d1c6a0e-1f2b-4c3d-8e5f-6a7b8c9d0e1f",
			{ type: "Approve", jobId: row.id, mergeCommit });
		assert.equal(denied.status, 409);
		assert.deepEqual(await denied.json(), { outcome: { kind: "DENIED", reason: "NOT_OWNER" } });
		const client = await token("maya-client");
		const committed = await approve(client, "5e2d7b1f-2a3c-4d5e-9f6a-7b8c9d0e1f2a",
			{ type: "Approve", jobId: row.id, mergeCommit });
		assert.equal(committed.status, 200);
		const body = await committed.json() as { outcome: { kind: string; result: { job: { status: string; phase: string } } } };
		assert.equal(body.outcome.kind, "COMMITTED");
		assert.equal(body.outcome.result.job.status, "VERIFIED");
		assert.equal(body.outcome.result.job.phase, "RELEASE_PENDING");
		// The same key replays the same result instead of selecting a second release.
		assert.equal((await approve(client, "5e2d7b1f-2a3c-4d5e-9f6a-7b8c9d0e1f2a",
			{ type: "Approve", jobId: row.id, mergeCommit })).status, 200);
		const reread = await fetch(`${url}/api/jobs/${row.id}`, { headers: { Authorization: `Bearer ${client}` } });
		const { job } = await reread.json() as { job: { status: string; phase: string; mergeCommit: string | null } };
		assert.equal(job.phase, "RELEASE_PENDING");
		assert.equal(job.mergeCommit, mergeCommit);
		// The release the approval selected went to the stubbed boundary and nowhere else: the token call,
		// then the referenced payout for the held capture.
		assert.deepEqual((await calls()).map(call => [call.method, new URL(call.url).pathname]),
			[["POST", "/v1/oauth2/token"], ["POST", "/v1/payments/referenced-payouts-items"]]);
	});
});
test("the client disputes through the command route and the dev arbiter route resolves it", async () => {
	await apiFixture(true, async (url, databasePath, calls) => {
		const { DatabaseSync } = await import("node:sqlite");
		const at = "2026-11-01T11:12:00.000Z";
		const mergeCommit = "5cccb66515313caed72e4af329a62fc011139426";
		const row = verifiedFixture(mergeCommit, at);
		const db = new DatabaseSync(databasePath);
		db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(row.id, JSON.stringify(row));
		db.close();
		const signedIn = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle: "maya-client" }) });
		assert.equal(signedIn.status, 200);
		const client = ((await signedIn.json()) as { token: string }).token;
		const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST",
			headers: { Authorization: `Bearer ${client}` }, body: JSON.stringify(body) });
		const disputed = await post("/api/commands", { key: randomUUID(),
			command: { type: "Dispute", jobId: row.id, mergeCommit, reason: "The export path regressed." } });
		assert.equal(disputed.status, 200);
		const opened = await disputed.json() as { outcome: { kind: string; result: { job: { phase: string; viewerCanDispute: boolean;
			viewerCanApprove: boolean; reviewEndsAt: string | null; dispute: { reason: string; openedAt: string; resolveBy: string } | null } } } };
		assert.equal(opened.outcome.kind, "COMMITTED");
		assert.equal(opened.outcome.result.job.phase, "DISPUTED");
		assert.equal(opened.outcome.result.job.viewerCanDispute, false);
		assert.equal(opened.outcome.result.job.viewerCanApprove, false);
		assert.equal(opened.outcome.result.job.reviewEndsAt, null);
		assert.deepEqual(opened.outcome.result.job.dispute, { reason: "The export path regressed.",
			openedAt: "2025-10-09T08:53:20.000Z", resolveBy: "2025-10-11T08:53:20.000Z" });
		// The arbiter's hackathon surface sends the same ResolveDispute the staff console will send later.
		const upheld = await post("/api/dev/arbiter", { jobId: row.id, verdict: "UPHOLD", note: "The artifact met the frozen contract." });
		assert.equal(upheld.status, 200);
		const resolved = await upheld.json() as { outcome: { kind: string; result: { job: { phase: string; releaseAuthority: string | null; arbiterNote: string | null } } } };
		assert.equal(resolved.outcome.kind, "COMMITTED");
		assert.equal(resolved.outcome.result.job.phase, "RELEASE_PENDING");
		assert.equal(resolved.outcome.result.job.releaseAuthority, "ARBITER_UPHELD");
		assert.equal(resolved.outcome.result.job.arbiterNote, "The artifact met the frozen contract.");
		// The row left DISPUTED, so a second verdict is refused, and an unknown verdict never parses.
		assert.equal((await post("/api/dev/arbiter", { jobId: row.id, verdict: "REFUND", note: "again" })).status, 409);
		assert.equal((await post("/api/dev/arbiter", { jobId: row.id, verdict: "MAYBE", note: "again" })).status, 400);
		assert.deepEqual((await calls()).map(call => [call.method, new URL(call.url).pathname]),
			[["POST", "/v1/oauth2/token"], ["POST", "/v1/payments/referenced-payouts-items"]]);
	});
});
test("the dispute and arbiter routes bound their text and the dispute owner", async () => {
	await apiFixture(true, async (url, databasePath) => {
		const { DatabaseSync } = await import("node:sqlite");
		const at = "2026-11-01T11:12:00.000Z";
		const mergeCommit = "5cccb66515313caed72e4af329a62fc011139426";
		const row = verifiedFixture(mergeCommit, at);
		const db = new DatabaseSync(databasePath);
		db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(row.id, JSON.stringify(row));
		db.close();
		const token = async (handle: string): Promise<string> => {
			const signedIn = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle }) });
			assert.equal(signedIn.status, 200);
			return ((await signedIn.json()) as { token: string }).token;
		};
		const post = (path: string, auth: string, body: unknown) => fetch(`${url}${path}`, { method: "POST",
			headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
		const reason = "x".repeat(300);
		const overLong = "x".repeat(301);
		// No session: the dev arbiter route answers 401 before it parses or resolves anything.
		assert.equal((await fetch(`${url}/api/dev/arbiter`, { method: "POST",
			body: JSON.stringify({ jobId: row.id, verdict: "UPHOLD", note: reason }) })).status, 401);
		// A session that is not the job's client cannot dispute it, however well formed the body is.
		const devon = await token("devon-ops");
		const stranger = await post("/api/commands", devon, { key: randomUUID(),
			command: { type: "Dispute", jobId: row.id, mergeCommit, reason } });
		assert.equal(stranger.status, 409);
		assert.deepEqual(await stranger.json(), { outcome: { kind: "DENIED", reason: "NOT_OWNER" } });
		// The owning client may dispute, and a 301-character reason is refused before the domain sees it.
		const maya = await token("maya-client");
		const tooLong = await post("/api/commands", maya, { key: randomUUID(),
			command: { type: "Dispute", jobId: row.id, mergeCommit, reason: overLong } });
		assert.equal(tooLong.status, 400);
		assert.equal((await post("/api/commands", maya, { key: randomUUID(),
			command: { type: "Dispute", jobId: row.id, mergeCommit, reason } })).status, 200);
		// The arbiter's note is bounded the same way; the 300-character edge is the reason it stays 300.
		assert.equal((await post("/api/dev/arbiter", maya, { jobId: row.id, verdict: "UPHOLD", note: overLong })).status, 400);
	});
});
test("a bid the operator cannot afford answers with the credit balance and the next grant", async () => {
	await apiFixture(true, async (url, databasePath) => {
		const { DatabaseSync } = await import("node:sqlite");
		const at = "2026-11-01T11:12:00.000Z";
		const operator = { id: "devon-ops", handle: "devon-ops", kind: "INDEPENDENT", version: 0,
			payouts: { kind: "READY", merchant: "D3SSQU3ZEN7R2", connectedAt: at } };
		const agent = { id: "ts-bugfixer", owner: "devon-ops", name: "ts-bugfixer", runner: "claude-code", promptDigest: "digest", tools: [] };
		const credits = { operator: "devon-ops", version: 0, balance: { allowance: 0, purchased: 0 }, lines: [] };
		const job = { id: "job_7Q2K", version: 1, client: "maya-client", title: "Fixture", openedAt: at,
			contract: { budget: 40000, deliveryEndsAt: "2026-11-08T11:12:00.000Z", definitionOfDone: null },
			bids: [], state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } } };
		const db = new DatabaseSync(databasePath);
		db.prepare("INSERT INTO operators VALUES (?, 0, ?, 0)").run("devon-ops", JSON.stringify(operator));
		db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run("ts-bugfixer", "devon-ops", JSON.stringify(agent));
		db.prepare("INSERT INTO credits VALUES (?, 0, ?)").run("devon-ops", JSON.stringify(credits));
		db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(job.id, JSON.stringify(job));
		db.close();
		const signedIn = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle: "devon-ops" }) });
		assert.equal(signedIn.status, 200);
		const token = ((await signedIn.json()) as { token: string }).token;
		const denied = await fetch(`${url}/api/commands`, { method: "POST", headers: { Authorization: `Bearer ${token}` },
			body: JSON.stringify({ key: randomUUID(),
				command: { type: "PlaceBid", jobId: job.id, price: 40000, eta: 48, agent: "ts-bugfixer", pitch: "no credits" } }) });
		assert.equal(denied.status, 409);
		assert.deepEqual(await denied.json(), { outcome: { kind: "DENIED", reason: "INSUFFICIENT_CREDITS" },
			credits: { available: 0, weeklyAllowance: 30, nextGrantAt: "2025-10-13T00:00:00.000Z" } });
	});
});
test("a BEGIN the lock refuses fails that request and leaves the API serving the next one", async () => {
	await apiFixture(true, async (url, databasePath) => {
		const { DatabaseSync } = await import("node:sqlite");
		const signedIn = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle: "devon-ops" }) });
		assert.equal(signedIn.status, 200);
		const auth = ((await signedIn.json()) as { token: string }).token;
		const challenge = createHash("sha256").update("unit-test-verifier").digest("base64url");
		const created = await fetch(`${url}/api/cli/codes`, { method: "POST", body: JSON.stringify({ challenge }) });
		assert.equal(created.status, 201);
		const { code } = await created.json() as { code: string };
		const approve = () => fetch(`${url}/api/cli/approve`, { method: "POST",
			headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify({ code }) });
		// A second connection holds the write lock, so the approval's BEGIN IMMEDIATE is refused.
		const blocker = new DatabaseSync(databasePath);
		blocker.exec("BEGIN IMMEDIATE");
		const refused = await approve();
		assert.equal(refused.status, 500);
		assert.deepEqual(await refused.json(), { error: "INTERNAL_ERROR" });
		// Releasing the lock leaves the connection out of a transaction: the same approval now claims
		// the code, so the failed BEGIN wedged nothing.
		blocker.exec("ROLLBACK");
		blocker.close();
		const approved = await approve();
		assert.equal(approved.status, 200);
		assert.deepEqual(await approved.json(), { handle: "devon-ops", role: "OPERATOR" });
	});
});
test("an expired code is refused by the claim that would approve or deliver it", async () => {
	await apiFixture(true, async url => {
		const signedIn = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle: "devon-ops" }) });
		assert.equal(signedIn.status, 200);
		const auth = ((await signedIn.json()) as { token: string }).token;
		const challenge = createHash("sha256").update("unit-test-verifier").digest("base64url");
		const issue = async (): Promise<string> => {
			const response = await fetch(`${url}/api/cli/codes`, { method: "POST", body: JSON.stringify({ challenge }) });
			assert.equal(response.status, 201);
			return ((await response.json()) as { code: string }).code;
		};
		const advance = (advanceMs: number) => fetch(`${url}/api/dev/clock`, { method: "POST",
			headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify({ advanceMs }) });
		const approve = (code: string) => fetch(`${url}/api/cli/approve`, { method: "POST",
			headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify({ code }) });
		const poll = (code: string) => fetch(`${url}/api/cli/codes/${encodeURIComponent(code)}`,
			{ headers: { "X-Acquit-Verifier": "unit-test-verifier" } });
		// A code that lapses before approval cannot be claimed: the approval's UPDATE carries the expiry.
		const stale = await issue();
		assert.equal((await advance(600_001)).status, 200);
		const refused = await approve(stale);
		assert.equal(refused.status, 410);
		assert.deepEqual(await refused.json(), { error: "CLI_CODE_EXPIRED" });
		// A code approved before it lapses still expires before its one delivery: the delivery claim
		// carries the same expiry.
		const approved = await issue();
		assert.equal((await approve(approved)).status, 200);
		assert.equal((await advance(600_001)).status, 200);
		const lapsed = await poll(approved);
		assert.equal(lapsed.status, 410);
		assert.deepEqual(await lapsed.json(), { error: "CLI_CODE_EXPIRED" });
	});
});
