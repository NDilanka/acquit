// The platform explain route, served by the real server: the role gates, the figure check, and the shape of the
// answer. The first two tests boot a fresh database with no ledger lines, so no figure there makes a PayPal read.
// The third seeds a populated book and reads PayPal through fake-paypal.mjs. The lines' PayPal mapping is tested in
// figure-trace.test.ts with a stubbed reconciliation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteStore } from "../../../packages/core/src/store.ts";

const root = join(import.meta.dirname, "..");
const PLATFORM_KEY = "test-platform-key-0123456789abcdef";

function bootServer(port: number, dbPath: string, preload?: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, [...(preload === undefined ? [] : ["--import", pathToFileURL(preload).href]), "src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1", ACQUIT_PLATFORM_KEY: PLATFORM_KEY,
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret", WEB_ORIGIN: "http://localhost:5674",
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

test("the explain route refuses anonymous and non-platform sessions, and names an unknown figure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-explain-"));
	const port = 4899;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"));
		const url = `http://127.0.0.1:${port}/api/platform/explain?figure=fees`;
		assert.equal((await fetch(url)).status, 401, "an anonymous request is refused before the role check");

		const signedIn = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signedIn.status, 200);
		const { token: clientToken } = await signedIn.json() as { token: string };
		const client = await fetch(url, { headers: { authorization: `Bearer ${clientToken}` } });
		assert.equal(client.status, 403);
		assert.deepEqual(await client.json(), { error: "PLATFORM_ONLY" });

		const minted = await post(port, "/api/platform/session", { key: PLATFORM_KEY });
		assert.equal(minted.status, 201);
		const { token } = await minted.json() as { token: string };
		const unknown = await fetch(`http://127.0.0.1:${port}/api/platform/explain?figure=pass-rate`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(unknown.status, 400);
		assert.deepEqual(await unknown.json(), { error: "UNKNOWN_FIGURE", figures: ["held", "released", "refunded", "fees", "paid-by-clients"] });
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

test("the explain route answers every figure with its total and line shape, and the ask tool's trace_figure answers the same body", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-explain-"));
	const port = 4900;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"));
		const minted = await post(port, "/api/platform/session", { key: PLATFORM_KEY });
		const { token } = await minted.json() as { token: string };
		const routeBodies = new Map<string, unknown>();
		for (const figure of ["held", "released", "refunded", "fees", "paid-by-clients"]) {
			const answer = await fetch(`http://127.0.0.1:${port}/api/platform/explain?figure=${figure}`, { headers: { authorization: `Bearer ${token}` } });
			assert.equal(answer.status, 200, `${figure} is answered`);
			const text = await answer.text();
			const body = JSON.parse(text) as { figure: string; label: string; totalCents: number; lines: Record<string, unknown>[] };
			assert.equal(body.figure, figure);
			assert.equal(typeof body.label, "string");
			assert.equal(body.lines.reduce((sum, line) => sum + (line["cents"] as number), 0), body.totalCents, `${figure}: lines sum to the figure`);
			for (const line of body.lines) assert.deepEqual(Object.keys(line).sort(), ["at", "cents", "entryId", "jobId", "kind", "paypal", "receiptId"]);
			if (body.lines.length === 0) assert.equal(body.totalCents, 0, `${figure}: an empty figure totals zero`);
			assert.doesNotMatch(text, /merchant|payee|@/i, "the body names no merchant, payee, or email");
			routeBodies.set(figure, body);
		}

		const callTool = (figure: string) => fetch(`http://127.0.0.1:${port}/api/ask-ledger/tool`, { method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: "trace_figure", arguments: { figure } }) });
		const traced = await callTool("fees");
		assert.equal(traced.status, 200);
		assert.deepEqual(await traced.json(), { result: routeBodies.get("fees") }, "the ask tool and the route answer the same fees trace");
		const refused = await callTool("pass-rate");
		assert.equal(refused.status, 502, "a verifier rate is refused by the ask tool too");
		await refused.text();
	} finally {
		if (child && child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});

const FAKE_PAYPAL = join(import.meta.dirname, "fake-paypal.mjs");
const T = "2099-01-01T00:00:00.000Z";
const MERCHANT = "MERCHANT_PRIVATE_SENTINEL";
const payee = { operator: "devon-ops", payee: MERCHANT, price: 36000, bidId: "bid_test", agent: "test-agent", eta: 48 };
const line = (kind: string, cents: number, extra: Record<string, unknown> = {}) => ({ kind, cents, at: T, ...extra });
const hold = (id: string, cents: number) => ({ payee, capture: { captureId: `CAP-${id}`, orderId: `ORDER-${id}`, payee: MERCHANT,
	gross: cents, capturedAt: T, processorFee: 1515, platformFee: 4485, sellerNet: cents - 6000, disbursement: "DELAYED" },
	book: [line("HELD", cents)], cutoffAt: "2099-02-01T00:00:00.000Z", quote: {} });
const job = (id: string, state: object) => ({ id, client: "maya-client", tenant: null, title: id, version: 1, openedAt: T,
	contract: { budget: 42000, deliveryEndsAt: "2099-01-15T00:00:00.000Z", definitionOfDone: null }, bids: [], state });
const populated = [
	job("job_paid", { status: "PAID", payee, book: [line("HELD", 42000), line("RELEASED", 36000), line("FEE", 6000, { processor: 1515, acquit: 4485 })],
		history: [], receipt: { id: "rcpt_paid", attemptsUsed: 1, paid: 36000, releasedAt: T },
		release: { captureId: "CAP-job_paid", payoutItemId: "PAYOUT-job_paid", paid: 36000, at: T }, merge: { phase: "MERGED", at: T, sha: null }, treasury: [] }),
	job("job_held", { status: "IN_PROGRESS", escrow: hold("job_held", 37800), attempts: { phase: "READY", history: [] } }),
	job("job_refunded", { status: "REFUNDED", payee, book: [line("HELD", 42000), line("REFUND", 42000)], history: [],
		refund: { captureId: "CAP-job_refunded", refundId: "REFUND-job_refunded", refunded: 42000, at: T }, treasury: [] }),
	job("job_disputed", { status: "VERIFIED", escrow: hold("job_disputed", 26789), history: [], review: { phase: "DISPUTED", resolveBy: "2099-01-10T00:00:00.000Z" } }),
	job("job_work_refund_pending", { status: "IN_PROGRESS", escrow: hold("job_work_refund_pending", 12345),
		attempts: { phase: "REFUND_PENDING", history: [], refund: { reason: "ATTEMPTS_EXHAUSTED", selectedAt: T } } }),
	job("job_review_refund_pending", { status: "VERIFIED", escrow: hold("job_review_refund_pending", 23456), history: [],
		review: { phase: "REFUND_PENDING", refund: { reason: "ARBITER_REFUND", selectedAt: T } } }),
	job("job_capture_mismatch", { status: "OPEN", phase: { kind: "FUNDING", checkout: { phase: "REFUND_PENDING",
		escrow: hold("job_capture_mismatch", 42100), refund: { reason: "CAPTURE_MISMATCH", selectedAt: T } } } }),
];

type Figure = "held" | "released" | "refunded" | "fees" | "paid-by-clients";
type ExpectedLine = { jobId: string; kind: string; cents: number; entryId: string };
const expected: Record<Figure, { label: string; totalCents: number; lines: ExpectedLine[] }> = {
	held: { label: "Held escrow", totalCents: 142490, lines: [
		{ jobId: "job_capture_mismatch", kind: "HELD", cents: 42100, entryId: "job_capture_mismatch#0" },
		{ jobId: "job_disputed", kind: "HELD", cents: 26789, entryId: "job_disputed#0" },
		{ jobId: "job_held", kind: "HELD", cents: 37800, entryId: "job_held#0" },
		{ jobId: "job_review_refund_pending", kind: "HELD", cents: 23456, entryId: "job_review_refund_pending#0" },
		{ jobId: "job_work_refund_pending", kind: "HELD", cents: 12345, entryId: "job_work_refund_pending#0" },
	] },
	released: { label: "Released", totalCents: 36000, lines: [{ jobId: "job_paid", kind: "RELEASED", cents: 36000, entryId: "job_paid#1" }] },
	refunded: { label: "Refunded", totalCents: 42000, lines: [{ jobId: "job_refunded", kind: "REFUND", cents: 42000, entryId: "job_refunded#1" }] },
	fees: { label: "Fees collected", totalCents: 6000, lines: [{ jobId: "job_paid", kind: "FEE", cents: 6000, entryId: "job_paid#2" }] },
	"paid-by-clients": { label: "Paid by clients", totalCents: 42000, lines: [{ jobId: "job_paid", kind: "HELD", cents: 42000, entryId: "job_paid#0" }] },
};

type TracedLine = { entryId: string; jobId: string; kind: string; cents: number; at: string; receiptId: string | null; paypal: { status: string } };
type Trace = { figure: string; label: string; totalCents: number; lines: TracedLine[] };
const byEntryId = (a: { entryId: string }, b: { entryId: string }) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0);

function jobsTable(dbPath: string): unknown {
	const store = new SqliteStore(dbPath);
	try { return store.db.prepare("SELECT id, version, json FROM jobs ORDER BY id").all(); } finally { store.close(); }
}

test("a populated book answers each figure with its literal total and lines, and the ask tool answers the same body", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-explain-"));
	const dbPath = join(dir, "test.db");
	const port = 4901;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		const store = new SqliteStore(dbPath);
		try {
			for (const row of populated) store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, NULL)").run(row.id, row.version, JSON.stringify(row));
		} finally { store.close(); }
		const before = jobsTable(dbPath);

		child = await bootServer(port, dbPath, FAKE_PAYPAL);
		const minted = await post(port, "/api/platform/session", { key: PLATFORM_KEY });
		assert.equal(minted.status, 201);
		const { token } = await minted.json() as { token: string };
		const auth = { authorization: `Bearer ${token}` };

		const routeBodies = new Map<string, Trace>();
		for (const figure of Object.keys(expected) as Figure[]) {
			const want = expected[figure];
			const answer = await fetch(`http://127.0.0.1:${port}/api/platform/explain?figure=${figure}`, { headers: auth });
			const raw = await answer.text();
			assert.equal(answer.status, 200, `${figure} is answered`);
			assert.doesNotMatch(raw, /MERCHANT_PRIVATE_SENTINEL|secret-payee@example\.com/, `${figure} names no merchant or payee`);
			const body = JSON.parse(raw) as Trace;
			assert.equal(body.figure, figure);
			assert.equal(body.label, want.label, `${figure} label`);
			assert.equal(body.totalCents, want.totalCents, `${figure} total`);
			const lines = body.lines.map(({ jobId, kind, cents, entryId }) => ({ jobId, kind, cents, entryId })).sort(byEntryId);
			assert.deepEqual(lines, want.lines, `${figure} lines`);
			for (const item of body.lines) {
				assert.deepEqual(Object.keys(item).sort(), ["at", "cents", "entryId", "jobId", "kind", "paypal", "receiptId"], `${figure} ${item.entryId} keys`);
				assert.equal(item.receiptId, item.jobId === "job_paid" ? "rcpt_paid" : null, `${figure} ${item.entryId} receipt`);
				assert.equal(item.paypal.status, "PENDING_AT_PAYPAL", `${figure} ${item.entryId} PayPal status`);
			}
			routeBodies.set(figure, body);
		}

		for (const figure of Object.keys(expected) as Figure[]) {
			const traced = await fetch(`http://127.0.0.1:${port}/api/ask-ledger/tool`, { method: "POST",
				headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ name: "trace_figure", arguments: { figure } }) });
			assert.equal(traced.status, 200, `${figure} is answered by the ask tool`);
			assert.deepEqual(await traced.json(), { result: routeBodies.get(figure) }, `${figure}: the ask tool and the route answer the same body`);
		}
		assert.deepEqual(jobsTable(dbPath), before, "the jobs table is unchanged by the explain route and the ask tool");
	} finally {
		if (child && child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
