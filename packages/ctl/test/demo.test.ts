// Judge mode's session boundary, driven over HTTP against the real API: public mode refuses the
// seeded handles, "Start my demo" mints a visitor whose two principals are the only pair it can read
// or switch between, and dev mode keeps today's seeded sign-in.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reachable, releaseSpawned, sleep } from "../src/process.ts";

const preload = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
/** The one network boundary of the isolated API: every fetch is recorded, and only PayPal answers. */
const fetchStub = `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init) => {
	appendFileSync(process.env.STUB_FETCH_LOG, JSON.stringify({ method: init?.method ?? "GET", url: String(input) }) + "\\n");
	if (String(input).startsWith("https://api-m.sandbox.paypal.com/v1/oauth2/token")) return Response.json({ access_token: "isolated-test-token", expires_in: 300 });
	return Response.json({ name: "RESOURCE_NOT_FOUND", debug_id: "isolated" }, { status: 404 });
};
`;
type VisitorBody = { readonly id: string; readonly client: string; readonly operator: string;
	readonly repository: string | null; readonly expiresAt: string };
type DemoBody = { readonly user: { readonly handle: string; readonly role: string }; readonly visitor: VisitorBody; readonly token: string };

async function apiFixture(dev: boolean, run: (url: string) => Promise<void>): Promise<void> {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "acquit-demo-test-"));
	const log = join(dir, "fetch.log");
	const listener = createServer();
	await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as { port: number }).port;
	await new Promise<void>(resolve => listener.close(() => resolve()));
	const child = spawn(process.execPath, ["--import", preload("Date.now=()=>1760000000000"), "--import", preload(fetchStub), "apps/api/src/server.ts"],
		{ cwd: root, stdio: "ignore", env: {
			...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: dev ? "1" : "0", PORT: String(port), WEB_ORIGIN: "http://localhost:5213",
			ACQUIT_HIDDEN_CASES: fileURLToPath(new URL("../../verifier/fixtures/hidden-cases.test.json", import.meta.url)),
			DATABASE_PATH: join(dir, "acquit.db"), PAYPAL_CLIENT_ID: "unit-test", PAYPAL_CLIENT_SECRET: "unit-test",
			OPERATOR_DEVON_MERCHANT_ID: "unit-merchant", STUB_FETCH_LOG: log,
		} });
	try {
		const deadline = Date.now() + 15_000;
		const url = `http://127.0.0.1:${port}`;
		while (!(await reachable(`${url}/api/session`))) {
			assert.equal(child.exitCode, null, "The isolated test API exited early.");
			assert(Date.now() < deadline, "The isolated test API failed readiness.");
			await sleep(50);
		}
		await run(url);
		const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(line => line !== "");
		assert.equal(calls.every(line => JSON.parse(line).url.startsWith("https://api-m.sandbox.paypal.com/")), true,
			`The isolated test API reached ${calls.join(", ")}`);
	} finally {
		await releaseSpawned(child);
		await rm(dir, { recursive: true, force: true });
	}
}
const post = (url: string, path: string, body: unknown, token?: string) => fetch(`${url}${path}`, { method: "POST",
	headers: { "Content-Type": "application/json", ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
const sessionOf = (url: string, token: string) => fetch(`${url}/api/session`, { headers: { Authorization: `Bearer ${token}` } })
	.then(response => response.json() as Promise<{ user: { handle: string; role: string } | null; visitor: VisitorBody | null }>);

test("public mode refuses a seeded handle and mints a visitor through Start my demo", async () => {
	await apiFixture(false, async url => {
		const seeded = await post(url, "/api/session", { handle: "maya-client" });
		assert.equal(seeded.status, 403);
		assert.equal((await seeded.json() as { error: string }).error, "SEEDED_LOGIN_DISABLED");
		const created = await post(url, "/api/demo", {});
		assert.equal(created.status, 201);
		const body = await created.json() as DemoBody;
		assert.equal(body.user.role, "CLIENT");
		assert.equal(body.user.handle, body.visitor.client);
		assert.notEqual(body.visitor.client, body.visitor.operator);
		assert.equal(body.visitor.repository, null);
		assert.equal(Date.parse(body.visitor.expiresAt), 1_760_000_000_000 + 86_400_000);
		const signed = await sessionOf(url, body.token);
		assert.deepEqual(signed.user, { handle: body.visitor.client, role: "CLIENT" });
		assert.equal(signed.visitor?.id, body.visitor.id);
	});
});

test("a visitor reads only its own pair and switches between its two principals", async () => {
	await apiFixture(false, async url => {
		const first = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const second = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const users = await fetch(`${url}/api/users`, { headers: { Authorization: `Bearer ${first.token}` } });
		assert.equal(users.status, 200);
		const mine = await users.json() as { users: { handle: string; role: string }[] };
		assert.deepEqual(mine, { users: [{ handle: first.visitor.client, role: "CLIENT" },
			{ handle: first.visitor.operator, role: "OPERATOR" }] });
		// The other visitor's pair is never visible through the first visitor's session.
		assert.equal(mine.users.some(user => user.handle === second.visitor.client || user.handle === second.visitor.operator), false);
		const switched = await post(url, "/api/demo/switch", {}, first.token);
		assert.equal(switched.status, 200);
		assert.deepEqual((await switched.json() as { user: { handle: string; role: string } }).user,
			{ handle: first.visitor.operator, role: "OPERATOR" });
		// The same token now acts as the operator: the switch moved the session, it did not mint one.
		assert.deepEqual((await sessionOf(url, first.token)).user, { handle: first.visitor.operator, role: "OPERATOR" });
		// The operator principal is a real operator row with its own agent and weekly grant.
		const operator = await fetch(`${url}/api/me/operator`, { headers: { Authorization: `Bearer ${first.token}` } });
		assert.equal(operator.status, 200);
		const operatorBody = await operator.json() as { operator: { handle: string }; agents: { id: string }[] };
		assert.equal(operatorBody.operator.handle, first.visitor.operator);
		assert.equal(operatorBody.agents.length, 1);
		const credits = await fetch(`${url}/api/me/credits`, { headers: { Authorization: `Bearer ${first.token}` } });
		assert.equal(credits.status, 200);
		assert.equal((await credits.json() as { credits: { available: number } }).credits.available, 30);
		// And back to the client principal.
		await post(url, "/api/demo/switch", {}, first.token);
		assert.deepEqual((await sessionOf(url, first.token)).user, { handle: first.visitor.client, role: "CLIENT" });
	});
});

test("public mode mints no session from a visitor handle, and dev mode keeps seeded sign-in", async () => {
	await apiFixture(false, async url => {
		const visitor = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const forged = await post(url, "/api/session", { handle: visitor.visitor.client });
		assert.equal(forged.status, 403);
		assert.equal((await forged.json() as { error: string }).error, "SESSION_MINT_DISABLED");
		const users = await fetch(`${url}/api/users`);
		assert.equal(users.status, 401);
	});
	await apiFixture(true, async url => {
		const signed = await post(url, "/api/session", { handle: "maya-client" });
		assert.equal(signed.status, 200);
		const body = await signed.json() as { user: { handle: string; role: string }; token: string };
		assert.deepEqual(body.user, { handle: "maya-client", role: "CLIENT" });
		assert.deepEqual(await (await fetch(`${url}/api/users`)).json(),
			{ users: [{ handle: "maya-client", role: "CLIENT" }, { handle: "devon-ops", role: "OPERATOR" }] });
		assert.deepEqual(await sessionOf(url, body.token), { user: { handle: "maya-client", role: "CLIENT" }, visitor: null });
	});
});
