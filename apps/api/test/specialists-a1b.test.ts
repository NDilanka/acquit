// The A1b routes over real HTTP, in the default configuration (the exam gate off): the floor's seeded and gate
// fields (row 8), the standing orders read and write (rows 9 and 10), the morning report (row 11), and the money-held
// read (row 12). The server is booted once; each test reads the rows the earlier ones left.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { creditWeek, reduceCredits } from "../../../packages/core/src/credits.ts";
import { instant } from "../../../packages/core/src/ids.ts";

const root = join(import.meta.dirname, "..");
const port = 4943;

function bootServer(dbPath: string, home: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_SCOPING_DIR: home, ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673", HOME: home, FACTORY_API_KEY: "",
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

const post = (path: string, payload: unknown, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
const put = (path: string, payload: unknown, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "PUT", headers: { "content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
const get = (path: string, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const session = async (handle: string): Promise<string> => {
	const signed = await post("/api/session", { handle });
	assert.equal(signed.status, 200);
	return (await signed.json() as { token: string }).token;
};

/** The operator row and credits a bid needs, written the way the core tests seed them. */
function seedOperator(dbPath: string) {
	const db = new DatabaseSync(dbPath);
	const now = instant(new Date().toISOString());
	db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run("devon-ops", 0, JSON.stringify({
		id: "devon-ops", handle: "devon-ops", kind: "INDEPENDENT", version: 0,
		payouts: { kind: "READY", merchant: "sandbox-seller", connectedAt: now } }), 0);
	const granted = reduceCredits({ operator: "devon-ops", version: 0, balance: { allowance: 0, purchased: 0 }, lines: [] } as never,
		{ kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
	assert.notEqual(typeof granted, "string");
	const account = granted as { version: number };
	db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run("devon-ops", account.version, JSON.stringify(granted));
	db.close();
}

function insertAgent(dbPath: string, agent: Record<string, unknown>) {
	const db = new DatabaseSync(dbPath);
	db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(String(agent.id), String(agent.owner), JSON.stringify(agent));
	db.close();
}

const openJob = async (token: string): Promise<string> => {
	const opened = await post("/api/commands", { key: crypto.randomUUID(),
		command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
			budget: 40000, deliveryEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }, token);
	const answer = await opened.json() as { outcome?: { result?: { kind: string; job?: { id: string } } } };
	assert.equal(opened.status, 200, `the open committed: ${JSON.stringify(answer)}`);
	return answer.outcome!.result!.job!.id;
};

const placeBid = (jobId: string, agent: string, token: string) =>
	post("/api/commands", { key: crypto.randomUUID(),
		command: { type: "PlaceBid", jobId, price: 40000, eta: 48, agent, pitch: "test" } }, token);

const digest = "d".repeat(64);
const ORDERS = { priceFloorCents: 500, maxConcurrent: 2, autopilot: true, runsOn: "owner", preApprove: true };

let server: ReturnType<typeof spawn>;
let dir: string;
let dbPath: string;
let maya: string;
let devon: string;
let jobId: string;
const SEED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "acquit-specialists-a1b-"));
	dbPath = join(dir, "acquit.db");
	server = await bootServer(dbPath, dir);
	seedOperator(dbPath);
	insertAgent(dbPath, { id: "seeded-fixer", owner: "devon-ops", name: "seeded-fixer", runner: "claude-code",
		promptDigest: digest, tools: [], task: "code", acquittal: { examId: "seed", at: SEED_AT }, sample: null });
	insertAgent(dbPath, { id: "exam-fixer", owner: "devon-ops", name: "exam-fixer", runner: "claude-code",
		promptDigest: digest, tools: [], task: "code", acquittal: { examId: "exam_0b8f0c52-7d1e-4a51-9d2a-3c1f2e6a9b11", at: SEED_AT }, sample: null });
	insertAgent(dbPath, { id: "plain-fixer", owner: "devon-ops", name: "plain-fixer", runner: "claude-code",
		promptDigest: digest, tools: [], task: "code", acquittal: null, sample: null });
	insertAgent(dbPath, { id: "code-fixer-devon-ops", owner: "devon-ops", name: "code-fixer-devon-ops", runner: "claude-code",
		promptDigest: digest, tools: [], task: "code", acquittal: null, sample: "code-fixer" });
	maya = await session("maya-client");
	devon = await session("devon-ops");
});

after(async () => {
	server.kill();
	try { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may hold the WAL briefly. */ }
});

test("the floor labels the seed acquittal, reports each gate, and leaves out agents never acquitted", async () => {
	const answer = await get("/api/floor", maya);
	assert.equal(answer.status, 200);
	const { specialists } = await answer.json() as { specialists: Array<Record<string, unknown>> };
	const byId = new Map(specialists.map(entry => [String(entry.agentId), entry]));
	assert.equal(byId.get("seeded-fixer")?.seeded, true);
	assert.equal(byId.get("seeded-fixer")?.gate, "OPEN");
	assert.equal(byId.get("exam-fixer")?.seeded, false);
	assert.equal(byId.get("exam-fixer")?.gate, "OPEN");
	assert.equal(byId.has("plain-fixer"), false);
	assert.equal(byId.has("code-fixer-devon-ops"), false);
});

test("standing orders: the owner reads null, refused writes change nothing, and a valid write replaces the row", async () => {
	const base = "/api/me/agents/exam-fixer/standing-orders";
	const unset = await get(base, devon);
	assert.equal(unset.status, 200);
	assert.deepEqual(await unset.json(), { standingOrders: null });

	const notOwner = await get(base, maya);
	assert.equal(notOwner.status, 404);
	assert.equal((await notOwner.json() as { error: string }).error, "NOT_FOUND");
	const missing = await get("/api/me/agents/no-such-agent/standing-orders", devon);
	assert.equal(missing.status, 404);

	const clientWrite = await put(base, ORDERS, maya);
	assert.equal(clientWrite.status, 403);
	assert.equal((await clientWrite.json() as { error: string }).error, "NOT_OWNER");
	const absentWrite = await put("/api/me/agents/no-such-agent/standing-orders", ORDERS, devon);
	assert.equal(absentWrite.status, 404);

	const badBody = await put(base, { ...ORDERS, maxConcurrent: 4 }, devon);
	assert.equal(badBody.status, 400);
	assert.equal((await badBody.json() as { error: string }).error, "BAD_REQUEST");
	const extra = await put(base, { ...ORDERS, pricing: "x" }, devon);
	assert.equal(extra.status, 400);
	assert.equal((await (await get(base, devon)).json() as { standingOrders: unknown }).standingOrders, null);

	// Autopilot needs an acquittal, and an owner's own agent cannot run on Acquit.
	const plainAutopilot = await put("/api/me/agents/plain-fixer/standing-orders", ORDERS, devon);
	assert.equal(plainAutopilot.status, 409);
	assert.equal((await plainAutopilot.json() as { error: string }).error, "NOT_ACQUITTED");
	const plainAcquit = await put("/api/me/agents/plain-fixer/standing-orders", { ...ORDERS, autopilot: false, runsOn: "acquit" }, devon);
	assert.equal(plainAcquit.status, 409);
	assert.equal((await plainAcquit.json() as { error: string }).error, "RUNS_ON_NOT_ALLOWED");

	const written = await put(base, ORDERS, devon);
	assert.equal(written.status, 200);
	const { standingOrders: first } = await written.json() as { standingOrders: Record<string, unknown> };
	assert.deepEqual({ ...first, updatedAt: undefined }, { priceFloorCents: 500, maxConcurrent: 2, autopilot: true,
		runsOn: "owner", preApprove: true, preApproveCap: 3, updatedAt: undefined });
	assert.equal(typeof first.updatedAt, "string");
	assert.deepEqual(await (await get(base, devon)).json(), { standingOrders: first });

	const replaced = await put(base, { priceFloorCents: 900, maxConcurrent: 1, autopilot: false, runsOn: "owner",
		preApprove: false, preApproveCap: 1 }, devon);
	assert.equal(replaced.status, 200);
	const { standingOrders: second } = await replaced.json() as { standingOrders: Record<string, unknown> };
	assert.equal(second.priceFloorCents, 900);
	assert.equal(second.preApproveCap, 1);
	assert.equal(second.autopilot, false);

	const listed = await (await get("/api/me/agents", devon)).json() as { agents: Array<Record<string, unknown>> };
	assert.deepEqual(listed.agents.find(entry => entry.id === "exam-fixer")?.standingOrders, second);
});

test("a plugged sample may run on Acquit, and the write names the rows it stores", async () => {
	const written = await put("/api/me/agents/code-fixer-devon-ops/standing-orders",
		{ ...ORDERS, autopilot: false, runsOn: "acquit" }, devon);
	assert.equal(written.status, 200);
	const { standingOrders } = await written.json() as { standingOrders: Record<string, unknown> };
	assert.equal(standingOrders.runsOn, "acquit");
	assert.equal(standingOrders.preApproveCap, 3);
});

test("the morning report counts a bid by its own time, and refuses a missing or malformed since", async () => {
	jobId = await openJob(maya);
	const bid = await placeBid(jobId, "exam-fixer", devon);
	assert.equal(bid.status, 200);

	const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const report = await get(`/api/me/morning-report?since=${encodeURIComponent(since)}`, devon);
	assert.equal(report.status, 200);
	const body = await report.json() as Record<string, unknown>;
	assert.equal(body.since, since);
	assert.equal(body.sandbox, true);
	const bids = body.bids as Array<Record<string, unknown>>;
	const mine = bids.find(entry => entry.jobId === jobId);
	assert(mine, "the bid placed after since is listed");
	assert.equal(mine.agentId, "exam-fixer");
	assert.equal(mine.amountCents, 40000);
	assert.equal(typeof mine.at, "string");
	for (const key of ["wins", "verified", "rejected", "payouts", "gradeChanges", "preApprovals"]) assert(Array.isArray(body[key]), key);

	const later = await get("/api/me/morning-report?since=2999-01-01T00:00:00.000Z", devon);
	assert.deepEqual((await later.json() as { bids: unknown[] }).bids, []);

	const malformed = await get("/api/me/morning-report?since=yesterday", devon);
	assert.equal(malformed.status, 400);
	assert.equal((await malformed.json() as { error: string }).error, "BAD_REQUEST");
	const absent = await get("/api/me/morning-report", devon);
	assert.equal(absent.status, 400);
	const asClient = await get(`/api/me/morning-report?since=${encodeURIComponent(since)}`, maya);
	assert.equal(asClient.status, 403);
});

test("money held: a bidding operator reads the escrow state of an open job, and anyone else gets 404", async () => {
	const held = await get(`/api/me/jobs/${jobId}/money-held`, devon);
	assert.equal(held.status, 200);
	const answer = await held.json() as Record<string, unknown>;
	assert.equal(answer.held, false);
	assert.equal(answer.source, "ESCROW_STATE");
	assert.equal(answer.captureId, null);
	assert.equal(answer.captureStatus, null);
	assert.equal(typeof answer.checkedAt, "string");

	const clientRead = await get(`/api/me/jobs/${jobId}/money-held`, maya);
	assert.equal(clientRead.status, 404);
	assert.equal((await clientRead.json() as { error: string }).error, "NOT_FOUND");
	const unknown = await get("/api/me/jobs/not-a-real-job/money-held", devon);
	assert.equal(unknown.status, 404);
});
