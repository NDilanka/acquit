// The M1 migration. A database created before per-job manifests holds each job's frozen contract
// only inside the job row. The migration gives every such job one manifest row carrying exactly
// the contract it was frozen with, plus the frozen test path its fixture's registry entry names;
// a job whose fixture the registry does not name is skipped with one log line and no row. The job
// ids key the rows, so a second migration inserts nothing new.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instant } from "../src/ids.ts";
import type { ClientId, CommitSha, JobId, TestId, Version } from "../src/ids.ts";
import { TERMS, storedDefinitionOfDone } from "../src/job.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { openDatabase, SqliteStore } from "../src/store.ts";
import { manifestOf } from "../src/fixtures.ts";
import { operationKey, runOutboxOnce } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import type { VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";

const now = instant("2026-10-06T12:00:00Z");
const later = instant("2026-10-20T12:00:00Z");
const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const fixture = demoFixture(exampleContract);

/** A pre-M1 contract: the frozen definition, with no frozen test path (the registry names it). */
const preM1Definition = {
	issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
	frozenAt: frozenCommit, frozenTests: Array.from({ length: 48 }, (_, i) => `frozen:${i + 1}` as TestId),
	hiddenManifest: exampleContract.digest, hiddenTests: exampleContract.ids,
	protectedPaths: [...(demoFixture().protectedPaths)] };
const contract = (definition: unknown) => ({ budget: usd("400.00"), deliveryEndsAt: later, definitionOfDone: definition, terms: TERMS });

function insertJob(db: SqliteStore["db"], id: string, state: object, definition: unknown = preM1Definition): void {
	const row = { id, version: 1 as Version, client: "maya-client" as ClientId, tenant: null,
		title: "Totals round wrong for 3-decimal currencies", openedAt: now, contract: contract(definition),
		bids: [], state };
	db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), later);
}

test("the migration gives every stored job the manifest it was frozen with, once", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-m1-migration-"));
	try {
		const path = join(root, "acquit.db");
		// A pre-M1 database: the jobs exist, no job_manifests table has rows, and the definitions
		// carry no frozen test path.
		{
			const store = new SqliteStore(path);
			store.db.exec("CREATE TABLE IF NOT EXISTS job_manifests (job_id TEXT PRIMARY KEY, json TEXT NOT NULL)");
			insertJob(store.db, "job_open", { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } });
			insertJob(store.db, "job_held", { status: "IN_PROGRESS", escrow: {}, attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } });
			insertJob(store.db, "job_paid", { status: "PAID" });
			store.close();
		}
		const before = new SqliteStore(path).db.prepare("SELECT id, json FROM jobs ORDER BY id").all()
			.map(row => JSON.stringify(row));
		// The migration, exactly what `ctl migrate` runs: open with the registry's fixture refs.
		const refs = [{ repository: fixture.repository, issue: { number: 12 }, frozenTestPath: fixture.frozenTestPath, demoForkPrefix: fixture.demoForkPrefix }];
		const migrated = openDatabase(path, refs, fixture.repository);
		const manifests = migrated.prepare("SELECT job_id, json FROM job_manifests ORDER BY job_id").all();
		assert.equal(manifests.length, 3);
		const expected = manifestOf(fixture, "maya-client/invoice-app");
		for (const row of manifests) {
			assert.deepEqual(JSON.parse(String(row.json)), expected, `${row.job_id} holds the contract it was frozen with`);
			assert.equal(JSON.parse(String(row.json)).frozenTestPath, "tests/totals.test.ts");
		}
		// Every pre-existing row keeps its bytes.
		const after = migrated.prepare("SELECT id, json FROM jobs ORDER BY id").all().map(row => JSON.stringify(row));
		assert.deepEqual(after, before);
		migrated.close();
		// A second migration inserts nothing new.
		const again = openDatabase(path, refs, fixture.repository);
		assert.equal(again.prepare("SELECT COUNT(*) AS n FROM job_manifests").get()!.n, 3);
		assert.deepEqual(again.prepare("SELECT id, json FROM jobs ORDER BY id").all().map(row => JSON.stringify(row)), before);
		again.close();
		// And the migrated copy reads each job's manifest back beside the contract it kept.
		const reader = new SqliteStore(path, refs);
		for (const id of ["job_open", "job_held", "job_paid"]) {
			const row = JSON.parse(String(reader.db.prepare("SELECT json FROM jobs WHERE id = ?").get(id)!.json));
			// The stored contract keeps the bytes it was frozen with; only the manifest row is new.
			assert.deepEqual(storedDefinitionOfDone(row), preM1Definition);
			assert.deepEqual(await reader.readManifest(id as never), expected);
		}
		reader.close();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} finally { /* the temp dir removal above owns cleanup */ }
});

test("a stored job whose fixture the registry does not name is skipped with one log line", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-m1-migration-unknown-"));
	try {
		const path = join(root, "acquit.db");
		{
			const store = new SqliteStore(path);
			store.db.exec("CREATE TABLE IF NOT EXISTS job_manifests (job_id TEXT PRIMARY KEY, json TEXT NOT NULL)");
			insertJob(store.db, "job_stray", { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } });
			store.close();
		}
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			// The registry names no fixture for maya-client/invoice-app: nothing to match.
			openDatabase(path, []);
		} finally { console.warn = original; }
		const db = openDatabase(path, []);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_manifests").get()!.n, 0, "no manifest row for an unregistered fixture");
		assert.equal(warnings.length, 1, "exactly one log line");
		assert.match(warnings[0]!, /job_stray/);
		assert.match(warnings[0]!, /maya-client\/invoice-app#12/);
		db.close();
		// Fixing the registry re-runs the backfill: the job becomes judgeable.
		const refs = [{ repository: fixture.repository, issue: { number: 12 }, frozenTestPath: fixture.frozenTestPath, demoForkPrefix: fixture.demoForkPrefix }];
		const fixed = openDatabase(path, refs);
		assert.equal(fixed.prepare("SELECT COUNT(*) AS n FROM job_manifests").get()!.n, 1);
		fixed.close();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} finally { /* cleanup above */ }
});

test("the migration gives a held visitor job on a registered demo fork its manifest, and its dispatch verifies", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-m1-migration-visitor-"));
	try {
		const path = join(root, "acquit.db");
		// A pre-M1 database: the visitor's job is HELD and verifying on the fork its session carried,
		// with no manifest row. The contract names the fork, the registry names the fork's prefix.
		const fork = "acquit-forks/demo-aabbcc112233";
		const visitorDefinition = { ...preM1Definition, issue: { repository: fork, number: 12, title: preM1Definition.issue.title } };
		{
			const store = new SqliteStore(path);
			store.db.exec("CREATE TABLE IF NOT EXISTS job_manifests (job_id TEXT PRIMARY KEY, json TEXT NOT NULL)");
			insertJob(store.db, "job_visitor", { status: "IN_PROGRESS", escrow: {}, attempts: { phase: "VERIFYING", history: [],
				runsStarted: 1, pending: { ordinal: 1, run: 1, runId: "run_visitor_1" as VerifierRunId, sourceCommit: frozenCommit,
					submittedAt: now, runEndsAt: later }, failure: null } }, visitorDefinition);
			store.close();
		}
		const before = new SqliteStore(path).db.prepare("SELECT id, json FROM jobs ORDER BY id").all().map(row => JSON.stringify(row));
		const refs = [{ repository: fixture.repository, issue: { number: 12 }, frozenTestPath: fixture.frozenTestPath, demoForkPrefix: fixture.demoForkPrefix }];
		const migrated = openDatabase(path, refs, fixture.repository);
		const manifests = migrated.prepare("SELECT job_id, json FROM job_manifests").all();
		assert.equal(manifests.length, 1, "the visitor job holds exactly one manifest row");
		assert.equal(String(manifests[0]!.job_id), "job_visitor");
		assert.deepEqual(JSON.parse(String(manifests[0]!.json)), manifestOf(fixture, fork),
			"the manifest names the fork with the fixture's frozen contract");
		assert.deepEqual(migrated.prepare("SELECT id, json FROM jobs ORDER BY id").all().map(row => JSON.stringify(row)), before);
		migrated.close();
		// A second migration inserts nothing new.
		const again = openDatabase(path, refs, fixture.repository);
		assert.equal(again.prepare("SELECT COUNT(*) AS n FROM job_manifests").get()!.n, 1);
		again.close();
		// The migrated job's dispatch reads its manifest and starts the run; no CONTRACT_NOT_FROZEN park.
		const reader = new SqliteStore(path, refs, fixture.repository);
		const started: VerifierRunRequest[] = [];
		const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
		const ports: Ports = { store: reader, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") }, fixtures: [],
			clock: { now: () => now }, verifier: { start: async request => { started.push(request); }, parseCallback: unimplemented },
			github: { merge: unimplemented }, alerts: { raise: unimplemented },
			paypal: { dispatch: unimplemented, reconcile: unimplemented, getOrder: unimplemented,
				parseWebhook: unimplemented, verifyWebhookDelivery: unimplemented, readResource: unimplemented } };
		const effect = { kind: "START_VERIFIER" as const, jobId: "job_visitor" as JobId, attempt: { ordinal: 1 as const, run: 1,
			runId: "run_visitor_1" as VerifierRunId, sourceCommit: frozenCommit, submittedAt: now, runEndsAt: later } };
		const key = operationKey(effect);
		const ready = { kind: "READY", runAt: now };
		reader.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)").run(key, JSON.stringify({ key, effect, payloadDigest: "d", state: ready }), JSON.stringify(ready), now);
		assert.equal(await runOutboxOnce(ports, key), "WORKED");
		assert.deepEqual(started.map(run => run.definitionOfDone), [manifestOf(fixture, fork)], "the dispatch verifies with the job's own manifest");
		assert.deepEqual(JSON.parse(String(reader.db.prepare("SELECT state FROM outbox WHERE key = ?").get(key)!.state)),
			{ kind: "CONFIRMED", at: now }, "the effect confirmed; the job never parked NEEDS_HUMAN");
		reader.close();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} finally { /* cleanup above */ }
});

test("a visitor job on a fork no registered fixture names is skipped with one log line", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-m1-migration-stray-fork-"));
	try {
		const path = join(root, "acquit.db");
		{
			const store = new SqliteStore(path);
			store.db.exec("CREATE TABLE IF NOT EXISTS job_manifests (job_id TEXT PRIMARY KEY, json TEXT NOT NULL)");
			insertJob(store.db, "job_stray_fork", { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } },
				{ ...preM1Definition, issue: { repository: "other-forks/demo-ffffffffffff", number: 12, title: preM1Definition.issue.title } });
			store.close();
		}
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		let db;
		try {
			// The registry's only fork prefix is acquit-forks/: other-forks is genuinely unregistered.
			db = openDatabase(path, [{ repository: fixture.repository, issue: { number: 12 }, frozenTestPath: fixture.frozenTestPath, demoForkPrefix: "acquit-forks/" }]);
		} finally { console.warn = original; }
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_manifests").get()!.n, 0, "no manifest row for an unregistered fork");
		assert.equal(warnings.length, 1, "exactly one log line");
		assert.match(warnings[0]!, /job_stray_fork/);
		assert.match(warnings[0]!, /other-forks\/demo-ffffffffffff#12/);
		db.close();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} finally { /* cleanup above */ }
});
