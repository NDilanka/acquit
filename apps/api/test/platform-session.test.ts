// The platform session mint over real HTTP: a holder of the deployment's key mints a session with no
// prior sign-in (public mode has no seeded sign-in to lean on), a wrong key is refused, and the
// ledger route answers the minted session and refuses everyone else. The route must sit before the
// API's session gate, or the mint is unreachable exactly when it is needed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function bootServer(port: number, dbPath: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673",
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

const post = (port: number, path: string, payload: unknown) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

test("the platform key mints a session with no prior sign-in, and only that session reads the ledger", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-platform-"));
	const port = 4877;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"));
		const minted = await post(port, "/api/platform/session", { key: "test-platform-key-0123456789abcdef" });
		assert.equal(minted.status, 201);
		const { user, token } = await minted.json() as { user: { handle: string; role: string }; token: string };
		assert.deepEqual(user, { handle: "platform", role: "PLATFORM" });

		const wrong = await post(port, "/api/platform/session", { key: "not-the-key" });
		assert.equal(wrong.status, 403);

		const ledger = await fetch(`http://127.0.0.1:${port}/api/platform/ledger`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(ledger.status, 200);
		const body = await ledger.json() as { jobs: unknown[]; now: string };
		assert.deepEqual(body.jobs, []);
		assert.ok(body.now);

		const anonymous = await fetch(`http://127.0.0.1:${port}/api/platform/ledger`);
		assert.equal(anonymous.status, 401);

		const signedIn = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signedIn.status, 200);
		const { token: clientToken } = await signedIn.json() as { token: string };
		const client = await fetch(`http://127.0.0.1:${port}/api/platform/ledger`, { headers: { authorization: `Bearer ${clientToken}` } });
		assert.equal(client.status, 403);
	} finally {
		if (child && child.exitCode === null) {
			const exited = new Promise((r) => child!.once("exit", r));
			child.kill("SIGTERM");
			// Windows refuses to unlink the SQLite files while the server still holds them open.
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
