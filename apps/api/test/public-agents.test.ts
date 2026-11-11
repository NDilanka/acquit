// Anonymous display reads in public mode, and the authenticated routes around them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

const port = 4976;
const origin = `http://127.0.0.1:${port}`;
const at = "2026-11-10T00:00:00.000Z";
const privateValues = [
	"private-owner@example.invalid", "private-session-token", "private-merchant-id",
	"private-payer-id", "private-hidden-check", "private-prompt-digest", "private-tool",
];
let child: ReturnType<typeof spawn> | undefined;
let db: DatabaseSync | undefined;
let home: string;

before(async () => {
	home = await mkdtemp(join(tmpdir(), "acquit-public-agents-"));
	const dbPath = join(home, "acquit.db");
	await new Promise<void>((resolve, reject) => {
		child = spawn(process.execPath, ["--max-old-space-size=512", "src/server.ts"], {
			cwd: join(import.meta.dirname, ".."),
			env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "0",
				ACQUIT_FIXTURES: join(import.meta.dirname, "../../../packages/verifier/fixtures/fixtures.example.json"),
				ACQUIT_SCOPING_DIR: home, HOME: home, FACTORY_API_KEY: "",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef", WEB_ORIGIN: origin },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let errors = "";
		const timer = setTimeout(() => reject(new Error(`API did not boot: ${output} ${errors}`)), 30_000);
		child.stdout!.on("data", chunk => {
			output += String(chunk);
			if (output.includes("Acquit API:")) { clearTimeout(timer); resolve(); }
		});
		child.stderr!.on("data", chunk => { errors += String(chunk); });
		child.on("error", error => { clearTimeout(timer); reject(error); });
		child.on("exit", code => { clearTimeout(timer); reject(new Error(`API exited (${code}): ${output} ${errors}`)); });
	});
	db = new DatabaseSync(dbPath);
	db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run("display-owner", 0, JSON.stringify({
		id: "display-owner", handle: "display-owner", kind: "INDEPENDENT", version: 0,
		email: privateValues[0], token: privateValues[1],
		payouts: { kind: "READY", merchant: privateValues[2], connectedAt: at },
	}), 0);
	for (const [id, acquittal] of [
		["public-record", { examId: "public-exam", at, simulated: true, hiddenCheck: privateValues[4] }],
		["not-acquitted", null],
	] as const) {
		db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(id, "display-owner", JSON.stringify({
			id, owner: "display-owner", name: id, runner: "claude-code", task: "code", sample: "code-fixer",
			acquittal, promptDigest: privateValues[5], tools: [privateValues[6]],
			email: privateValues[0], token: privateValues[1], paypalMerchantId: privateValues[2],
			payer: { id: privateValues[3], email: privateValues[0] }, standingOrders: { autopilot: true },
		}));
	}
});

after(async () => {
	db?.close();
	if (child && child.exitCode === null && child.signalCode === null) {
		const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
		child.kill();
		await exited;
	}
	if (home) await rm(home, { recursive: true, force: true, maxRetries: 3 });
});

function keys(value: Record<string, unknown>, expected: string[]) {
	assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}
function noPrivateFields(value: unknown) {
	const serialized = JSON.stringify(value);
	for (const secret of privateValues) assert.ok(!serialized.includes(secret), `private canary leaked: ${secret}`);
	const walk = (node: unknown) => {
		if (node === null || typeof node !== "object") return;
		for (const [key, item] of Object.entries(node)) {
			assert.doesNotMatch(key, /email|token|merchant|payer|promptDigest|tools|standingOrders|hiddenCheck/i);
			walk(item);
		}
	};
	walk(value);
}

test("signed-out GET /api/floor returns only public ranking fields in public mode", async () => {
	const response = await fetch(`${origin}/api/floor`);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("set-cookie"), null);
	const answer = await response.json() as { specialists: Array<Record<string, unknown>> };
	keys(answer, ["specialists"]);
	assert.equal(answer.specialists.length, 1);
	const entry = answer.specialists[0]!;
	keys(entry, ["agentId", "name", "task", "grade", "record", "earnedCents", "seeded", "simulated", "gate"]);
	keys(entry.record as Record<string, unknown>, ["jobsTaken", "verified", "rejected", "earnedCents"]);
	assert.equal(entry.agentId, "public-record");
	assert.equal(entry.simulated, true);
	assert.equal(entry.grade, 50);
	noPrivateFields(answer);
});

test("signed-out GET /api/agents/:id returns only Record fields and the already-displayed owner handle", async () => {
	const response = await fetch(`${origin}/api/agents/public-record`);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("set-cookie"), null);
	const answer = await response.json() as { agent: Record<string, unknown> };
	keys(answer, ["agent"]);
	keys(answer.agent, ["id", "name", "task", "runner", "owner", "acquittal", "acquittedAt", "gate", "grade", "record"]);
	assert.deepEqual(answer.agent.owner, { handle: "display-owner" });
	assert.deepEqual(answer.agent.acquittal, { examId: "public-exam", at, seeded: false, simulated: true });
	assert.deepEqual(answer.agent.record, { jobsTaken: 0, verified: 0, rejected: 0, earnedCents: 0 });
	noPrivateFields(answer);
});

test("unacquitted Records are public; missing and malformed ids return the same 404", async () => {
	const response = await fetch(`${origin}/api/agents/not-acquitted`);
	assert.equal(response.status, 200);
	const answer = await response.json() as { agent: Record<string, unknown> };
	assert.equal(answer.agent.acquittal, null);
	assert.equal(answer.agent.grade, null);
	noPrivateFields(answer);
	for (const id of ["missing", "%E0%A4%A"]) {
		const missing = await fetch(`${origin}/api/agents/${id}`);
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: "NOT_FOUND" });
	}
});

test("public reads ignore invalid credentials without database writes or session renewal", async () => {
	const before = db!.prepare("PRAGMA data_version").get();
	for (const path of ["/api/floor", "/api/agents/public-record"]) {
		const response = await fetch(`${origin}${path}`, {
			headers: { cookie: "acquit_session=invalid", authorization: "Bearer invalid" },
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("set-cookie"), null);
		noPrivateFields(await response.json());
	}
	assert.deepEqual(db!.prepare("PRAGMA data_version").get(), before);
	assert.equal(db!.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 0);
});

test("owner, exam, payout, activity and adjacent reads remain authenticated", async () => {
	for (const path of ["/api/me/agents", "/api/specialists/samples", "/api/me/agents/public-record/exam",
		"/api/me/agents/public-record/standing-orders", "/api/me/morning-report", "/api/me/activity",
		"/api/me/escrow", "/api/me/payouts", "/api/agents", "/api/floor/extra", "/api/agents/public-record/private"]) {
		const response = await fetch(`${origin}${path}`);
		assert.equal(response.status, 401, path);
		assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
	}
});

test("only GET is public: writes to both display endpoints remain authenticated", async () => {
	const before = db!.prepare("PRAGMA data_version").get();
	for (const path of ["/api/floor", "/api/agents/public-record"]) {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const response = await fetch(`${origin}${path}`, { method });
			assert.equal(response.status, 401, `${method} ${path}`);
			assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
		}
	}
	assert.deepEqual(db!.prepare("PRAGMA data_version").get(), before);
});
