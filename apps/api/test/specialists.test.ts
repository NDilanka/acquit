// The specialist routes over real HTTP: the sample catalog, the two agent-create forms, the agent
// list and view, the floor, and the job view's fixtureMatched. One server runs with the exam gate
// off (the default) and one with ACQUIT_EXAM_GATE=1, so the same PlaceBid is seen both landing and
// refused by name through the commands route's 409.

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
const portOff = 4941;
const portOn = 4942;

function bootServer(port: number, dbPath: string, home: string, extraEnv: Record<string, string> = {}): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_SCOPING_DIR: home, ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673", HOME: home, FACTORY_API_KEY: "", ...extraEnv,
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

const post = (port: number, path: string, payload: unknown, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
const get = (port: number, path: string, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const session = async (port: number, handle: string): Promise<string> => {
	const signed = await post(port, "/api/session", { handle });
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

const openJob = async (port: number, token: string): Promise<string> => {
	const opened = await post(port, "/api/commands", { key: crypto.randomUUID(),
		command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
			budget: 40000, deliveryEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }, token);
	const answer = await opened.json() as { outcome?: { result?: { kind: string; job?: { id: string } } } };
	assert.equal(opened.status, 200, `the open committed: ${JSON.stringify(answer)}`);
	return answer.outcome!.result!.job!.id;
};

const placeBid = (port: number, token: string, jobId: string, agent: string) =>
	post(port, "/api/commands", { key: crypto.randomUUID(),
		command: { type: "PlaceBid", jobId, price: 40000, eta: 48, agent, pitch: "test" } }, token);

const digest = "d".repeat(64);
const agentBody = (name: string, extra: Record<string, unknown> = {}) =>
	({ name, runner: "claude-code", promptDigest: digest, tools: ["read"], ...extra });

let serverA: ReturnType<typeof spawn>;
let dirA: string;
let dbA: string;
let maya: string;
let devon: string;

before(async () => {
	dirA = await mkdtemp(join(tmpdir(), "acquit-specialists-a-"));
	dbA = join(dirA, "acquit.db");
	serverA = await bootServer(portOff, dbA, dirA);
	seedOperator(dbA);
	maya = await session(portOff, "maya-client");
	devon = await session(portOff, "devon-ops");
});

after(async () => {
	serverA.kill();
	try { await rm(dirA, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may hold the WAL briefly. */ }
});

test("the catalog names each sample's runner and reports no plugged agent yet", async () => {
	const anonymous = await get(portOff, "/api/specialists/samples");
	assert.equal(anonymous.status, 401);
	const answer = await get(portOff, "/api/specialists/samples", devon);
	assert.equal(answer.status, 200);
	const { samples } = await answer.json() as { samples: Array<Record<string, unknown>> };
	assert.equal(samples.length, 3);
	const byId = new Map(samples.map(sample => [String(sample.id), sample]));
	assert.equal(byId.get("code-fixer")?.runner, "claude-code");
	assert.equal(byId.get("code-fixer")?.task, "code");
	assert.equal(byId.get("print-fdm")?.runner, "simulated-fdm");
	assert.equal(byId.get("laser-cut")?.runner, "simulated-laser");
	for (const sample of samples) {
		assert.equal(sample.runsOn, "acquit");
		assert.equal(sample.plugged, null);
	}
});

test("plugging a sample registers the agent, and the catalog then names it", async () => {
	const plugged = await post(portOff, "/api/me/agents", { sample: "code-fixer" }, devon);
	assert.equal(plugged.status, 201);
	const { agent } = await plugged.json() as { agent: Record<string, unknown> };
	assert.equal(agent.id, "code-fixer-devon-ops");
	assert.equal(agent.name, "code-fixer-devon-ops");
	assert.equal(agent.runner, "claude-code");
	assert.equal(agent.task, "code");
	assert.equal(agent.acquittal, null);
	assert.equal(agent.sample, "code-fixer");
	assert.deepEqual(agent.tools, []);

	const again = await post(portOff, "/api/me/agents", { sample: "code-fixer" }, devon);
	assert.equal(again.status, 409);
	assert.equal((await again.json() as { error: string }).error, "AGENT_EXISTS");
	const laser = await post(portOff, "/api/me/agents", { sample: "laser-cut" }, devon);
	assert.equal(laser.status, 409);
	assert.equal((await laser.json() as { error: string }).error, "TASK_NOT_EXAMINABLE");
	const unknown = await post(portOff, "/api/me/agents", { sample: "nope" }, devon);
	assert.equal(unknown.status, 400);
	const mixed = await post(portOff, "/api/me/agents", { sample: "print-fdm", name: "x" }, devon);
	assert.equal(mixed.status, 400);

	const catalog = await (await get(portOff, "/api/specialists/samples", devon)).json() as { samples: Array<Record<string, unknown>> };
	assert.equal(catalog.samples.find(sample => sample.id === "code-fixer")?.plugged, "code-fixer-devon-ops");

	const listed = await (await get(portOff, "/api/me/agents", devon)).json() as { agents: Array<Record<string, unknown>> };
	const mine = listed.agents.find(entry => entry.id === "code-fixer-devon-ops");
	assert(mine, "the plugged agent is listed");
	assert.equal(mine.gate, "NOT_ACQUITTED");
	assert.equal(mine.grade, null);
	assert.equal(mine.standingOrders, null);

	const viewed = await get(portOff, "/api/agents/code-fixer-devon-ops", maya);
	assert.equal(viewed.status, 200);
	const { agent: view } = await viewed.json() as { agent: Record<string, unknown> };
	assert.equal((view.owner as { handle: string }).handle, "devon-ops");
	assert.equal(view.acquittedAt, null);
	assert.equal(view.gate, "NOT_ACQUITTED");
	assert.deepEqual(view.record, { jobsTaken: 0, verified: 0, rejected: 0, earnedCents: 0 });
	assert(!("promptDigest" in view), "the view never carries the prompt digest");

	const missing = await get(portOff, "/api/agents/no-such-agent", maya);
	assert.equal(missing.status, 404);
	const asClient = await get(portOff, "/api/me/agents", maya);
	assert.equal(asClient.status, 403);
	assert.equal((await asClient.json() as { error: string }).error, "NOT_OWNER");
});

test("the owner form defaults the task to code and accepts a named task", async () => {
	const fixer = await post(portOff, "/api/me/agents", agentBody("fixer"), devon);
	assert.equal(fixer.status, 201);
	const fixerAgent = (await fixer.json() as { agent: Record<string, unknown> }).agent;
	assert.equal(fixerAgent.task, "code");
	assert.equal(fixerAgent.acquittal, null);
	assert.equal(fixerAgent.sample, null);

	const printer = await post(portOff, "/api/me/agents", agentBody("printer", { runner: "codex", task: "print-fdm" }), devon);
	assert.equal(printer.status, 201);
	assert.equal((await printer.json() as { agent: Record<string, unknown> }).agent.task, "print-fdm");

	const badTask = await post(portOff, "/api/me/agents", agentBody("bogus", { task: "cnc" }), devon);
	assert.equal(badTask.status, 400);

	const operator = await get(portOff, "/api/me/operator", devon);
	assert.equal(operator.status, 200);
	const { agents } = await operator.json() as { agents: Array<Record<string, unknown>> };
	const printerEntry = agents.find(entry => entry.id === "printer");
	assert(printerEntry, "the operator view carries the new agent");
	assert.equal(printerEntry.task, "print-fdm");
	assert.equal(printerEntry.gate, "WRONG_TASK");
	assert.equal(printerEntry.acquittal, null);
});

test("the floor lists only acquitted agents and labels the seeded ones", async () => {
	const empty = await (await get(portOff, "/api/floor", devon)).json() as { specialists: unknown[] };
	assert.equal(empty.specialists.length, 0);
	const at = "2026-11-10T00:00:00.000Z";
	insertAgent(dbA, { id: "ace", owner: "devon-ops", name: "ace", runner: "claude-code", promptDigest: digest, tools: [],
		task: "code", acquittal: { examId: "exam_1", at }, sample: null });
	insertAgent(dbA, { id: "seeder", owner: "devon-ops", name: "seeder", runner: "claude-code", promptDigest: digest, tools: [],
		task: "code", acquittal: { examId: "seed", at }, sample: null });
	const { specialists } = await (await get(portOff, "/api/floor", maya)).json() as { specialists: Array<Record<string, unknown>> };
	assert.equal(specialists.length, 2);
	const ace = specialists.find(entry => entry.agentId === "ace");
	const seeder = specialists.find(entry => entry.agentId === "seeder");
	assert(ace && seeder, "both acquitted agents are on the floor");
	assert.equal(ace.grade, 50);
	assert.equal(ace.seeded, false);
	assert.equal(ace.earnedCents, 0);
	assert.equal(seeder.seeded, true);
	assert(!specialists.some(entry => entry.agentId === "fixer"), "an unacquitted agent never appears");
});

test("the job view reports fixtureMatched against the deployment registry", async () => {
	const jobId = await openJob(portOff, maya);
	const matched = await get(portOff, `/api/jobs/${jobId}`, maya);
	assert.equal(matched.status, 200);
	assert.equal((await matched.json() as { fixtureMatched: unknown }).fixtureMatched, true);

	const db = new DatabaseSync(dbA);
	const row = db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId);
	assert(row);
	const copy = JSON.parse(String(row.json)) as { id: string; contract: { definitionOfDone: { issue: { repository: string; number: number } } } };
	const bogusId = `${jobId.slice(0, -1)}${jobId.endsWith("0") ? "1" : "0"}`;
	copy.id = bogusId;
	copy.contract.definitionOfDone.issue.repository = "no-one/no-such-repo";
	copy.contract.definitionOfDone.issue.number = 999;
	db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(bogusId, JSON.stringify(copy));
	db.close();
	const unmatched = await get(portOff, `/api/jobs/${bogusId}`, maya);
	assert.equal(unmatched.status, 200);
	assert.equal((await unmatched.json() as { fixtureMatched: unknown }).fixtureMatched, false);
});

test("with the gate off, an unacquitted agent's bid still lands", async () => {
	const jobId = await openJob(portOff, maya);
	const bid = await placeBid(portOff, devon, jobId, "fixer");
	const answer = await bid.json() as { outcome: { kind: string; result?: { kind: string } } };
	assert.equal(bid.status, 200, `the bid committed: ${JSON.stringify(answer)}`);
	assert.equal(answer.outcome.result?.kind, "BID");
});

test("with ACQUIT_EXAM_GATE=1 the same bids answer 409 by name, and an acquitted agent bids", async () => {
	const dirB = await mkdtemp(join(tmpdir(), "acquit-specialists-b-"));
	const dbB = join(dirB, "acquit.db");
	const serverB = await bootServer(portOn, dbB, dirB, { ACQUIT_EXAM_GATE: "1" });
	try {
		seedOperator(dbB);
		const mayaB = await session(portOn, "maya-client");
		const devonB = await session(portOn, "devon-ops");
		const jobId = await openJob(portOn, mayaB);

		const created = await post(portOn, "/api/me/agents", agentBody("fixer"), devonB);
		assert.equal(created.status, 201);
		const unacquitted = await placeBid(portOn, devonB, jobId, "fixer");
		assert.equal(unacquitted.status, 409);
		const refused = await unacquitted.json() as { outcome: { kind: string; reason: string } };
		assert.equal(refused.outcome.kind, "DENIED");
		assert.equal(refused.outcome.reason, "NOT_ACQUITTED");

		const printerCreated = await post(portOn, "/api/me/agents", agentBody("printer", { task: "print-fdm" }), devonB);
		assert.equal(printerCreated.status, 201);
		const wrongTask = await placeBid(portOn, devonB, jobId, "printer");
		assert.equal(wrongTask.status, 409);
		assert.equal((await wrongTask.json() as { outcome: { reason: string } }).outcome.reason, "WRONG_TASK");

		insertAgent(dbB, { id: "ace", owner: "devon-ops", name: "ace", runner: "claude-code", promptDigest: digest, tools: [],
			task: "code", acquittal: { examId: "exam_1", at: "2026-11-10T00:00:00.000Z" }, sample: null });
		const acquitted = await placeBid(portOn, devonB, jobId, "ace");
		const answer = await acquitted.json() as { outcome: { result?: { kind: string } } };
		assert.equal(acquitted.status, 200, `the acquitted bid committed: ${JSON.stringify(answer)}`);
		assert.equal(answer.outcome.result?.kind, "BID");
	} finally {
		serverB.kill();
		try { await rm(dirB, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may hold the WAL briefly. */ }
	}
});
