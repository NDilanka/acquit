// The approval's concurrency contract, through the production handler itself: two interleaved
// approvals both reach the guarded claim, exactly one wins and freezes, the loser is refused by
// name, and a private-file write failure leaves the draft parked — never an approval without its
// file. Modeled on validation/a1/scrutiny's approval-adjudication probe: the production
// createServer handler is driven with in-memory request streams, no listener binds, and every
// outbound door (network, child process) is refused before the module loads, so no live model
// call and no delivery can leave this process.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { instant } from "../../../packages/core/src/ids.ts";
import type { TestId } from "../../../packages/core/src/ids.ts";
import { hiddenManifest } from "../../../packages/verifier/hidden.ts";

const root = join(import.meta.dirname, "..");
const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4";
const now = instant("2026-10-14T12:00:00Z");

// The doors close before the API module loads: the handler under test is driven by emitted
// requests, and nothing it could start may leave this process.
const require_ = createRequire(import.meta.url);
const http = require_("node:http");
const net = require_("node:net");
const cp = require_("node:child_process");
let server: import("node:http").Server | null = null;
http.Server.prototype.listen = function (this: import("node:http").Server, ..._args: unknown[]) { server = this; return this; } as unknown as typeof http.Server.prototype.listen;
globalThis.fetch = async () => { throw new Error("test: network refused"); };
net.Socket.prototype.connect = function (..._args: unknown[]) { throw new Error("test: network refused"); } as unknown as typeof net.Socket.prototype.connect;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
	cp[name] = () => { throw new Error("test: child process refused"); };
}
syncBuiltinESMExports();

const dir = mkdtempSync(join(tmpdir(), "acquit-a1-race-"));
const scopingDir = join(dir, "scoping");
Object.assign(process.env, {
	DATABASE_PATH: join(dir, "test.db"), ACQUIT_DEV: "1", PORT: "4884", WEB_ORIGIN: "http://localhost:5673",
	ACQUIT_SCOPING_DIR: scopingDir, ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
	PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
	HOME: join(dir, "home"), FACTORY_API_KEY: "",
});
mkdirSync(join(dir, "home"), { recursive: true });
await import(join(root, "src/server.ts"));
if (!server) throw new Error("the API module never created its server");

after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

type Answer = { readonly status: number; readonly body: any };

/** One in-memory request through the production handler. The body is held until send() is called. */
function inject(method: string, path: string, token?: string) {
	const req = new PassThrough();
	Object.assign(req, { method, url: path,
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		socket: { remoteAddress: "127.0.0.1" } });
	let finish!: (value: Answer) => void;
	const done = new Promise<Answer>(resolve => { finish = resolve; });
	const sent = { statusCode: 0, headersSent: false };
	const headers: Record<string, string> = {};
	const res = {
		setHeader: (key: string, value: string) => { headers[key] = value; },
		writeHead: (status: number, responseHeaders?: Record<string, string>) => { sent.statusCode = status; sent.headersSent = true; Object.assign(headers, responseHeaders ?? {}); },
		end: (data?: unknown) => { finish({ status: sent.statusCode, body: data ? JSON.parse(String(data)) : null }); },
	} as unknown as ServerResponse;
	server!.emit("request", req as unknown as IncomingMessage, res);
	return { req, done, send(payload?: unknown): Promise<Answer> { req.end(payload === undefined ? undefined : JSON.stringify(payload)); return done; } };
}

const call = (method: string, path: string, payload: unknown, token?: string): Promise<Answer> => inject(method, path, token).send(payload);

const session = async (handle: string): Promise<string> => {
	const signed = await call("POST", "/api/session", { handle });
	assert.equal(signed.status, 200);
	return signed.body.token as string;
};

const openJob = async (token: string): Promise<string> => {
	const opened = await call("POST", "/api/commands", { key: crypto.randomUUID(),
		command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
			budget: 40000, deliveryEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }, token);
	assert.equal(opened.status, 200, `the open committed: ${JSON.stringify(opened.body)}`);
	return (opened.body as { outcome: { result: { job: { id: string } } } }).outcome.result.job.id;
};

/** Waits until the handler is reading this request's body, the spot the old check raced past. */
const waitReading = async (req: PassThrough): Promise<boolean> => {
	for (let i = 0; i < 400; i += 1) {
		if (req.listenerCount("readable") + req.listenerCount("data") > 0) return true;
		await new Promise(resolve => setImmediate(resolve));
	}
	return false;
};

/** The kick settles before the draft is parked: the pipeline never writes again once its row has
 * left DRAFTING, so the park below cannot be overwritten by a late pipeline failure. */
const settleRow = async (jobId: string): Promise<void> => {
	for (let i = 0; i < 200; i += 1) {
		const row = readRow(jobId);
		if (row && row.status !== "DRAFTING") return;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error("the scoping kick never settled");
};

const draftedCases = [
	{ id: "draft:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235", citation: "three decimals" },
	{ id: "draft:2", target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500", citation: "minor-unit count" },
	{ id: "draft:3", target: { module: "src/money.ts", export: "formatTotal" }, args: [2500, "KWD"], expected: "2.500", citation: "three decimals" },
];

/** Parks a draft for the job the way the pipeline would have: one row, one private file. */
const parkDraft = (jobId: string) => {
	const db = new DatabaseSync(join(dir, "test.db"));
	db.prepare("INSERT OR REPLACE INTO job_scoping VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(jobId, "AWAITING_APPROVAL",
		"Totals round wrong: BHD and its friends carry three decimals, and JPY keeps none.", JSON.stringify(draftedCases.map(test => test.id)),
		null, null, JSON.stringify({ candidates: 3, f1: 3, f2: 3, f3: 3, f4: 3, deduped: 3 }), now);
	db.close();
	mkdirSync(scopingDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(scopingDir, `${jobId}.json`), JSON.stringify({
		version: 1, jobId, repository: "maya-client/invoice-app",
		issue: { number: 12, title: "Totals round wrong for 3-decimal currencies" }, frozenAt: frozenCommit,
		contract: "Every total formats to the currency's own minor-unit count.", approved: null, cases: draftedCases,
	}, null, "\t"), { mode: 0o600 });
};

const readManifest = (jobId: string): { hiddenTests: string[]; hiddenManifest: string } | null => {
	const db = new DatabaseSync(join(dir, "test.db"));
	const row = db.prepare("SELECT json FROM job_manifests WHERE job_id = ?").get(jobId);
	db.close();
	return row ? JSON.parse(String(row.json)) : null;
};

const readRow = (jobId: string): { status: string; digest: string | null } | null => {
	const db = new DatabaseSync(join(dir, "test.db"));
	const row = db.prepare("SELECT status, digest FROM job_scoping WHERE job_id = ?").get(jobId);
	db.close();
	return row ? { status: String(row.status), digest: row.digest === null ? null : String(row.digest) } : null;
};

test("two interleaved approvals claim the freeze once, and the loser is refused by name", async () => {
	const maya = await session("maya-client");
	const jobId = await openJob(maya);
	await settleRow(jobId);
	parkDraft(jobId);

	const a = inject("POST", `/api/jobs/${jobId}/scoping/approve`, maya);
	const b = inject("POST", `/api/jobs/${jobId}/scoping/approve`, maya);
	assert.ok(await waitReading(a.req) && await waitReading(b.req), "both approvals reached the body read while the draft waited");

	const first = await a.send({ leaveOut: ["draft:3"] });
	assert.equal(first.status, 200, "the first claim freezes the cases it kept");
	const second = await b.send({ leaveOut: ["draft:1"] });
	assert.equal(second.status, 409, "the loser of the claim is refused, not silently second");
	assert.deepEqual((await second.body) as unknown, { error: "ALREADY_FROZEN" });
	const manifest = readManifest(jobId);
	assert.equal(manifest!.hiddenManifest, first.body.digest, "the frozen manifest is the winner's digest");
	assert.deepEqual(manifest!.hiddenTests, first.body.approvedIds, "the frozen manifest is the winner's set");
	assert.equal(readRow(jobId)!.digest, first.body.digest);
	const third = await call("POST", `/api/jobs/${jobId}/scoping/approve`, { leaveOut: [] }, maya);
	assert.equal(third.status, 409, "after the freeze every approval is refused the same way");
	const file = JSON.parse(readFileSync(join(scopingDir, `${jobId}.json`), "utf8")) as { approved: string | null; cases: readonly { id: string }[] };
	assert.ok(file.approved, "the private file records the approval");
	assert.deepEqual(file.cases.map(test => test.id), ["draft:1", "draft:2"], "the private file holds exactly the winner's cases");
});

test("a private-file write failure rolls the approval back: no approved state without its file", async () => {
	const maya = await session("maya-client");
	const jobId = await openJob(maya);
	await settleRow(jobId);
	parkDraft(jobId);
	const frozenAtOpen = readManifest(jobId);

	const pending = inject("POST", `/api/jobs/${jobId}/scoping/approve`, maya);
	assert.ok(await waitReading(pending.req), "the approval reached its body read");
	chmodSync(join(scopingDir, `${jobId}.json`), 0o400);
	const refused = await pending.send({ leaveOut: ["draft:3"] });
	chmodSync(join(scopingDir, `${jobId}.json`), 0o600);
	assert.equal(refused.status, 500, `a failed private-file write is an internal failure, not an approval: ${JSON.stringify(refused.body)}`);
	assert.equal(readRow(jobId)!.status, "AWAITING_APPROVAL", "the draft stays parked — nothing was approved");
	assert.deepEqual(readManifest(jobId), frozenAtOpen, "the manifest is untouched");
	const file = JSON.parse(readFileSync(join(scopingDir, `${jobId}.json`), "utf8")) as { approved: string | null };
	assert.equal(file.approved, null, "the private file was not rewritten");

	const retry = await call("POST", `/api/jobs/${jobId}/scoping/approve`, { leaveOut: ["draft:3"] }, maya);
	assert.equal(retry.status, 200, "the approval retries cleanly once the fault clears");
	const kept = draftedCases.filter(test => test.id !== "draft:3").map(({ id, target, args, expected }) => ({ id: id as TestId, target, args, expected }));
	assert.equal((retry.body as { digest: string }).digest, hiddenManifest(kept).digest);
});
