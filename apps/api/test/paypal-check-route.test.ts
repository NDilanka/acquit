// The PayPal check's read route over real HTTP: the job's client and the operators who bid, the House's bid included, read
// the check recorded for it, a job nobody checked answers null, and any other caller (anonymous, or an operator who only
// sees the open job) is refused.
// The check row is written straight into the table the server creates at boot, since a check starts only on a push.

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
const port = 4975;
const ORDER = "8AB12345CD678901E";
const CHECKED = "2026-11-10T18:00:00.000Z";

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

/** An operator row and its credits, written the way the core tests seed them. */
function seedOperator(dbPath: string, handle: string, kind: "INDEPENDENT" | "HOUSE" = "INDEPENDENT") {
	const db = new DatabaseSync(dbPath);
	const now = instant(new Date().toISOString());
	db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(handle, 0, JSON.stringify({
		id: handle, handle, kind, version: 0,
		payouts: { kind: "READY", merchant: "sandbox-seller", connectedAt: now } }), 0);
	const granted = reduceCredits({ operator: handle, version: 0, balance: { allowance: 0, purchased: 0 }, lines: [] } as never,
		{ kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
	assert.notEqual(typeof granted, "string");
	const account = granted as { version: number };
	db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(handle, account.version, JSON.stringify(granted));
	db.close();
}

/** The row the deployment writes when a check of a funded job's money has been answered by PayPal. */
function recordCheck(dbPath: string, jobId: string): void {
	const db = new DatabaseSync(dbPath);
	db.prepare("INSERT INTO job_paypal_checks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(jobId, ORDER, CHECKED, "HELD", "APPROVED", "COMPLETED", "400.00", "USD", null);
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

const dir = await mkdtemp(join(tmpdir(), "acquit-paypal-check-route-"));
let child: ReturnType<typeof spawn> | null = null;
let maya = "";
let devon = "";
let rival = "";
let house = "";
let checkedJob = "";
let uncheckedJob = "";

before(async () => {
	const dbPath = join(dir, "acquit.db");
	child = await bootServer(dbPath, dir);
	seedOperator(dbPath, "devon-ops");
	seedOperator(dbPath, "rival-ops");
	seedOperator(dbPath, "house-tsfix", "HOUSE");
	const principals = new DatabaseSync(dbPath);
	principals.prepare("INSERT INTO principals VALUES (?, ?, ?)").run("rival-ops", "OPERATOR", null);
	principals.prepare("INSERT INTO principals VALUES (?, ?, ?)").run("house-tsfix", "OPERATOR", null);
	principals.close();
	maya = await session("maya-client");
	devon = await session("devon-ops");
	rival = await session("rival-ops");
	house = await session("house-tsfix");
	checkedJob = await openJob(maya);
	uncheckedJob = await openJob(maya);
	const plugged = await post("/api/me/agents", { sample: "code-fixer" }, devon);
	assert.equal(plugged.status, 201);
	const bid = await post("/api/commands", { key: crypto.randomUUID(),
		command: { type: "PlaceBid", jobId: checkedJob, price: 40000, eta: 48, agent: "code-fixer-devon-ops", pitch: "test" } }, devon);
	assert.equal(bid.status, 200, "the bid committed");
	// The House bids through the same command, and its bid is projected under `bids.house`, not `bids.operators`.
	const housePlugged = await post("/api/me/agents", { sample: "code-fixer" }, house);
	assert.equal(housePlugged.status, 201);
	const houseBid = await post("/api/commands", { key: crypto.randomUUID(),
		command: { type: "PlaceBid", jobId: checkedJob, price: 40000, eta: 48, agent: "code-fixer-house-tsfix", pitch: "test" } }, house);
	assert.equal(houseBid.status, 200, "the House's bid committed");
	recordCheck(dbPath, checkedJob);
});

after(async () => {
	child?.kill("SIGKILL");
	await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("the check route answers the recorded check to the job's owner and its bidder, and null when none is recorded", async () => {
	const owner = await get(`/api/jobs/${checkedJob}/paypal-check`, maya);
	assert.equal(owner.status, 200);
	assert.deepEqual(await owner.json(), { check: { jobId: checkedJob, orderId: ORDER, checkedAt: CHECKED, outcome: "HELD",
		orderStatus: "APPROVED", captureStatus: "COMPLETED", heldValue: "400.00", heldCurrency: "USD", reason: null } });

	const bidder = await get(`/api/jobs/${checkedJob}/paypal-check`, devon);
	assert.equal(bidder.status, 200);
	assert.equal(((await bidder.json()) as { check: { orderId: string } }).check.orderId, ORDER);

	const unchecked = await get(`/api/jobs/${uncheckedJob}/paypal-check`, maya);
	assert.equal(unchecked.status, 200);
	assert.deepEqual(await unchecked.json(), { check: null });
});

test("the check route answers the House's own bid on the job the same way it answers an independent bid", async () => {
	const houseBidder = await get(`/api/jobs/${checkedJob}/paypal-check`, house);
	assert.equal(houseBidder.status, 200, "the House operator is a bidder on the job");
	assert.equal(((await houseBidder.json()) as { check: { orderId: string } }).check.orderId, ORDER);
});

test("the check route refuses an anonymous caller and an operator who neither owns nor bid on the job", async () => {
	const anonymousJob = await get(`/api/jobs/${checkedJob}`);
	const anonymous = await get(`/api/jobs/${checkedJob}/paypal-check`);
	assert.equal(anonymous.status, anonymousJob.status);
	assert.notEqual(anonymous.status, 200);

	// The job is still open, so the job route shows it to every operator; the check is narrower than that.
	const jobAsRival = await get(`/api/jobs/${checkedJob}`, rival);
	assert.equal(jobAsRival.status, 200, "an open job is visible to any operator");
	const checkAsRival = await get(`/api/jobs/${checkedJob}/paypal-check`, rival);
	assert.equal(checkAsRival.status, 403);
	const refused = await checkAsRival.json() as Record<string, unknown>;
	assert.deepEqual(refused, { error: "NOT_OWNER" }, "a caller who is not the client or a bidder reads no record");
});
