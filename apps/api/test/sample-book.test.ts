// The sample book: its literal totals and PayPal references, read in process, and then served by the real server to a
// client, an operator, and a platform-less request. The server stores real rows first, and no sample answer may name
// one. Forged real ids are refused, the platform's gates still refuse these accounts, the two accounts keep separate
// layouts, and no sample read reaches PayPal.

import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteStore } from "../../../packages/core/src/store.ts";
import { SAMPLE_PAYPAL_NOTE, sampleBook, sampleExplain } from "../src/sample-book.ts";

const FIGURES = ["held", "released", "refunded", "fees", "paid-by-clients"] as const;
const root = join(import.meta.dirname, "..");
const SPY = join(import.meta.dirname, "sample-paypal-spy.mjs");

test("the sample book's totals are literal, the four money figures conserve, and every reference is labelled sample", () => {
	const totals = Object.fromEntries(FIGURES.map((figure) => [figure, sampleExplain(figure).totalCents]));
	assert.deepEqual(totals, { held: 32000, released: 20300, refunded: 9000, fees: 2700, "paid-by-clients": 23000 });

	const book = sampleBook();
	const funded = book.jobs.flatMap((job) => job.lines).filter((line) => line.kind === "HELD").reduce((sum, line) => sum + line.cents, 0);
	assert.equal(funded, 64000, "every HELD line is what clients funded");
	assert.equal(totals.held + totals.released + totals.refunded + totals.fees, funded, "held + released + refunded + fees = funded");
	assert.equal(totals.released + totals.fees, totals["paid-by-clients"], "over released jobs, payout + fee = paid by clients");

	const attempts = book.jobs.flatMap((job) => job.attempts);
	assert.equal(attempts.length, 7);
	assert.equal(attempts.filter((attempt) => attempt.result === "VERIFIED").length, 3);
	assert.equal(attempts.filter((attempt) => attempt.result === "REJECTED" && attempt.tamper).length, 1);

	assert.deepEqual(book.reconciliation, { entries: 10, tied: 10, note: SAMPLE_PAYPAL_NOTE });
	assert.equal(book.jobs.length, 6);
	for (const job of book.jobs) {
		assert.match(job.jobId, /^job_sample0[1-6]$/);
		assert.equal(job.tenant, "sample_book");
		assert.match(job.title, /^Sample: /);
	}
	for (const entry of book.tables.ledger_entries) assert.match(entry.captureId ?? "", /^SAMPLE-CAPTURE-0\d$/);
	assert.deepEqual(sampleBook(), sampleBook(), "the same book on every read");
});

test("each sample explain line names its sample reference and says it was not checked against PayPal", () => {
	for (const figure of FIGURES) {
		const trace = sampleExplain(figure);
		for (const line of trace.lines) {
			assert.deepEqual(Object.keys(line).sort(), ["at", "cents", "entryId", "jobId", "kind", "paypal", "receiptId"]);
			assert.equal(line.paypal.status, "NOT_CHECKED");
			assert.equal(line.paypal.note, SAMPLE_PAYPAL_NOTE);
			assert.match(line.paypal.id ?? "", /^SAMPLE-/);
		}
		assert.equal(trace.lines.reduce((sum, line) => sum + line.cents, 0), trace.totalCents, `${figure}: the lines sum to the figure`);
	}
});

// ---- the served book ----------------------------------------------------------------------------------------------

const T = "2099-01-01T00:00:00.000Z";
const PAYEE = { operator: "devon-ops", payee: "REAL_MERCHANT_SENTINEL", price: 36000, bidId: "bid_real", agent: "real-agent", eta: 48 };
const line = (kind: string, cents: number, extra: Record<string, unknown> = {}) => ({ kind, cents, at: T, ...extra });
const realPaid = { id: "job_real_paid", client: "maya-client", tenant: "vis_REAL_SENTINEL", title: "REAL_TITLE_SENTINEL", version: 1, openedAt: T,
	contract: { budget: 42000, deliveryEndsAt: "2099-01-15T00:00:00.000Z", definitionOfDone: null }, bids: [],
	state: { status: "PAID", payee: PAYEE, book: [line("HELD", 42000), line("RELEASED", 36000), line("FEE", 6000, { processor: 1515, acquit: 4485 })],
		history: [], receipt: { id: "rcpt_real", attemptsUsed: 1, paid: 36000, releasedAt: T },
		release: { captureId: "CAP-REAL_SENTINEL", payoutItemId: "PAYOUT_REAL_SENTINEL", paid: 36000, at: T },
		merge: { phase: "MERGED", at: T, sha: null }, treasury: [] } };
const realRefund = { id: "job_real_refund", client: "maya-client", tenant: null, title: "REAL_REFUND_SENTINEL", version: 1, openedAt: T,
	contract: { budget: 42000, deliveryEndsAt: "2099-01-15T00:00:00.000Z", definitionOfDone: null }, bids: [],
	state: { status: "REFUNDED", payee: PAYEE, book: [line("HELD", 42000), line("REFUND", 42000)], history: [],
		refund: { captureId: "CAP-REAL_REFUND", refundId: "REFUND_REAL_SENTINEL", refunded: 42000, at: T }, treasury: [] } };
const REAL_IDS = /REAL_|vis_REAL|job_real|CAP-REAL|PAYOUT_REAL|rcpt_real/;

async function bootServer(port: number, dbPath: string, fetchLog: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["--import", pathToFileURL(SPY).href, "src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1", SAMPLE_FETCH_LOG: fetchLog,
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

test("the sample book is served to a client and an operator, never names a stored row, refuses forged ids, and keeps layouts and PayPal apart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-sample-"));
	const dbPath = join(dir, "test.db");
	const fetchLog = join(dir, "fetch.log");
	const port = 4931;
	const base = `http://127.0.0.1:${port}`;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		const store = new SqliteStore(dbPath);
		try {
			for (const row of [realPaid, realRefund]) store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, NULL)").run(row.id, row.version, JSON.stringify(row));
		} finally { store.close(); }

		child = await bootServer(port, dbPath, fetchLog);
		const logged = async () => (await readFile(fetchLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
		const before = (await logged()).length;

		assert.equal((await fetch(`${base}/api/sample/book`)).status, 401, "an anonymous request is refused");

		const expected = JSON.parse(JSON.stringify(sampleBook())) as unknown;
		const clientToken = (await (await post(port, "/api/session", { handle: "maya-client" })).json() as { token: string }).token;
		const clientAuth = { authorization: `Bearer ${clientToken}` };
		const operatorToken = (await (await post(port, "/api/session", { handle: "devon-ops" })).json() as { token: string }).token;
		const operatorAuth = { authorization: `Bearer ${operatorToken}` };

		const bodies: string[] = [];
		for (const auth of [clientAuth, operatorAuth]) {
			const answer = await fetch(`${base}/api/sample/book`, { headers: auth });
			assert.equal(answer.status, 200, "a signed-in account reads the sample book");
			const raw = await answer.text();
			bodies.push(raw);
			assert.deepEqual(JSON.parse(raw), expected, "the sample book answer is the same book for every account");
		}
		for (const figure of FIGURES) {
			const answer = await fetch(`${base}/api/sample/explain?figure=${figure}`, { headers: clientAuth });
			assert.equal(answer.status, 200, `${figure} is answered`);
			bodies.push(await answer.text());
		}
		for (const raw of bodies) assert.doesNotMatch(raw, REAL_IDS, "no stored row, tenant, or PayPal id is named by a sample answer");

		// Forged real ids: every sample endpoint takes no id, so a real job, refund, or capture id is refused before any read.
		for (const path of [
			"/api/sample/book?job=job_real_paid",
			"/api/sample/explain?figure=held&job=job_real_paid",
			"/api/sample/explain?figure=held&refund=REFUND_REAL_SENTINEL",
			"/api/sample/explain?figure=held&capture=CAP-REAL_SENTINEL",
		]) {
			const answer = await fetch(`${base}${path}`, { headers: clientAuth });
			assert.equal(answer.status, 400, `${path} is refused`);
		}
		const unknown = await fetch(`${base}/api/sample/explain?figure=pass-rate`, { headers: clientAuth });
		assert.equal(unknown.status, 400);
		assert.deepEqual(await unknown.json(), { error: "UNKNOWN_FIGURE", figures: ["held", "released", "refunded", "fees", "paid-by-clients"] });

		// The sample view never opens the platform's endpoints, nor the ask tools, for a client account.
		for (const path of ["/api/platform/ledger", "/api/platform/tables", "/api/platform/reconciliation", "/api/platform/explain?figure=held",
			"/api/platform/stream", "/api/ask-ledger/tools"]) {
			const answer = await fetch(`${base}${path}`, { headers: clientAuth });
			assert.equal(answer.status, 403, `${path} is refused for a client`);
		}
		const askTool = await fetch(`${base}/api/ask-ledger/tool`, { method: "POST", headers: { "content-type": "application/json", ...clientAuth },
			body: JSON.stringify({ name: "trace_figure", arguments: { figure: "held" } }) });
		assert.equal(askTool.status, 403, "the ask tool is refused for a client");

		// Layouts are per account: each handle reads and writes its own sample layout, and neither sees the other's.
		const putLayout = (auth: Record<string, string>, state: string) => fetch(`${base}/api/studio/layout`, { method: "PUT",
			headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ dashboard: "sample", state }) });
		const getLayout = async (auth: Record<string, string>) => (await (await fetch(`${base}/api/studio/layout?dashboard=sample`, { headers: auth })).json() as { state: string | null }).state;
		assert.equal((await putLayout(clientAuth, '{"account":"client"}')).status, 200);
		assert.equal(await getLayout(operatorAuth), null, "the operator's sample layout is not the client's");
		assert.equal((await putLayout(operatorAuth, '{"account":"operator"}')).status, 200);
		assert.equal(await getLayout(clientAuth), '{"account":"client"}', "the client's layout is unchanged by the operator");
		assert.equal(await getLayout(operatorAuth), '{"account":"operator"}');

		// No sample read reaches PayPal: the spy logs every outbound fetch, and none of the new ones names PayPal.
		const sampleCalls = (await logged()).slice(before);
		assert.deepEqual(sampleCalls.filter((url) => /paypal/i.test(url)), [], "the sample reads make no PayPal call");
	} finally {
		if (child && child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
