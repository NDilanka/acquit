// The autopilot worker against the real API server over HTTP, on a temporary database. The worker reads its standing
// orders, bids at the price floor, checks held money before any work, pre-approves a submit only on a fixture-matched
// job, and records a job first seen as PAID as VERIFIED. The server preloads a spy that refuses PayPal, so held money
// is answered from the escrow state, the same answer the worker gets without PayPal credentials.

import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runAutopilot } from "../../../packages/acquit-cli/src/autopilot.ts";
import type { AutopilotActions } from "../../../packages/acquit-cli/src/autopilot.ts";
import { apiClient } from "../../../packages/acquit-cli/src/client.ts";
import type { ApiClient } from "../../../packages/acquit-cli/src/client.ts";
import { stateRoot } from "../../../packages/acquit-cli/src/gitstate.ts";
import type { ProviderPort } from "../../../packages/acquit-cli/src/operator.ts";
import { creditWeek, reduceCredits } from "../../../packages/core/src/credits.ts";
import { commercialSplit, reduceLedger, usd } from "../../../packages/core/src/ledger.ts";
import type { HeldBook, PaidBook } from "../../../packages/core/src/ledger.ts";
import { instant } from "../../../packages/core/src/ids.ts";
import type { CommitSha, JobId, MerchantId } from "../../../packages/core/src/ids.ts";
import { verifierRunId } from "../../../packages/core/src/job.ts";
import { quote } from "../../../packages/core/src/paypal.ts";
import type { Bps, ProcessorFeeModel } from "../../../packages/core/src/paypal.ts";

const root = join(import.meta.dirname, "..");
const port = 4951;
const apiUrl = `http://127.0.0.1:${port}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPERATOR = "devon-ops";
const CLIENT = "maya-client";
const AGENT_NAME = "pilot";
/** The agent's id differs from its name, as a plugged agent's can, so the worker must put the id on the wire. */
const AGENT_ID = "pilot-7f3a";
const ORDERS = { priceFloorCents: 4000, maxConcurrent: 2, autopilot: true, runsOn: "owner", preApprove: true, preApproveCap: 3 };
const BID_PITCH = "Autopilot bid at the price floor";
const COMMIT = "1234567890abcdef1234567890abcdef12345678";
const MERGE = "fedcba0987654321fedcba0987654321fedcba09";
const CAPTURE = "CAPTURE-E2E-1";
const DIGEST_AGENT = "d".repeat(64);
const DIGEST_REPORT = "e".repeat(64);
const MERCHANT = "sandbox-seller" as MerchantId;
const MODEL: ProcessorFeeModel = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };

/** The price the worker bids (the floor, $40.00) and the split the core computes for it. */
function money() {
	const split = commercialSplit(usd("40.00"));
	return { split, fee: quote(split, MODEL) };
}

function bootServer(dbPath: string, home: string, fetchLog: string): Promise<ChildProcess> {
	const preload = pathToFileURL(join(root, "test", "sample-paypal-spy.mjs")).href;
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["--import", preload, "src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_SCOPING_DIR: home, ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673", HOME: home, FACTORY_API_KEY: "", SAMPLE_FETCH_LOG: fetchLog,
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

const call = (method: string, path: string, token: string | undefined, payload?: unknown) =>
	fetch(`${apiUrl}${path}`, {
		method,
		headers: {
			...(payload === undefined ? {} : { "content-type": "application/json" }),
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: payload === undefined ? undefined : JSON.stringify(payload),
	});

const session = async (handle: string): Promise<string> => {
	const signed = await call("POST", "/api/session", undefined, { handle });
	assert.equal(signed.status, 200);
	return (await signed.json() as { token: string }).token;
};

/** The operator row and credits a bid needs, written the way the core tests seed them. */
function seedOperator(dbPath: string) {
	const db = new DatabaseSync(dbPath);
	const now = instant(new Date().toISOString());
	db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(OPERATOR, 0, JSON.stringify({
		id: OPERATOR, handle: OPERATOR, kind: "INDEPENDENT", version: 0,
		payouts: { kind: "READY", merchant: "sandbox-seller", connectedAt: now } }), 0);
	const granted = reduceCredits({ operator: OPERATOR, version: 0, balance: { allowance: 0, purchased: 0 }, lines: [] } as never,
		{ kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
	assert.notEqual(typeof granted, "string");
	const account = granted as { version: number };
	db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(OPERATOR, account.version, JSON.stringify(granted));
	db.close();
}

function insertAgent(dbPath: string, agent: Record<string, unknown>) {
	const db = new DatabaseSync(dbPath);
	db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(String(agent.id), String(agent.owner), JSON.stringify(agent));
	db.close();
}

type StoredBid = { id: string; operator: string; agent: string; status: string; [key: string]: unknown };
type StoredRow = { id: string; bids: StoredBid[]; state: Record<string, unknown>; [key: string]: unknown };

function storedRow(dbPath: string, jobId: string): StoredRow {
	const db = new DatabaseSync(dbPath);
	const found = db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId) as { json: string } | undefined;
	db.close();
	assert.ok(found, `job ${jobId} is stored`);
	return JSON.parse(found.json) as StoredRow;
}

function writeRow(dbPath: string, jobId: string, row: StoredRow): void {
	const db = new DatabaseSync(dbPath);
	db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(JSON.stringify(row), jobId);
	db.close();
}

/** A job the worker's bid won, with the buyer's money held in escrow: the state a captured order leaves. */
function seedInProgress(dbPath: string, jobId: string): void {
	const row = storedRow(dbPath, jobId);
	const bid = row.bids.find(entry => entry.operator === OPERATOR);
	assert.ok(bid, "the worker's bid is on the job");
	bid.status = "ACCEPTED";
	const { split, fee } = money();
	const at = instant(new Date(Date.now() - 60_000).toISOString());
	const book = reduceLedger([] as const, { kind: "Hold", gross: split.held, at }) as HeldBook;
	row.state = {
		status: "IN_PROGRESS",
		escrow: {
			payee: { bidId: bid.id, operator: OPERATOR, payee: MERCHANT, agent: AGENT_ID, price: usd("40.00"), eta: 48 },
			quote: fee,
			capture: { orderId: "ORDER-E2E-1", captureId: CAPTURE, payee: MERCHANT, disbursement: "DELAYED", gross: split.held,
				processorFee: fee.predictedProcessorFee, platformFee: fee.platformFeeInstruction, sellerNet: split.operatorNet, capturedAt: at },
			book,
			cutoffAt: instant(new Date(Date.now() + 21 * DAY_MS).toISOString()),
		},
		attempts: { phase: "READY", history: [], runsStarted: 0, failure: null },
	};
	writeRow(dbPath, jobId, row);
}

/** The same job after its verifier passed the submitted commit and the release paid out: the state a settled release leaves. */
function seedPaid(dbPath: string, jobId: string): void {
	const row = storedRow(dbPath, jobId);
	const escrow = row.state.escrow as { payee: unknown; book: HeldBook };
	const { split, fee } = money();
	const at = instant(new Date().toISOString());
	const book = reduceLedger(escrow.book, { kind: "Release", operatorNet: split.operatorNet,
		processorFee: fee.predictedProcessorFee, platformFee: fee.platformFeeInstruction, at }) as PaidBook;
	const frozen = { expected: 3, passed: 3 };
	const hidden = { expected: 2, passed: 2 };
	row.state = {
		status: "PAID",
		payee: escrow.payee,
		book,
		receipt: { id: `rcpt_${crypto.randomUUID()}`, jobId, operator: OPERATOR, agent: AGENT_ID, pullRequest: 13,
			mergeCommit: MERGE, frozen, hidden, attemptsUsed: 1, paid: split.operatorNet, releasedAt: at },
		release: { payoutItemId: "PAYOUT-E2E-1", captureId: CAPTURE, paid: split.operatorNet, at },
		releaseAuthority: "CLIENT_APPROVAL",
		history: [{ ordinal: 1, verdict: { result: "VERIFIED", runId: verifierRunId(jobId as JobId, 1), sourceCommit: COMMIT,
			mergeCommit: MERGE, pullRequest: 13, frozen, hidden, reportDigest: DIGEST_REPORT, at } }],
		merge: { phase: "MERGED", at, sha: MERGE },
		treasury: [],
	};
	writeRow(dbPath, jobId, row);
}

/**
 * A job whose frozen fixture the registry does not hold, the state the server reports as fixtureMatched false. OpenJob
 * refuses an unregistered repository, so the frozen manifest is re-pointed here, the way a job frozen before a registry
 * change is left. The store reads the manifest over the job's own contract, so the server sees the new fixture.
 */
function seedUnregistered(dbPath: string, jobId: string): void {
	const db = new DatabaseSync(dbPath);
	const found = db.prepare("SELECT json FROM job_manifests WHERE job_id = ?").get(jobId) as { json: string } | undefined;
	assert.ok(found, "the job's frozen manifest is stored");
	const manifest = JSON.parse(found.json) as { issue: Record<string, unknown> };
	manifest.issue = { ...manifest.issue, repository: "maya-client/unregistered-app", number: 99 };
	db.prepare("UPDATE job_manifests SET json = ? WHERE job_id = ?").run(JSON.stringify(manifest), jobId);
	db.close();
}

const openJob = async (token: string, repository = "maya-client/invoice-app", issueNumber = 12): Promise<string> => {
	const opened = await call("POST", "/api/commands", token, { key: crypto.randomUUID(),
		command: { type: "OpenJob", repository, issueNumber, budget: 40000, deliveryEndsAt: new Date(Date.now() + 7 * DAY_MS).toISOString() } });
	const answer = await opened.json() as { outcome?: { result?: { kind: string; job?: { id: string } } } };
	assert.equal(opened.status, 200, `the open committed: ${JSON.stringify(answer)}`);
	return answer.outcome!.result!.job!.id;
};

type JobView = {
	job: {
		status: string;
		bids: { operators: { operator: string; agent: string; price: number; eta: number; pitch: string; status: string }[] };
		attempts: { history: { sourceCommit: string; result: string }[] };
	};
	fixtureMatched: boolean;
};

const jobView = async (id: string, token: string): Promise<JobView> => {
	const answer = await call("GET", `/api/jobs/${id}`, token);
	assert.equal(answer.status, 200);
	return await answer.json() as JobView;
};

// The stubs stand in for the sandbox run and the verifier submit. The trace records each call in order, so a test can
// assert what the worker did and in what order.
const trace: string[] = [];
const stubs: Partial<AutopilotActions> = {
	run: async options => { trace.push(`run ${options.jobId}`); },
	submit: async options => { trace.push(`submit ${options.jobId}`); return "Submitted to the verifier."; },
	head: () => COMMIT as CommitSha,
};

let server: ChildProcess | undefined;
let dir = "";
let dbPath = "";
let workRoot = "";
let stateDir = "";
let env: NodeJS.ProcessEnv = {};
let devon = "";
let maya = "";
let workerClient: ApiClient;
let jobId = "";
let jobTwo = "";
const SEED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

type StateFile = { jobs: Record<string, { phase: string; commit: string | null; note: string }>; preApprovals: string[] };
const readState = (): StateFile => JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as StateFile;
const readRecord = (): Record<string, unknown>[] =>
	readFileSync(join(stateDir, "record.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);

/** One tick of the worker, run the way `acquit autopilot --once` runs it. */
async function tick(): Promise<{ code: number; out: string }> {
	let out = "";
	const code = await runAutopilot({ apiUrl, token: devon, agent: AGENT_NAME, once: true, everyMs: 15_000, promptPath: null, workRoot }, {
		client: workerClient, provider: {} as ProviderPort, env, write: text => { out += text; }, actions: stubs,
	});
	return { code, out };
}

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "acquit-autopilot-e2e-"));
	dbPath = join(dir, "acquit.db");
	server = await bootServer(dbPath, dir, join(dir, "fetch.log"));
	seedOperator(dbPath);
	insertAgent(dbPath, { id: AGENT_ID, owner: OPERATOR, name: AGENT_NAME, runner: "claude-code", promptDigest: DIGEST_AGENT,
		tools: [], task: "code", acquittal: { examId: "exam_5d2c9a1e-3b7f-4c8a-9e21-7a6f0d4b2c11", at: SEED_AT }, sample: null });
	maya = await session(CLIENT);
	devon = await session(OPERATOR);
	env = { ...process.env, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: join(dir, "local"), XDG_STATE_HOME: join(dir, "state"),
		XDG_CONFIG_HOME: join(dir, "config"), ACQUIT_MCP_CONFIRMATIONS: join(dir, "confirmations") };
	workRoot = join(dir, "work");
	stateDir = join(stateRoot(env), "autopilot", AGENT_NAME);
	const base = apiClient({ baseUrl: apiUrl, token: devon });
	workerClient = { ...base, get: (path: string) => {
		if (path.includes("/money-held")) trace.push(`money-held ${path.split("/")[4]}`);
		return base.get(path);
	} };
});

after(async () => {
	if (server !== undefined && server.exitCode === null && server.signalCode === null) {
		const exited = once(server, "exit");
		server.kill();
		await exited;
	}
	try { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may hold the WAL briefly. */ }
});

test("with no standing orders the worker stops and says where to set them", async () => {
	const { code, out } = await tick();
	assert.equal(code, 1, out);
	assert.match(out, /no standing orders for pilot/);
});

test("the standing orders the owner sets come back from the route the worker reads", async () => {
	const saved = await call("PUT", `/api/me/agents/${AGENT_ID}/standing-orders`, devon, ORDERS);
	assert.equal(saved.status, 200);
	const read = await call("GET", `/api/me/agents/${AGENT_ID}/standing-orders`, devon);
	const { standingOrders } = await read.json() as { standingOrders: Record<string, unknown> };
	assert.equal(standingOrders.priceFloorCents, 4000);
	assert.equal(standingOrders.maxConcurrent, 2);
	assert.equal(standingOrders.runsOn, "owner");
	assert.equal(standingOrders.preApproveCap, 3);
	assert.ok(standingOrders.autopilot && standingOrders.preApprove);
});

test("the worker bids at the price floor on an open job, under the agent's id", async () => {
	jobId = await openJob(maya);
	assert.equal((await jobView(jobId, maya)).fixtureMatched, true, "the job's contract is a registered fixture");
	trace.length = 0;
	const { code, out } = await tick();
	assert.equal(code, 0, out);
	const bid = (await jobView(jobId, devon)).job.bids.operators.find(entry => entry.operator === OPERATOR);
	assert.ok(bid, "the worker's bid is on the job");
	assert.deepEqual({ agent: bid.agent, price: bid.price, eta: bid.eta, pitch: bid.pitch, status: bid.status },
		{ agent: AGENT_ID, price: 4000, eta: 48, pitch: BID_PITCH, status: "PENDING" });
	assert.equal(readState().jobs[jobId].phase, "BID");
	assert.deepEqual(trace, []);
});

test("a later tick leaves the open bid alone", async () => {
	const { code, out } = await tick();
	assert.equal(code, 0, out);
	assert.equal((await jobView(jobId, devon)).job.bids.operators.length, 1);
	assert.equal(readRecord().filter(line => line.event === "bid").length, 1);
});

test("the money is checked before any work, and the run starts once the escrow says it is held", async () => {
	seedInProgress(dbPath, jobId);
	const held = await call("GET", `/api/me/jobs/${jobId}/money-held`, devon);
	assert.equal(held.status, 200);
	const answer = await held.json() as { held: boolean; source: string };
	assert.deepEqual([answer.held, answer.source], [true, "ESCROW_STATE"]);
	trace.length = 0;
	const { code, out } = await tick();
	assert.equal(code, 0, out);
	assert.deepEqual(trace, [`money-held ${jobId}`, `run ${jobId}`]);
	assert.equal(readState().jobs[jobId].phase, "RAN");
	assert.ok(readRecord().some(line => line.event === "run" && line.note === "held by acquit"));
});

test("a fixture-matched submit is pre-approved, with no typed confirmation", async () => {
	trace.length = 0;
	const { code, out } = await tick();
	assert.equal(code, 0, out);
	assert.deepEqual(trace, [`submit ${jobId}`]);
	const state = readState();
	assert.deepEqual(state.jobs[jobId], { phase: "SUBMITTED", commit: COMMIT, note: "submitted" });
	assert.equal(state.preApprovals.length, 1);
	assert.match(out, /Pre-approved submit for job/);
	assert.ok(readRecord().some(line => line.event === "pre-approved" && line.jobId === jobId));
});

test("a submit on a job that is not a registered fixture waits for the owner", async () => {
	jobTwo = await openJob(maya);
	seedUnregistered(dbPath, jobTwo);
	assert.equal((await jobView(jobTwo, maya)).fixtureMatched, false);
	trace.length = 0;
	const bidTick = await tick();
	assert.equal(bidTick.code, 0, bidTick.out);
	assert.ok((await jobView(jobTwo, devon)).job.bids.operators.some(entry => entry.operator === OPERATOR));
	seedInProgress(dbPath, jobTwo);
	const runTick = await tick();
	assert.equal(runTick.code, 0, runTick.out);
	assert.deepEqual(trace, [`money-held ${jobTwo}`, `run ${jobTwo}`]);
	trace.length = 0;
	const { code, out } = await tick();
	assert.equal(code, 0, out);
	assert.deepEqual(trace, []);
	assert.match(out, new RegExp(`Submit for job ${jobTwo} waits for you`));
	const entry = readState().jobs[jobTwo];
	assert.equal(entry.phase, "REQUESTED");
	assert.match(entry.note, /waiting for your confirmation/);
});

test("a job first seen as PAID is recorded VERIFIED for the commit the worker submitted", async () => {
	seedPaid(dbPath, jobId);
	const view = await jobView(jobId, devon);
	assert.equal(view.job.status, "PAID");
	assert.deepEqual(view.job.attempts.history.map(item => [item.sourceCommit, item.result]), [[COMMIT, "VERIFIED"]]);
	trace.length = 0;
	const { code, out } = await tick();
	assert.equal(code, 0, out);
	assert.deepEqual(trace, []);
	assert.match(out, new RegExp(`Job ${jobId} finished: VERIFIED`));
	const entry = readState().jobs[jobId];
	assert.deepEqual([entry.phase, entry.commit, entry.note], ["DONE", COMMIT, "VERIFIED: verifier passed the commit"]);
	assert.ok(readRecord().some(line => line.event === "phase" && line.jobId === jobId && line.phase === "DONE"));
});
