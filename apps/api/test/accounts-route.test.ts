// Try Acquit accounts through the production handler: one click makes a lasting account with both roles, its
// session lasts 30 days and renews on use, the role switch stays inside the account, and a saved link restores it.
// The link's token travels only in a request body, a new link ends the old one, and every token that opens nothing
// answers the same 404. Requests are emitted with a chosen socket address and no listener binds; every outbound door
// is refused before the module loads. Only documentation addresses appear here.

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

// The API's clock reads Date.now, so this file moves time by moving this value.
let nowMs = Date.parse("2026-10-24T09:00:00.000Z");
Date.now = () => nowMs;

const dir = mkdtempSync(join(tmpdir(), "acquit-accounts-route-"));
Object.assign(process.env, {
	DATABASE_PATH: join(dir, "test.db"), ACQUIT_DEV: "1", PORT: "4889", WEB_ORIGIN: "http://localhost:5678",
	ACQUIT_SCOPING_DIR: join(dir, "scoping"), ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
	PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
	OPERATOR_DEVON_MERCHANT_ID: "test-demo-merchant", ACQUIT_DEMO_ALLOW_IPS: "",
	ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_ORG: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "",
	HOME: join(dir, "home"), FACTORY_API_KEY: "",
});
mkdirSync(join(dir, "home"), { recursive: true });
await import(pathToFileURL(join(root, "src/server.ts")).href);
if (!server) throw new Error("the API module never created its server");

after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left for the OS temp sweep */ } });

type Account = { readonly name: string | null; readonly client: string; readonly operator: string; readonly roles: readonly string[];
	readonly repository: string | null; readonly lasting: boolean; readonly recoveryLinkMade: boolean };
type Answer = { readonly status: number; readonly body: Record<string, unknown>; readonly cookie: string | null };
type Request = { readonly method: string; readonly url: string; readonly address?: string; readonly cookie?: string; readonly payload?: unknown };

/** One request through the real handler. `cookie` is the session token sent as the browser sends it. */
function send({ method, url, address = "192.0.2.1", cookie, payload }: Request): Promise<Answer> {
	const req = new PassThrough();
	Object.assign(req, { method, url, headers: cookie === undefined ? {} : { cookie: `theme=light; acquit_session=${cookie}` },
		socket: { remoteAddress: address } });
	let finish!: (value: Answer) => void;
	const done = new Promise<Answer>(resolve => { finish = resolve; });
	const sent = { statusCode: 0, cookie: null as string | null };
	const res = {
		setHeader: (name: string, value: string) => { if (name.toLowerCase() === "set-cookie") sent.cookie = value; },
		writeHead: (status: number) => { sent.statusCode = status; },
		end: (data?: unknown) => { finish({ status: sent.statusCode, cookie: sent.cookie,
			body: data ? JSON.parse(String(data)) as Record<string, unknown> : {} }); },
	} as unknown as ServerResponse;
	server!.emit("request", req as unknown as IncomingMessage, res);
	req.end(payload === undefined ? undefined : JSON.stringify(payload));
	return done;
}

const tokenOf = (cookie: string | null): string => /^acquit_session=([A-Za-z0-9_-]+);/.exec(cookie ?? "")?.[1] ?? "";
const maxAgeOf = (cookie: string | null): number => Number(/Max-Age=(\d+)/.exec(cookie ?? "")?.[1] ?? -1);

function read<T>(sql: string, ...params: string[]): T | undefined {
	const db = new DatabaseSync(process.env.DATABASE_PATH!, { readOnly: true });
	try { return db.prepare(sql).get(...params) as T | undefined; } finally { db.close(); }
}

/** One Try Acquit click: the account, and the session token its cookie carries. */
async function tryAcquit(address = "192.0.2.1"): Promise<{ readonly account: Account; readonly token: string }> {
	const made = await send({ method: "POST", url: "/api/accounts", address, payload: {} });
	assert.equal(made.status, 201);
	return { account: made.body.account as Account, token: tokenOf(made.cookie) };
}

test("Try Acquit makes a lasting account with both roles, a two-word name, and a 30-day session", async () => {
	nowMs = Date.parse("2026-10-24T09:00:00.000Z");
	const made = await send({ method: "POST", url: "/api/accounts", payload: {} });
	assert.equal(made.status, 201);
	const account = made.body.account as Account;
	assert.match(account.client, /^[a-z]+-[a-z]+(-[0-9a-f]{2})?$/);
	const [first = "", second = ""] = account.client.split("-");
	assert.deepEqual(account, { name: `${first[0]!.toUpperCase()}${first.slice(1)} ${second[0]!.toUpperCase()}${second.slice(1)}`,
		client: account.client, operator: `${account.client}-ops`, roles: ["CLIENT", "OPERATOR"], repository: null, lasting: true, recoveryLinkMade: false });
	assert.deepEqual(made.body.user, { handle: account.client, role: "CLIENT" });
	assert.equal("visitor" in made.body, false);
	assert.equal(maxAgeOf(made.cookie), 30 * 86_400);
	assert.equal(read<{ expires_at: string | null }>("SELECT expires_at FROM visitors WHERE client_handle = ?", account.client)?.expires_at, null);
	assert.equal(read<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE handle = ?", account.client)?.expires_at, "2026-11-23T09:00:00.000Z");
});

test("the old start route still answers, with the old visitor field beside the account", async () => {
	const made = await send({ method: "POST", url: "/api/demo", payload: {} });
	assert.equal(made.status, 201);
	const account = made.body.account as Account;
	const visitor = made.body.visitor as Record<string, unknown>;
	assert.deepEqual({ client: visitor.client, operator: visitor.operator, expiresAt: visitor.expiresAt },
		{ client: account.client, operator: account.operator, expiresAt: null });
});

test("the session read names the account, renews a used session, and an unused one ends after 30 days", async () => {
	nowMs = Date.parse("2026-10-24T09:00:00.000Z");
	const { account, token } = await tryAcquit();
	const read1 = await send({ method: "GET", url: "/api/session", cookie: token });
	assert.deepEqual({ user: read1.body.user, account: read1.body.account, visitor: "visitor" in read1.body },
		{ user: { handle: account.client, role: "CLIENT" }, account, visitor: false });
	// Twenty days on, a use moves the deadline to 30 days from then, and the cookie with it.
	nowMs = Date.parse("2026-11-13T09:00:00.000Z");
	const read2 = await send({ method: "GET", url: "/api/session", cookie: token });
	assert.equal((read2.body.user as { handle: string }).handle, account.client);
	assert.equal(read<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE handle = ?", account.client)?.expires_at, "2026-12-13T09:00:00.000Z");
	assert.equal(maxAgeOf(read2.cookie), 30 * 86_400);
	// Unused for 30 more days, the session ends. The account itself stays.
	nowMs = Date.parse("2026-12-13T09:00:01.000Z");
	assert.equal((await send({ method: "GET", url: "/api/session", cookie: token })).body.user, null);
	assert.equal(read<{ state: string }>("SELECT state FROM visitors WHERE client_handle = ?", account.client)?.state, "ACTIVE");
	nowMs = Date.parse("2026-10-24T09:00:00.000Z");
});

test("the role switch moves the session between the account's own two handles and nowhere else", async () => {
	const { account, token } = await tryAcquit();
	const toOperator = await send({ method: "POST", url: "/api/account/role", cookie: token, payload: { role: "OPERATOR" } });
	assert.deepEqual({ status: toOperator.status, user: toOperator.body.user }, { status: 200, user: { handle: account.operator, role: "OPERATOR" } });
	assert.deepEqual((await send({ method: "GET", url: "/api/session", cookie: token })).body.user, { handle: account.operator, role: "OPERATOR" });
	// Asking for the role it already has changes nothing.
	assert.deepEqual((await send({ method: "POST", url: "/api/account/role", cookie: token, payload: { role: "OPERATOR" } })).body.user,
		{ handle: account.operator, role: "OPERATOR" });
	for (const payload of [{ role: "PLATFORM" }, { role: "client" }, {}, { role: "CLIENT", handle: "maya-client" }]) {
		assert.equal((await send({ method: "POST", url: "/api/account/role", cookie: token, payload })).status, 400, JSON.stringify(payload));
	}
	assert.deepEqual((await send({ method: "POST", url: "/api/account/role", cookie: token, payload: { role: "CLIENT" } })).body.user,
		{ handle: account.client, role: "CLIENT" });
	const seeded = await send({ method: "POST", url: "/api/session", payload: { handle: "maya-client" } });
	assert.deepEqual(await send({ method: "POST", url: "/api/account/role", cookie: tokenOf(seeded.cookie), payload: { role: "OPERATOR" } }),
		{ status: 403, body: { error: "NOT_AN_ACCOUNT" }, cookie: null });
	assert.deepEqual(await send({ method: "POST", url: "/api/account/role", payload: { role: "OPERATOR" } }),
		{ status: 401, body: { error: "UNAUTHENTICATED" }, cookie: null });
});

test("a saved link restores its account as the client in a fresh browser", async () => {
	const { account, token } = await tryAcquit();
	await send({ method: "POST", url: "/api/account/role", cookie: token, payload: { role: "OPERATOR" } });
	const made = await send({ method: "POST", url: "/api/account/recovery", cookie: token, payload: {} });
	assert.equal(made.status, 200);
	const recoveryToken = String(made.body.recoveryToken);
	assert.match(recoveryToken, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(((await send({ method: "GET", url: "/api/session", cookie: token })).body.account as Account).recoveryLinkMade, true);
	const restored = await send({ method: "POST", url: "/api/account/restore", address: "192.0.2.20", payload: { token: recoveryToken } });
	assert.deepEqual({ status: restored.status, user: restored.body.user, name: (restored.body.account as Account).name, keys: Object.keys(restored.body) },
		{ status: 200, user: { handle: account.client, role: "CLIENT" }, name: account.name, keys: ["user", "account"] });
	const fresh = tokenOf(restored.cookie);
	assert.notEqual(fresh, token);
	assert.equal(maxAgeOf(restored.cookie), 30 * 86_400);
	assert.deepEqual((await send({ method: "GET", url: "/api/session", cookie: fresh })).body.user, { handle: account.client, role: "CLIENT" });
	// The link opens the account again and again until a new link replaces it.
	assert.equal((await send({ method: "POST", url: "/api/account/restore", address: "192.0.2.20", payload: { token: recoveryToken } })).status, 200);
});

test("a new link ends the old one, and every token that opens nothing answers the same 404", async () => {
	const { token } = await tryAcquit();
	const first = String((await send({ method: "POST", url: "/api/account/recovery", cookie: token })).body.recoveryToken);
	const second = String((await send({ method: "POST", url: "/api/account/recovery", cookie: token })).body.recoveryToken);
	assert.notEqual(first, second);
	const restore = (payload: unknown) => send({ method: "POST", url: "/api/account/restore", address: "192.0.2.30", payload });
	const notFound = { status: 404, body: { error: "NOT_FOUND" }, cookie: null };
	assert.deepEqual(await restore({ token: first }), notFound);
	for (const payload of [{ token: "" }, { token: "short" }, { token: "A".repeat(43) }, { token: 42 }, { token: null }, {}]) {
		assert.deepEqual(await restore(payload), notFound, JSON.stringify(payload));
	}
	assert.equal((await restore({ token: second })).status, 200);
});

test("a token in the address is never read: only the body restores", async () => {
	const { token } = await tryAcquit();
	const recoveryToken = String((await send({ method: "POST", url: "/api/account/recovery", cookie: token })).body.recoveryToken);
	assert.deepEqual(await send({ method: "POST", url: `/api/account/restore?token=${recoveryToken}`, address: "192.0.2.40", payload: {} }),
		{ status: 404, body: { error: "NOT_FOUND" }, cookie: null });
});

test("restoring while signed in as another account ends that session", async () => {
	const saved = await tryAcquit();
	const recoveryToken = String((await send({ method: "POST", url: "/api/account/recovery", cookie: saved.token })).body.recoveryToken);
	const other = await tryAcquit();
	const restored = await send({ method: "POST", url: "/api/account/restore", address: "192.0.2.50", cookie: other.token, payload: { token: recoveryToken } });
	assert.deepEqual(restored.body.user, { handle: saved.account.client, role: "CLIENT" });
	assert.equal((await send({ method: "GET", url: "/api/session", cookie: other.token })).body.user, null);
	assert.equal(read<{ state: string }>("SELECT state FROM visitors WHERE client_handle = ?", other.account.client)?.state, "ACTIVE");
});

test("one address gets ten restores per window, good token or bad, and another address is not held back", async () => {
	const { token } = await tryAcquit();
	const recoveryToken = String((await send({ method: "POST", url: "/api/account/recovery", cookie: token })).body.recoveryToken);
	for (let attempt = 0; attempt < 10; attempt++) {
		assert.equal((await send({ method: "POST", url: "/api/account/restore", address: "192.0.2.60", payload: { token: "B".repeat(43) } })).status, 404);
	}
	assert.deepEqual(await send({ method: "POST", url: "/api/account/restore", address: "192.0.2.60", payload: { token: recoveryToken } }),
		{ status: 429, body: { error: "RESTORE_LIMITED" }, cookie: null });
	assert.equal((await send({ method: "POST", url: "/api/account/restore", address: "192.0.2.61", payload: { token: recoveryToken } })).status, 200);
	nowMs += 15 * 60_000;
	assert.equal((await send({ method: "POST", url: "/api/account/restore", address: "192.0.2.60", payload: { token: recoveryToken } })).status, 200);
	nowMs = Date.parse("2026-10-24T09:00:00.000Z");
});

test("only an account makes a saved link: a seeded session and a signed-out caller are refused", async () => {
	const seeded = await send({ method: "POST", url: "/api/session", payload: { handle: "maya-client" } });
	assert.deepEqual(await send({ method: "POST", url: "/api/account/recovery", cookie: tokenOf(seeded.cookie) }),
		{ status: 403, body: { error: "NOT_AN_ACCOUNT" }, cookie: null });
	assert.deepEqual(await send({ method: "POST", url: "/api/account/recovery" }), { status: 401, body: { error: "UNAUTHENTICATED" }, cookie: null });
});

test("any route a lasting account uses renews its cookie with its session, once a day at most", async () => {
	nowMs = Date.parse("2026-10-24T09:00:00.000Z");
	const { token } = await tryAcquit();
	nowMs = Date.parse("2026-11-13T09:00:00.000Z");
	const renewed = await send({ method: "GET", url: "/api/jobs", cookie: token });
	assert.equal(renewed.status, 200);
	assert.equal(maxAgeOf(renewed.cookie), 30 * 86_400);
	// Within the day the row is not moved, so the answer carries no new cookie.
	nowMs += 60_000;
	assert.equal((await send({ method: "GET", url: "/api/jobs", cookie: token })).cookie, null);
	nowMs = Date.parse("2026-10-24T09:00:00.000Z");
});

test("the House client never holds a session: a mint is refused, and a row naming it opens nothing", async () => {
	assert.deepEqual(await send({ method: "POST", url: "/api/session", payload: { handle: "house-client" } }),
		{ status: 403, body: { error: "HOUSE_CLIENT_NO_SESSION" }, cookie: null });
	const forged = "house-client-forged-token-0123456789abcdef";
	const db = new DatabaseSync(process.env.DATABASE_PATH!);
	try {
		db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(createHash("sha256").update(forged).digest("hex"), "house-client", "2027-01-01T00:00:00.000Z");
	} finally { db.close(); }
	assert.equal((await send({ method: "GET", url: "/api/session", cookie: forged })).body.user, null);
	assert.deepEqual(await send({ method: "GET", url: "/api/jobs", cookie: forged }), { status: 401, body: { error: "UNAUTHENTICATED" }, cookie: null });
});

test("a new account opens with two starter jobs from the House client, and the job list reports the day's count", async () => {
	const { token } = await tryAcquit("192.0.2.70");
	await send({ method: "POST", url: "/api/account/role", cookie: token, payload: { role: "OPERATOR" } });
	const listed = await send({ method: "GET", url: "/api/jobs", cookie: token });
	assert.equal(listed.status, 200);
	const starters = (listed.body.jobs as { starter: boolean; client: string | null; budget: number }[]).filter(job => job.starter);
	assert.equal(starters.length, 2, JSON.stringify(listed.body.jobs));
	assert.deepEqual(listed.body.starters, { open: 2, openedToday: 2, dailyLimit: 6, capped: false });
	assert.equal(starters.every(job => job.client === null && job.budget === 40_000), true, JSON.stringify(starters));
});
