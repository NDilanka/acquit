// One job's clock. Judge mode advances the job a visitor owns: its stored instants move back by the
// advance, its wake time moves with them, and its own pending effects come due as if that much time
// had passed for this job. Another job's row, deadlines, and outbox are never touched, so no
// visitor's advance can push another visitor's review window.

import type { DatabaseSync } from "node:sqlite";
import type { OutboxState } from "./effects.ts";
import { wakeAt } from "./job.ts";
import type { JobRow, JobState } from "./job.ts";
import type { JobId, Version } from "./ids.ts";
import { instant } from "./ids.ts";
import { outboxDue } from "./store.ts";

/**
 * The keys the domain stores an instant under: `at`, `openedAt`, `respondBy`, `runEndsAt`, and the
 * rest. A string under any other key is text, however much it looks like a time.
 */
const INSTANT_KEY = /^(at|.+At|.+By)$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const moved = (value: string, advanceMs: number): string => new Date(Date.parse(value) - advanceMs).toISOString();

function shifted(value: unknown, advanceMs: number): unknown {
	if (Array.isArray(value)) return value.map(item => shifted(item, advanceMs));
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		out[key] = INSTANT_KEY.test(key) && typeof item === "string" && ISO_INSTANT.test(item)
			? moved(item, advanceMs) : shifted(item, advanceMs);
	}
	return out;
}
/** The row's own instants, moved back by the advance, as if that much time had passed for this job alone. */
export function shiftJobInstants<S extends JobState>(row: JobRow<S>, advanceMs: number): JobRow<S> {
	return shifted(row, advanceMs) as JobRow<S>;
}
/**
 * Moves one job's clock and leaves it due for the next tick. The version moves with the write, so a
 * command already in flight against the old row loses its compare-and-set and re-reads the shift.
 * A leased effect stays where it is: that lease is another worker's hold, not this job's timeline.
 */
export function shiftJobClock(db: DatabaseSync, jobId: JobId, advanceMs: number): JobRow | null {
	const record = db.prepare("SELECT json, version FROM jobs WHERE id = ?").get(jobId);
	if (!record) return null;
	const row = JSON.parse(String(record.json)) as JobRow;
	const next = { ...shiftJobInstants(row, advanceMs), version: (row.version + 1) as Version };
	const updated = db.prepare("UPDATE jobs SET version = ?, json = ?, wake_at = ? WHERE id = ? AND version = ?")
		.run(next.version, JSON.stringify(next), wakeAt(next), jobId, row.version);
	if (!updated.changes) return null;
	for (const effect of db.prepare("SELECT key, json, state FROM outbox").all()) {
		const stored = JSON.parse(String(effect.json)) as { effect?: { jobId?: string } };
		if (stored.effect?.jobId !== jobId) continue;
		const state = JSON.parse(String(effect.state)) as OutboxState;
		const nextState: OutboxState = state.kind === "READY" ? { ...state, runAt: instant(moved(state.runAt, advanceMs)) }
			: state.kind === "UNCERTAIN" ? { ...state, reconcileAt: instant(moved(state.reconcileAt, advanceMs)) }
			: state;
		// A lease is another worker's hold on this effect, not part of the job's own timeline.
		if (nextState === state) continue;
		db.prepare("UPDATE outbox SET state = ?, due_at = ? WHERE key = ?").run(JSON.stringify(nextState), outboxDue(nextState), String(effect.key));
	}
	return next;
}
