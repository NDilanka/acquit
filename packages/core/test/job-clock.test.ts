// Advancing one job's clock moves that job's own stored instants, its wake time, and its own pending
// effects' due times. Another job's row, deadlines, and outbox never move: judge mode's clock is a
// per-job action, so no visitor can push another visitor's review window.

import assert from "node:assert/strict";
import test from "node:test";
import { shiftJobClock, shiftJobInstants } from "../src/job-clock.ts";
import { SqliteStore } from "../src/store.ts";
import type { JobRow } from "../src/job.ts";
import type { JobId } from "../src/ids.ts";

const day = 86_400_000;
const at = "2026-10-06T12:00:00.000Z";
/** One open job with a bid, an escrow cutoff, and a book line: every kind of instant the domain stores. */
function openRow(id: string): JobRow {
	return { id: id as JobId, version: 1 as JobRow["version"], client: "maya-client" as JobRow["client"], title: "Totals round wrong",
		contract: { definitionOfDone: null, budget: 40000 as JobRow["contract"]["budget"], deliveryEndsAt: "2026-10-10T12:00:00.000Z" as JobRow["contract"]["deliveryEndsAt"],
			terms: {} as JobRow["contract"]["terms"] },
		openedAt: at as JobRow["openedAt"],
		bids: [{ id: "bid_1" as JobRow["bids"][number]["id"], operator: "devon-ops" as JobRow["bids"][number]["operator"], handle: "devon-ops",
			kind: "INDEPENDENT", payee: "merchant" as JobRow["bids"][number]["payee"], agent: "ts-bugfixer" as JobRow["bids"][number]["agent"],
			runner: "claude-code", price: 40000 as JobRow["bids"][number]["price"], eta: 48 as JobRow["bids"][number]["eta"], pitch: "fix it",
			placedAt: at as JobRow["bids"][number]["placedAt"], respondBy: "2026-10-09T12:00:00.000Z" as JobRow["bids"][number]["respondBy"], status: "PENDING" }],
		state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } } };
}

test("the shift moves the job's own instants and leaves text that only looks like one alone", () => {
	const row = openRow("job_A");
	const lookedLikeAnInstant = { ...row, title: at, arbiterNote: at };
	const shifted = shiftJobInstants(lookedLikeAnInstant, 2 * day);
	assert.equal(shifted.openedAt, "2026-10-04T12:00:00.000Z");
	assert.equal(shifted.contract.deliveryEndsAt, "2026-10-08T12:00:00.000Z");
	assert.equal(shifted.bids[0].placedAt, "2026-10-04T12:00:00.000Z");
	assert.equal(shifted.bids[0].respondBy, "2026-10-07T12:00:00.000Z");
	// A title or a note is text, whatever it spells, and the row's numbers are not instants either.
	assert.equal(shifted.title, at);
	assert.equal(shifted.arbiterNote, at);
	assert.equal(shifted.contract.budget, 40000);
	assert.equal(shifted.bids[0].pitch, "fix it");
	// The shift reads the row it was handed, never the row it produced.
	assert.equal(row.openedAt, at);
});

test("advancing one job's clock moves its row, its wake time, and its own effects, and nothing else", () => {
	const store = new SqliteStore(":memory:");
	const insert = (row: JobRow, wakeAt: string) => store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)")
		.run(row.id, row.version, JSON.stringify(row), wakeAt);
	insert(openRow("job_A"), "2026-10-09T12:00:00.000Z");
	insert(openRow("job_B"), "2026-10-09T12:00:00.000Z");
	const effect = (jobId: string, state: unknown) => JSON.stringify({ key: `effect_${jobId}`, payloadDigest: "d",
		effect: { kind: "CREATE_ORDER", jobId, round: 1 }, state });
	const ready = { kind: "READY", runAt: "2026-10-06T12:30:00.000Z" };
	const leased = { kind: "LEASED", leaseUntil: "2026-10-06T12:01:00.000Z" };
	store.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)").run("effect_A", effect("job_A", ready), JSON.stringify(ready), "2026-10-06T12:30:00.000Z");
	store.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)").run("effect_B", effect("job_B", ready), JSON.stringify(ready), "2026-10-06T12:30:00.000Z");
	store.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)").run("effect_lease", effect("job_A", leased), JSON.stringify(leased), "2026-10-06T12:01:00.000Z");
	const rowOf = (id: string) => JSON.parse(String(store.db.prepare("SELECT json FROM jobs WHERE id = ?").get(id)!.json)) as JobRow;
	const stored = (id: string) => ({ ...store.db.prepare("SELECT version, wake_at FROM jobs WHERE id = ?").get(id) as { version: number; wake_at: string } });
	const effectRow = (key: string) => ({ ...store.db.prepare("SELECT state, due_at FROM outbox WHERE key = ?").get(key) as { state: string; due_at: string } });
	try {
		const before = rowOf("job_B");
		const shifted = shiftJobClock(store.db, "job_A" as JobId, day);
		assert(shifted);
		assert.equal(shifted.version, 2, "The shift is a write a racing command's compare-and-set must see.");
		assert.equal(shifted.contract.deliveryEndsAt, "2026-10-09T12:00:00.000Z");
		assert.equal(stored("job_A").version, 2);
		assert.equal(stored("job_A").wake_at, "2026-10-08T12:00:00.000Z", "The shifted job is due at its own new deadline.");
		// The other job's row, its wake time, and its own effect did not move at all.
		assert.deepEqual(rowOf("job_B"), before);
		assert.deepEqual(stored("job_B"), { version: 1, wake_at: "2026-10-09T12:00:00.000Z" });
		assert.deepEqual(effectRow("effect_B"), { state: JSON.stringify(ready), due_at: "2026-10-06T12:30:00.000Z" });
		// The shifted job's own pending effect moved with it; a lease another worker holds did not.
		assert.deepEqual(JSON.parse(effectRow("effect_A").state), { kind: "READY", runAt: "2026-10-05T12:30:00.000Z" });
		assert.equal(effectRow("effect_A").due_at, "2026-10-05T12:30:00.000Z");
		assert.deepEqual(effectRow("effect_lease"), { state: JSON.stringify(leased), due_at: "2026-10-06T12:01:00.000Z" });
		assert.equal(shiftJobClock(store.db, "job_MISSING" as JobId, day), null);
	} finally { store.close(); }
});
