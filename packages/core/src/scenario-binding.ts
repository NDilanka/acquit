// Which job a scenario run opened, read from the database the core writes it to. The run's own OpenJob is
// committed with its request receipt in the job's transaction, under a key derived from the run, so the receipt
// is the proof. A run record in memory or in a snapshot is never the proof.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseRequestKey } from "./ids.ts";
import type { JobId, RequestKey } from "./ids.ts";

/** A request key derived from the run and the step, so a resent step is the same request. */
export function stepKey(runId: string, step: string): RequestKey {
	const hex = createHash("sha256").update(`${runId}:${step}`).digest("hex");
	return parseRequestKey(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}

/**
 * The job a run's OpenJob committed, or null when no such receipt exists. The receipt belongs to the run's own
 * client (its handle, as the open was made) and to the run's key for the open step. A forged run id has no receipt.
 */
export function openedJobOf(db: DatabaseSync, run: { readonly id: string; readonly visitorId: string }): JobId | null {
	const visitor = db.prepare("SELECT client_handle FROM visitors WHERE id = ?").get(run.visitorId);
	if (visitor === undefined) return null;
	const receipt = db.prepare("SELECT result FROM requests WHERE actor = ? AND key = ?")
		.get(`CLIENT:${String(visitor.client_handle)}`, stepKey(run.id, "open-job"));
	if (receipt === undefined) return null;
	const result = JSON.parse(String(receipt.result)) as { readonly kind?: unknown; readonly job?: { readonly id?: unknown } };
	return result.kind === "JOB" && typeof result.job?.id === "string" ? result.job.id as JobId : null;
}

/**
 * Whether a run may take the scenario arbiter's verdict on a job. The committed row must name the dispute-arbiter
 * scenario and this job and still be RUNNING, and the run's own OpenJob receipt must name the job. The row is read
 * from the database, where its identity is write-once, so no caller's copy of a run decides.
 */
export function arbiterOwns(db: DatabaseSync, run: { readonly id: string; readonly jobId: string }): boolean {
	const row = db.prepare("SELECT visitor_id, name, job_id, state FROM scenario_runs WHERE id = ?").get(run.id);
	return row !== undefined && row.name === "dispute-arbiter" && row.state === "RUNNING" && row.job_id === run.jobId
		&& openedJobOf(db, { id: run.id, visitorId: String(row.visitor_id) }) === run.jobId;
}
