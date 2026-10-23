// The platform reads one job and holds no command, so every development route refuses its session by name: the arbiter route
// (which would run ResolveDispute as the arbiter), the clock, the tick, the funding mode, and the dev webhook replay, which
// answers before the session gate. The same routes still answer an anonymous or signed-in client, so the refusal is the platform's alone.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = join(import.meta.dirname, "..");

function bootServer(port: number, dbPath: string, home: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_SCOPING_DIR: join(home, "scoping"),
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
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

const post = (port: number, path: string, payload: unknown, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });

const session = async (port: number, handle: string): Promise<string> => {
	const signed = await post(port, "/api/session", { handle });
	assert.equal(signed.status, 200);
	return (await signed.json() as { token: string }).token;
};

const open = (port: number, token: string, budget: number) =>
	post(port, "/api/commands", { key: crypto.randomUUID(),
		command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
			budget, deliveryEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }, token);

/** The event ids the webhook_events table holds, read on a connection that closes before the test moves on. */
const recordedEventIds = (dbPath: string): string[] => {
	const db = new DatabaseSync(dbPath);
	try { return db.prepare("SELECT id FROM webhook_events ORDER BY rowid").all().map(row => String(row.id)); }
	finally { db.close(); }
};

test("the platform is refused on every development route by name, the dev replay included, and an anonymous or signed-in client still reaches them", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-platform-dev-routes-"));
	const dbPath = join(dir, "test.db");
	const port = 4904;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, dbPath, dir);
		const maya = await session(port, "maya-client");
		const opened = await open(port, maya, 40_000);
		assert.equal(opened.status, 200);
		const committed = await opened.json() as { outcome: { kind: string; result?: { kind: string; job?: { id: string } } } };
		const jobId = committed.outcome.result?.job?.id;
		assert.ok(jobId, "the client opened a job");

		const minted = await post(port, "/api/platform/session", { key: "test-platform-key-0123456789abcdef" });
		assert.equal(minted.status, 201);
		const { token: platform } = await minted.json() as { token: string };

		const routes: [string, unknown][] = [
			["/api/dev/arbiter", { jobId, verdict: "UPHOLD", note: "The platform must not rule." }],
			["/api/dev/clock", { advanceMs: 86400000 }],
			["/api/dev/tick", {}],
			["/api/dev/fund-mode", { mode: "checkout" }],
		];
		for (const [path, payload] of routes) {
			const refused = await post(port, path, payload, platform);
			assert.equal(refused.status, 403, `${path} is refused to the platform`);
			assert.deepEqual(await refused.json(), { error: "PLATFORM_READ_ONLY" });
		}

		// The dev replay answers before the session gate, so the platform is refused there too, and the handler never runs: the
		// delivery it would record is absent. An anonymous replay and a client's replay both reach the handler and are recorded.
		const probe = (id: string) => ({ id, event_type: "CUSTOMER.DEV.PROBE", resource_type: "dev_probe", resource: { id: `PROBE-${id}` } });
		const before = recordedEventIds(dbPath);
		const platformReplay = await post(port, "/api/dev/paypal/webhook", probe("WH-DEV-PLATFORM-1"), platform);
		assert.equal(platformReplay.status, 403, "the dev replay is refused to the platform");
		assert.deepEqual(await platformReplay.json(), { error: "PLATFORM_READ_ONLY" });
		assert.deepEqual(recordedEventIds(dbPath), before, "the platform's replay records nothing: the handler did not run");
		assert.equal((await post(port, "/api/dev/paypal/webhook", probe("WH-DEV-ANON-1"))).status, 202, "an anonymous replay still reaches the handler");
		assert.equal((await post(port, "/api/dev/paypal/webhook", probe("WH-DEV-CLIENT-1"), maya)).status, 202, "a client's replay still reaches the handler");
		const after = recordedEventIds(dbPath);
		assert.ok(after.includes("WH-DEV-ANON-1"), "the anonymous delivery is recorded");
		assert.ok(after.includes("WH-DEV-CLIENT-1"), "the client's delivery is recorded");
		assert.ok(!after.includes("WH-DEV-PLATFORM-1"), "the refused delivery is not recorded");

		// The arbiter route still runs for a client: the core refuses the ruling on a job that is not disputed, so the answer is a
		// conflict, not the platform refusal. The tick still answers the client.
		const clientRuling = await post(port, "/api/dev/arbiter", { jobId, verdict: "UPHOLD", note: "The client is not the arbiter." }, maya);
		assert.equal(clientRuling.status, 409, "the arbiter route runs for a client and the core refuses the ruling");
		assert.notDeepEqual(await clientRuling.json(), { error: "PLATFORM_READ_ONLY" });
		const clientTick = await post(port, "/api/dev/tick", {}, maya);
		assert.equal(clientTick.status, 200);
		assert.deepEqual(await clientTick.json(), { ok: true });
	} finally {
		if (child && child.exitCode === null) {
			const exited = new Promise((r) => child!.once("exit", r));
			child.kill("SIGTERM");
			// Windows refuses to unlink the SQLite files while the server still holds them open.
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
