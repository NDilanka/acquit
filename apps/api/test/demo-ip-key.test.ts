// A visitor row records the real client address as a digest. The deployment's proxy (Caddy) answers
// X-Forwarded-For itself, so the first hop a client sends is a claim the client controls; the
// handler must read the proxy's own addition — the last hop — and the socket address when no
// header arrives. Driven through the production handler with in-memory request streams, like the
// approval race test: no listener binds, and every outbound door is refused before the module
// loads, so no fork, no network, and no child process can leave this process.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");

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

const dir = mkdtempSync(join(tmpdir(), "acquit-demo-ip-"));
// loadEnvFile keeps variables that are already set, so the blanks here win over the worktree's
// .env: the App is not configured (no fork is ever asked for) and no key is read from any home.
Object.assign(process.env, {
	DATABASE_PATH: join(dir, "test.db"), ACQUIT_DEV: "1", PORT: "4885", WEB_ORIGIN: "http://localhost:5674",
	ACQUIT_SCOPING_DIR: join(dir, "scoping"), ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
	PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
	OPERATOR_DEVON_MERCHANT_ID: "test-demo-merchant", ACQUIT_DEMO_ALLOW_IPS: "",
	ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_ORG: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "",
	HOME: join(dir, "home"), FACTORY_API_KEY: "",
});
mkdirSync(join(dir, "home"), { recursive: true });
await import(pathToFileURL(join(root, "src/server.ts")).href);
if (!server) throw new Error("the API module never created its server");

after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

type Answer = { readonly status: number; readonly body: { readonly error?: string; readonly visitor?: { readonly id: string } } };

/** One Start-my-demo request from `address`, carrying exactly `headers`, through the real handler. */
function inject(address: string, headers: Record<string, string | string[]>) {
	const req = new PassThrough();
	Object.assign(req, { method: "POST", url: "/api/demo", headers, socket: { remoteAddress: address } });
	let finish!: (value: Answer) => void;
	const done = new Promise<Answer>(resolve => { finish = resolve; });
	const sent = { statusCode: 0 };
	const res = {
		setHeader: () => {},
		writeHead: (status: number) => { sent.statusCode = status; },
		end: (data?: unknown) => { finish({ status: sent.statusCode, body: data ? JSON.parse(String(data)) : null }); },
	} as unknown as ServerResponse;
	server!.emit("request", req as unknown as IncomingMessage, res);
	return { done, send(): Promise<Answer> { req.end(); return done; } };
}

const startDemo = (address: string, headers: Record<string, string | string[]> = {}) => inject(address, headers).send();

const keyOf = (address: string): string => createHash("sha256").update(address).digest("hex").slice(0, 16);

/** The address key the API stored for the visitor one request created. */
async function storedKey(address: string, headers: Record<string, string | string[]> = {}): Promise<string> {
	const created = await startDemo(address, headers);
	assert.equal(created.status, 201);
	const db = new DatabaseSync(process.env.DATABASE_PATH!, { readOnly: true });
	try {
		const row = db.prepare("SELECT ip_key FROM visitors WHERE id = ?").get(created.body.visitor!.id) as { readonly ip_key: string };
		return row.ip_key;
	} finally { db.close(); }
}

test("a spoofed first X-Forwarded-For hop cannot rename the visitor's address", async () => {
	// What the proxy delivers for a client that sent its own first hop: the spoofed entry, then the
	// proxy's own answer for that same connection. The key must be the proxy's answer.
	assert.equal(await storedKey("127.0.0.1", { "x-forwarded-for": "1.2.3.4, 127.0.0.1" }), keyOf("127.0.0.1"));
});

test("a request with no header is keyed by its socket address", async () => {
	assert.equal(await storedKey("127.0.0.2"), keyOf("127.0.0.2"));
});

test("several X-Forwarded-For header lines still resolve to the last hop", async () => {
	assert.equal(await storedKey("127.0.0.3", { "x-forwarded-for": ["9.9.9.9", "127.0.0.3"] }), keyOf("127.0.0.3"));
});
