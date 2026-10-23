// The platform reads one job and holds no command, so every development route refuses its session by name: the arbiter route
// (which would run ResolveDispute as the arbiter), the clock, the tick, and the funding mode. The same routes still answer a
// signed-in client, so the refusal is the platform's alone.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("the platform is refused on every development route by name, and a signed-in client still reaches the same routes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-platform-dev-routes-"));
	const port = 4904;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"), dir);
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
