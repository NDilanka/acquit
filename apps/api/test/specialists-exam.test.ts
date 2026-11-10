// The labelled simulated code exam over real HTTP: row 4 (start) and row 6 (read) on a server with the exam gate off,
// the row 5 refusal, and the bid gate on a second server booted with ACQUIT_EXAM_GATE=1. Each server boots once; each
// test reads the rows the earlier ones left.

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
const portOff = 4944;
const portOn = 4945;
const digest = "d".repeat(64);
const COMMIT = "a".repeat(40);
const SEED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function bootServer(port: number, dbPath: string, home: string, extraEnv: Record<string, string>): Promise<ReturnType<typeof spawn>> {
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

/** How many exam_runs rows one agent has, and the acquittal its stored row carries. */
function examStateOf(dbPath: string, agentId: string) {
	const db = new DatabaseSync(dbPath);
	try {
		const counted = db.prepare("SELECT COUNT(*) AS n FROM exam_runs WHERE agent_id = ?").get(agentId);
		const stored = db.prepare("SELECT json FROM agents WHERE id = ?").get(agentId);
		const acquittal = stored === undefined ? null : (JSON.parse(String(stored.json)) as { acquittal: unknown }).acquittal;
		return { runs: Number(counted?.n), acquittal };
	} finally {
		db.close();
	}
}

const openJob = async (port: number, token: string, issueNumber: number): Promise<string> => {
	const opened = await post(port, "/api/commands", { key: crypto.randomUUID(),
		command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber,
			budget: 40000, deliveryEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }, token);
	const answer = await opened.json() as { outcome?: { result?: { kind: string; job?: { id: string } } } };
	assert.equal(opened.status, 200, `the open committed: ${JSON.stringify(answer)}`);
	return answer.outcome!.result!.job!.id;
};

const placeBid = (port: number, jobId: string, agent: string, token: string) =>
	post(port, "/api/commands", { key: crypto.randomUUID(),
		command: { type: "PlaceBid", jobId, price: 40000, eta: 48, agent, pitch: "test" } }, token);

let offServer: ReturnType<typeof spawn> | undefined;
let onServer: ReturnType<typeof spawn> | undefined;
let offDir: string;
let onDir: string;
let offDb: string;
let onDb: string;
let devon: string;
let maya: string;
let devonOn: string;
let mayaOn: string;
let startedId = "";

before(async () => {
	offDir = await mkdtemp(join(tmpdir(), "acquit-exam-off-"));
	offDb = join(offDir, "acquit.db");
	offServer = await bootServer(portOff, offDb, offDir, { ACQUIT_EXAM_GATE: "0" });
	seedOperator(offDb);
	insertAgent(offDb, { id: "seeded-fixer", owner: "devon-ops", name: "seeded-fixer", runner: "claude-code",
		promptDigest: digest, tools: [], task: "code", acquittal: { examId: "seed", at: SEED_AT }, sample: null });
	insertAgent(offDb, { id: "plain-fixer", owner: "devon-ops", name: "plain-fixer", runner: "claude-code",
		promptDigest: digest, tools: [], task: "code", acquittal: null, sample: null });
	insertAgent(offDb, { id: "printer-devon", owner: "devon-ops", name: "printer-devon", runner: "claude-code",
		promptDigest: digest, tools: [], task: "print-fdm", acquittal: null, sample: null });
	insertAgent(offDb, { id: "laser-devon", owner: "devon-ops", name: "laser-devon", runner: "claude-code",
		promptDigest: digest, tools: [], task: "laser-cut", acquittal: null, sample: null });
	devon = await session(portOff, "devon-ops");
	maya = await session(portOff, "maya-client");

	onDir = await mkdtemp(join(tmpdir(), "acquit-exam-on-"));
	onDb = join(onDir, "acquit.db");
	onServer = await bootServer(portOn, onDb, onDir, { ACQUIT_EXAM_GATE: "1" });
	seedOperator(onDb);
	insertAgent(onDb, { id: "seeded-fixer", owner: "devon-ops", name: "seeded-fixer", runner: "claude-code",
		promptDigest: digest, tools: [], task: "code", acquittal: { examId: "seed", at: SEED_AT }, sample: null });
	devonOn = await session(portOn, "devon-ops");
	mayaOn = await session(portOn, "maya-client");
});

after(async () => {
	offServer?.kill();
	onServer?.kill();
	for (const dir of [offDir, onDir]) {
		try { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may hold the WAL briefly. */ }
	}
});

test("a code agent with no run reads 404, and its start answers 202 RUNNING with the simulated label", async () => {
	const unstarted = await get(portOff, "/api/me/agents/plain-fixer/exam", devon);
	assert.equal(unstarted.status, 404);
	assert.equal((await unstarted.json() as { error: string }).error, "NOT_FOUND");

	const started = await post(portOff, "/api/me/agents/plain-fixer/exam", {}, devon);
	const answer = await started.json() as { exam: Record<string, unknown> };
	assert.equal(started.status, 202, `the start answers 202: ${JSON.stringify(answer)}`);
	assert.match(String(answer.exam.id), /^exam_[0-9a-f-]{36}$/);
	assert.equal(answer.exam.agentId, "plain-fixer");
	assert.equal(answer.exam.task, "code");
	assert.equal(answer.exam.status, "RUNNING");
	assert.equal(answer.exam.simulated, true);
	startedId = String(answer.exam.id);
});

test("the next read answers the settled run: PASSED with the example counts and the simulated label", async () => {
	const read = await get(portOff, "/api/me/agents/plain-fixer/exam", devon);
	assert.equal(read.status, 200);
	const answer = await read.json() as { exam: Record<string, unknown>; agent: { acquittal: Record<string, unknown> } };
	assert.equal(answer.exam.id, startedId);
	assert.equal(answer.exam.status, "PASSED");
	assert.deepEqual(answer.exam.visible, { passed: 48, total: 48 });
	assert.deepEqual(answer.exam.hidden, { passed: 8, total: 8 });
	assert.deepEqual(answer.exam.reasons, []);
	assert.equal(typeof answer.exam.endedAt, "string");
	assert.equal(answer.exam.simulated, true);
	assert.equal(answer.agent.acquittal.examId, startedId);
	assert.equal(answer.agent.acquittal.simulated, true);
	assert.equal(answer.agent.acquittal.seeded, false);

	const byId = await get(portOff, `/api/me/agents/plain-fixer/exam?examId=${startedId}`, devon);
	assert.equal(byId.status, 200);
	assert.equal(((await byId.json()) as { exam: { id: string } }).exam.id, startedId);

	const unknown = await get(portOff, "/api/me/agents/plain-fixer/exam?examId=exam_no-such-run", devon);
	assert.equal(unknown.status, 404);
});

test("the floor lists the simulated agent with its label, and the seed agent keeps its own", async () => {
	const floor = await get(portOff, "/api/floor", maya);
	assert.equal(floor.status, 200);
	const { specialists } = await floor.json() as { specialists: Array<Record<string, unknown>> };
	const byId = new Map(specialists.map(entry => [String(entry.agentId), entry]));
	assert.equal(byId.get("plain-fixer")?.simulated, true);
	assert.equal(byId.get("plain-fixer")?.seeded, false);
	assert.equal(byId.get("plain-fixer")?.gate, "OPEN");
	assert.equal(byId.get("plain-fixer")?.grade, 50);
	assert.equal(byId.get("seeded-fixer")?.simulated, false);
	assert.equal(byId.get("seeded-fixer")?.seeded, true);
});

test("a second start on an acquitted agent answers 409 ALREADY_ACQUITTED and writes no run", async () => {
	const again = await post(portOff, "/api/me/agents/plain-fixer/exam", {}, devon);
	assert.equal(again.status, 409);
	assert.equal((await again.json() as { error: string }).error, "ALREADY_ACQUITTED");

	const state = examStateOf(offDb, "plain-fixer");
	assert.equal(state.runs, 1);
	assert.equal((state.acquittal as { examId: string; simulated: boolean }).examId, startedId);
	assert.equal((state.acquittal as { simulated: boolean }).simulated, true);
});

test("a non-owner gets 404 on start and read, and so does a missing agent", async () => {
	const startedByOther = await post(portOff, "/api/me/agents/plain-fixer/exam", {}, maya);
	assert.equal(startedByOther.status, 404);
	assert.equal((await startedByOther.json() as { error: string }).error, "NOT_FOUND");
	const readByOther = await get(portOff, "/api/me/agents/plain-fixer/exam", maya);
	assert.equal(readByOther.status, 404);
	const missing = await post(portOff, "/api/me/agents/no-such-agent/exam", {}, devon);
	assert.equal(missing.status, 404);
	const missingRead = await get(portOff, "/api/me/agents/no-such-agent/exam", devon);
	assert.equal(missingRead.status, 404);
});

test("a print agent answers 503 EXAM_NOT_BUILT and writes no run", async () => {
	const started = await post(portOff, "/api/me/agents/printer-devon/exam", {}, devon);
	assert.equal(started.status, 503);
	assert.equal((await started.json() as { error: string }).error, "EXAM_NOT_BUILT");
	const read = await get(portOff, "/api/me/agents/printer-devon/exam", devon);
	assert.equal(read.status, 404);
	assert.equal(examStateOf(offDb, "printer-devon").runs, 0);
});

test("a laser agent answers 409 TASK_NOT_EXAMINABLE", async () => {
	const started = await post(portOff, "/api/me/agents/laser-devon/exam", {}, devon);
	assert.equal(started.status, 409);
	assert.equal((await started.json() as { error: string }).error, "TASK_NOT_EXAMINABLE");
	assert.equal(examStateOf(offDb, "laser-devon").runs, 0);
});

test("a submit answers 409 EXAM_NOT_RUNNING for a real run, 404 for an unknown one, and 400 for a bad body", async () => {
	const path = "/api/me/agents/plain-fixer/exam/submit";
	const settled = await post(portOff, path, { examId: startedId, commit: COMMIT }, devon);
	assert.equal(settled.status, 409);
	assert.equal((await settled.json() as { error: string }).error, "EXAM_NOT_RUNNING");

	const unknown = await post(portOff, path, { examId: "exam_no-such-run", commit: COMMIT }, devon);
	assert.equal(unknown.status, 404);

	const shortSha = await post(portOff, path, { examId: startedId, commit: "abc123" }, devon);
	assert.equal(shortSha.status, 400);
	assert.equal((await shortSha.json() as { error: string }).error, "BAD_REQUEST");

	const extra = await post(portOff, path, { examId: startedId, commit: COMMIT, note: "x" }, devon);
	assert.equal(extra.status, 400);

	const byOther = await post(portOff, path, { examId: startedId, commit: COMMIT }, maya);
	assert.equal(byOther.status, 404);
});

test("with ACQUIT_EXAM_GATE=1: a seed-acquitted agent bids, a plugged agent is refused, and a simulated exam lets it bid", async () => {
	const plugged = await post(portOn, "/api/me/agents", { sample: "code-fixer" }, devonOn);
	assert.equal(plugged.status, 201, `the sample plugs: ${plugged.status}`);

	const jobA = await openJob(portOn, mayaOn, 12);
	const seededBid = await placeBid(portOn, jobA, "seeded-fixer", devonOn);
	const seededAnswer = await seededBid.json() as { outcome: { result?: { kind: string } } };
	assert.equal(seededBid.status, 200, `the seed-acquitted bid committed: ${JSON.stringify(seededAnswer)}`);
	assert.equal(seededAnswer.outcome.result?.kind, "BID");

	const refused = await placeBid(portOn, jobA, "code-fixer-devon-ops", devonOn);
	assert.equal(refused.status, 409);
	const refusedAnswer = await refused.json() as { outcome: { kind: string; reason: string } };
	assert.equal(refusedAnswer.outcome.kind, "DENIED");
	assert.equal(refusedAnswer.outcome.reason, "NOT_ACQUITTED");

	const started = await post(portOn, "/api/me/agents/code-fixer-devon-ops/exam", {}, devonOn);
	assert.equal(started.status, 202);
	assert.equal(((await started.json()) as { exam: { simulated: boolean } }).exam.simulated, true);

	const jobB = await openJob(portOn, mayaOn, 13);
	const acquittedBid = await placeBid(portOn, jobB, "code-fixer-devon-ops", devonOn);
	const acquittedAnswer = await acquittedBid.json() as { outcome: { result?: { kind: string } } };
	assert.equal(acquittedBid.status, 200, `the simulated-acquitted bid committed: ${JSON.stringify(acquittedAnswer)}`);
	assert.equal(acquittedAnswer.outcome.result?.kind, "BID");

	const floor = await get(portOn, "/api/floor", mayaOn);
	const { specialists } = await floor.json() as { specialists: Array<Record<string, unknown>> };
	const byId = new Map(specialists.map(entry => [String(entry.agentId), entry]));
	assert.equal(byId.get("code-fixer-devon-ops")?.simulated, true);
	assert.equal(byId.get("code-fixer-devon-ops")?.seeded, false);
	assert.equal(byId.get("code-fixer-devon-ops")?.gate, "OPEN");
	assert.equal(byId.get("seeded-fixer")?.simulated, false);
	assert.equal(byId.get("seeded-fixer")?.seeded, true);
});
