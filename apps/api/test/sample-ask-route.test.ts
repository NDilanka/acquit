// The sample book's Ask the ledger over real HTTP. Any signed-in role reads the four sample tools and no PayPal or platform
// tool. A forged real id is not found while real rows sit in the store, and no sample request reaches PayPal. A turn is
// admitted by its account and its address before the budget reserves, so a turn past the address's cap is refused with no
// budget record, and a turn with no model key stops at the model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteStore } from "../../../packages/core/src/store.ts";
import { SAMPLE_LABEL } from "../src/sample-ask.ts";

const root = join(import.meta.dirname, "..");
const SPY = join(import.meta.dirname, "sample-paypal-spy.mjs");
const PLATFORM_KEY = "test-platform-key-0123456789abcdef";
const REAL_IDS = /REAL_|vis_REAL|job_real|CAP-REAL|PAYOUT_REAL|rcpt_real/;
const FORGED_INPUTS = /job_real_paid|job_real_refund|REFUND_REAL_SENTINEL|CAP-REAL_SENTINEL|SAMPLE-ORDER-02/g;
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

async function bootServer(port: number, dbPath: string, home: string, fetchLog: string): Promise<ChildProcess> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["--import", pathToFileURL(SPY).href, "src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1", ACQUIT_PLATFORM_KEY: PLATFORM_KEY,
				SAMPLE_FETCH_LOG: fetchLog, PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5674", HOME: home, FACTORY_API_KEY: "",
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

async function stopServer(child: ChildProcess | null): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	await exited;
}

const post = (port: number, path: string, payload: unknown, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
const get = (port: number, path: string, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

/** A fresh database with real rows in it, so a forged id that the sample executor read from the store would be found. */
async function seededStore(dbPath: string): Promise<void> {
	const store = new SqliteStore(dbPath);
	try {
		for (const row of [realPaid, realRefund]) store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, NULL)").run(row.id, row.version, JSON.stringify(row));
	} finally { store.close(); }
}

test("the sample Ask answers every signed-in role with its four sample tools, refuses forged real ids, and makes no PayPal call", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-sample-ask-route-"));
	const port = 4934;
	const fetchLog = join(dir, "fetch.log");
	let child: ChildProcess | null = null;
	try {
		await seededStore(join(dir, "test.db"));
		child = await bootServer(port, join(dir, "test.db"), join(dir, "homeless"), fetchLog);
		const logged = async () => (await readFile(fetchLog, "utf8").catch(() => "")).split("\n").filter(Boolean);

		for (const path of ["/api/sample/ask/tools", "/api/sample/ask/turn", "/api/sample/ask/tool"]) {
			const anonymous = path.endsWith("tools") ? await get(port, path) : await post(port, path, {});
			assert.equal(anonymous.status, 401, `${path} is refused for an anonymous caller`);
		}

		const sessionOf = async (handle: string) => (await (await post(port, "/api/session", { handle })).json() as { token: string }).token;
		const client = await sessionOf("maya-client");
		const operator = await sessionOf("devon-ops");
		const platform = await (await post(port, "/api/platform/session", { key: PLATFORM_KEY })).json() as { token: string };
		// Positive control: the platform's own PayPal read reaches the spy in the server process and leaves its URL in the log,
		// so an empty log for the sample requests below means no PayPal call was made, not that the spy was not counting.
		await post(port, "/api/ask-ledger/tool", { name: "get_order", arguments: { id: "SAMPLE-ORDER-02" } }, platform.token);
		assert.ok((await logged()).some(url => /paypal/i.test(url)), "positive control: the spy logged the platform's PayPal read");
		const before = (await logged()).length;
		const bodies: string[] = [];

		for (const token of [client, operator, platform.token]) {
			const tools = await get(port, "/api/sample/ask/tools", token);
			assert.equal(tools.status, 200, "a signed-in role lists the sample tools");
			const listed = await tools.json() as { tools: { name: string }[]; keyConfigured: boolean };
			assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["explain_sample_figure", "get_sample_job", "list_sample_jobs", "sample_totals"],
				"the sample Ask lists its four reads, and no PayPal or platform tool");
			assert.equal(listed.keyConfigured, false, "a boot with no Factory key says so, without naming one");
		}

		const call = async (name: string, args: Record<string, unknown>, token = client) => {
			const answer = await post(port, "/api/sample/ask/tool", { name, arguments: args }, token);
			const raw = await answer.text();
			bodies.push(raw);
			return { status: answer.status, body: JSON.parse(raw) as Record<string, unknown> };
		};

		const totals = await call("sample_totals", {});
		assert.equal(totals.status, 200);
		assert.deepEqual(totals.body, { result: { sample: SAMPLE_LABEL, held: 32000, released: 20300, refunded: 9000, fees: 2700, heldJobs: 2 } });
		const listed = await call("list_sample_jobs", {});
		assert.equal(((listed.body["result"] as { jobs: unknown[] }).jobs).length, 6, "six sample jobs");
		const one = await call("get_sample_job", { jobId: "job_sample04" }, operator);
		assert.equal(((one.body["result"] as { job: { jobId: string } }).job).jobId, "job_sample04", "the operator reads a sample job");
		const figure = await call("explain_sample_figure", { figure: "held" }, platform.token);
		assert.equal(((figure.body["result"] as { totalCents: number }).totalCents), 32000, "the platform account reads the sample figure");

		// Forged real ids: the rows above are in the store, and none is a sample job, order, refund, or capture. A real id
		// gets the same answer as an id that is in no store at all, so a reply never shows whether a row exists.
		const unknown = await call("get_sample_job", { jobId: "job_nowhere" });
		const unknownDetail = String(unknown.body["detail"]).replace("job_nowhere", "<id>");
		for (const jobId of ["job_real_paid", "job_real_refund", "SAMPLE-ORDER-02", "CAP-REAL_SENTINEL"]) {
			const forged = await call("get_sample_job", { jobId });
			assert.equal(forged.status, 502, `${jobId} is refused`);
			assert.equal(forged.body["error"], "TOOL_FAILED");
			assert.equal(String(forged.body["detail"]).replace(jobId, "<id>"), unknownDetail, `${jobId} reads as an unknown id`);
		}
		const forgedFigure = await call("explain_sample_figure", { figure: "REFUND_REAL_SENTINEL" });
		assert.equal(forgedFigure.status, 502, "a forged figure is refused");

		// The platform's and PayPal's names are not the sample set, so each is refused before any read.
		for (const name of ["list_jobs", "get_order", "platform_totals", "list_transactions"]) {
			const refused = await call(name, {});
			assert.equal(refused.status, 502);
			assert.match(String(refused.body["detail"]), /no tool named/, `${name} is not a sample tool`);
		}

		// A refusal echoes the id the caller sent; that echo is the caller's own input, so it is set aside before the check.
		for (const raw of bodies) assert.doesNotMatch(raw.replace(FORGED_INPUTS, ""), REAL_IDS, "no stored row, tenant, or PayPal id is named by a sample answer");
		const sampleCalls = (await logged()).slice(before);
		assert.deepEqual(sampleCalls.filter(url => /paypal/i.test(url)), [], "the sample Ask makes no PayPal call");
	} finally {
		await stopServer(child);
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});

test("a sample turn is admitted per account and per address, a turn past the address's cap is refused with no budget record, and a turn with no key stops at the model", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-sample-ask-turns-"));
	const port = 4935;
	const fetchLog = join(dir, "fetch.log");
	const budgetLog = join(dir, "model-calls.jsonl");
	let child: ChildProcess | null = null;
	try {
		await seededStore(join(dir, "test.db"));
		child = await bootServer(port, join(dir, "test.db"), join(dir, "homeless"), fetchLog);
		const logged = async () => (await readFile(fetchLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
		const sessionOf = async (handle: string) => (await (await post(port, "/api/session", { handle })).json() as { token: string }).token;
		const client = await sessionOf("maya-client");
		const operator = await sessionOf("devon-ops");
		const platform = await (await post(port, "/api/platform/session", { key: PLATFORM_KEY })).json() as { token: string };
		// Positive control, as in the read test: the spy counts a PayPal read made by this server.
		await post(port, "/api/ask-ledger/tool", { name: "get_order", arguments: { id: "SAMPLE-ORDER-02" } }, platform.token);
		assert.ok((await logged()).some(url => /paypal/i.test(url)), "positive control: the spy logged the platform's PayPal read");
		const before = (await logged()).length;
		const messages = [{ id: "m1", role: "user", content: "How much is held for the sample?" }];

		// The relayed tools are for the prompt only, so a delegation's schema is accepted and the turn still stops at the missing key.
		const relayed = await post(port, "/api/sample/ask/turn", { messages, tools: [{ name: "get_order", description: "x", parameters: { type: "object", properties: {} } }] }, client);
		assert.equal(relayed.status, 503, "a relayed tool is accepted for the prompt");
		assert.equal(((await relayed.json()) as { error: string }).error, "MODEL_KEY_MISSING");

		// Five more admitted turns: the client makes two and the operator three, all from one address, so the address is now full.
		for (const token of [client, client, operator, operator, operator]) {
			const admitted = await post(port, "/api/sample/ask/turn", { messages }, token);
			assert.equal(admitted.status, 503, "an admitted turn reaches the model, which has no key");
			assert.equal(((await admitted.json()) as { error: string }).error, "MODEL_KEY_MISSING");
		}

		// The seventh turn is refused by the address, whichever account sends it, and it reserves no budget record.
		const refused = await post(port, "/api/sample/ask/turn", { messages }, client);
		assert.equal(refused.status, 429);
		assert.equal(((await refused.json()) as { error: string }).error, "MODEL_BUDGET");

		const records = (await readFile(budgetLog, "utf8")).split("\n").filter(Boolean).map(text => JSON.parse(text) as { caller: string; phase: string });
		assert.equal(records.filter(record => record.caller === "sample-ask").length, 12, "six admitted turns, each a START and an END");
		assert.equal(records.filter(record => record.caller === "ask-ledger").length, 0, "the sample's turns are budgeted under their own caller");

		const sampleCalls = (await logged()).slice(before);
		assert.deepEqual(sampleCalls.filter(url => /paypal/i.test(url)), [], "the sample turns make no PayPal call");
	} finally {
		await stopServer(child);
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
