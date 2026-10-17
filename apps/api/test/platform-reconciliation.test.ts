// The platform reconciliation's server side: the Transaction Search walk (windows, pages, the span limit), the
// one-minute cache, and the refusal of every holder but the platform role. PayPal is replaced by a fake that
// records each call, so these tests name the exact windows and pages the route asks for.

import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReconcileSpanError, reconciliationService } from "../src/reconciliation.ts";
import type { LedgerTables, TransactionFetch } from "../src/reconciliation.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");

/** One Transaction Search page as PayPal answers it. */
function page(rows: readonly unknown[], current: number, totalPages: number): unknown {
	return { transaction_details: rows, page: current, total_pages: totalPages, total_items: rows.length };
}

function row(id: string, value: string): unknown {
	return { transaction_info: { transaction_id: id, transaction_event_code: "T0006", transaction_initiation_date: "2026-08-01T10:00:00Z",
		transaction_amount: { currency_code: "USD", value } } };
}

/** A fake PayPal: records every (start, end, page) it is asked for and answers from `answer`. */
function fakePayPal(answer: (start: string, page: number) => unknown) {
	const calls: [string, string, number][] = [];
	const fetchPage: TransactionFetch = async (start, end, current) => {
		calls.push([start, end, current]);
		return answer(start, current);
	};
	return { calls, fetchPage };
}

const EMPTY: LedgerTables = { entries: [], events: [] };

test("an empty ledger reads the last 31 days in two windows, and a read inside the cache window does not reach PayPal", async () => {
	const { calls, fetchPage } = fakePayPal(() => page([], 1, 1));
	const reconcile = reconciliationService(fetchPage, 60_000);
	const first = await reconcile(EMPTY, NOW);
	assert.equal(first.cached, false);
	assert.deepEqual(calls, [
		["2026-09-12T00:00:00Z", "2026-10-13T00:00:00Z", 1],
		["2026-10-13T00:00:00Z", "2026-10-13T12:00:00Z", 1],
	]);

	const inside = await reconcile(EMPTY, NOW + 30_000);
	assert.equal(inside.cached, true);
	assert.equal(inside.fetchedAt, "2026-10-13T12:00:00Z", "the cached read keeps its own time");
	assert.equal(calls.length, 2, "a read inside the window is served from the cache");

	const after = await reconcile(EMPTY, NOW + 61_000);
	assert.equal(after.cached, false);
	assert.equal(calls.length, 4, "the first read after the window goes back to PayPal");
});

test("the walk pages each window to total_pages, and every window is at most 31 days", async () => {
	const { calls, fetchPage } = fakePayPal((start, current) => {
		if (start === "2026-08-01T00:00:00Z") return current === 1 ? page([row("CAP-A", "420.00")], 1, 2) : page([row("CAP-B", "100.00")], 2, 2);
		if (start === "2026-09-01T00:00:00Z") return page([], 1, 1);
		return page([row("CAP-C", "50.00")], 1, 1);
	});
	const tables: LedgerTables = {
		entries: [{ entryId: "job_a#0", jobId: "job_a", kind: "HELD", cents: 42000, at: "2026-08-01T10:00:00Z", captureId: "CAP-A", processorCents: null }],
		events: [],
	};
	const body = await reconciliationService(fetchPage)(tables, NOW);
	assert.deepEqual(calls, [
		["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 1],
		["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 2],
		["2026-09-01T00:00:00Z", "2026-10-02T00:00:00Z", 1],
		["2026-10-02T00:00:00Z", "2026-10-13T12:00:00Z", 1],
	]);
	assert.equal(body.from, "2026-08-01T00:00:00Z");
	assert.equal(body.to, "2026-10-13T12:00:00Z");
	assert.equal(body.transactions, 3);
	assert.deepEqual(body.counts, { matched: 1, pending: 0, mismatched: 0, unknown: 2 });
	assert.deepEqual(body.unknown.map(t => t.transactionId), ["CAP-B", "CAP-C"]);
	assert.equal(body.pendingWindowHours, 3);
});

test("a ledger spanning more windows than the limit is refused before any PayPal call", async () => {
	const { calls, fetchPage } = fakePayPal(() => page([], 1, 1));
	const tables: LedgerTables = {
		entries: [{ entryId: "job_old#0", jobId: "job_old", kind: "HELD", cents: 42000, at: "2023-10-13T12:00:00Z", captureId: "CAP-OLD", processorCents: null }],
		events: [],
	};
	await assert.rejects(reconciliationService(fetchPage)(tables, NOW), ReconcileSpanError);
	assert.equal(calls.length, 0);
});

test("a refused PayPal read is not cached: the next request asks PayPal again and can succeed", async () => {
	let calls = 0;
	let refusing = true;
	const fetchPage: TransactionFetch = async () => {
		calls++;
		if (refusing) throw new Error("PayPal answered 500 for /v1/reporting/transactions.");
		return page([], 1, 1);
	};
	const reconcile = reconciliationService(fetchPage);
	await assert.rejects(reconcile(EMPTY, NOW), /PayPal answered 500/);
	refusing = false;
	const recovered = await reconcile(EMPTY, NOW);
	assert.equal(recovered.cached, false);
	assert.equal(calls, 3, "the refused read stops at its first window; the recovered read asks both windows");
});

// ---- the route over real HTTP: the platform role alone may read it, and nothing is fetched for anyone else ----

const root = join(import.meta.dirname, "..");

function bootServer(port: number, dbPath: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673",
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

const post = (port: number, path: string, payload: unknown) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

test("the reconciliation route refuses anonymous and non-platform sessions before it reads PayPal", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-reconcile-"));
	const port = 4898;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"));
		const anonymous = await fetch(`http://127.0.0.1:${port}/api/platform/reconciliation`);
		assert.equal(anonymous.status, 401);

		const signedIn = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signedIn.status, 200);
		const { token: clientToken } = await signedIn.json() as { token: string };
		const client = await fetch(`http://127.0.0.1:${port}/api/platform/reconciliation`, { headers: { authorization: `Bearer ${clientToken}` } });
		assert.equal(client.status, 403);
		assert.deepEqual(await client.json(), { error: "PLATFORM_ONLY" });
	} finally {
		// Windows keeps the SQLite file locked until the server process has exited.
		if (child && child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
