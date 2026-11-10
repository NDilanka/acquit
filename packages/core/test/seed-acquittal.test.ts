// The seed acquittal (contract section 3.6). A database from before exams holds agents with no acquittal: the
// migration gives each pre-exam visitor starter and the seeded ts-bugfixer the seed acquittal, and never touches a
// House agent, a plugged sample, or an agent that already holds an acquittal. A second migration changes nothing.
// A PAID row stored before it kept its verdict history reads with the empty history.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instant } from "../src/ids.ts";
import type { JobId } from "../src/ids.ts";
import { TERMS } from "../src/job.ts";
import { usd } from "../src/ledger.ts";
import { openDatabase, SqliteStore } from "../src/store.ts";

type Db = ReturnType<typeof openDatabase>;

const VISITED_AT = "2026-10-01T10:00:00.000Z";
const EXAMINED_AT = "2026-10-05T09:00:00.000Z";

function insertVisitor(db: Db, id: string, operator: string, createdAt: string): void {
	db.prepare("INSERT INTO visitors (id, created_at, expires_at, ip_key, client_handle, operator_handle) VALUES (?, ?, ?, 'ip-key', 'maya-client', ?)")
		.run(id, createdAt, "2026-10-08T10:00:00.000Z", operator);
}

function insertAgent(db: Db, id: string, owner: string, extra: { acquittal?: unknown; sample?: unknown } = {}): void {
	const json = { id, owner, name: id, acquittal: null, sample: null, ...extra };
	db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(id, owner, JSON.stringify(json));
}

function agentOf(db: Db, id: string): { acquittal: unknown; sample: unknown } {
	const row = db.prepare("SELECT json FROM agents WHERE id = ?").get(id)!;
	const json = JSON.parse(String(row.json)) as { acquittal?: unknown; sample?: unknown };
	return { acquittal: json.acquittal ?? null, sample: json.sample ?? null };
}

test("the seed acquittal lands on pre-exam visitor starters and ts-bugfixer, once, and nowhere else", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-seed-acquittal-"));
	try {
		const path = join(root, "acquit.db");
		// A database from before exams: the schema exists, and the rows are written the way the old code wrote them.
		{
			const db = openDatabase(path);
			insertVisitor(db, "visitor_vis", "vis-op", VISITED_AT);
			insertVisitor(db, "visitor_plug", "plug-op", VISITED_AT);
			insertVisitor(db, "visitor_exam", "exam-op", VISITED_AT);
			insertAgent(db, "vis-op-agent", "vis-op");
			// Not `<handle>-agent`, so no visitor starter.
			insertAgent(db, "vis-op-custom", "vis-op");
			// A plugged sample is a sample, not a starter.
			insertAgent(db, "plug-op-agent", "plug-op", { sample: { task: "code-fixer" } });
			insertAgent(db, "exam-op-agent", "exam-op", { acquittal: { examId: "exam_1", at: EXAMINED_AT } });
			insertAgent(db, "house-ts-fixer", "house-tsfix");
			insertAgent(db, "ts-bugfixer", "devon-ops");
			db.close();
		}
		// The migration: the open that runs the backfill.
		const before = Date.now();
		const migrated = openDatabase(path);
		const after = Date.now();
		assert.deepEqual(agentOf(migrated, "vis-op-agent").acquittal, { examId: "seed", at: VISITED_AT },
			"a pre-exam visitor starter takes the seed acquittal dated at the visitor's creation");
		assert.equal(agentOf(migrated, "vis-op-custom").acquittal, null, "an agent that is not the starter takes nothing");
		assert.equal(agentOf(migrated, "plug-op-agent").acquittal, null, "a plugged sample takes no seed acquittal");
		assert.deepEqual(agentOf(migrated, "plug-op-agent").sample, { task: "code-fixer" }, "a plugged sample keeps its sample");
		assert.deepEqual(agentOf(migrated, "exam-op-agent").acquittal, { examId: "exam_1", at: EXAMINED_AT },
			"an existing acquittal is kept");
		assert.equal(agentOf(migrated, "house-ts-fixer").acquittal, null, "a House agent takes no seed acquittal");
		const tsAcquittal = agentOf(migrated, "ts-bugfixer").acquittal as { examId: string; at: string };
		assert.equal(tsAcquittal.examId, "seed");
		const stamp = Date.parse(tsAcquittal.at);
		assert.ok(stamp >= before && stamp <= after, "ts-bugfixer is dated at the migration");
		migrated.close();
		// A second migration re-dates nothing and adds nothing.
		await new Promise(resolve => setTimeout(resolve, 5));
		const again = openDatabase(path);
		assert.deepEqual(agentOf(again, "vis-op-agent").acquittal, { examId: "seed", at: VISITED_AT });
		assert.deepEqual(agentOf(again, "ts-bugfixer").acquittal, tsAcquittal, "a second migration keeps the first date");
		assert.equal(agentOf(again, "plug-op-agent").acquittal, null);
		assert.equal(agentOf(again, "house-ts-fixer").acquittal, null);
		again.close();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} finally { /* the temp dir removal above owns cleanup */ }
});

test("a PAID row stored before it kept its verdict history reads with the empty history", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-legacy-paid-"));
	try {
		const path = join(root, "acquit.db");
		const now = instant("2026-10-06T12:00:00Z");
		// A legacy PAID row: no history, no release authority, and a merge with no commit sha.
		const row = { id: "job_legacy_paid", version: 1, client: "maya-client", tenant: null, title: "Totals round wrong",
			openedAt: now, contract: { budget: usd("400.00"), deliveryEndsAt: now, terms: TERMS }, bids: [],
			state: { status: "PAID", merge: { phase: "MERGED", at: now } } };
		{
			const db = openDatabase(path);
			db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), null);
			db.close();
		}
		const store = new SqliteStore(path);
		const job = await store.readJob("job_legacy_paid" as JobId);
		assert.ok(job);
		const state = job.state as unknown as { status: string; history: unknown; releaseAuthority: unknown;
			merge: { phase: string; at: string; sha: unknown } };
		assert.equal(state.status, "PAID");
		assert.deepEqual(state.history, [], "the legacy row reads with the empty verdict history");
		assert.equal(state.releaseAuthority, null, "the legacy row reads with no release authority");
		assert.deepEqual(state.merge, { phase: "MERGED", at: now, sha: null }, "the legacy merge reads with a null sha");
		store.close();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} finally { /* the temp dir removal above owns cleanup */ }
});
