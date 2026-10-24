// The visitor identity: two principals, one operator with its agent and grant, and the repository
// the contract will freeze. Core owns these rows; the API owns the session that names them.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAcquit, createAcquit } from "../src/acquit.ts";
import { createFakeGitHubApp } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { MerchantId } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import { sweepExpiredVisitors } from "../src/sweep.ts";
import { accountName, insertVisitor, newVisitorId, principalOf, readVisitor, repositoryForClient, reserveVisitor, visitorOfHandle, visitorRepositoryName } from "../src/visitors.ts";
import { demoFixture } from "./hidden-fixture.ts";

const now = instant("2026-10-06T12:00:00Z");
const merchant = "sandbox-seller" as MerchantId;
/** A name draw that answers the given integers in order: the color, the animal, then each suffix tried. */
const draws = (...values: number[]) => () => { const next = values.shift(); if (next === undefined) throw new Error("draw exhausted"); return next; };

test("a fresh database holds the seeded principals, and none of them has a visitor", () => {
	const store = new SqliteStore(":memory:");
	try {
		assert.deepEqual(principalOf(store.db, "maya-client"), { handle: "maya-client", role: "CLIENT", visitorId: null });
		assert.deepEqual(principalOf(store.db, "devon-ops"), { handle: "devon-ops", role: "OPERATOR", visitorId: null });
		assert.equal(principalOf(store.db, "nobody"), null);
	} finally { store.close(); }
});

test("a visitor resolves through its two principals and names only its own repository", async () => {
	const store = new SqliteStore(":memory:");
	try {
		const id = newVisitorId();
		const visitor = insertVisitor(store.db, { id, ipKey: "ip-a", repository: "acquit-forks/demo-abc123", merchant, now, pick: draws(40, 22) });
		const handles = { client: "teal-otter", operator: "teal-otter-ops" };
		assert.deepEqual({ client: visitor.clientHandle, operator: visitor.operatorHandle, name: visitor.displayName },
			{ ...handles, name: "Teal Otter" });
		assert.deepEqual(principalOf(store.db, handles.client), { handle: handles.client, role: "CLIENT", visitorId: id });
		assert.deepEqual(principalOf(store.db, handles.operator), { handle: handles.operator, role: "OPERATOR", visitorId: id });
		assert.equal(visitorOfHandle(store.db, handles.client)?.id, id);
		assert.equal(visitorOfHandle(store.db, handles.operator)?.id, id);
		assert.equal(visitorOfHandle(store.db, "maya-client"), null);
		assert.equal(readVisitor(store.db, id)?.repository, "acquit-forks/demo-abc123");
		// The deployment repository answers for a seeded client, and the visitor's for nobody else.
		assert.equal(repositoryForClient(store.db, handles.client), "acquit-forks/demo-abc123");
		assert.equal(repositoryForClient(store.db, "maya-client"), null);
		assert.equal(repositoryForClient(store.db, handles.operator), null);
		// The operator is ready to bid with the deployment's sandbox seller, and its grant is written.
		const operator = await store.readOperator(handles.operator as never);
		assert.equal(operator?.payouts.kind, "READY");
		assert.equal(operator?.payouts.kind === "READY" ? operator.payouts.merchant : null, merchant);
		const credits = await store.readCredits(handles.operator as never);
		assert.equal(credits.balance.allowance, 30);
		const agent = await store.readAgent(`${handles.operator}-agent` as never);
		assert.equal(agent?.owner, handles.operator);
		assert.equal(agent?.runner, "claude-code");
	} finally { store.close(); }
});

test("an account name is two words, and its handles are the slug and the slug plus -ops", () => {
	assert.deepEqual(accountName(40, 22, null), { displayName: "Teal Otter", client: "teal-otter", operator: "teal-otter-ops" });
	assert.deepEqual(accountName(0, 0, 0x4f), { displayName: "Amber Badger", client: "amber-badger-4f", operator: "amber-badger-4f-ops" });
	assert.deepEqual(accountName(45, 45, 0), { displayName: "Wintry Zebra", client: "wintry-zebra-00", operator: "wintry-zebra-00-ops" });
});

test("a taken name gets a two-character suffix, so two accounts never share a handle", () => {
	const store = new SqliteStore(":memory:");
	try {
		const first = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now, pick: draws(40, 22) });
		const second = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now, pick: draws(40, 22, 0x4f) });
		const third = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now, pick: draws(40, 22, 0x4f, 0x07) });
		assert.deepEqual([first, second, third].map(v => [v.displayName, v.clientHandle, v.operatorHandle]), [
			["Teal Otter", "teal-otter", "teal-otter-ops"],
			["Teal Otter", "teal-otter-4f", "teal-otter-4f-ops"],
			["Teal Otter", "teal-otter-07", "teal-otter-07-ops"],
		]);
	} finally { store.close(); }
});

test("a name some other row already answers to is skipped, whichever table holds it", () => {
	const store = new SqliteStore(":memory:");
	try {
		// An operator row with no principal, the way a House operator is stored, still takes its handle.
		store.db.prepare("INSERT INTO operators VALUES (?, 0, ?, 0)").run("teal-otter-ops", JSON.stringify({ id: "teal-otter-ops" }));
		const visitor = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now, pick: draws(40, 22, 0x10) });
		assert.equal(visitor.clientHandle, "teal-otter-10");
	} finally { store.close(); }
});

test("a Try Acquit account has no expiry, and a scenario run's visitor keeps one day", () => {
	const store = new SqliteStore(":memory:");
	try {
		const account = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now });
		assert.equal(account.expiresAt, null);
		assert.equal(readVisitor(store.db, account.id)?.expiresAt, null);
		const reserved = reserveVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now, scenarioOf: account.id });
		assert.equal(reserved.kind, "RESERVED");
		assert.equal(reserved.kind === "RESERVED" ? reserved.visitor.expiresAt : null, "2026-10-07T12:00:00.000Z");
	} finally { store.close(); }
});

test("a fork that fails leaves the visitor FAILED, kept for the sweep, and no session", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-provision-"));
	const path = join(root, "acquit.db");
	const service = createAcquit({ databaseUrl: path, fixtures: [demoFixture()], demo: { merchant }, clock: { now: () => now },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: merchant, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	const store = new SqliteStore(path);
	try {
		const { provisionDemoVisitor } = await import("../src/acquit.ts");
		const id = newVisitorId();
		const failed = await provisionDemoVisitor(service, { id, ipKey: "ip-a", fork: async () => { throw new Error("GitHub answered 500."); } });
		assert.equal(failed.kind, "FAILED");
		// The row is reserved before the fork and kept after it fails: nothing the App was asked for is untracked.
		const row = readVisitor(store.db, id);
		assert.equal(row?.state, "FAILED");
		assert.equal(row?.repository, null);
		assert.equal(principalOf(store.db, row?.clientHandle ?? "")?.visitorId, id);
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});

test("a crash between the fork and the bind names the repository, and the sweep keeps it rather than delete it without an id", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-provision-"));
	const path = join(root, "acquit.db");
	const service = createAcquit({ databaseUrl: path, fixtures: [demoFixture()], demo: { merchant }, clock: { now: () => now },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: merchant, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "1", privateKey: "key", organization: "acquit-forks" } });
	const store = new SqliteStore(path);
	const app = createFakeGitHubApp();
	try {
		const { provisionDemoVisitor } = await import("../src/acquit.ts");
		const id = newVisitorId();
		const repository = `acquit-forks/${visitorRepositoryName(id)}`;
		let namedBeforeFork: string | null = null;
		// The App lands the fork, then the process dies before the answer can be bound to the row.
		const failed = await provisionDemoVisitor(service, { id, ipKey: "ip-a", fork: async () => {
			namedBeforeFork = readVisitor(store.db, id)?.repository ?? null;
			await app.createClientRepo({ repository: "maya-client/invoice-app", name: visitorRepositoryName(id) });
			throw new Error("GitHub answered 500 after the fork.");
		} });
		assert.equal(failed.kind, "FAILED");
		assert.equal(namedBeforeFork, repository, "the row names the repository before the App is asked");
		assert.equal(readVisitor(store.db, id)?.repository, repository);
		assert.equal(readVisitor(store.db, id)?.repositoryId, null);
		// The sweep attempts the removal by name, with no id. The App refuses it, because a same-source fork that
		// took the name could not be told apart from this one. Nothing is deleted, so the repository stays until
		// someone with the App removes it by hand: the sweep never guesses. This is the cost of the strict rule.
		const requests: { readonly repository: string; readonly id: number | null }[] = [];
		const recorded = { deleteClientRepo: async (request: { readonly repository: string; readonly source: string; readonly id: number | null }) => {
			requests.push({ repository: request.repository, id: request.id });
			return app.deleteClientRepo(request);
		} };
		const later = instant(new Date(Date.parse(now) + 2 * 86_400_000).toISOString());
		const report = await sweepExpiredVisitors({ db: store.db, app: recorded, source: "maya-client/invoice-app", now: later });
		assert.deepEqual(requests, [{ repository, id: null }]);
		assert.deepEqual(report, { swept: [], repositories: [], kept: [{ id, repository, reason: "GITHUB_FORK_UNRECORDED" }] });
		assert.equal(app.clientRepos.has(visitorRepositoryName(id)), true);
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});
