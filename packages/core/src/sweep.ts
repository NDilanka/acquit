// The expiry sweep. A visitor lives 24 hours; its repository must not outlive it, so the sweep removes
// the repository first and marks the visitor second. A refusal keeps the row for the next sweep, so the
// next pass retries exactly the work that is left, and a repository that is already gone is not a
// failure. Nothing a job needs is deleted: a swept visitor's job still settles through the tick.

import type { DatabaseSync } from "node:sqlite";
import type { ClientRepoDeleteRequest, ClientRepoRemoval } from "./github.ts";
import type { Instant, JobId, VisitorId } from "./ids.ts";
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

/**
 * One pass over the scenario runs' repositories. A scenario visitor's fork goes once every run it started has
 * finished longer than the TTL ago (or it never started one), and it was created longer than the TTL ago. A
 * finished run's work repo goes once it is past the TTL. A RUNNING run is never touched, and neither is a fresh
 * one. Each removal goes through the App's own guard, so a repository this deployment did not make is refused
 * and kept. A refused removal keeps its row, so the next pass retries exactly that work.
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
			AND NOT EXISTS (SELECT 1 FROM scenario_runs r WHERE r.visitor_id = v.id
				AND (r.state = 'RUNNING' OR r.finished_at IS NULL OR r.finished_at > ?))
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
	const finished = input.db.prepare(`SELECT id, job_id FROM scenario_runs
			WHERE state <> 'RUNNING' AND swept_at IS NULL AND finished_at <= ? ORDER BY rowid`).all(cutoff);
	for (const row of finished) {
		const runId = String(row.id);
		const work = input.db.prepare("SELECT repository, repository_id, source FROM work_repos WHERE job_id = ?").get(String(row.job_id) as JobId);
		if (work !== undefined) {
			const repository = String(work.repository);
			try {
				const outcome = await input.app.deleteWorkRepo({ repository, source: String(work.source),
					id: typeof work.repository_id === "number" ? work.repository_id : null });
				workRepos.push({ runId, repository, outcome });
			} catch (error) {
				kept.push({ id: runId, repository, reason: reasonOf(error) });
				continue;
			}
		}
		input.db.prepare("UPDATE scenario_runs SET swept_at = ? WHERE id = ?").run(input.now, runId);
	}
	return { swept, workRepos, kept };
}
