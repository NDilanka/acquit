// The print demo routes as the production handler answers them. The API module is loaded in this process and
// driven through emitted requests, the way scenarios-wiring.test.ts drives it: no listener binds, and every
// outbound door is refused before the module loads, so no fork, no network, and no child process can leave this
// process. The honest run is the real print judge, run here in-process.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");

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

const dir = mkdtempSync(join(tmpdir(), "acquit-print-demo-route-"));
// loadEnvFile keeps variables that are already set, so the blanks here win over the worktree's .env: the
// App is not configured and no key is read from any home.
Object.assign(process.env, {
	DATABASE_PATH: join(dir, "test.db"), ACQUIT_DEV: "1", PORT: "4887", WEB_ORIGIN: "http://localhost:5675",
	ACQUIT_SCOPING_DIR: join(dir, "scoping"), ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
	PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
	OPERATOR_DEVON_MERCHANT_ID: "test-demo-merchant", ACQUIT_DEMO_ALLOW_IPS: "",
	ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_ORG: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "",
	HOME: join(dir, "home"), FACTORY_API_KEY: "",
});
mkdirSync(join(dir, "home"), { recursive: true });
await import(pathToFileURL(join(root, "src/server.ts")).href);
if (!server) throw new Error("the API module never created its server");

// The server keeps its SQLite file open for the life of the process, and Windows will not delete an open file.
after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left for the OS temp sweep */ } });

type Answer = { readonly status: number; readonly body: Record<string, unknown> };

/** One request through the real handler. The body, when given, is the JSON the route reads. */
function send(method: string, url: string, headers: Record<string, string>, payload?: unknown): Promise<Answer> {
	const req = new PassThrough();
	Object.assign(req, { method, url, headers, socket: { remoteAddress: "127.0.0.9" } });
	let finish!: (value: Answer) => void;
	const done = new Promise<Answer>(resolve => { finish = resolve; });
	const sent = { statusCode: 0 };
	const res = {
		setHeader: () => {},
		writeHead: (status: number) => { sent.statusCode = status; },
		end: (data?: unknown) => { finish({ status: sent.statusCode, body: data ? JSON.parse(String(data)) as Record<string, unknown> : {} }); },
	} as unknown as ServerResponse;
	server!.emit("request", req as unknown as IncomingMessage, res);
	req.end(payload === undefined ? undefined : JSON.stringify(payload));
	return done;
}

test("the print routes need a session: without one the answer is 401 UNAUTHENTICATED", async () => {
	assert.deepEqual(await send("POST", "/api/demo/print/runs", {}, { farm: "honest" }), { status: 401, body: { error: "UNAUTHENTICATED" } });
	assert.deepEqual(await send("GET", "/api/demo/print/runs/prt_nobody", {}), { status: 401, body: { error: "UNAUTHENTICATED" } });
});

test("the platform session is not a visitor, so a print run is refused as NOT_DEMO_VISITOR", async () => {
	const platform = await send("POST", "/api/platform/session", {}, { key: "test-platform-key-0123456789abcdef" });
	assert.equal(platform.status, 201);
	const bearer = { authorization: `Bearer ${String(platform.body.token)}` };
	assert.deepEqual(await send("POST", "/api/demo/print/runs", bearer, { farm: "honest" }), { status: 403, body: { error: "NOT_DEMO_VISITOR" } });
});

test("a visitor's unknown farm is 404 UNKNOWN_FARM, and a run id nobody holds is 404 NOT_FOUND", async () => {
	const created = await send("POST", "/api/demo", {}, {});
	assert.equal(created.status, 201);
	const bearer = { authorization: `Bearer ${String(created.body.token)}` };
	assert.deepEqual(await send("POST", "/api/demo/print/runs", bearer, { farm: "fraud:made-up" }), { status: 404, body: { error: "UNKNOWN_FARM" } });
	assert.deepEqual(await send("GET", "/api/demo/print/runs/prt_nobody", bearer), { status: 404, body: { error: "NOT_FOUND" } });
});

test("an honest run starts RUNNING, finishes DONE with a verified print, and opens no job in the core", async () => {
	const created = await send("POST", "/api/demo", {}, {});
	assert.equal(created.status, 201);
	const bearer = { authorization: `Bearer ${String(created.body.token)}` };
	const started = await send("POST", "/api/demo/print/runs", bearer, { farm: "honest" });
	assert.equal(started.status, 201);
	assert.equal(started.body.state, "RUNNING");
	assert.equal(started.body.farm, "honest");
	const runPath = `/api/demo/print/runs/${String(started.body.id)}`;

	let run = await send("GET", runPath, bearer);
	for (let attempt = 0; attempt < 240 && run.body.state === "RUNNING"; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 500));
		run = await send("GET", runPath, bearer);
	}
	assert.equal(run.status, 200);
	assert.equal(run.body.state, "DONE", JSON.stringify(run.body.failure));
	const result = run.body.result as { farm: { simulated: boolean }; qualification: { qualified: boolean }; certificate: unknown; print: { verdict: string; fraud: unknown } };
	assert.equal(result.farm.simulated, true);
	assert.equal(result.qualification.qualified, true);
	assert.ok(result.certificate);
	assert.equal(result.print.verdict, "VERIFIED");
	assert.equal(result.print.fraud, null);

	const jobs = await send("GET", "/api/jobs", bearer);
	assert.deepEqual(jobs.body.jobs, [], "the print run never opens a job in the core");
});
