// The demo's address gate as the production handler answers it. ACQUIT_DEMO_ALLOW_IPS is set before the API
// module loads, and requests are emitted with a chosen socket address, the way demo-ip-key.test.ts drives the
// handler: no listener binds, and every outbound door is refused before the module loads. Only documentation
// addresses appear here.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

const dir = mkdtempSync(join(tmpdir(), "acquit-demo-private-"));
// loadEnvFile keeps variables that are already set, so the blanks here win over the worktree's .env: the App is
// not configured and no key is read from any home. The allowlist is this file's own, set before the module loads.
Object.assign(process.env, {
	DATABASE_PATH: join(dir, "test.db"), ACQUIT_DEV: "1", PORT: "4887", WEB_ORIGIN: "http://localhost:5676",
	ACQUIT_SCOPING_DIR: join(dir, "scoping"), ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
	PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
	OPERATOR_DEVON_MERCHANT_ID: "test-demo-merchant",
	ACQUIT_DEMO_ALLOW_IPS: "192.0.2.10, ,::ffff:198.51.100.7, 2001:db8::5",
	ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_ORG: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "",
	HOME: join(dir, "home"), FACTORY_API_KEY: "",
});
mkdirSync(join(dir, "home"), { recursive: true });
await import(pathToFileURL(join(root, "src/server.ts")).href);
if (!server) throw new Error("the API module never created its server");

// The server keeps its SQLite file open for the life of the process, and Windows will not delete an open file.
after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left for the OS temp sweep */ } });

const LISTED = "192.0.2.10";
const UNLISTED = "192.0.2.99";
const PRIVATE_BODY = { error: "DEMO_PRIVATE", detail: "The live demo is private for now." };

type Answer = { readonly status: number; readonly body: Record<string, unknown> };
type Request = { readonly method: string; readonly url: string; readonly address: string; readonly headers?: Record<string, string>; readonly payload?: unknown };

/** One request from `address` through the real handler. The payload, when given, is the JSON body. */
function send({ method, url, address, headers = {}, payload }: Request): Promise<Answer> {
	const req = new PassThrough();
	Object.assign(req, { method, url, headers, socket: { remoteAddress: address } });
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

/** The visitor rows the database holds, read beside the server so a refused start that wrote one would show. */
function visitorCount(): number {
	const db = new DatabaseSync(process.env.DATABASE_PATH!, { readOnly: true });
	try {
		return (db.prepare("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).n;
	} finally { db.close(); }
}

test("the access answer is open for a listed address and closed for another, signed out", async () => {
	assert.deepEqual(await send({ method: "GET", url: "/api/demo/access", address: LISTED }), { status: 200, body: { open: true } });
	assert.deepEqual(await send({ method: "GET", url: "/api/demo/access", address: UNLISTED }), { status: 200, body: { open: false } });
});

test("a listed address matches in its IPv4-mapped and IPv6 forms", async () => {
	assert.deepEqual(await send({ method: "GET", url: "/api/demo/access", address: "::ffff:198.51.100.7" }), { status: 200, body: { open: true } });
	assert.deepEqual(await send({ method: "GET", url: "/api/demo/access", address: "2001:db8::5" }), { status: 200, body: { open: true } });
});

test("the proxy's last X-Forwarded-For hop decides, so a spoofed first hop cannot open the demo", async () => {
	const spoofed = await send({ method: "GET", url: "/api/demo/access", address: "127.0.0.1", headers: { "x-forwarded-for": `${LISTED}, ${UNLISTED}` } });
	assert.deepEqual(spoofed, { status: 200, body: { open: false } });
});

test("a start from an address off the list is 403 DEMO_PRIVATE, and it writes no visitor", async () => {
	const before = visitorCount();
	assert.deepEqual(await send({ method: "POST", url: "/api/demo", address: UNLISTED, payload: {} }), { status: 403, body: PRIVATE_BODY });
	assert.equal(visitorCount(), before);
});

test("a scenario start from an address off the list is 403 DEMO_PRIVATE before any run's visitor is provisioned", async () => {
	const created = await send({ method: "POST", url: "/api/demo", address: LISTED, payload: {} });
	assert.equal(created.status, 201);
	const bearer = { authorization: `Bearer ${String(created.body.token)}` };
	const before = visitorCount();
	assert.deepEqual(await send({ method: "POST", url: "/api/demo/scenarios/verified-and-paid", address: UNLISTED, headers: bearer, payload: {} }),
		{ status: 403, body: PRIVATE_BODY });
	assert.equal(visitorCount(), before);
});
