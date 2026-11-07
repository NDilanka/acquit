// The account that starts a judge scenario reads the job the run opened, over real HTTP. The run's job belongs to
// the run's own visitor, so the read reaches the requester alone, as the run's own client; another account gets
// NOT_OWNER. The server is a child process, so the run's wait for its House bid ends when the test stops it.

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
				OPERATOR_DEVON_MERCHANT_ID: "test-demo-merchant", ACQUIT_DEMO_ALLOW_IPS: "",
				ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_ORG: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "",
				WEB_ORIGIN: "http://localhost:5680", HOME: home, FACTORY_API_KEY: "",
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

const get = (port: number, path: string, token: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });

const account = async (port: number): Promise<string> => {
	const created = await post(port, "/api/accounts", {});
	assert.equal(created.status, 201);
	return (await created.json() as { token: string }).token;
};

test("the account that starts a judge scenario reads the run's job read-only, and another account is refused NOT_OWNER", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-scenario-owner-read-"));
	const port = 4905;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"), dir);
		const requester = await account(port);
		const stranger = await account(port);

		const started = await post(port, "/api/demo/scenarios/deadline-refund", {}, requester);
		assert.equal(started.status, 201, "the account starts a run");
		const { jobId } = await started.json() as { scenarioId: string; jobId: string };
		assert.match(jobId, /^job_/);

		const read = await get(port, `/api/jobs/${jobId}`, requester);
		assert.equal(read.status, 200, "the account reads the job its run opened");
		const { job } = await read.json() as { job: { id: string; client: string | null; viewerCanApprove: boolean } };
		assert.equal(job.id, jobId);
		assert.equal(job.client, null, "the read is the platform's view: the run's client is not named");
		assert.equal(job.viewerCanApprove, false, "the read offers no approve");

		// The grant reads the job and sends no command: the account's cancel is refused by the command's own owner check.
		const cancelled = await post(port, "/api/commands", { key: crypto.randomUUID(), command: { type: "CancelJob", jobId } }, requester);
		assert.equal(cancelled.status, 409);
		assert.deepEqual(await cancelled.json(), { outcome: { kind: "DENIED", reason: "NOT_OWNER" } });

		const refused = await get(port, `/api/jobs/${jobId}`, stranger);
		assert.equal(refused.status, 403);
		assert.deepEqual(await refused.json(), { error: "NOT_OWNER" });
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
