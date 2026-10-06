// The verifier service's contract: a signed, replay-proof run boundary; one judge run per runId; and
// a real API that accepts the callback the service posts. The API case spawns the real server, seeds
// one funded job, submits over HTTP, and reads the projection the CLI prints.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeGitHubApp } from "../src/github.ts";
import { hours, instant, parseJobId } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, CommitSha, MerchantId, OperatorId, OrderId, TestId, Version } from "../src/ids.ts";
import { commercialSplit, reduceLedger, usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { quote } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import { TERMS, wakeAt } from "../src/job.ts";
import type { JobProjection, JobRow } from "../src/job.ts";
import type { DefinitionOfDone, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { createVerifierService } from "../../verifier/service.ts";
import type { VerifierService, VerifierServiceDeps } from "../../verifier/service.ts";
import { gitSource, hiddenManifest } from "../../verifier/judge.ts";
import { createHttpShell } from "../../verifier/server.ts";
import { dockerReachable, dockerSubject, subjectFor } from "../../verifier/subject.ts";
import { RUN_NONCE_HEADER, RUN_SIGNATURE_HEADER, RUN_TIMESTAMP_HEADER, runSignature } from "../../verifier/signing.ts";
import { renderSubmission } from "../../acquit-cli/src/submit.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = [process.env.ACQUIT_VERIFIER_FIXTURE,
	fileURLToPath(new URL("../../../../../acquit/scratch/verifier/invoice-app", import.meta.url))]
	.find(candidate => candidate !== undefined && existsSync(join(candidate, ".git"))) ?? null;

const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const honestCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const now = instant("2026-10-06T12:00:00Z");
const merchant = "sandbox-seller" as MerchantId;
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const runSecret = "run-secret-for-the-service-test";
const callbackSecret = "callback-secret-for-the-service-test";
const fixtureSkip = FIXTURE === null ? "Set ACQUIT_VERIFIER_FIXTURE to the invoice-app fixture." : false;

function definition(repository = "maya-client/invoice-app"): DefinitionOfDone {
	return { issue: { repository, number: 12, title: "Totals round wrong for 3-decimal currencies" },
		frozenAt: frozenCommit, frozenTests: Array.from({ length: 48 }, (_, index) => `frozen:${index + 1}` as TestId),
		hiddenManifest: hiddenManifest().digest, hiddenTests: hiddenManifest().cases.map(c => c.id),
		protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json", ".gitattributes", "**/.gitattributes"] as never };
}

function runRequest(runId: string, sourceCommit: CommitSha = honestCommit): VerifierRunRequest {
	return { runId: runId as VerifierRunId, jobId: parseJobId("job_svc_test"), ordinal: 1, sourceCommit, definitionOfDone: definition() };
}

function signed(body: string, options: { readonly secret?: string; readonly timestamp?: number; readonly nonce?: string } = {}): Request {
	const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
	const nonce = options.nonce ?? randomBytes(16).toString("hex");
	const secret = options.secret ?? runSecret;
	return new Request("http://verifier.test/runs", { method: "POST", headers: { "content-type": "application/json",
		[RUN_TIMESTAMP_HEADER]: timestamp, [RUN_NONCE_HEADER]: nonce,
		[RUN_SIGNATURE_HEADER]: `sha256=${runSignature(secret, timestamp, nonce, body)}` }, body });
}

function serviceFor(options: { readonly callbackUrl: string; readonly source?: VerifierServiceDeps["source"]; readonly subject?: VerifierServiceDeps["subject"] }): VerifierService {
	return createVerifierService({ runSecret, callback: { url: options.callbackUrl, secret: callbackSecret },
		subject: options.subject ?? subjectFor({ subject: "child", dev: true }), publisher: createFakeGitHubApp(),
		source: options.source ?? (async () => ({ source: gitSource(FIXTURE!), remove: () => {} })), log: () => {} });
}

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", () => resolve()));
	const port = (probe.address() as AddressInfo).port;
	await new Promise<void>(resolve => probe.close(() => resolve()));
	return port;
}

/** The service's own HTTP shell, exactly as the entrypoint builds it, on an ephemeral port. */
async function listen(service: VerifierService): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
			const answer = await service.handle(new Request(`http://127.0.0.1${request.url ?? "/"}`, { method: request.method,
				headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
				body: Buffer.concat(chunks) }));
			response.writeHead(answer.status, Object.fromEntries(answer.headers));
			response.end(await answer.text());
		})().catch(() => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "INTERNAL_ERROR" })); });
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	return { port, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("the run boundary refuses an unsigned, wrongly signed, stale, or replayed request by name", async () => {
	let sources = 0;
	// A refusal happens before any judging: the source is wired to a counter that must stay at zero.
	const service = serviceFor({ callbackUrl: "http://127.0.0.1:1/callback",
		source: async () => { sources++; throw new Error("source must not be called"); } });
	const body = JSON.stringify(runRequest("run_svc_boundary"));
	assert.deepEqual(await (await service.handle(new Request("http://verifier.test/runs", { method: "POST", body }))).json(), { error: "RUN_SIGNATURE_MISSING" });
	assert.deepEqual(await (await service.handle(signed(body, { secret: "wrong-secret" }))).json(), { error: "RUN_SIGNATURE_MISMATCH" });
	assert.deepEqual(await (await service.handle(signed(body, { timestamp: Math.floor(Date.now() / 1000) - 3_600 }))).json(), { error: "RUN_TIMESTAMP_STALE" });
	assert.equal(service.runs.size, 0);
	assert.equal(sources, 0);
	const first = signed(body);
	const accepted = await service.handle(first.clone());
	assert.equal(accepted.status, 202);
	const answer = await accepted.json() as { runId: string; accepted: boolean };
	assert.deepEqual([answer.runId, answer.accepted], ["run_svc_boundary", true]);
	// The same signed request delivered twice is a replay, not a retry: the nonce is inside the signature.
	const replayed = await service.handle(first.clone());
	assert.equal(replayed.status, 409);
	assert.deepEqual(await replayed.json(), { error: "RUN_REPLAYED" });
	assert.equal(service.runs.size, 1);
	await service.whenIdle();
	const record = service.runs.get("run_svc_boundary" as VerifierRunId)!;
	// A source that never arrives is a named refusal, and the service reports it to the API as RUN_FAILED.
	assert.match(record.refusal ?? "", /^SOURCE_UNAVAILABLE: source must not be called$/);
	assert.equal(record.outcome, null);
	assert.equal(record.callback, "UNDELIVERABLE");
	assert.equal(sources, 1);
	await service.close();
});

test("the callback route authenticates the bytes it was posted, not a re-encoding", { timeout: 60_000 }, async () => {
	const apiPort = await freePort();
	let log = "";
	const dir = await mkdtemp(join(tmpdir(), "acquit-callback-bytes-"));
	const databasePath = join(dir, "acquit.db");
	const store = new SqliteStore(databasePath);
	const row = heldRow();
	await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [], outbox: [],
		acknowledge: null, delivery: null, request: null });
	store.close();
	const api = spawn(process.execPath, [join(root, "apps/api/src/server.ts")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PORT: String(apiPort), WEB_ORIGIN: `http://localhost:${apiPort}`, DATABASE_PATH: databasePath,
			ACQUIT_DEV: "1", ACQUIT_VERIFIER_SUBJECT: "child", PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret",
			ACQUIT_VERIFIER_CI_URL: "http://127.0.0.1:1", ACQUIT_VERIFIER_RUN_SECRET: runSecret, ACQUIT_VERIFIER_CALLBACK_SECRET: callbackSecret,
			ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "", ACQUIT_GITHUB_APP_ORG: "" } });
	api.stdout?.on("data", (chunk: Buffer) => { log += String(chunk); });
	api.stderr?.on("data", (chunk: Buffer) => { log += String(chunk); });
	try {
		const base = `http://127.0.0.1:${apiPort}`;
		await waitFor(async () => (await fetch(`${base}/api/users`)).ok, 20_000, () => log);
		const login = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "devon-ops" }) });
		const token = (await login.json() as { token: string }).token;
		const submit = await fetch(`${base}/api/commands`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ key: randomUUID(), command: { type: "Submit", jobId: row.id, sourceCommit: honestCommit } }) });
		assert.equal(submit.status, 200);
		const verdict = { result: "VERIFIED", runId: "run_7Q2K_1", sourceCommit: honestCommit, mergeCommit: honestCommit,
			pullRequest: 13, frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 },
			reportDigest: "f".repeat(64), at: "2026-10-06T12:00:00.000Z" };
		// The service signs the exact bytes it posts, so valid JSON that is not the canonical
		// stringification of itself must still authenticate.
		const spaced = `{ "jobId": "job_7Q2K", "ordinal": 1, "report": ${JSON.stringify({ kind: "VERDICT", verdict })} }`;
		const sign = (body: string) => `sha256=${createHmac("sha256", callbackSecret).update(body).digest("hex")}`;
		const tampered = spaced.replace('"ordinal": 1', '"ordinal": 1 ');
		const refused = await fetch(`${base}/api/verifier/callback`, { method: "POST",
			headers: { "content-type": "application/json", "x-acquit-signature": sign(spaced) }, body: tampered });
		assert.equal(refused.status, 401);
		const accepted = await fetch(`${base}/api/verifier/callback`, { method: "POST",
			headers: { "content-type": "application/json", "x-acquit-signature": sign(spaced) }, body: spaced });
		assert.equal(accepted.status, 200);
		assert.deepEqual(await accepted.json(), { ok: true, applied: true });
		await waitFor(async () => (await jobView(base, token, row.id))?.status === "VERIFIED", 10_000, () => log);
	} finally {
		api.kill("SIGTERM");
		await once(api, "exit");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a rejection with hundreds of protected paths still ends the job REJECTED", { skip: fixtureSkip, timeout: 90_000 }, async () => {
	const apiPort = await freePort();
	let log = "";
	const changes = Array.from({ length: 600 }, (_, index) => ({ path: `.github/workflows/w${index}.yml`, status: "MODIFIED" as const,
		from: null, modeChanged: false, gitlink: false, binary: false, addedText: "" }));
	const wired = createVerifierService({ runSecret, callback: { url: `http://127.0.0.1:${apiPort}/api/verifier/callback`, secret: callbackSecret },
		subject: subjectFor({ subject: "child", dev: true }), publisher: createFakeGitHubApp(),
		source: async () => ({ remove: () => {},
			source: { readFile: (commit, path) => gitSource(FIXTURE!).readFile(commit, path), diff: () => ({ changes }),
				materialize: () => { throw new Error("a screen refusal must not materialize the tree"); } } }),
		log: line => { log += `[verifier] ${line}\n`; } });
	const shell = await listen(wired);
	const dir = await mkdtemp(join(tmpdir(), "acquit-service-many-reasons-"));
	const databasePath = join(dir, "acquit.db");
	const store = new SqliteStore(databasePath);
	const row = heldRow();
	await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [], outbox: [],
		acknowledge: null, delivery: null, request: null });
	store.close();
	const api = spawn(process.execPath, [join(root, "apps/api/src/server.ts")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PORT: String(apiPort), WEB_ORIGIN: `http://localhost:${apiPort}`, DATABASE_PATH: databasePath,
			ACQUIT_DEV: "1", ACQUIT_VERIFIER_SUBJECT: "child", PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret",
			ACQUIT_VERIFIER_CI_URL: `http://127.0.0.1:${shell.port}`, ACQUIT_VERIFIER_RUN_SECRET: runSecret, ACQUIT_VERIFIER_CALLBACK_SECRET: callbackSecret,
			ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "", ACQUIT_GITHUB_APP_ORG: "" } });
	api.stdout?.on("data", (chunk: Buffer) => { log += String(chunk); });
	api.stderr?.on("data", (chunk: Buffer) => { log += String(chunk); });
	try {
		const base = `http://127.0.0.1:${apiPort}`;
		await waitFor(async () => (await fetch(`${base}/api/users`)).ok, 20_000, () => log);
		const login = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "devon-ops" }) });
		const token = (await login.json() as { token: string }).token;
		const submit = await fetch(`${base}/api/commands`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ key: randomUUID(), command: { type: "Submit", jobId: row.id, sourceCommit: honestCommit } }) });
		assert.equal(submit.status, 200);
		const runId = "run_7Q2K_1" as VerifierRunId;
		await waitFor(async () => wired.runs.get(runId)?.phase === "FINISHED", 30_000, () => log);
		const record = wired.runs.get(runId)!;
		assert.equal(record.callback, "DELIVERED");
		const verdict = record.outcome?.kind === "VERDICT" ? record.outcome.verdict : null;
		assert.equal(verdict?.result, "REJECTED");
		const bounded = verdict?.result === "REJECTED" ? verdict : null;
		assert.equal(bounded?.reasonsTruncated, 600 - (bounded?.reasons.length ?? 0));
		assert.ok((bounded?.reasons.length ?? 0) < 600, "the reasons must be capped to fit the callback");
		await waitFor(async () => (await jobView(base, token, row.id))?.status === "IN_PROGRESS" && (await jobView(base, token, row.id))?.attempts.last === "REJECTED", 15_000, () => log);
		const view = await jobView(base, token, row.id);
		// A rejection charges the attempt exactly as any other rejection does.
		assert.equal(view?.attempts.used, 1);
		assert.equal(view?.attempts.left, 2);
		assert.equal(view?.attempts.last, "REJECTED");
		assert.deepEqual(view?.attempts.history.map(attempt => [attempt.ordinal, attempt.result]), [[1, "REJECTED"]]);
		assert.ok((view?.attempts.reasons.length ?? 0) > 0 && (view?.attempts.reasons.length ?? 0) < 600);
	} finally {
		api.kill("SIGTERM");
		await once(api, "exit");
		await shell.close();
		await wired.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a source failure's detail is bounded and stripped of token shapes before it is reported", async () => {
	const leaked = "ghs_SYNTHETIC_INSTALLATION_TOKEN";
	const deliveries: string[] = [];
	const target = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
			deliveries.push(Buffer.concat(chunks).toString("utf8"));
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, applied: true }));
		})();
	});
	await new Promise<void>(resolve => target.listen(0, "127.0.0.1", () => resolve()));
	const port = (target.address() as AddressInfo).port;
	const service = createVerifierService({ runSecret, callback: { url: `http://127.0.0.1:${port}/api/verifier/callback`, secret: callbackSecret },
		subject: subjectFor({ subject: "child", dev: true }), publisher: createFakeGitHubApp(),
		source: async () => { throw new Error(`SUBMITTED_COMMIT_UNFETCHABLE: https://x-access-token:${leaked}@github.com/acquit-forks/invoice-app-7Q2K.git`); },
		log: () => {} });
	try {
		assert.equal((await service.handle(signed(JSON.stringify(runRequest("run_svc_redact"))))).status, 202);
		await service.whenIdle();
		const record = service.runs.get("run_svc_redact" as VerifierRunId)!;
		assert.match(record.refusal ?? "", /^SOURCE_UNAVAILABLE: /);
		assert.equal(record.refusal?.includes(leaked), false);
		assert.ok((record.refusal?.length ?? 0) <= 300, `refusal is ${record.refusal?.length} characters`);
		assert.equal(deliveries.length, 1);
		assert.equal(deliveries[0]!.includes(leaked), false);
		const view = JSON.stringify(await (await service.handle(new Request("http://verifier.test/runs/run_svc_redact"))).json());
		assert.equal(view.includes(leaked), false);
	} finally {
		await service.close();
		await new Promise<void>(resolve => target.close(() => resolve()));
	}
});

test("a duplicate run id is accepted once and judged once", { skip: fixtureSkip }, async () => {
	let sources = 0;
	const service = serviceFor({ callbackUrl: "http://127.0.0.1:1/callback",
		source: async () => { sources++; return { source: gitSource(FIXTURE!), remove: () => {} }; } });
	assert.equal((await service.handle(signed(JSON.stringify(runRequest("run_svc_duplicate"))))).status, 202);
	const second = await service.handle(signed(JSON.stringify(runRequest("run_svc_duplicate"))));
	assert.equal(second.status, 202);
	const duplicate = await second.json() as { runId: string; accepted: boolean; phase: string };
	assert.equal(duplicate.runId, "run_svc_duplicate");
	assert.equal(duplicate.accepted, false);
	assert.ok(["QUEUED", "RUNNING"].includes(duplicate.phase), `unexpected phase ${duplicate.phase}`);
	await service.whenIdle();
	assert.equal(sources, 1);
	assert.equal(service.runs.size, 1);
	assert.equal(service.runs.get("run_svc_duplicate" as VerifierRunId)?.outcome?.kind, "VERDICT");
	await service.close();
});

test("the service judges a clean commit and posts a callback the real API applies", { skip: fixtureSkip, timeout: 60_000 }, async () => {
	const apiPort = await freePort();
	let log = "";
	const wired = createVerifierService({ runSecret, callback: { url: `http://127.0.0.1:${apiPort}/api/verifier/callback`, secret: callbackSecret },
		subject: subjectFor({ subject: "child", dev: true }), publisher: createFakeGitHubApp(),
		source: async () => ({ source: gitSource(FIXTURE!), remove: () => {} }), log: line => { log += `[verifier] ${line}\n`; } });
	const shell = await listen(wired);
	const dir = await mkdtemp(join(tmpdir(), "acquit-service-e2e-"));
	const databasePath = join(dir, "acquit.db");
	const store = new SqliteStore(databasePath);
	const row = heldRow();
	await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [], outbox: [],
		acknowledge: null, delivery: null, request: null });
	store.close();
	const api = spawn(process.execPath, [join(root, "apps/api/src/server.ts")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PORT: String(apiPort), WEB_ORIGIN: `http://localhost:${apiPort}`, DATABASE_PATH: databasePath,
			ACQUIT_DEV: "1", ACQUIT_VERIFIER_SUBJECT: "child", PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret",
			ACQUIT_VERIFIER_CI_URL: `http://127.0.0.1:${shell.port}`, ACQUIT_VERIFIER_RUN_SECRET: runSecret, ACQUIT_VERIFIER_CALLBACK_SECRET: callbackSecret,
			ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "", ACQUIT_GITHUB_APP_ORG: "" } });
	api.stdout?.on("data", (chunk: Buffer) => { log += String(chunk); });
	api.stderr?.on("data", (chunk: Buffer) => { log += String(chunk); });
	try {
		const base = `http://127.0.0.1:${apiPort}`;
		await waitFor(async () => (await fetch(`${base}/api/users`)).ok, 20_000, () => log);
		const login = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "devon-ops" }) });
		assert.equal(login.status, 200);
		const token = (await login.json() as { token: string }).token;
		const submit = await fetch(`${base}/api/commands`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ key: randomUUID(), command: { type: "Submit", jobId: row.id, sourceCommit: honestCommit } }) });
		assert.equal(submit.status, 200);
		const submitBody = await submit.text();
		assert.equal((JSON.parse(submitBody) as { outcome: { kind: string } }).outcome.kind, "COMMITTED");
		// The state machine names the run after the job and the attempt.
		const runId = "run_7Q2K_1" as VerifierRunId;
		await waitFor(async () => wired.runs.get(runId)?.phase === "FINISHED", 30_000, () => log);
		const record = wired.runs.get(runId)!;
		assert.equal(record.callback, "DELIVERED");
		assert.equal(record.outcome?.kind === "VERDICT" ? record.outcome.verdict.result : null, "VERIFIED");
		// The run view explains the wall time: every step of the judge reports its own milliseconds.
		const reported = await (await wired.handle(new Request(`http://verifier.test/runs/${runId}`))).json() as { timings?: Record<string, number> | null };
		assert.ok(reported.timings !== null && reported.timings !== undefined, "the run view reports the run's timings");
		assert.ok((reported.timings?.subjectMs ?? 0) > 0, `subjectMs ${reported.timings?.subjectMs} must bound a judged run`);
		assert.ok((reported.timings?.wallMs ?? 0) >= (reported.timings?.subjectMs ?? 0), "the wall time covers the subject");
		await waitFor(async () => (await jobView(base, token, row.id))?.status === "VERIFIED", 15_000, () => log);
		const view = await jobView(base, token, row.id);
		assert.equal(view?.pullRequest, 13);
		assert.deepEqual(view?.attempts.history.map(attempt => [attempt.ordinal, attempt.result]), [[1, "VERIFIED"]]);
		assert.equal(renderSubmission(view!, () => "devon-ops"), [
			"Submitted job_7Q2K (attempt 1 of 3)",
			"Verifier result: VERIFIED",
			"\tFrozen tests: 48 passed (suite frozen at a3b6ead)",
			"\tHidden tests: 6 passed",
			"\tRequired tests: 54 completed, 0 skipped or missing",
			"\tProtected paths: none touched",
			"Pull request opened: maya-client/invoice-app#13",
			"Job status: VERIFIED",
			"Client review window: 72 hours",
		].join("\n"));
	} finally {
		api.kill("SIGTERM");
		await once(api, "exit");
		await shell.close();
		await wired.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a source that never arrives posts a signed RUN_FAILED the real API applies at once", { timeout: 60_000 }, async () => {
	const apiPort = await freePort();
	let log = "";
	const wired = createVerifierService({ runSecret, callback: { url: `http://127.0.0.1:${apiPort}/api/verifier/callback`, secret: callbackSecret },
		subject: subjectFor({ subject: "child", dev: true }), publisher: createFakeGitHubApp(),
		source: async () => { throw new Error("SUBMITTED_COMMIT_UNFETCHABLE: acquit-forks/invoice-app-7Q2K 5cccb6651531: remote: Repository not found"); },
		log: line => { log += `[verifier] ${line}\n`; } });
	const shell = await listen(wired);
	const dir = await mkdtemp(join(tmpdir(), "acquit-service-failed-"));
	const databasePath = join(dir, "acquit.db");
	const store = new SqliteStore(databasePath);
	const row = heldRow();
	await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [], outbox: [],
		acknowledge: null, delivery: null, request: null });
	store.close();
	const api = spawn(process.execPath, [join(root, "apps/api/src/server.ts")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PORT: String(apiPort), WEB_ORIGIN: `http://localhost:${apiPort}`, DATABASE_PATH: databasePath,
			ACQUIT_DEV: "1", ACQUIT_VERIFIER_SUBJECT: "child", PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret",
			ACQUIT_VERIFIER_CI_URL: `http://127.0.0.1:${shell.port}`, ACQUIT_VERIFIER_RUN_SECRET: runSecret, ACQUIT_VERIFIER_CALLBACK_SECRET: callbackSecret,
			ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "", ACQUIT_GITHUB_APP_ORG: "" } });
	api.stdout?.on("data", (chunk: Buffer) => { log += String(chunk); });
	api.stderr?.on("data", (chunk: Buffer) => { log += String(chunk); });
	try {
		const base = `http://127.0.0.1:${apiPort}`;
		await waitFor(async () => (await fetch(`${base}/api/users`)).ok, 20_000, () => log);
		const login = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "devon-ops" }) });
		const token = (await login.json() as { token: string }).token;
		const submit = await fetch(`${base}/api/commands`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ key: randomUUID(), command: { type: "Submit", jobId: row.id, sourceCommit: honestCommit } }) });
		assert.equal(submit.status, 200);
		const runId = "run_7Q2K_1" as VerifierRunId;
		await waitFor(async () => wired.runs.get(runId)?.phase === "FINISHED", 30_000, () => log);
		const record = wired.runs.get(runId)!;
		assert.equal(record.callback, "DELIVERED");
		assert.equal(record.outcome, null);
		assert.match(record.refusal ?? "", /^SOURCE_UNAVAILABLE: SUBMITTED_COMMIT_UNFETCHABLE/);
		// The API applies it at once: the slot returns, no attempt is charged, and the reason is on the attempt.
		await waitFor(async () => (await jobView(base, token, row.id))?.phase === "READY", 15_000, () => log);
		const view = await jobView(base, token, row.id);
		assert.equal(view?.status, "IN_PROGRESS");
		assert.equal(view?.attempts.used, 0);
		assert.equal(view?.attempts.left, 3);
		assert.equal(view?.attempts.pending, null);
		assert.equal(view?.attempts.failure?.runId, runId);
		assert.equal(view?.attempts.failure?.sourceCommit, honestCommit);
		assert.equal(view?.attempts.failure?.name, "SOURCE_UNAVAILABLE");
		assert.match(view?.attempts.failure?.detail ?? "", /^SUBMITTED_COMMIT_UNFETCHABLE/);
	} finally {
		api.kill("SIGTERM");
		await once(api, "exit");
		await shell.close();
		await wired.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a publish that fails after a clean judgment posts a named RUN_FAILED the API applies", { skip: fixtureSkip, timeout: 60_000 }, async () => {
	const apiPort = await freePort();
	let log = "";
	const wired = createVerifierService({ runSecret, callback: { url: `http://127.0.0.1:${apiPort}/api/verifier/callback`, secret: callbackSecret },
		subject: subjectFor({ subject: "child", dev: true }),
		publisher: { publishVerified: async () => { throw new Error("no App installation on NDilanka/invoice-app"); } },
		source: async () => ({ source: gitSource(FIXTURE!), remove: () => {} }), log: line => { log += `[verifier] ${line}\n`; } });
	const shell = await listen(wired);
	const dir = await mkdtemp(join(tmpdir(), "acquit-service-publish-"));
	const databasePath = join(dir, "acquit.db");
	const store = new SqliteStore(databasePath);
	const row = heldRow();
	await store.commit({ job: { expectedVersion: null, row, wakeAt: wakeAt(row) }, operator: null, credits: [], outbox: [],
		acknowledge: null, delivery: null, request: null });
	store.close();
	const api = spawn(process.execPath, [join(root, "apps/api/src/server.ts")], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PORT: String(apiPort), WEB_ORIGIN: `http://localhost:${apiPort}`, DATABASE_PATH: databasePath,
			ACQUIT_DEV: "1", ACQUIT_VERIFIER_SUBJECT: "child", PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret",
			ACQUIT_VERIFIER_CI_URL: `http://127.0.0.1:${shell.port}`, ACQUIT_VERIFIER_RUN_SECRET: runSecret, ACQUIT_VERIFIER_CALLBACK_SECRET: callbackSecret,
			ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "", ACQUIT_GITHUB_APP_ORG: "" } });
	api.stdout?.on("data", (chunk: Buffer) => { log += String(chunk); });
	api.stderr?.on("data", (chunk: Buffer) => { log += String(chunk); });
	try {
		const base = `http://127.0.0.1:${apiPort}`;
		await waitFor(async () => (await fetch(`${base}/api/users`)).ok, 20_000, () => log);
		const login = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "devon-ops" }) });
		const token = (await login.json() as { token: string }).token;
		const submit = await fetch(`${base}/api/commands`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ key: randomUUID(), command: { type: "Submit", jobId: row.id, sourceCommit: honestCommit } }) });
		assert.equal(submit.status, 200);
		const runId = "run_7Q2K_1" as VerifierRunId;
		await waitFor(async () => wired.runs.get(runId)?.phase === "FINISHED", 30_000, () => log);
		const record = wired.runs.get(runId)!;
		assert.equal(record.callback, "DELIVERED");
		// The judgment was clean and the publisher refused: the run names that step, not the worker.
		assert.equal(record.outcome?.kind === "RUN_FAILED" ? record.outcome.failure?.name : null, "PUBLISH_FAILED");
		assert.match(record.outcome?.kind === "RUN_FAILED" ? record.outcome.failure?.detail ?? "" : "", /no App installation/);
		// The API applies it at once: the slot returns, no attempt is charged, and the name is on the attempt.
		await waitFor(async () => (await jobView(base, token, row.id))?.phase === "READY", 15_000, () => log);
		const view = await jobView(base, token, row.id);
		assert.equal(view?.status, "IN_PROGRESS");
		assert.equal(view?.attempts.used, 0);
		assert.equal(view?.attempts.left, 3);
		assert.equal(view?.attempts.pending, null);
		assert.equal(view?.attempts.failure?.name, "PUBLISH_FAILED");
		assert.match(view?.attempts.failure?.detail ?? "", /no App installation/);
	} finally {
		api.kill("SIGTERM");
		await once(api, "exit");
		await shell.close();
		await wired.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("the shell answers 413 on a declared over-cap body before it is read", async () => {
	const service = serviceFor({ callbackUrl: "http://127.0.0.1:1/callback", source: async () => { throw new Error("unused"); } });
	const server = createServer(createHttpShell(service, 0));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	try {
		const answer = await new Promise<string>((resolve, reject) => {
			const socket = connect(port, "127.0.0.1");
			let seen = "";
			socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error(`no answer; saw ${JSON.stringify(seen.slice(0, 120))}`)); });
			socket.on("connect", () => {
				socket.write("POST /runs HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 10000000\r\n\r\n");
				socket.write("x".repeat(4_096));
			});
			socket.on("data", chunk => {
				seen += String(chunk);
				if (seen.includes("\r\n\r\n")) { socket.destroy(); resolve(seen); }
			});
			socket.on("error", reject);
		});
		assert.match(answer, /^HTTP\/1\.1 413 /);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		await service.close();
	}
});

test("the lane's HTTP shell answers a GET probe, a run lookup, and a refusal", async () => {
	// The shell is the entrypoint a lane runs, so a GET must not be built with an empty body:
	// Request refuses one, and the probe a lane gates readiness on would answer 500 forever.
	const service = serviceFor({ callbackUrl: "http://127.0.0.1:1/callback", source: async () => { throw new Error("unused"); } });
	const server = createServer(createHttpShell(service, 0));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	try {
		const health = await fetch(`http://127.0.0.1:${port}/healthz`);
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), { ok: true, queued: 0, running: 0, runs: 0, phase: "READY" });
		const missing = await fetch(`http://127.0.0.1:${port}/runs/run_absent`);
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: "RUN_NOT_FOUND" });
		// An unsigned POST is refused by the boundary, not by the shell.
		const refused = await fetch(`http://127.0.0.1:${port}/runs`, { method: "POST", body: "{}" });
		assert.equal(refused.status, 401);
		assert.deepEqual(await refused.json(), { error: "RUN_SIGNATURE_MISSING" });
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		await service.close();
	}
});

test("the Docker subject verifies the honest fix", { skip: fixtureSkip !== false ? fixtureSkip : dockerReachable() ? false : "Docker is not reachable.", timeout: 60_000 }, async () => {
	const deliveries: string[] = [];
	const target = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
			deliveries.push(Buffer.concat(chunks).toString("utf8"));
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, applied: true }));
		})();
	});
	await new Promise<void>(resolve => target.listen(0, "127.0.0.1", () => resolve()));
	const port = (target.address() as AddressInfo).port;
	const service = createVerifierService({ runSecret, callback: { url: `http://127.0.0.1:${port}/api/verifier/callback`, secret: callbackSecret },
		subject: dockerSubject(), publisher: createFakeGitHubApp(), source: async () => ({ source: gitSource(FIXTURE!), remove: () => {} }), log: () => {} });
	try {
		assert.equal((await service.handle(signed(JSON.stringify(runRequest("run_svc_docker"))))).status, 202);
		await service.whenIdle();
		const record = service.runs.get("run_svc_docker" as VerifierRunId)!;
		assert.equal(record.callback, "DELIVERED");
		const verdict = record.outcome?.kind === "VERDICT" ? record.outcome.verdict : null;
		assert.equal(verdict?.result, "VERIFIED");
		assert.deepEqual(verdict?.result === "VERIFIED" ? verdict.frozen : null, { expected: 48, passed: 48 });
		assert.deepEqual(verdict?.result === "VERIFIED" ? verdict.hidden : null, { expected: 6, passed: 6 });
		assert.equal(deliveries.length, 1);
	} finally {
		await service.close();
		await new Promise<void>(resolve => target.close(() => resolve()));
	}
});

/** A job that is funded, locked to devon-ops, and ready for its first attempt. */
function heldRow(): JobRow {
	const capture = { orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"), platformFee: usd("44.85"),
		sellerNet: usd("360.00"), capturedAt: now };
	const book = reduceLedger([], { kind: "Hold", gross: capture.gross, at: now });
	if ("kind" in book) throw new Error(book.law);
	return { id: parseJobId("job_7Q2K"), version: 1 as Version, client: "maya-client" as ClientId,
		title: "Totals round wrong for 3-decimal currencies", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt: instant("2027-11-08T10:00:00Z"), definitionOfDone: definition(), terms: TERMS },
		bids: [{ id: "bid_submit" as never, operator: "devon-ops" as OperatorId, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant,
			agent: "ts-bugfixer" as AgentId, runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "test", placedAt: now,
			respondBy: instant("2027-10-09T12:00:00Z"), status: "ACCEPTED" }],
		state: { status: "IN_PROGRESS", escrow: { payee: { bidId: "bid_submit" as never, operator: "devon-ops" as OperatorId, payee: merchant,
			agent: "ts-bugfixer" as AgentId, price: usd("400.00"), eta: hours(48) }, quote: quote(commercialSplit(usd("400.00")), model),
			capture, book, cutoffAt: instant("2027-10-27T12:00:00Z") }, attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } } };
}

async function jobView(base: string, token: string, jobId: string): Promise<JobProjection | null> {
	const response = await fetch(`${base}/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${token}` } });
	if (!response.ok) return null;
	return (await response.json() as { job: JobProjection }).job;
}

async function waitFor(ready: () => Promise<boolean>, timeoutMs: number, log: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try { if (await ready()) return; } catch { /* the service or the API is not up yet */ }
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out after ${timeoutMs} ms. API log tail: ${log().slice(-2000)}`);
}
