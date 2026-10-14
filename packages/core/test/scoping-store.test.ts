// The scoping store: one row per scoped job holding the draft's state — ids and digest only, the
// expected values and citations living in the private case store beside the registry — plus the
// freeze that rewrites the job's manifest from the approved draft. The migration: a database from
// before A1 opens with the table created, every pre-existing row unchanged, and a second open a
// no-op.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instant } from "../src/ids.ts";
import type { ClientId, CommitSha, Digest, JobId, TestId, Version } from "../src/ids.ts";
import { SqliteStore, openDatabase } from "../src/store.ts";
import { hiddenManifest } from "../../verifier/hidden.ts";
import type { HiddenCase } from "../src/verifier.ts";

const now = instant("2026-10-14T12:00:00Z");
const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;

function seedJob(store: SqliteStore, id: string, status: string): void {
	const row = { id, version: 1 as Version, client: "maya-client" as ClientId, tenant: null,
		title: "Totals round wrong for 3-decimal currencies", openedAt: now,
		contract: { budget: 40000, deliveryEndsAt: instant("2026-10-20T12:00:00Z"), definitionOfDone: null, terms: {} },
		bids: [], state: { status, phase: { kind: "BIDDING", fundingRounds: 0 } } };
	store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), null);
}

test("the scoping row round-trips: ids and counts only, the case values never enter the database", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-a1-store-"));
	try {
		const store = new SqliteStore(join(root, "acquit.db"));
		assert.equal(await store.readScoping("job_none" as JobId), null);
		await store.writeScoping({
			jobId: "job_scoped" as JobId, status: "AWAITING_APPROVAL", issueBody: "The issue body text.",
			ids: ["draft:1", "draft:2"] as TestId[], digest: null,
			reason: null, counts: { candidates: 7, f1: 5, f2: 4, f3: 2, f4: 2, deduped: 2 }, updatedAt: now,
		});
		const row = await store.readScoping("job_scoped" as JobId);
		assert.ok(row);
		assert.equal(row.status, "AWAITING_APPROVAL");
		assert.equal(row.issueBody, "The issue body text.");
		assert.deepEqual(row.ids, ["draft:1", "draft:2"]);
		assert.deepEqual(row.counts, { candidates: 7, f1: 5, f2: 4, f3: 2, f4: 2, deduped: 2 });
		const raw = String(store.db.prepare("SELECT ids, counts, issue_body FROM job_scoping WHERE job_id = ?").get("job_scoped"));
		assert.ok(!raw.includes("expected"), "no case shape reaches the database");
		store.close();
	} finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("the freeze rewrites the job's manifest hidden contract from the approved draft", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-a1-freeze-"));
	try {
		const store = new SqliteStore(join(root, "acquit.db"));
		seedJob(store, "job_freeze", "OPEN");
		store.db.prepare("INSERT INTO job_manifests VALUES (?, ?)").run("job_freeze", JSON.stringify({
			issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
			frozenAt: frozenCommit, frozenTestPath: "tests/totals.test.ts",
			frozenTests: ["frozen:1", "frozen:2"], hiddenTests: ["hidden:1"], hiddenManifest: "a".repeat(64),
			protectedPaths: ["tests/**"],
		}));
		const cases: readonly HiddenCase[] = [
			{ id: "draft:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235" },
			{ id: "draft:2" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500" },
		];
		const digest = hiddenManifest(cases).digest;
		await store.freezeManifest("job_freeze" as JobId, {
			issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
			frozenAt: frozenCommit, frozenTestPath: "tests/totals.test.ts",
			frozenTests: ["frozen:1", "frozen:2"], hiddenTests: cases.map(test => test.id),
			hiddenManifest: digest, protectedPaths: ["tests/**"],
		});
		const frozen = await store.readManifest("job_freeze" as JobId);
		assert.ok(frozen);
		assert.deepEqual(frozen.hiddenTests, ["draft:1", "draft:2"], "the manifest holds exactly the approved draft ids");
		assert.equal(frozen.hiddenManifest, digest, "the frozen digest is the approved cases' digest");
		assert.equal(frozen.frozenAt, frozenCommit, "the frozen commit never moves");
		store.close();
	} finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("the A1 migration creates the scoping table on a pre-A1 database and changes nothing else", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-a1-migration-"));
	try {
		const path = join(root, "acquit.db");
		{
			// A pre-A1 database: M1 manifests exist, one job reached PAID, no scoping table.
			const store = new SqliteStore(path);
			seedJob(store, "job_paid", "PAID");
			store.db.prepare("INSERT INTO job_manifests VALUES (?, ?)").run("job_paid", JSON.stringify({
				issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
				frozenAt: frozenCommit, frozenTestPath: "tests/totals.test.ts",
				frozenTests: ["frozen:1"], hiddenTests: ["hidden:1"], hiddenManifest: "a".repeat(64), protectedPaths: ["tests/**"],
			}));
			store.close();
		}
		const before = new SqliteStore(path).db.prepare("SELECT id, json FROM jobs ORDER BY id").all().map(row => JSON.stringify(row));
		const beforeManifests = new SqliteStore(path).db.prepare("SELECT job_id, json FROM job_manifests ORDER BY job_id").all().map(row => JSON.stringify(row));
		// The migration, exactly what `ctl migrate` runs.
		const migrated = openDatabase(path, []);
		const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name));
		assert.ok(tables.includes("job_scoping"), "the scoping table exists after the migration");
		assert.equal((migrated.prepare("SELECT COUNT(*) AS n FROM jobs").get())!.n, 1, "every pre-existing job row survives");
		assert.deepEqual(migrated.prepare("SELECT id, json FROM jobs ORDER BY id").all().map(row => JSON.stringify(row)), before);
		assert.deepEqual(migrated.prepare("SELECT job_id, json FROM job_manifests ORDER BY job_id").all().map(row => JSON.stringify(row)), beforeManifests);
		migrated.close();
		// A second migration is a no-op.
		const again = openDatabase(path, []);
		assert.equal((again.prepare("SELECT COUNT(*) AS n FROM job_manifests").get())!.n, 1);
		again.close();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
