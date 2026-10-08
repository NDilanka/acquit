// The expiry sweep: a visitor past its 24 hours loses its repository and its sessions, and its row is
// marked SWEPT. Everything its jobs need to finish stays: its operator, its agent, its credits, its
// jobs, and its bids. A refusal leaves the row for the next sweep instead of forgetting a repository
// still out there.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAcquit, createAcquit, createDemoVisitor } from "../src/acquit.ts";
import type { Actor } from "../src/acquit.ts";
import { createFakeGitHubApp, GitHubAppError, unconfiguredGitHubApp } from "../src/github.ts";
import { instant, parseRequestKey } from "../src/ids.ts";
import type { ClientId, JobId, MerchantId, OperatorId } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import { sweepExpiredVisitors } from "../src/sweep.ts";
import { insertVisitor, newVisitorId, principalOf, readVisitor, visitorRepositoryName } from "../src/visitors.ts";
import { exampleContract } from "./hidden-fixture.ts";

const merchant = "sandbox-seller" as MerchantId;
const source = "maya-client/invoice-app";
const live = instant(new Date().toISOString());
const long = instant(new Date(Date.now() - 3 * 86_400_000).toISOString());
const now = instant(new Date().toISOString());

test("a sweep deletes an expired visitor's repository, forgets its rows, and leaves a live visitor alone", async () => {
	const store = new SqliteStore(":memory:");
	const app = createFakeGitHubApp();
	const expired = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: "acquit-forks/demo-old", merchant, now: long });
	const staying = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-b", repository: "acquit-forks/demo-live", merchant, now: live });
	await app.createClientRepo({ repository: source, name: "demo-old" });
	await app.createClientRepo({ repository: source, name: "demo-live" });
	const report = await sweepExpiredVisitors({ db: store.db, app, source, now });
	assert.deepEqual(report, { swept: [expired.id], repositories: [{ repository: "acquit-forks/demo-old", outcome: "DELETED" }], kept: [] });
	assert.equal(readVisitor(store.db, expired.id), null);
	assert.equal(principalOf(store.db, expired.clientHandle), null);
	assert.equal(principalOf(store.db, expired.operatorHandle), null);
	assert.equal(readVisitor(store.db, staying.id)?.id, staying.id);
	assert.equal(principalOf(store.db, staying.clientHandle)?.visitorId, staying.id);
	assert.equal(app.clientRepos.has("demo-old"), false);
	assert.equal(app.clientRepos.has("demo-live"), true);
	// Idempotent: the second sweep finds nothing, so nothing is deleted twice.
	assert.deepEqual(await sweepExpiredVisitors({ db: store.db, app, source, now }), { swept: [], repositories: [], kept: [] });
	store.close();
});

test("a repository that is already gone is not a failure, and the visitor is still forgotten", async () => {
	const store = new SqliteStore(":memory:");
	const app = createFakeGitHubApp();
	const expired = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: "acquit-forks/demo-gone", merchant, now: long });
	const report = await sweepExpiredVisitors({ db: store.db, app, source, now });
	assert.deepEqual(report, { swept: [expired.id], repositories: [{ repository: "acquit-forks/demo-gone", outcome: "ABSENT" }], kept: [] });
	assert.equal(readVisitor(store.db, expired.id), null);
	store.close();
});

test("a repository this deployment cannot remove keeps the visitor for the next sweep", async () => {
	const store = new SqliteStore(":memory:");
	const refusing = { deleteClientRepo: async (): Promise<"DELETED" | "ABSENT"> => {
		throw new GitHubAppError("GITHUB_FORK_MISMATCH", "acquit-forks/demo-taken is not the fork this visitor creates."); } };
	const expired = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: "acquit-forks/demo-taken", merchant, now: long });
	const report = await sweepExpiredVisitors({ db: store.db, app: refusing, source, now });
	assert.deepEqual(report.swept, []);
	assert.deepEqual(report.repositories, []);
	assert.deepEqual(report.kept, [{ id: expired.id, repository: "acquit-forks/demo-taken", reason: "GITHUB_FORK_MISMATCH" }]);
	assert.equal(readVisitor(store.db, expired.id)?.id, expired.id);
	store.close();
});

test("without an App nothing is forgotten, because the repository would be left behind", async () => {
	const store = new SqliteStore(":memory:");
	const expired = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: "acquit-forks/demo-no-app", merchant, now: long });
	const report = await sweepExpiredVisitors({ db: store.db, app: unconfiguredGitHubApp(), source, now });
	assert.deepEqual(report.kept, [{ id: expired.id, repository: "acquit-forks/demo-no-app", reason: "GITHUB_APP_NOT_CONFIGURED" }]);
	assert.equal(readVisitor(store.db, expired.id)?.id, expired.id);
	store.close();
});

/** How many rows one table holds for one key. The sweep's whole claim is which rows it leaves. */
const rowsOf = (store: SqliteStore, table: string, where: string, key: string): number =>
	Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(key) as { readonly n: number }).n);

test("a swept visitor keeps its operator, credits, and jobs, loses its sessions, and its job still settles through the tick", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-sweep-"));
	const path = join(root, "acquit.db");
	const noon = instant("2026-10-06T12:00:00.000Z");
	const deadline = instant("2026-10-06T13:00:00.000Z");
	let currentNow = noon;
	const service = createAcquit({ databaseUrl: path, clientRepository: source, hiddenContract: exampleContract, demo: { merchant },
		clock: { now: () => currentNow },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: merchant, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	const store = new SqliteStore(path);
	const app = createFakeGitHubApp();
	try {
		// The visitor the API would mint, with the fork the App would make for it and a session per principal.
		const id = newVisitorId();
		const forked = await app.createClientRepo({ repository: source, name: visitorRepositoryName(id) });
		const created = await createDemoVisitor(service, { id, ipKey: "ip-a", repository: forked.repository });
		assert.equal(created.kind, "CREATED");
		if (created.kind !== "CREATED") throw new Error("The caps refused the fixture's visitor");
		const visitor = created.visitor;
		for (const handle of [visitor.clientHandle, visitor.operatorHandle]) {
			store.db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(`digest-${handle}`, handle, visitor.expiresAt);
		}
		// The visitor's own job, in work under its own operator's escrow, its clock at the delivery deadline.
		const opened = await service.execute({ role: "CLIENT", clientId: visitor.clientHandle as ClientId, tenant: visitor.id,
			repository: forked.repository } as Actor, parseRequestKey(randomUUID()),
			{ type: "OpenJob", repository: forked.repository, issueNumber: 12, budget: usd("400.00"), deliveryEndsAt: deadline });
		assert.equal(opened.kind, "COMMITTED");
		const jobId = (opened.kind === "COMMITTED" && opened.result.kind === "JOB" ? opened.result.job.id : "job_missing") as JobId;
		const stored = store.db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId) as { readonly json: string };
		const job = JSON.parse(stored.json) as Record<string, unknown>;
		store.db.prepare("UPDATE jobs SET json = ?, wake_at = ? WHERE id = ?").run(JSON.stringify({ ...job, state: { status: "IN_PROGRESS",
			escrow: { payee: { bidId: "bid_1", operator: visitor.operatorHandle, payee: merchant, agent: "ts-bugfixer", price: 40_000, eta: 48 },
				quote: {}, capture: { orderId: "ORDER-SWEPT", captureId: "CAPTURE-SWEPT" }, book: [], cutoffAt: instant("2026-11-01T00:00:00.000Z") },
			attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } } }), deadline, jobId);
		// The visitor's day ends. The sweep takes its repository and its sessions, and marks the row.
		currentNow = instant(new Date(Date.parse(visitor.expiresAt) + 1000).toISOString());
		const report = await sweepExpiredVisitors({ db: store.db, app, source, now: currentNow });
		assert.deepEqual(report.swept, [id]);
		assert.deepEqual(report.repositories, [{ repository: forked.repository, outcome: "DELETED" }]);
		assert.equal(app.clientRepos.has(visitorRepositoryName(id)), false);
		assert.equal(readVisitor(store.db, id)?.state, "SWEPT");
		assert.equal(principalOf(store.db, visitor.clientHandle)?.visitorId, id);
		assert.equal(principalOf(store.db, visitor.operatorHandle)?.visitorId, id);
		// What the job needs to settle is still there; what could still sign in is not.
		assert.equal(rowsOf(store, "operators", "id = ?", visitor.operatorHandle), 1);
		assert.equal(rowsOf(store, "agents", "owner = ?", visitor.operatorHandle), 1);
		assert.equal(rowsOf(store, "credits", "id = ?", visitor.operatorHandle), 1);
		assert.equal(rowsOf(store, "jobs", "id = ?", jobId), 1);
		assert.equal(rowsOf(store, "sessions", "handle = ?", visitor.clientHandle), 0);
		assert.equal(rowsOf(store, "sessions", "handle = ?", visitor.operatorHandle), 0);
		// The tick still reaches the swept visitor's job: the deadline refunds, and its effect is queued. The
		// provider is offline here, so the effect waits for its next pass rather than moving money in a test.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => { throw new Error("offline"); };
		try { await service.tick(); } finally { globalThis.fetch = originalFetch; }
		const after = await store.readJob(jobId);
		assert.equal(after?.state.status, "IN_PROGRESS");
		assert.equal(after?.state.attempts.phase, "REFUND_PENDING");
		assert.equal(after?.state.attempts.phase === "REFUND_PENDING" ? after.state.attempts.refund.reason : null, "DELIVERY_DEADLINE");
		assert.equal(rowsOf(store, "outbox", "json LIKE ?", `%${jobId}%`), 1);
		// Idempotent: a swept visitor is not swept twice.
		assert.deepEqual(await sweepExpiredVisitors({ db: store.db, app, source, now: currentNow }), { swept: [], repositories: [], kept: [] });
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});
