// The expiry sweep: a visitor past its 24 hours loses its repository and then its rows, in that order,
// so a refusal leaves the row for the next sweep instead of forgetting a repository still out there.

import assert from "node:assert/strict";
import test from "node:test";
import { createFakeGitHubApp, GitHubAppError, unconfiguredGitHubApp } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { MerchantId } from "../src/ids.ts";
import { SqliteStore } from "../src/store.ts";
import { sweepExpiredVisitors } from "../src/sweep.ts";
import { insertVisitor, newVisitorId, principalOf, readVisitor } from "../src/visitors.ts";

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
