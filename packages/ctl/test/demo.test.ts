// Judge mode's session boundary, driven over HTTP against the real API: public mode refuses the
// seeded handles, "Start my demo" mints a visitor whose two principals are the only pair it can read
// or switch between, and dev mode keeps today's seeded sign-in. The visitor's own job is the only
// job its card funding and its clock reach.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
type JobBody = { readonly job: { readonly id: string; readonly phase: string; readonly funding: string | null; readonly deliveryEndsAt: string } };
/** One job of the visitor's own, opened by its client principal: the fixture repository and issue 12. */
async function openVisitorJob(url: string, token: string): Promise<string> {
	const response = await post(url, "/api/commands", { key: randomUUID(), command: { type: "OpenJob",
		repository: "maya-client/invoice-app", issueNumber: 12, budget: 40000, deliveryEndsAt: "2025-10-20T12:00:00.000Z" } }, token);
	const body = await response.json() as { outcome: { kind: string; result?: { job: { id: string } } } };
	assert.equal(body.outcome.kind, "COMMITTED", JSON.stringify(body));
	return body.outcome.result!.job.id;
}
const jobOf = async (url: string, jobId: string, token: string): Promise<{ status: number; body: JobBody }> => {
	const response = await fetch(`${url}/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${token}` } });
	return { status: response.status, body: await response.json() as JobBody };
};
/** The visitor's operator bids on its own client's job, and the session returns to the client. */
async function placeBid(url: string, token: string, jobId: string): Promise<string> {
	await post(url, "/api/demo/switch", {}, token);
	const me = await fetch(`${url}/api/me/operator`, { headers: { Authorization: `Bearer ${token}` } })
		.then(response => response.json() as Promise<{ agents: { id: string }[] }>);
	const response = await post(url, "/api/commands", { key: randomUUID(), command: { type: "PlaceBid", jobId,
		price: 40000, eta: 48, agent: me.agents[0].id, pitch: "judge mode fixture" } }, token);
	const body = await response.json() as { outcome: { kind: string; result?: { bid?: string } } };
	assert.equal(body.outcome.kind, "COMMITTED", JSON.stringify(body));
	await post(url, "/api/demo/switch", {}, token);
	return body.outcome.result!.bid!;
}

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

test("a visitor's job funds with the test card until its client chooses otherwise, and the choice binds at accept", async () => {
	await apiFixture(false, async url => {
		const visitor = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const other = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const jobId = await openVisitorJob(url, visitor.token);
		// A judge has no sandbox buyer account, so a visitor's job starts on the test card.
		const fresh = await jobOf(url, jobId, visitor.token);
		assert.equal(fresh.status, 200);
		assert.equal(fresh.body.job.funding, "card");
		// An open job is public to read, but its funding is served to its own client and its choice is refused to everyone else.
		const stranger = await jobOf(url, jobId, other.token);
		assert.equal(stranger.status, 200);
		assert.equal(stranger.body.job.funding, null);
		assert.equal((await post(url, `/api/jobs/${jobId}/funding`, { mode: "checkout" }, other.token)).status, 403);
		assert.equal((await post(url, `/api/jobs/${jobId}/funding`, { mode: "checkout" }, other.token)
			.then(response => response.json() as Promise<{ error: string }>)).error, "NOT_VISITOR_JOB");
		// The client may switch to the sandbox checkout while the job still takes bids.
		const chosen = await post(url, `/api/jobs/${jobId}/funding`, { mode: "checkout" }, visitor.token);
		assert.equal(chosen.status, 200);
		assert.deepEqual(await chosen.json(), { mode: "checkout" });
		assert.equal((await jobOf(url, jobId, visitor.token)).body.job.funding, "checkout");
		// An accepted bid binds the source: the order is queued with what the job held, and the choice is closed.
		const bidId = await placeBid(url, visitor.token, jobId);
		const accepted = await post(url, "/api/commands", { key: randomUUID(), command: { type: "AcceptBid", jobId, bidId } }, visitor.token);
		assert.equal(accepted.status, 200);
		assert.equal((await jobOf(url, jobId, visitor.token)).body.job.phase, "FUNDING");
		const bound = await post(url, `/api/jobs/${jobId}/funding`, { mode: "card" }, visitor.token);
		assert.equal(bound.status, 409);
		assert.equal((await bound.json() as { error: string }).error, "FUNDING_BOUND");
		// An unknown job, and a mode outside the closed set.
		assert.equal((await post(url, "/api/jobs/job_NOPE/funding", { mode: "card" }, visitor.token)).status, 404);
		assert.equal((await post(url, `/api/jobs/${jobId}/funding`, { mode: "cash" }, visitor.token)).status, 400);
	});
});

test("a visitor advances its own job's clock and no other visitor's", async () => {
	const day = 86_400_000;
	await apiFixture(false, async url => {
		const first = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const second = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const mine = await openVisitorJob(url, first.token);
		const theirs = await openVisitorJob(url, second.token);
		assert.equal((await fetch(`${url}/api/jobs/${mine}/clock`, { method: "POST",
			headers: { "Content-Type": "application/json" }, body: JSON.stringify({ advanceMs: day }) })).status, 401);
		assert.equal((await post(url, "/api/jobs/job_NOPE/clock", { advanceMs: day }, first.token)).status, 404);
		const refused = await post(url, `/api/jobs/${mine}/clock`, { advanceMs: day }, second.token);
		assert.equal(refused.status, 403);
		assert.equal((await refused.json() as { error: string }).error, "NOT_VISITOR_JOB");
		const before = (await jobOf(url, theirs, second.token)).body.job.deliveryEndsAt;
		const advanced = await post(url, `/api/jobs/${mine}/clock`, { advanceMs: day }, first.token);
		assert.equal(advanced.status, 200);
		const body = await advanced.json() as JobBody;
		assert.equal(body.job.deliveryEndsAt, "2025-10-19T12:00:00.000Z");
		// The job's own page reads the moved deadline, and the other visitor's job is exactly where it was.
		assert.equal((await jobOf(url, mine, first.token)).body.job.deliveryEndsAt, "2025-10-19T12:00:00.000Z");
		assert.equal((await jobOf(url, theirs, second.token)).body.job.deliveryEndsAt, before);
		// A clock that is not a positive whole number of milliseconds is refused before anything moves.
		assert.equal((await post(url, `/api/jobs/${mine}/clock`, { advanceMs: 0 }, first.token)).status, 400);
		assert.equal((await post(url, `/api/jobs/${mine}/clock`, { advanceMs: -day }, first.token)).status, 400);
	});
});
