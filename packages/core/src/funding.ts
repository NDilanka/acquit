// A job's funding source, held per job. The judge-mode route writes it for a visitor's own job; the
// AcceptBid loader reads it when it builds the order the accept queues. Nothing process-wide decides
// it, so one job's choice can never fund another job.

import type { DatabaseSync } from "node:sqlite";
import type { Instant, JobId, Version } from "./ids.ts";
import type { JobRow } from "./job.ts";

/** The two sources the sandbox boundary accepts. A stored value outside them is not a mode this build knows. */
export type JobFundingMode = "checkout" | "card";

/** The mode a job holds, or null when nobody has chosen for it and the deployment's default applies. */
export function jobFunding(db: DatabaseSync, jobId: JobId): JobFundingMode | null {
	const row = db.prepare("SELECT mode FROM job_funding WHERE job_id = ?").get(jobId);
	const mode = row ? String(row.mode) : null;
	return mode === "checkout" || mode === "card" ? mode : null;
}

/** What a choice did. Only CHOSEN writes anything. */
export type FundingChoice = "CHOSEN" | "FUNDING_BOUND" | "JOB_CHANGED" | "NOT_FOUND";

/** One client's choice, read from the row the route showed it. */
export type FundingRequest = {
	readonly jobId: JobId;
	/** The version the caller read. A row that moved under it refuses the choice whole. */
	readonly expectedVersion: Version;
	readonly mode: JobFundingMode;
	readonly at: Instant;
};

/**
 * The client's choice for one job, taken in one transaction against the row the caller read.
 *
 * The choice moves the job's own version, which is what makes it safe against the other writer that
 * reads the same row: AcceptBid's loader reads the mode and then commits with the version it read, so
 * a choice that lands in between refuses that commit and the accept re-plans from the row that now
 * carries this mode. The choice itself belongs to a job that still takes bids: an accepted bid has
 * already bound the order's payment source, and a later choice would be a claim this job cannot honour.
 */
export function chooseJobFunding(db: DatabaseSync, request: FundingRequest): FundingChoice {
	db.exec("BEGIN IMMEDIATE");
	try {
		const stored = db.prepare("SELECT version, json FROM jobs WHERE id = ?").get(request.jobId);
		if (!stored) { db.exec("ROLLBACK"); return "NOT_FOUND"; }
		const row = JSON.parse(String(stored.json)) as JobRow;
		// The phase is asked first, so a choice that arrives after the accept names the accept as its
		// reason, whatever row the caller read.
		if (!(row.state.status === "OPEN" && row.state.phase.kind === "BIDDING")) { db.exec("ROLLBACK"); return "FUNDING_BOUND"; }
		if (row.version !== request.expectedVersion) { db.exec("ROLLBACK"); return "JOB_CHANGED"; }
		const next = { ...row, version: (row.version + 1) as Version };
		const moved = db.prepare("UPDATE jobs SET version = ?, json = ? WHERE id = ? AND version = ?")
			.run(next.version, JSON.stringify(next), request.jobId, request.expectedVersion);
		if (!moved.changes) { db.exec("ROLLBACK"); return "JOB_CHANGED"; }
		db.prepare(`INSERT INTO job_funding (job_id, mode, set_at) VALUES (?, ?, ?)
			ON CONFLICT(job_id) DO UPDATE SET mode = excluded.mode, set_at = excluded.set_at`).run(request.jobId, request.mode, request.at);
		db.exec("COMMIT");
		return "CHOSEN";
	} catch (error) { db.exec("ROLLBACK"); throw error; }
}
/**
 * The deployment's own default for a job nobody has chosen for. It never overwrites a choice, so a
 * replayed OpenJob cannot reset what the client set in between.
 */
export function defaultJobFunding(db: DatabaseSync, jobId: JobId, mode: JobFundingMode, at: Instant): void {
	db.prepare("INSERT OR IGNORE INTO job_funding (job_id, mode, set_at) VALUES (?, ?, ?)").run(jobId, mode, at);
}
