// The visitor cap keys on the real client address. The deployment's proxy (Caddy) answers
// X-Forwarded-For itself, so the first hop a client sends is a claim the client controls; the
// handler must read the proxy's own addition — the last hop — and the socket address when no
// header arrives. Driven through the production handler with in-memory request streams, like the
// approval race test: no listener binds, and every outbound door is refused before the module
// loads, so no fork, no network, and no child process can leave this process.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

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
	OPERATOR_DEVON_MERCHANT_ID: "test-demo-merchant",
	ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_ORG: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "",
	HOME: join(dir, "home"), FACTORY_API_KEY: "",
});
mkdirSync(join(dir, "home"), { recursive: true });
await import(join(root, "src/server.ts"));
if (!server) throw new Error("the API module never created its server");

after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

type Answer = { readonly status: number; readonly body: { readonly error?: string } };

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

test("a spoofed first X-Forwarded-For hop cannot leave the visitor cap's address", async () => {
	const address = "127.0.0.1";
	for (let i = 0; i < 3; i += 1) {
		const created = await startDemo(address);
		assert.equal(created.status, 201, `plain visitor ${i + 1} of 3 from ${address}`);
	}
	// What the proxy delivers for a client that sent its own first hop: the spoofed entry, then the
	// proxy's own answer for that same connection. The cap must read the proxy's answer.
	const spoofed = await startDemo(address, { "x-forwarded-for": "1.2.3.4, 127.0.0.1" });
	assert.equal(spoofed.status, 429, "the fourth visitor from one address is refused through the proxied header too");
	assert.equal(spoofed.body.error, "CAP_VISITORS_IP_DAY");
});

test("a proxied request lands in the same bucket a plain request from that address uses", async () => {
	const address = "127.0.0.2";
	for (let i = 0; i < 3; i += 1) {
		const created = await startDemo(address, { "x-forwarded-for": "5.6.7.8, 127.0.0.2" });
		assert.equal(created.status, 201, `proxied visitor ${i + 1} of 3 for ${address}`);
	}
	const plain = await startDemo(address);
	assert.equal(plain.status, 429, "the fourth visitor is refused when it arrives with no header at all");
	assert.equal(plain.body.error, "CAP_VISITORS_IP_DAY");
});

test("several X-Forwarded-For header lines still resolve to the last hop", async () => {
	const address = "127.0.0.3";
	for (let i = 0; i < 3; i += 1) {
		const created = await startDemo(address, { "x-forwarded-for": ["9.9.9.9", "127.0.0.3"] });
		assert.equal(created.status, 201, `array-header visitor ${i + 1} of 3 for ${address}`);
	}
	const plain = await startDemo(address);
	assert.equal(plain.status, 429, "the fourth visitor is refused: the array's last hop is the caller");
});
