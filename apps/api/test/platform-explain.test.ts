// The platform explain route, served by the real server: the role gates, the figure check, and the shape of the
// answer. The boot carries fake PayPal credentials, and a fresh database has no ledger lines, so no figure here
// makes a PayPal read. The lines' PayPal mapping is tested in figure-trace.test.ts with a stubbed reconciliation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const PLATFORM_KEY = "test-platform-key-0123456789abcdef";

function bootServer(port: number, dbPath: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1", ACQUIT_PLATFORM_KEY: PLATFORM_KEY,
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret", WEB_ORIGIN: "http://localhost:5674",
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

test("the explain route refuses anonymous and non-platform sessions, and names an unknown figure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-explain-"));
	const port = 4899;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"));
		const url = `http://127.0.0.1:${port}/api/platform/explain?figure=fees`;
		assert.equal((await fetch(url)).status, 401, "an anonymous request is refused before the role check");

		const signedIn = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signedIn.status, 200);
		const { token: clientToken } = await signedIn.json() as { token: string };
		const client = await fetch(url, { headers: { authorization: `Bearer ${clientToken}` } });
		assert.equal(client.status, 403);
		assert.deepEqual(await client.json(), { error: "PLATFORM_ONLY" });

		const minted = await post(port, "/api/platform/session", { key: PLATFORM_KEY });
		assert.equal(minted.status, 201);
		const { token } = await minted.json() as { token: string };
		const unknown = await fetch(`http://127.0.0.1:${port}/api/platform/explain?figure=pass-rate`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(unknown.status, 400);
		assert.deepEqual(await unknown.json(), { error: "UNKNOWN_FIGURE", figures: ["held", "released", "refunded", "fees", "paid-by-clients"] });
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

test("the explain route answers every figure with its total and its line shape, and reads no PayPal object for an empty figure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-explain-"));
	const port = 4900;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"));
		const minted = await post(port, "/api/platform/session", { key: PLATFORM_KEY });
		const { token } = await minted.json() as { token: string };
		for (const figure of ["held", "released", "refunded", "fees", "paid-by-clients"]) {
			const answer = await fetch(`http://127.0.0.1:${port}/api/platform/explain?figure=${figure}`, { headers: { authorization: `Bearer ${token}` } });
			assert.equal(answer.status, 200, `${figure} is answered`);
			const text = await answer.text();
			const body = JSON.parse(text) as { figure: string; label: string; totalCents: number; lines: Record<string, unknown>[] };
			assert.equal(body.figure, figure);
			assert.equal(typeof body.label, "string");
			assert.equal(body.lines.reduce((sum, line) => sum + (line["cents"] as number), 0), body.totalCents, `${figure}: lines sum to the figure`);
			for (const line of body.lines) assert.deepEqual(Object.keys(line).sort(), ["at", "cents", "entryId", "jobId", "kind", "paypal", "receiptId"]);
			if (body.lines.length === 0) assert.equal(body.totalCents, 0, `${figure}: an empty figure totals zero`);
			assert.doesNotMatch(text, /merchant|payee|@/i, "the body names no merchant, payee, or email");
		}
	} finally {
		if (child && child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
