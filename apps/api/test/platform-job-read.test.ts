// The platform reads one job over real HTTP and sends no command. A signed-in client opens a job; the platform
// mint reads that job by id with 200 and sees no owner-only field, its job list stays empty, and each job command
// it sends is refused by name. The owner's own client still reads the job.

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

const get = (port: number, path: string, token: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });

const session = async (port: number, handle: string): Promise<string> => {
	const signed = await post(port, "/api/session", { handle });
	assert.equal(signed.status, 200);
	return (await signed.json() as { token: string }).token;
};

const open = (port: number, token: string, budget: number) =>
	post(port, "/api/commands", { key: crypto.randomUUID(),
		command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
			budget, deliveryEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }, token);

test("the platform reads one job and sends no command: the read is 200 with no owner field, the list is empty, and every command is refused", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-platform-job-read-"));
	const port = 4903;
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

		const read = await get(port, `/api/jobs/${jobId}`, platform);
		assert.equal(read.status, 200, "the platform reads the one job");
		const { job } = await read.json() as { job: { id: string; client: string | null; funding: string | null; clockShiftMs: number | null;
			viewerCanApprove: boolean; viewerCanDispute: boolean; approveUrl: string | null } };
		assert.equal(job.id, jobId);
		assert.equal(job.client, null, "the owning client is named only to its own session");
		assert.equal(job.funding, null);
		assert.equal(job.clockShiftMs, null);
		assert.equal(job.viewerCanApprove, false);
		assert.equal(job.viewerCanDispute, false);
		assert.equal(job.approveUrl, null);

		const owner = await get(port, `/api/jobs/${jobId}`, maya);
		assert.equal(owner.status, 200);
		assert.equal((await owner.json() as { job: { client: string | null } }).job.client, "maya-client");

		const listed = await get(port, "/api/jobs", platform);
		assert.equal(listed.status, 200);
		assert.deepEqual((await listed.json() as { jobs: unknown[] }).jobs, [], "the platform lists no job");

		const commands = [
			{ type: "CancelJob", jobId },
			{ type: "Submit", jobId, sourceCommit: "0042bbeb5d1e" },
			{ type: "Approve", jobId, mergeCommit: "0042bbeb5d1e" },
			{ type: "Dispute", jobId, mergeCommit: "0042bbeb5d1e", reason: "The fix breaks rounding." },
		];
		for (const command of commands) {
			const refused = await post(port, "/api/commands", { key: crypto.randomUUID(), command }, platform);
			assert.equal(refused.status, 403, `${command.type} is refused to the platform`);
			assert.deepEqual(await refused.json(), { error: "PLATFORM_READ_ONLY" });
		}
		const refusedOpen = await open(port, platform, 40_000);
		assert.equal(refusedOpen.status, 403, "OpenJob is refused to the platform");
		assert.deepEqual(await refusedOpen.json(), { error: "PLATFORM_READ_ONLY" });
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
