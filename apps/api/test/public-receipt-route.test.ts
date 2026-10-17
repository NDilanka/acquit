// The public receipt route over real HTTP, with no session. A PAID job's receipt answers 200; a job that is
// not PAID, an unknown id, a job id, and a malformed id all answer the same 404, and the session gate still
// holds every other /api route.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../../../packages/core/src/store.ts";

const root = join(import.meta.dirname, "..");
const RECEIPT = "rcpt_routepaid";
const RELEASED_AT = "2026-10-12T00:00:00Z";
const MERGE = "a".repeat(40);

function bootServer(port: number, dbPath: string, home: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673",
				HOME: home, FACTORY_API_KEY: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => rejectBoot(new Error(`server did not boot: ${out} ${err}`)), 30_000);
		child.stdout.on("data", (chunk: Buffer) => {
			out += String(chunk);
			if (out.includes("Acquit API:")) { clearTimeout(timer); resolveBoot(child); }
		});
		child.stderr.on("data", (chunk: Buffer) => { err += String(chunk); });
		child.on("exit", (code) => { clearTimeout(timer); rejectBoot(new Error(`server exited early (${code}): ${out} ${err}`)); });
	});
}

const get = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`);

// Windows keeps the SQLite file locked until the server process has actually exited, so the temp dir waits for it.
function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise(resolveStop => {
		if (child.exitCode !== null || child.signalCode !== null) { resolveStop(); return; }
		child.once("exit", () => resolveStop());
		child.kill("SIGTERM");
	});
}

function seedRows(dbPath: string): void {
	const store = new SqliteStore(dbPath);
	try {
		const paid = { title: "Fix the invoice total", contract: { definitionOfDone: { issue: { repository: "maya-client/invoice-app", number: 42, title: "Fix the invoice total" } } },
			bids: [{ id: "bid_devon", handle: "devon-ops", kind: "INDEPENDENT" }],
			state: { status: "PAID", payee: { bidId: "bid_devon", operator: "devon-ops", payee: "MERCHANT-PRIVATE-7" },
				book: [{ kind: "HELD", cents: 42_000, at: RELEASED_AT }, { kind: "RELEASED", cents: 36_000, at: RELEASED_AT },
					{ kind: "FEE", cents: 6_000, processor: 1_515, acquit: 4_485, at: RELEASED_AT }],
				receipt: { id: RECEIPT, jobId: "job_routepaid", operator: "devon-ops", agent: "ts-bugfixer", pullRequest: 7, mergeCommit: MERGE,
					frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, attemptsUsed: 1, paid: 36_000, releasedAt: RELEASED_AT },
				release: { payoutItemId: "PAYOUT-ITEM-7", captureId: "CAPTURE-7", paid: 36_000, at: RELEASED_AT },
				releaseAuthority: "CLIENT_APPROVAL",
				history: [{ ordinal: 1, verdict: { result: "VERIFIED", runId: "run_1", sourceCommit: "c".repeat(40), mergeCommit: MERGE, pullRequest: 7,
					frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "d".repeat(64), at: RELEASED_AT } }],
				merge: { phase: "MERGED", at: RELEASED_AT, sha: MERGE }, treasury: [] } };
		const open = { title: "Still open", contract: { definitionOfDone: { issue: { repository: "maya-client/invoice-app", number: 43, title: "Still open" } } },
			bids: [], state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } } };
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_routepaid", JSON.stringify(paid));
		store.db.prepare("INSERT INTO job_manifests VALUES (?, ?)").run("job_routepaid", JSON.stringify({ issue: { repository: "maya-client/invoice-app", number: 42, title: "Fix the invoice total" } }));
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, 'devon-ops', 'JOB', 1, ?)").run(RECEIPT, "job_routepaid", RELEASED_AT);
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_routeopen", JSON.stringify(open));
		store.db.prepare("INSERT INTO job_manifests VALUES (?, ?)").run("job_routeopen", JSON.stringify({ issue: { repository: "maya-client/invoice-app", number: 43, title: "Still open" } }));
	} finally { store.close(); }
}

test("the public receipt answers a PAID job's id with 200, and every other id with the same 404, with no session", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-public-receipt-route-"));
	const port = 4891;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		const dbPath = join(dir, "test.db");
		seedRows(dbPath);
		child = await bootServer(port, dbPath, join(dir, "homeless"));

		const paid = await get(port, `/api/receipts/${RECEIPT}`);
		assert.equal(paid.status, 200);
		const body = await paid.json() as { receipt: Record<string, unknown> };
		assert.equal(body.receipt.id, RECEIPT);
		assert.deepEqual(body.receipt.operator, { handle: "devon-ops", label: "INDEPENDENT" }, "the agent name stays off the public receipt");
		assert.deepEqual(body.receipt.money, { heldCents: 42_000, paidCents: 36_000, feeCents: 6_000, processorFeeCents: 1_515, acquitFeeCents: 4_485 });
		assert.equal(body.receipt.hiddenCases, null, "no seal was frozen, so no hidden-case section");
		assert.deepEqual(body.receipt.scoreCard, { cheatsCaught: 11, cheatsTotal: 11, honestPassed: 20, honestTotal: 20, gaps: [] });

		const openJobId = await get(port, "/api/receipts/job_routeopen");
		assert.equal(openJobId.status, 404);
		const openBody = await openJobId.json();
		const unknown = await get(port, "/api/receipts/rcpt_nobody");
		assert.equal(unknown.status, 404);
		assert.deepEqual(await unknown.json(), openBody, "an open job's id and an unknown id answer the same");
		assert.deepEqual(openBody, { error: "NOT_FOUND" });

		const jobId = await get(port, "/api/receipts/job_routepaid");
		assert.equal(jobId.status, 404, "a job id is not a receipt id");
		await jobId.text();

		const malformed = await get(port, "/api/receipts/%E0%A4%A");
		assert.equal(malformed.status, 404, "a malformed id is a 404, not a 500");
		await malformed.text();

		const gated = await get(port, "/api/jobs/job_routepaid");
		assert.equal(gated.status, 401, "the session gate still holds every other API route");
		await gated.text();
	} finally {
		if (child) await stopServer(child);
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
