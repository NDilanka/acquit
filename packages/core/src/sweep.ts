// The expiry sweep. A visitor lives 24 hours; its repository must not outlive it, so the sweep removes
// the repository first and marks the visitor second. A refusal keeps the row for the next sweep, so the
// next pass retries exactly the work that is left, and a repository that is already gone is not a
// failure. Nothing a job needs is deleted: a swept visitor's job still settles through the tick.

import type { DatabaseSync } from "node:sqlite";
import type { ClientRepoDeleteRequest, ClientRepoRemoval } from "./github.ts";
import type { Instant, JobId, VisitorId } from "./ids.ts";
import { openedJobOf } from "./scenario-binding.ts";
import { expiredVisitors, readVisitor, sweepVisitor } from "./visitors.ts";

/** What the sweep needs of the App, and nothing else. */
export type ClientRepoDeleter = { deleteClientRepo(request: { readonly repository: string; readonly source: string;
	readonly id: number | null }): Promise<ClientRepoRemoval> };

/** What the scenario sweep needs of the App: a visitor's fork and a job's work repo, each removed under the same guard. */
export type ScenarioRepoDeleter = ClientRepoDeleter & { deleteWorkRepo(request: ClientRepoDeleteRequest): Promise<ClientRepoRemoval> };

export type SweepReport = {
	/** The visitors whose repository is gone, whose sessions are deleted, and whose row now reads SWEPT. */
	readonly swept: readonly string[];
	/** What removing each repository found: this deployment's own fork, or a name already gone. */
	readonly repositories: readonly { readonly repository: string; readonly outcome: ClientRepoRemoval }[];
	/** The visitors left for the next sweep, with the refusal that kept them. */
	readonly kept: readonly { readonly id: string; readonly repository: string; readonly reason: string }[];
};

/** The reason a refusal is reported under: the App's own closed code, or one this module owns. */
const reasonOf = (error: unknown): string => {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
	return "SWEEP_FAILED";
};

/**
 * One pass over the visitors past their expiry. Every expired visitor is removed independently: one
 * refusal never stops the sweep or hides another visitor's outcome, and nothing is forgotten while its
 * repository is still out there.
 */
export async function sweepExpiredVisitors(input: { readonly db: DatabaseSync; readonly app: ClientRepoDeleter;
	readonly source: string; readonly now: Instant }): Promise<SweepReport> {
	const swept: string[] = [];
	const repositories: { repository: string; outcome: ClientRepoRemoval }[] = [];
	const kept: { id: string; repository: string; reason: string }[] = [];
	for (const visitor of expiredVisitors(input.db, input.now)) {
		if (visitor.repository !== null) {
			try {
				repositories.push({ repository: visitor.repository, outcome: await input.app.deleteClientRepo({ repository: visitor.repository,
					source: input.source, id: visitor.repositoryId }) });
			} catch (error) {
				kept.push({ id: visitor.id, repository: visitor.repository, reason: reasonOf(error) });
				continue;
			}
		}
		sweepVisitor(input.db, visitor.id);
		swept.push(visitor.id);
	}
	return { swept, repositories, kept };
}

/** How long a finished scenario run keeps its repositories, so a judge can still open the fork and the work repo. */
export const SCENARIO_SWEEP_TTL_MS = 2 * 3_600_000;

export type ScenarioSweepReport = {
	/** The scenario visitors whose fork is gone and whose row now reads SWEPT. */
	readonly swept: readonly string[];
	/** The work repositories removed for finished runs, by the run that opened the job. */
	readonly workRepos: readonly { readonly runId: string; readonly repository: string; readonly outcome: ClientRepoRemoval }[];
	/** What was left for the next pass, with the refusal that kept it. */
	readonly kept: readonly { readonly id: string; readonly repository: string; readonly reason: string }[];
};

/** Whether a job's CREATE_WORK_REPO effect may still create its repository: any state but CONFIRMED or NEEDS_HUMAN. */
const creationPending = (db: DatabaseSync, jobId: JobId): boolean => db.prepare(`SELECT 1 FROM outbox
	WHERE json_extract(json, '$.effect.kind') = 'CREATE_WORK_REPO' AND json_extract(json, '$.effect.jobId') = ?
	AND json_extract(state, '$.kind') NOT IN ('CONFIRMED', 'NEEDS_HUMAN')`).get(jobId) !== undefined;

/**
 * One pass over the scenario runs' repositories, read from the cleanup journal and never from a snapshot. A
 * scenario visitor's fork goes once every run it started has finished longer than the TTL ago (or it never
 * started one), and it was created longer than the TTL ago. A finished run's work repo goes once it is past the
 * TTL, and only when its job is the one the run's own OpenJob committed. A RUNNING run is never touched, and
 * neither is a fresh one. Each removal goes through the App's own guard, so a repository this deployment did not
 * make is refused and kept. A refused removal keeps its row, so the next pass retries exactly that work.
 */
export async function sweepScenarioRuns(input: { readonly db: DatabaseSync; readonly app: ScenarioRepoDeleter;
	readonly source: string; readonly now: Instant; readonly ttlMs?: number }): Promise<ScenarioSweepReport> {
	const cutoff = new Date(Date.parse(input.now) - (input.ttlMs ?? SCENARIO_SWEEP_TTL_MS)).toISOString() as Instant;
	const swept: string[] = [];
	const workRepos: { runId: string; repository: string; outcome: ClientRepoRemoval }[] = [];
	const kept: { id: string; repository: string; reason: string }[] = [];
	const visitorIds = input.db.prepare(`SELECT v.id FROM visitors v
			JOIN cap_reservations c ON c.kind = 'SCENARIO' AND c.ref = v.id
			WHERE v.state <> 'SWEPT' AND v.created_at <= ?
			AND NOT EXISTS (SELECT 1 FROM scenario_cleanup k WHERE k.visitor_id = v.id
				AND (k.finished_at IS NULL OR k.finished_at > ?))
			ORDER BY v.created_at`).all(cutoff, cutoff).map(row => String(row.id) as VisitorId);
	for (const id of visitorIds) {
		const visitor = readVisitor(input.db, id);
		if (visitor === null) continue;
		if (visitor.repository !== null) {
			try {
				await input.app.deleteClientRepo({ repository: visitor.repository, source: input.source, id: visitor.repositoryId });
			} catch (error) {
				kept.push({ id, repository: visitor.repository, reason: reasonOf(error) });
				continue;
			}
		}
		sweepVisitor(input.db, id);
		swept.push(id);
	}
	// Only the journal is read here, and only a scenario visitor's run counts. The job must be the one the run's own
	// OpenJob committed, so a row that names another job (a crafted snapshot, say) never reaches an ordinary job's repo.
	const due = input.db.prepare(`SELECT k.run_id, k.visitor_id, k.job_id FROM scenario_cleanup k
			JOIN cap_reservations c ON c.kind = 'SCENARIO' AND c.ref = k.visitor_id
			WHERE k.finished_at IS NOT NULL AND k.finished_at <= ? AND k.work_swept_at IS NULL ORDER BY k.rowid`).all(cutoff);
	for (const row of due) {
		const runId = String(row.run_id);
		const jobId = String(row.job_id) as JobId;
		const work = input.db.prepare("SELECT repository, repository_id, source FROM work_repos WHERE job_id = ?").get(jobId);
		const repository = work === undefined ? "" : String(work.repository);
		if (openedJobOf(input.db, { id: runId, visitorId: String(row.visitor_id) }) !== jobId) {
			kept.push({ id: runId, repository, reason: "SCENARIO_BINDING_MISSING" });
			continue;
		}
		// No record yet and the creation may still land: the record, when it comes, reopens the job's cleanup.
		if (work === undefined && creationPending(input.db, jobId)) {
			kept.push({ id: runId, repository, reason: "WORK_REPO_PENDING" });
			continue;
		}
		if (work !== undefined) {
			try {
				const outcome = await input.app.deleteWorkRepo({ repository, source: String(work.source),
					id: typeof work.repository_id === "number" ? work.repository_id : null });
				workRepos.push({ runId, repository, outcome });
			} catch (error) {
				kept.push({ id: runId, repository, reason: reasonOf(error) });
				continue;
			}
		}
		input.db.prepare("UPDATE scenario_cleanup SET work_swept_at = ? WHERE run_id = ?").run(input.now, runId);
	}
	return { swept, workRepos, kept };
}
