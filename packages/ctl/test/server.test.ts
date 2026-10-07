import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reachable, releaseSpawned, sleep } from "../src/process.ts";

async function apiFixture(dev: boolean, run: (url: string, databasePath: string) => Promise<void>): Promise<void> {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "acquit-api-test-"));
	const listener = createServer();
	await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as { port: number }).port;
	await new Promise<void>(resolve => listener.close(() => resolve()));
	// Inject a frozen wall clock before importing the server. No timing tolerance
	// or one-sided assertion can accidentally accept an ignored offset.
	const child = spawn(process.execPath, ["--import", "data:text/javascript,Date.now=()=>1760000000000", "apps/api/src/server.ts"], { cwd: root, stdio: "ignore", env: {
		...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: dev ? "1" : "0", PORT: String(port), WEB_ORIGIN: "http://localhost:5213",
		DATABASE_PATH: join(dir, "acquit.db"), PAYPAL_CLIENT_ID: "unit-test", PAYPAL_CLIENT_SECRET: "unit-test",
	} });
	try {
		const deadline = Date.now() + 15_000;
		const url = `http://127.0.0.1:${port}`;
		while (!(await reachable(`${url}/api/users`))) {
			assert.equal(child.exitCode, null, "The isolated test API exited early.");
			assert(Date.now() < deadline, "The isolated test API failed readiness.");
			await sleep(50);
		}
		await run(url, join(dir, "acquit.db"));
	} finally {
		await releaseSpawned(child);
		await rm(dir, { recursive: true, force: true });
	}
}
test("development routes require the flag and the configured lane origin", async () => {
	await apiFixture(false, async url => {
		for (const path of ["clock", "fund-mode", "tick"]) {
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
	await apiFixture(false, async (url, databasePath) => {
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
	await apiFixture(false, async (url, databasePath) => {
		const { DatabaseSync } = await import("node:sqlite");
		const at = "2026-11-01T11:12:00.000Z";
		const mergeCommit = "5cccb66515313caed72e4af329a62fc011139426";
		const verdict = { result: "VERIFIED", runId: "run_test_1", sourceCommit: "a3b6ead29f4e367d1871e753b516cc9e832871e4",
			mergeCommit, pullRequest: 13, frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 },
			reportDigest: "b".repeat(64), at };
		const row = { id: "job_7Q2K", version: 1, client: "maya-client", title: "Fixture", openedAt: at,
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
	});
});
