import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reachable, sleep } from "../src/process.ts";

async function apiFixture(dev: boolean, run: (url: string) => Promise<void>): Promise<void> {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "acquit-api-test-"));
	const listener = createServer();
	await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as { port: number }).port;
	await new Promise<void>(resolve => listener.close(() => resolve()));
	// Inject a frozen wall clock before importing the server. No timing tolerance
	// or one-sided assertion can accidentally accept an ignored offset.
	const child = spawn(process.execPath, ["--import", "data:text/javascript,Date.now=()=>1760000000000", "apps/api/src/server.ts"], { cwd: root, stdio: "ignore", env: {
		...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: dev ? "1" : "0", PORT: String(port), WEB_ORIGIN: "http://localhost:5213",
		DATABASE_PATH: join(dir, "acquit.db"), PAYPAL_CLIENT_ID: "unit-test", PAYPAL_CLIENT_SECRET: "unit-test",
	} });
	const exited = once(child, "exit");
	try {
		const deadline = Date.now() + 15_000;
		const url = `http://127.0.0.1:${port}`;
		while (!(await reachable(`${url}/api/users`))) {
			assert.equal(child.exitCode, null, "The isolated test API exited early.");
			assert(Date.now() < deadline, "The isolated test API failed readiness.");
			await sleep(50);
		}
		await run(url);
	} finally {
		child.kill();
		await exited;
		await rm(dir, { recursive: true, force: true });
	}
}
test("development routes require the flag and the configured lane origin", async () => {
	await apiFixture(false, async url => {
		for (const path of ["clock", "fund-mode", "tick"]) {
			const response = await fetch(`${url}/api/dev/${path}`, { method: "POST", body: "{}" });
			assert.equal(response.status, 403);
			const error = await response.json() as { error: string; detail: string };
			assert.equal(error.error, "DEV_DISABLED");
			assert.match(error.detail, /ACQUIT_DEV=1/);
		}
	});
	await apiFixture(true, async url => {
		const denied = await fetch(`${url}/api/session`, { method: "POST", headers: { Origin: "http://localhost:5203" }, body: JSON.stringify({ handle: "maya-client" }) });
		assert.equal(denied.status, 403);
		assert.equal((await denied.json() as { error: string }).error, "ORIGIN_DENIED");
		const signedIn = await fetch(`${url}/api/session`, { method: "POST", headers: { Origin: "http://localhost:5213" }, body: JSON.stringify({ handle: "maya-client" }) });
		assert.equal(signedIn.status, 200);
		const auth = await signedIn.json() as { token: string };
		const post = (path: string, body: unknown) => fetch(`${url}/api/dev/${path}`, { method: "POST",
			headers: { Authorization: `Bearer ${auth.token}`, Origin: "http://localhost:5213", "Content-Type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await fetch(`${url}/api/dev/clock`, { method: "POST", body: '{"advanceMs":1}' })).status, 401);
		assert.equal((await post("clock", { advanceMs: -1 })).status, 400);
		assert.equal((await post("clock", { advanceMs: 1, unexpected: true })).status, 400);
		const advanced = await post("clock", { advanceMs: 14_400_000 });
		assert.equal(advanced.status, 200);
		const now = Date.parse((await advanced.json() as { now: string }).now);
		assert.equal(now, 1760000000000 + 14_400_000);
		const mode = await post("fund-mode", { mode: "card" });
		assert.equal(mode.status, 200);
		assert.deepEqual(await mode.json(), { mode: "card" });
		assert.equal((await post("fund-mode", { mode: "production" })).status, 400);
		// Sessions use the same clock for both issuance and expiry, including
		// sessions created after a development-time jump.
		const fresh = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle: "maya-client" }) });
		const freshAuth = await fresh.json() as { token: string };
		assert.equal((await post("clock", { advanceMs: 7 * 86400000 - 1 })).status, 200);
		assert.equal((await fetch(`${url}/api/me/credits`, { headers: { Authorization: `Bearer ${freshAuth.token}` } })).status, 403);
		assert.equal((await fetch(`${url}/api/me/credits`, { headers: { Authorization: `Bearer ${auth.token}` } })).status, 401);
		assert.equal((await fetch(`${url}/api/dev/clock`, { method: "POST", headers: { Authorization: `Bearer ${freshAuth.token}` }, body: '{"advanceMs":1}' })).status, 200);
		assert.equal((await fetch(`${url}/api/me/credits`, { headers: { Authorization: `Bearer ${freshAuth.token}` } })).status, 401);
	});
});
