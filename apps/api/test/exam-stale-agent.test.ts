// startExam reads the agent row inside its own transaction. A caller that holds an Agent value from before an earlier
// start, here the same stale value twice, must still be refused as already acquitted, and only one run may be written.
// The store is a fresh in-memory database, so there is no HTTP server and no PayPal call.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_VERTICAL } from "../../../packages/core/src/code-manifest.ts";
import { instant } from "../../../packages/core/src/ids.ts";
import type { Agent } from "../../../packages/core/src/operator.ts";
import { SqliteStore } from "../../../packages/core/src/store.ts";
import { startExam } from "../src/specialists.ts";

const NOW = instant("2026-11-10T12:00:00.000Z");
const LATER = instant("2026-11-10T12:05:00.000Z");

/** A code agent with no acquittal: the value a caller reads before its first start. */
const STALE: Agent = { id: "stale-coder" as Agent["id"], owner: "devon-ops" as Agent["owner"], name: "stale-coder",
	runner: "claude-code", promptDigest: "e".repeat(64) as Agent["promptDigest"], tools: [], task: CODE_VERTICAL,
	acquittal: null, sample: null };

function storeWithAgent(): SqliteStore {
	const store = new SqliteStore(":memory:");
	store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(STALE.id, STALE.owner, JSON.stringify(STALE));
	return store;
}

test("a second start with the same stale agent is refused and leaves one run", () => {
	const store = storeWithAgent();
	const first = startExam(store.db, STALE, "exam_first", NOW);
	assert.equal(first.ok, true);
	const second = startExam(store.db, STALE, "exam_second", LATER);
	assert.deepEqual(second, { ok: false, error: "ALREADY_ACQUITTED" });
	const runs = store.db.prepare("SELECT id FROM exam_runs WHERE agent_id = ?").all(STALE.id);
	assert.deepEqual(runs.map(row => String(row.id)), ["exam_first"]);
	const stored = store.db.prepare("SELECT json FROM agents WHERE id = ?").get(STALE.id);
	assert.equal((JSON.parse(String(stored?.json)) as Agent).acquittal?.examId, "exam_first");
});

test("a start for an agent with no row answers NOT_FOUND and writes nothing", () => {
	const store = new SqliteStore(":memory:");
	assert.deepEqual(startExam(store.db, STALE, "exam_missing", NOW), { ok: false, error: "NOT_FOUND" });
	assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM exam_runs").get()?.n), 0);
});
