// Judge mode's session boundary, driven over HTTP against the real API: public mode refuses the
// seeded handles, "Start my demo" mints a visitor whose two principals are the only pair it can read
// or switch between, and dev mode keeps today's seeded sign-in. The visitor's own job is the only
// job its card funding and its clock reach.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reachable, releaseSpawned, sleep } from "../src/process.ts";

const preload = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
/** The stub GitHub this fixture's App talks to. Never a real host, never reached off this machine. */
const GITHUB_BASE = "https://api.github.test";
/** The one network boundary of the isolated API: every fetch is recorded, and only the two stubs answer. */
const fetchStub = `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init) => {
	appendFileSync(process.env.STUB_FETCH_LOG, JSON.stringify({ method: init?.method ?? "GET", url: String(input) }) + "\\n");
	if (String(input).startsWith("https://api-m.sandbox.paypal.com/v1/oauth2/token")) return Response.json({ access_token: "isolated-test-token", expires_in: 300 });
	// One order is created and never captured, so a job that accepted a bid stays in FUNDING with its
	// payment source bound, which is the state the funding choice must be refused in.
	if (String(input).startsWith("https://api-m.sandbox.paypal.com/v2/checkout/orders") && init?.method === "POST") {
		return Response.json({ id: "ORDER-JUDGE-1", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-JUDGE-1" }] });
	}
	if (String(input).startsWith("${GITHUB_BASE}/")) {
		const path = new URL(String(input)).pathname;
		if (path === "/app/installations") return Response.json([{ id: 42, account: { login: "acquit-forks", type: "Organization" } }]);
		if (path === "/app/installations/42/access_tokens") return Response.json({ token: "ghs_stub", expires_at: new Date(Date.now() + 3600000).toISOString() }, { status: 201 });
		if (init?.method === "POST" && /^\\/repos\\/[^/]+\\/[^/]+\\/forks$/.test(path)) {
			const body = JSON.parse(init.body);
			return Response.json({ full_name: body.organization + "/" + body.name, fork: true, parent: { full_name: "maya-client/invoice-app" } }, { status: 202 });
		}
		return Response.json({ message: "Not Found" }, { status: 404 });
	}
	return Response.json({ name: "RESOURCE_NOT_FOUND", debug_id: "isolated" }, { status: 404 });
};
`;
type VisitorBody = { readonly id: string; readonly client: string; readonly operator: string;
	readonly repository: string | null; readonly expiresAt: string };
type DemoBody = { readonly user: { readonly handle: string; readonly role: string }; readonly visitor: VisitorBody; readonly token: string };
/** The visitor's own repository is forked by the App, so this fixture needs the App's three names. */
const githubAppEnv = (): Record<string, string> => {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	return { ACQUIT_GITHUB_APP_ID: "4242", ACQUIT_GITHUB_APP_ORG: "acquit-forks", ACQUIT_GITHUB_API_BASE: GITHUB_BASE,
		ACQUIT_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
};

/** One free port on the loopback, handed out and released before the child binds it. */
async function freePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as { port: number }).port;
	await new Promise<void>(resolve => listener.close(() => resolve()));
	return port;
}
/** One isolated API child, listening on its own port and reaching only the two stubs. */
async function startApi(root: string, dir: string, dev: boolean, github = false): Promise<{ readonly child: ChildProcess; readonly url: string }> {
	const port = await freePort();
	const child = spawn(process.execPath, ["--import", preload("Date.now=()=>1760000000000"), "--import", preload(fetchStub), "apps/api/src/server.ts"],
		{ cwd: root, stdio: "ignore", env: {
			...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: dev ? "1" : "0", PORT: String(port), WEB_ORIGIN: "http://localhost:5213",
			ACQUIT_HIDDEN_CASES: fileURLToPath(new URL("../../verifier/fixtures/hidden-cases.test.json", import.meta.url)),
			DATABASE_PATH: join(dir, "acquit.db"), PAYPAL_CLIENT_ID: "unit-test", PAYPAL_CLIENT_SECRET: "unit-test",
			OPERATOR_DEVON_MERCHANT_ID: "unit-merchant", STUB_FETCH_LOG: join(dir, "fetch.log"),
			// The GitHub App is this test's own choice, never the developer's .env: without one the App
			// refuses by name and the visitor falls back to the deployment's repository, and with one every
			// fork is answered by the stub below and never by github.com.
			ACQUIT_GITHUB_APP_ID: "", ACQUIT_GITHUB_APP_PRIVATE_KEY: "", ACQUIT_GITHUB_APP_ORG: "", ACQUIT_GITHUB_API_BASE: "",
			...(github ? githubAppEnv() : {}),
		} });
	const url = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 15_000;
	while (!(await reachable(`${url}/api/session`))) {
		assert.equal(child.exitCode, null, "The isolated test API exited early.");
		assert(Date.now() < deadline, "The isolated test API failed readiness.");
		await sleep(50);
	}
	return { child, url };
}
async function apiFixture(dev: boolean, run: (url: string, databasePath: string) => Promise<void>, github = false): Promise<void> {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "acquit-demo-test-"));
	const databasePath = join(dir, "acquit.db");
	const children: ChildProcess[] = [];
	try {
		const api = await startApi(root, dir, dev, github);
		children.push(api.child);
		await run(api.url, databasePath);
		const log = join(dir, "fetch.log");
		const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(line => line !== "");
		assert.equal(calls.every(line => ["https://api-m.sandbox.paypal.com/", `${GITHUB_BASE}/`].some(base => JSON.parse(line).url.startsWith(base))), true,
			`The isolated test API reached ${calls.join(", ")}`);
	} finally {
		for (const child of children) await releaseSpawned(child);
		await rm(dir, { recursive: true, force: true });
	}
}
/**
 * Two API processes against one lane database, which is what a deployment behind more than one
 * worker looks like. A cap check that is not inside the committing transaction lets both processes
 * pass it at once; the same check inside BEGIN IMMEDIATE cannot.
 */
async function racingApiFixture(run: (urls: readonly string[], databasePath: string) => Promise<void>): Promise<void> {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "acquit-race-test-"));
	const children: ChildProcess[] = [];
	try {
		const first = await startApi(root, dir, false);
		children.push(first.child);
		const second = await startApi(root, dir, false);
		children.push(second.child);
		await run([first.url, second.url], join(dir, "acquit.db"));
	} finally {
		for (const child of children) await releaseSpawned(child);
		await rm(dir, { recursive: true, force: true });
	}
}
const post = (url: string, path: string, body: unknown, token?: string, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { method: "POST",
	headers: { "Content-Type": "application/json", ...headers, ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
/** One OpenJob whose outcome is read, not asserted: the caps refuse by code. */
const openOutcome = async (url: string, token: string, repository: string, budget: number) => {
	const response = await post(url, "/api/commands", { key: randomUUID(), command: { type: "OpenJob", repository,
		issueNumber: 12, budget, deliveryEndsAt: "2025-10-20T12:00:00.000Z" } }, token);
	return { status: response.status, body: await response.json() as { outcome: { kind: string; reason?: string } } };
};
const sessionOf = (url: string, token: string) => fetch(`${url}/api/session`, { headers: { Authorization: `Bearer ${token}` } })
	.then(response => response.json() as Promise<{ user: { handle: string; role: string } | null; visitor: VisitorBody | null }>);
type JobBody = { readonly job: { readonly id: string; readonly phase: string; readonly funding: string | null;
	readonly deliveryEndsAt: string; readonly contract: { readonly repository: string } | null };
	readonly handles: Readonly<Record<string, string>> };
/** One job of the visitor's own, opened by its client principal: the fixture repository and issue 12. */
async function openVisitorJob(url: string, token: string, repository = "maya-client/invoice-app"): Promise<string> {
	const response = await post(url, "/api/commands", { key: randomUUID(), command: { type: "OpenJob",
		repository, issueNumber: 12, budget: 40000, deliveryEndsAt: "2025-10-20T12:00:00.000Z" } }, token);
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

test("a visitor's session dies with its visitor, and never outlives it", async () => {
	await apiFixture(false, async (url, databasePath) => {
		const created = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const db = new DatabaseSync(databasePath);
		try {
			// The session's own deadline is at most the visitor's: no cookie outlives the demo.
			const row = db.prepare("SELECT expires_at FROM sessions WHERE handle = ?").get(created.visitor.client) as { expires_at: string };
			assert.equal(row.expires_at, created.visitor.expiresAt);
			// Once the visitor's own expiry passes, the session is refused even though its row stands.
			db.prepare("UPDATE visitors SET expires_at = ? WHERE id = ?").run("2025-10-08T12:00:00.000Z", created.visitor.id);
		} finally { db.close(); }
		assert.deepEqual(await sessionOf(url, created.token), { user: null, visitor: null });
		assert.equal((await fetch(`${url}/api/jobs`, { headers: { Authorization: `Bearer ${created.token}` } })).status, 401);
	});
});

test("public mode refuses a seeded session that an earlier run left behind", async () => {
	await apiFixture(false, async (url, databasePath) => {
		// A seeded handle's session, exactly as a dev-mode run mints it: a row with no visitor.
		const token = "seeded-session-token";
		const db = new DatabaseSync(databasePath);
		try {
			db.prepare("INSERT INTO sessions VALUES (?, ?, ?)")
				.run(createHash("sha256").update(token).digest("hex"), "maya-client", "2025-10-20T12:00:00.000Z");
		} finally { db.close(); }
		const restored = await fetch(`${url}/api/session`, { headers: { Authorization: `Bearer ${token}` } });
		assert.equal(restored.status, 200);
		assert.deepEqual(await restored.json(), { user: null, visitor: null });
		assert.equal((await fetch(`${url}/api/jobs`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
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

test("a cap holds when parallel requests race it on one lane", async () => {
	await racingApiFixture(async urls => {
		const visitor = await (await post(urls[0], "/api/demo", {})).json() as DemoBody;
		const repository = visitor.visitor.repository ?? "maya-client/invoice-app";
		const open = (url: string) => post(url, "/api/commands", { key: randomUUID(), command: { type: "OpenJob", repository,
			issueNumber: 12, budget: 40000, deliveryEndsAt: "2025-10-20T12:00:00.000Z" } }, visitor.token);
		// Eight opens across two processes: the visitor's allowance is three, whatever the interleaving.
		const opened = await Promise.all(Array.from({ length: 8 }, (_, index) => open(urls[index % 2])));
		const outcomes = await Promise.all(opened.map(async response => await response.json() as { outcome: { kind: string; reason?: string } }));
		assert.equal(outcomes.filter(outcome => outcome.outcome.kind === "COMMITTED").length, 3);
		assert.deepEqual(outcomes.filter(outcome => outcome.outcome.kind === "DENIED").map(outcome => outcome.outcome.reason),
			["CAP_VISITOR_JOBS", "CAP_VISITOR_JOBS", "CAP_VISITOR_JOBS", "CAP_VISITOR_JOBS", "CAP_VISITOR_JOBS"]);
		// The address's day holds the same way: this visitor is one, so two more may be created, ever.
		const created = await Promise.all(Array.from({ length: 10 }, (_, index) => post(urls[index % 2], "/api/demo", {})));
		assert.equal(created.filter(response => response.status === 201).length, 2);
		assert.deepEqual(created.filter(response => response.status !== 201).map(response => response.status), [429, 429, 429, 429, 429, 429, 429, 429]);
	});
});

test("the API's own writes wait for the lane's write lock instead of failing the request", async () => {
	await apiFixture(true, async (url, databasePath) => {
		// Another worker holds the lane's write lock while this sign-in arrives. Every write in core waits
		// for the lock; the API's own session write must wait the same way, not fail the caller's sign-in.
		const holder = new DatabaseSync(databasePath);
		holder.exec("PRAGMA busy_timeout = 5000");
		holder.exec("BEGIN IMMEDIATE");
		const release = setTimeout(() => holder.exec("COMMIT"), 400);
		try {
			const signed = await post(url, "/api/session", { handle: "maya-client" });
			assert.equal(signed.status, 200, `The sign-in answers ${signed.status}: ${await signed.text()}`);
		} finally {
			clearTimeout(release);
			holder.close();
		}
	});
});

test("a demo the caps refuse leaves no fork behind", async () => {
	await apiFixture(false, async (url, databasePath) => {
		for (let index = 0; index < 3; index++) {
			assert.equal((await post(url, "/api/demo", {})).status, 201);
		}
		// The address's day is spent: the fourth visitor is refused by code, and the App is never asked.
		const refused = await post(url, "/api/demo", {});
		assert.equal(refused.status, 429);
		assert.deepEqual(await refused.json(), { error: "CAP_VISITORS_IP_DAY" });
		const calls = (await readFile(join(dirname(databasePath), "fetch.log"), "utf8")).trim().split("\n").filter(line => line !== "");
		const forks = calls.map(line => JSON.parse(line) as { readonly url: string }).filter(call => call.url.endsWith("/forks"));
		assert.equal(forks.length, 3, `A refused visitor never reaches the App, so three forks are made: ${calls.length} calls.`);
	}, true);
});

test("one visitor's job is invisible and untouchable to another visitor", async () => {
	await apiFixture(false, async url => {
		const first = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const second = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const jobId = await openVisitorJob(url, first.token);
		// Reading another visitor's job is refused, not served because the job is OPEN.
		const stranger = await fetch(`${url}/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${second.token}` } });
		assert.equal(stranger.status, 403);
		assert.equal((await stranger.json() as { error: string }).error, "NOT_OWNER");
		// Listing never names another visitor's job.
		const list = await fetch(`${url}/api/jobs`, { headers: { Authorization: `Bearer ${second.token}` } })
			.then(response => response.json() as Promise<{ jobs: { id: string }[] }>);
		assert.equal(list.jobs.some(job => job.id === jobId), false);
		// The other visitor's operator cannot bid on it, even though the job is OPEN and takes bids.
		await post(url, "/api/demo/switch", {}, second.token);
		const me = await fetch(`${url}/api/me/operator`, { headers: { Authorization: `Bearer ${second.token}` } })
			.then(response => response.json() as Promise<{ agents: { id: string }[] }>);
		const bid = await post(url, "/api/commands", { key: randomUUID(), command: { type: "PlaceBid", jobId,
			price: 40000, eta: 48, agent: me.agents[0].id, pitch: "cross-visitor" } }, second.token);
		assert.equal(bid.status, 409);
		assert.deepEqual(await bid.json(), { outcome: { kind: "DENIED", reason: "NOT_OWNER" } });
		// The owner's own view never names the other visitor's operator.
		const mine = await jobOf(url, jobId, first.token);
		assert.equal(Object.values(mine.body.handles).includes(second.visitor.operator), false);
	});
});

test("the visitor's operator cannot choose funding or move its client's clock", async () => {
	await apiFixture(false, async url => {
		const visitor = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const jobId = await openVisitorJob(url, visitor.token);
		// The same visitor, acting as its operator: the job is in the visitor's world, but the controls
		// belong to its client alone.
		await post(url, "/api/demo/switch", {}, visitor.token);
		const funding = await post(url, `/api/jobs/${jobId}/funding`, { mode: "checkout" }, visitor.token);
		assert.equal(funding.status, 403);
		assert.equal((await funding.json() as { error: string }).error, "NOT_VISITOR_JOB");
		const clock = await post(url, `/api/jobs/${jobId}/clock`, { advanceMs: 86_400_000 }, visitor.token);
		assert.equal(clock.status, 403);
		assert.equal((await clock.json() as { error: string }).error, "NOT_VISITOR_JOB");
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
		// A job another visitor owns is refused whole: its funding is that client's own answer, and the
		// stranger never reads the job at all.
		const stranger = await jobOf(url, jobId, other.token);
		assert.equal(stranger.status, 403);
		assert.equal((stranger.body as unknown as { error: string }).error, "NOT_OWNER");
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

test("Start my demo forks the visitor's own client repository and binds it into its job", async () => {
	await apiFixture(false, async url => {
		const visitor = await (await post(url, "/api/demo", {})).json() as DemoBody;
		// The App forks the deployment's client repository under the visitor's own name: no PAT, no shared repo.
		assert.equal(visitor.visitor.repository, `acquit-forks/demo-${visitor.visitor.id.slice(2)}`);
		// The post form reads the repository this visitor may open a job on.
		const repos = await fetch(`${url}/api/repos`, { headers: { Authorization: `Bearer ${visitor.token}` } })
			.then(response => response.json() as Promise<{ repos: { repository: string }[] }>);
		assert.deepEqual(repos.repos.map(repo => repo.repository), [visitor.visitor.repository]);
		// The contract freezes the visitor's own repository, and the deployment's is refused for that client.
		const jobId = await openVisitorJob(url, visitor.token, visitor.visitor.repository ?? "");
		assert.equal((await jobOf(url, jobId, visitor.token)).body.job.contract?.repository, visitor.visitor.repository);
		const refused = await post(url, "/api/commands", { key: randomUUID(), command: { type: "OpenJob",
			repository: "maya-client/invoice-app", issueNumber: 12, budget: 40000, deliveryEndsAt: "2025-10-20T12:00:00.000Z" } }, visitor.token);
		assert.equal(refused.status, 409);
		assert.deepEqual(await refused.json(), { outcome: { kind: "DENIED", reason: "NOT_FOUND" } });
		// Every visitor forks its own: two visitors never share one repository name.
		const other = await (await post(url, "/api/demo", {})).json() as DemoBody;
		assert.notEqual(other.visitor.repository, visitor.visitor.repository);
	}, true);
});

test("a visitor's own caps bind: its jobs, what one may promise, and the address's day", async () => {
	await apiFixture(false, async url => {
		const first = await (await post(url, "/api/demo", {})).json() as DemoBody;
		const second = await (await post(url, "/api/demo", {})).json() as DemoBody;
		await post(url, "/api/demo", {});
		// Three visitors from one address is the day's allowance; the fourth is refused by code.
		const refused = await post(url, "/api/demo", {});
		assert.equal(refused.status, 429);
		assert.deepEqual(await refused.json(), { error: "CAP_VISITORS_IP_DAY" });
		// A budget over the ceiling is refused, and so is a fourth job: the visitor has three.
		const repository = first.visitor.repository ?? "maya-client/invoice-app";
		assert.deepEqual((await openOutcome(url, first.token, repository, 100001)).body,
			{ outcome: { kind: "DENIED", reason: "CAP_AMOUNT" } });
		for (const budget of [40000, 40000, 40000]) assert.equal((await openOutcome(url, first.token, repository, budget)).status, 200);
		assert.deepEqual((await openOutcome(url, first.token, repository, 1)).body,
			{ outcome: { kind: "DENIED", reason: "CAP_VISITOR_JOBS" } });
		// The other visitor is untouched by the first one's caps.
		assert.equal((await openOutcome(url, second.token, second.visitor.repository ?? "maya-client/invoice-app", 40000)).status, 200);
	});
});

test("the deployment's visitor day is capped across addresses, and it is a rolling day", async () => {
	await apiFixture(false, async url => {
		// Each visitor comes from its own address, so only the deployment's day can bind.
		for (let index = 0; index < 50; index++) {
			const created = await post(url, "/api/demo", {}, undefined, { "X-Forwarded-For": `10.0.0.${index + 1}` });
			assert.equal(created.status, 201, `visitor ${index + 1}`);
		}
		const refused = await post(url, "/api/demo", {}, undefined, { "X-Forwarded-For": "10.0.0.99" });
		assert.equal(refused.status, 429);
		assert.deepEqual(await refused.json(), { error: "CAP_VISITORS_DAY" });
	});
});
