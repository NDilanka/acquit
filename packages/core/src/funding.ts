// A job's funding source, held per job. The judge-mode route writes it for a visitor's own job; the
// AcceptBid loader reads it when it builds the order the accept queues. Nothing process-wide decides
// it, so one job's choice can never fund another job.

import type { DatabaseSync } from "node:sqlite";
import type { Instant, JobId } from "./ids.ts";

/** The two sources the sandbox boundary accepts. A stored value outside them is not a mode this build knows. */
export type JobFundingMode = "checkout" | "card";

/** The mode a job holds, or null when nobody has chosen for it and the deployment's default applies. */
export function jobFunding(db: DatabaseSync, jobId: JobId): JobFundingMode | null {
	const row = db.prepare("SELECT mode FROM job_funding WHERE job_id = ?").get(jobId);
	const mode = row ? String(row.mode) : null;
	return mode === "checkout" || mode === "card" ? mode : null;
}
/** The client's choice for one job. The last write wins: a second choice replaces the first. */
export function setJobFunding(db: DatabaseSync, jobId: JobId, mode: JobFundingMode, at: Instant): void {
	db.prepare(`INSERT INTO job_funding (job_id, mode, set_at) VALUES (?, ?, ?)
		ON CONFLICT(job_id) DO UPDATE SET mode = excluded.mode, set_at = excluded.set_at`).run(jobId, mode, at);
}
/**
 * The deployment's own default for a job nobody has chosen for. It never overwrites a choice, so a
 * replayed OpenJob cannot reset what the client set in between.
 */
export function defaultJobFunding(db: DatabaseSync, jobId: JobId, mode: JobFundingMode, at: Instant): void {
	db.prepare("INSERT OR IGNORE INTO job_funding (job_id, mode, set_at) VALUES (?, ?, ?)").run(jobId, mode, at);
}
