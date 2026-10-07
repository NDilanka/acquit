// The work-repo credential route hands one operator a credential for one job. The stub GitHub records
// every mint body, so these tests pin that the route asks for exactly the job's work repository with
// contents: write and metadata: read, never the owner-wide token, and that a work repo GitHub has not
// created yet is the named not-ready refusal the CLI retries instead of a 502.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { createServer as probeServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const JOB = "job_7Q2K";
const WORK_REPO = "acquit-forks/invoice-app-7Q2K";
const AT = "2026-11-01T11:12:00.000Z";
/** The scoped and owner-wide mints answer different tokens, so the route's answer names which it asked for. */
const SCOPED_TOKEN = "ghs_" + "S".repeat(36);
const OWNER_TOKEN = "ghs_" + "O".repeat(36);

type Mint = { readonly path: string; readonly body: Record<string, unknown> };
type Stub = { readonly base: string; readonly mints: readonly Mint[]; exist(): void; close(): Promise<void> };

/** api.github.com, only for the two calls the route makes: the installation list and the mint. */
async function githubStub(): Promise<Stub> {
	const mints: Mint[] = [];
	let exists = false;
	const json = (response: ServerResponse, status: number, body: unknown): void => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
			const path = request.url ?? "";
			const posted = Buffer.concat(chunks).toString("utf8");
			if (request.method === "GET" && path.startsWith("/app/installations")) {
				return json(response, 200, [{ id: 42, account: { login: "acquit-forks", type: "Organization" } }]);
			}
			if (request.method === "POST" && path === "/app/installations/42/access_tokens") {
				const body = posted === "" ? {} : JSON.parse(posted) as Record<string, unknown>;
				mints.push({ path, body });
				if (!exists) {
					// GitHub's answer for a repositories entry the installation cannot see yet.
					return json(response, 422, { message: "Validation Failed",
						errors: [{ resource: "InstallationToken", field: "repositories", code: "invalid" }] });
				}
				return json(response, 201, { token: Array.isArray(body.repositories) ? SCOPED_TOKEN : OWNER_TOKEN,
					expires_at: new Date(Date.now() + 3_600_000).toISOString() });
			}
			json(response, 404, { message: "Not Found" });
		})().catch(() => json(response, 500, { message: "stub failure" }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, mints,
		exist: () => { exists = true; },
		close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function freePort(): Promise<number> {
	const probe = probeServer();
	await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", () => resolve()));
	const port = (probe.address() as AddressInfo).port;
	await new Promise<void>(resolve => probe.close(() => resolve()));
	return port;
}

async function waitFor(ready: () => Promise<boolean>, timeoutMs: number, log: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try { if (await ready()) return; } catch { /* the API is not up yet */ }
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out after ${timeoutMs} ms. API log tail: ${log().slice(-2000)}`);
}

type Api = { readonly url: string; readonly databasePath: string; readonly stub: Stub };

/** The real API process with the App configured against the stub GitHub, on an ephemeral port. */
async function apiFixture(run: (api: Api) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "acquit-work-repo-token-"));
	const stub = await githubStub();
	const port = await freePort();
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	let log = "";
	const child = spawn(process.execPath, [join(root, "apps/api/src/server.ts")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PORT: String(port), WEB_ORIGIN: `http://localhost:${port}`, DATABASE_PATH: join(dir, "acquit.db"),
			ACQUIT_DEV: "1", PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret",
			ACQUIT_GITHUB_APP_ID: "4242", ACQUIT_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			ACQUIT_GITHUB_APP_ORG: "acquit-forks", ACQUIT_GITHUB_API_BASE: stub.base, ACQUIT_CLIENT_REPOSITORY: "NDilanka/invoice-app" } });
	child.stdout?.on("data", (chunk: Buffer) => { log += String(chunk); });
	child.stderr?.on("data", (chunk: Buffer) => { log += String(chunk); });
	try {
		const url = `http://127.0.0.1:${port}`;
		await waitFor(async () => (await fetch(`${url}/api/users`)).ok, 20_000, () => log);
		await run({ url, databasePath: join(dir, "acquit.db"), stub });
	} finally {
		child.kill("SIGTERM");
		await once(child, "exit");
		await stub.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

/** A funded job locked to devon-ops: the accepted bid and the held escrow make that operator the owner. */
function heldRow(): unknown {
	return { id: JOB, version: 1, client: "maya-client", title: "Totals round wrong for 3-decimal currencies",
		contract: { budget: 40000, deliveryEndsAt: "2027-11-08T11:12:00.000Z" },
		bids: [{ id: "bid_test", operator: "devon-ops", handle: "devon-ops", kind: "INDEPENDENT", agent: "ts-bugfixer", runner: "claude-code",
			price: 40000, eta: 48, pitch: "test", placedAt: AT, status: "ACCEPTED" }],
		state: { status: "IN_PROGRESS", escrow: { payee: { operator: "devon-ops" }, book: [{ kind: "HELD", cents: 42000, at: AT }] },
			attempts: { phase: "WORKING", history: [] } } };
}

async function seedLockedJob(api: Api): Promise<void> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(api.databasePath);
	db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(JOB, JSON.stringify(heldRow()));
	db.close();
}

async function operatorSession(url: string): Promise<string> {
	const signedIn = await fetch(`${url}/api/session`, { method: "POST", body: JSON.stringify({ handle: "devon-ops" }) });
	assert.equal(signedIn.status, 200);
	return ((await signedIn.json()) as { token: string }).token;
}

const postToken = (url: string, token: string): Promise<Response> => fetch(`${url}/api/jobs/${JOB}/work-repo-token`,
	{ method: "POST", headers: { authorization: `Bearer ${token}` } });

test("the route mints one token scoped to exactly the job's work repo", { timeout: 60_000 }, async () => {
	await apiFixture(async api => {
		await seedLockedJob(api);
		const token = await operatorSession(api.url);
		api.stub.exist();
		const answer = await postToken(api.url, token);
		assert.equal(answer.status, 200);
		const body = await answer.json() as { repository: string; token: string };
		assert.equal(body.repository, WORK_REPO);
		// The stub distinguishes a scoped mint from an owner-wide one by its answer, so this token is
		// proof the route asked for the scope instead of the organization token.
		assert.equal(body.token, SCOPED_TOKEN);
		assert.deepEqual(api.stub.mints, [{ path: "/app/installations/42/access_tokens",
			body: { repositories: ["invoice-app-7Q2K"], permissions: { contents: "write", metadata: "read" } } }]);
	});
});

test("a work repo GitHub has not created yet answers WORK_REPO_NOT_READY, not 502", { timeout: 60_000 }, async () => {
	await apiFixture(async api => {
		await seedLockedJob(api);
		const token = await operatorSession(api.url);
		// The fork exists only after funding, so the scoped mint answers 422 while it does not.
		const missing = await postToken(api.url, token);
		assert.equal(missing.status, 503);
		const refusal = await missing.json() as { error: string; detail: string };
		assert.equal(refusal.error, "WORK_REPO_NOT_READY");
		assert.match(refusal.detail, /invoice-app-7Q2K/);
		// The retry after the repository exists succeeds, and the not-ready path never minted an
		// unscoped token: both requests carry the same scope.
		api.stub.exist();
		const retried = await postToken(api.url, token);
		assert.equal(retried.status, 200);
		assert.equal(((await retried.json()) as { token: string }).token, SCOPED_TOKEN);
		assert.deepEqual(api.stub.mints.map(mint => mint.body), [
			{ repositories: ["invoice-app-7Q2K"], permissions: { contents: "write", metadata: "read" } },
			{ repositories: ["invoice-app-7Q2K"], permissions: { contents: "write", metadata: "read" } },
		]);
	});
});
