// The visitor identity: two principals, one operator with its agent and grant, and the repository
// the contract will freeze. Core owns these rows; the API owns the session that names them.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAcquit, createAcquit } from "../src/acquit.ts";
import { instant } from "../src/ids.ts";
import type { MerchantId } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import { insertVisitor, newVisitorId, principalOf, readVisitor, repositoryForClient, visitorHandles, visitorOfHandle } from "../src/visitors.ts";
import { exampleContract } from "./hidden-fixture.ts";

const now = instant("2026-10-06T12:00:00Z");
const merchant = "sandbox-seller" as MerchantId;

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
		const visitor = insertVisitor(store.db, { id, ipKey: "ip-a", repository: "acquit-forks/demo-abc123", merchant, now });
		const handles = visitorHandles(id);
		assert.deepEqual({ client: visitor.clientHandle, operator: visitor.operatorHandle }, handles);
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

test("two visitors never collide on an id, a handle, or a repository name", () => {
	const ids = new Set<string>();
	for (let index = 0; index < 50; index++) {
		const id = newVisitorId();
		const handles = visitorHandles(id);
		assert.equal(ids.has(id), false);
		assert.match(handles.client, /^guest-[0-9a-f]{12}-client$/);
		assert.match(handles.operator, /^guest-[0-9a-f]{12}-ops$/);
		ids.add(id);
	}
});

test("a fork that fails leaves the visitor FAILED, kept for the sweep, and no session", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-provision-"));
	const path = join(root, "acquit.db");
	const service = createAcquit({ databaseUrl: path, hiddenContract: exampleContract, demo: { merchant }, clock: { now: () => now },
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
		assert.equal(principalOf(store.db, visitorHandles(id).client)?.visitorId, id);
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});
