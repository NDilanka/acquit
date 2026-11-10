// The activity route over real HTTP: only an operator reads it, a malformed limit is refused by name, and an
// operator sees the job its own agent bid on, with the bid, and never a job it has no part in. The hosted
// runner is off in this boot, so the route's runner status reads OFF.

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
const port = 4961;

function bootServer(dbPath: string, home: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1", ACQUIT_SAMPLE_RUNNER: "0",
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

const openJob = async (token: string): Promise<string> => {
	const opened = await post("/api/commands", { key: crypto.randomUUID(),
		command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
			budget: 40000, deliveryEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }, token);
	const answer = await opened.json() as { outcome?: { result?: { kind: string; job?: { id: string } } } };
	assert.equal(opened.status, 200, `the open committed: ${JSON.stringify(answer)}`);
	return answer.outcome!.result!.job!.id;
};

type ActivityBody = {
	readonly sandbox: boolean;
	readonly activity: ReadonlyArray<{ readonly jobId: string; readonly state: string; readonly source: string;
		readonly bid: { readonly priceCents: number } | null }>;
	readonly runner: { readonly enabled: boolean; readonly status: string; readonly runsToday: number; readonly runsPerDay: number };
};

const dir = await mkdtemp(join(tmpdir(), "acquit-activity-route-"));
let child: ReturnType<typeof spawn> | null = null;
let maya = "";
let devon = "";
let jobBid = "";

before(async () => {
	const dbPath = join(dir, "acquit.db");
	child = await bootServer(dbPath, dir);
	seedOperator(dbPath);
	maya = await session("maya-client");
	devon = await session("devon-ops");
	jobBid = await openJob(maya);
	await openJob(maya); // a second job devon never bids on
	const plugged = await post("/api/me/agents", { sample: "code-fixer" }, devon);
	assert.equal(plugged.status, 201);
	const bid = await post("/api/commands", { key: crypto.randomUUID(),
		command: { type: "PlaceBid", jobId: jobBid, price: 40000, eta: 48, agent: "code-fixer-devon-ops", pitch: "test" } }, devon);
	const answer = await bid.json() as { outcome: { result?: { kind: string } } };
	assert.equal(bid.status, 200, `the bid committed: ${JSON.stringify(answer)}`);
	assert.equal(answer.outcome.result?.kind, "BID");
});

after(async () => {
	child?.kill("SIGKILL");
	await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("the activity route answers only an operator, and refuses a malformed limit by name", async () => {
	const anonymous = await get("/api/me/activity");
	assert.equal(anonymous.status, 401);
	const asClient = await get("/api/me/activity", maya);
	assert.equal(asClient.status, 403);
	assert.deepEqual(await asClient.json(), { error: "NOT_OWNER" });

	for (const limit of ["0", "51", "abc", "-1", "1.5", ""]) {
		const refused = await get(`/api/me/activity?limit=${limit}`, devon);
		assert.equal(refused.status, 400, `limit "${limit}" is refused`);
		assert.deepEqual(await refused.json(), { error: "BAD_REQUEST" });
	}
	for (const limit of ["1", "50"]) {
		assert.equal((await get(`/api/me/activity?limit=${limit}`, devon)).status, 200, `limit ${limit} is allowed`);
	}
});

test("an operator sees the job its own agent bid on, with the bid, and never a job it has no part in", async () => {
	const response = await get("/api/me/activity", devon);
	assert.equal(response.status, 200);
	const body = await response.json() as ActivityBody;
	assert.equal(body.sandbox, true);
	assert.deepEqual(body.activity.map(row => row.jobId), [jobBid], "the other job names no part of devon's, so it is not listed");
	const [row] = body.activity;
	assert.equal(row!.state, "BID_PLACED");
	assert.equal(row!.source, "OWNER", "a bid by the owner's own agent is the owner's, not the runner's");
	assert.equal(row!.bid?.priceCents, 40000);
	assert.equal(body.runner.enabled, false);
	assert.equal(body.runner.status, "OFF");
	assert.equal(body.runner.runsToday, 0);
	assert.equal(body.runner.runsPerDay, 3);
});
