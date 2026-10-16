// The scenario routes as the production handler answers them. The API module is loaded in this process
// and driven through emitted requests, the way demo-ip-key.test.ts drives it: no listener binds, and every
// outbound door is refused before the module loads, so no fork, no network, and no child process can leave
// this process. A run that would reach PayPal or GitHub is not started here: the names refused before any
// step, and the visitor's own run is only read.

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

const dir = mkdtempSync(join(tmpdir(), "acquit-scenario-wiring-"));
// loadEnvFile keeps variables that are already set, so the blanks here win over the worktree's .env: the
// App is not configured and no key is read from any home.
Object.assign(process.env, {
	DATABASE_PATH: join(dir, "test.db"), ACQUIT_DEV: "1", PORT: "4886", WEB_ORIGIN: "http://localhost:5675",
	ACQUIT_SCOPING_DIR: join(dir, "scoping"), ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
	PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
	OPERATOR_DEVON_MERCHANT_ID: "test-demo-merchant",
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

test("the scenario routes need a session: without one the answer is 401 UNAUTHENTICATED", async () => {
	assert.deepEqual(await send("POST", "/api/demo/scenarios/verified-and-paid", {}), { status: 401, body: { error: "UNAUTHENTICATED" } });
	assert.deepEqual(await send("GET", "/api/demo/scenarios/scn_nobody-holds-this", {}), { status: 401, body: { error: "UNAUTHENTICATED" } });
});

test("the platform session is not a visitor, so a scenario is refused as NOT_DEMO_VISITOR", async () => {
	const platform = await send("POST", "/api/platform/session", {}, { key: "test-platform-key-0123456789abcdef" });
	assert.equal(platform.status, 201);
	const bearer = { authorization: `Bearer ${String(platform.body.token)}` };
	assert.deepEqual(await send("POST", "/api/demo/scenarios/verified-and-paid", bearer, {}), { status: 403, body: { error: "NOT_DEMO_VISITOR" } });
});

test("a visitor's unknown scenario is 404 UNKNOWN_SCENARIO, and a run id nobody holds is 404 NOT_FOUND", async () => {
	const created = await send("POST", "/api/demo", {}, {});
	assert.equal(created.status, 201);
	const bearer = { authorization: `Bearer ${String(created.body.token)}` };
	assert.deepEqual(await send("POST", "/api/demo/scenarios/submit-everything", bearer, {}), { status: 404, body: { error: "UNKNOWN_SCENARIO" } });
	assert.deepEqual(await send("GET", "/api/demo/scenarios/scn_nobody-holds-this", bearer), { status: 404, body: { error: "NOT_FOUND" } });
});
