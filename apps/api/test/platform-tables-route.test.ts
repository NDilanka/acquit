// The platform tables route over real HTTP: the platform role reads the seven relational tables the
// escrow dashboard queries, and every other holder is refused. The table keys are the contract the
// Studio sources bind to, so the test names them rather than reading whatever the body carries.

import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const TABLES = ["bids", "clients", "jobs", "ledger_entries", "operators", "paypal_events", "verdicts"];

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

test("the platform tables route serves the seven tables to the platform role and refuses everyone else", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-tables-"));
	const port = 4878;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"));
		const minted = await post(port, "/api/platform/session", { key: "test-platform-key-0123456789abcdef" });
		assert.equal(minted.status, 201);
		const { token } = await minted.json() as { token: string };

		const tables = await fetch(`http://127.0.0.1:${port}/api/platform/tables`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(tables.status, 200);
		const body = await tables.json() as { tables: Record<string, unknown[]>; now: string };
		assert.deepEqual(Object.keys(body.tables).sort(), TABLES);
		for (const name of TABLES) assert.ok(Array.isArray(body.tables[name]), `${name} is a table`);
		assert.ok(body.now);

		const anonymous = await fetch(`http://127.0.0.1:${port}/api/platform/tables`);
		assert.equal(anonymous.status, 401);

		const signedIn = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signedIn.status, 200);
		const { token: clientToken } = await signedIn.json() as { token: string };
		const client = await fetch(`http://127.0.0.1:${port}/api/platform/tables`, { headers: { authorization: `Bearer ${clientToken}` } });
		assert.equal(client.status, 403);
		assert.deepEqual(await client.json(), { error: "PLATFORM_ONLY" });
	} finally {
		// Windows keeps the SQLite file locked until the server process has exited.
		if (child && child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
