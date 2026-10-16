// The open-job budget floor over real HTTP. A budget under the seeded minimum is refused by name
// before any job opens, the seeded amount opens, and an operator's open is refused by the domain.

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
			budget, deliveryEndsAt: "2026-10-21T12:00:00Z" } }, token);

test("a budget under the seeded minimum is refused by name, the seeded amount opens, and an operator cannot open", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-u1-budget-"));
	const port = 4889;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"), dir);
		const maya = await session(port, "maya-client");
		const devon = await session(port, "devon-ops");

		for (const budget of [0, 1, 39_999]) {
			const refused = await open(port, maya, budget);
			assert.equal(refused.status, 400, `a budget of ${budget} cents is refused`);
			assert.deepEqual(await refused.json(), { error: "BUDGET_BELOW_MINIMUM", detail: "The budget must be at least 400.00 USD." });
		}

		const opened = await open(port, maya, 40_000);
		assert.equal(opened.status, 200, "the seeded minimum opens a job");
		const committed = await opened.json() as { outcome: { kind: string; result?: { kind: string } } };
		assert.equal(committed.outcome.result?.kind, "JOB");

		const operator = await open(port, devon, 40_000);
		assert.equal(operator.status, 409, "an operator's open is refused");
		const refusal = await operator.json() as { outcome: { kind: string; reason?: string } };
		assert.equal(refusal.outcome.kind, "DENIED");
		assert.equal(refusal.outcome.reason, "NOT_OWNER");
	} finally {
		child?.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
