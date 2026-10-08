// The expiry sweep. A visitor lives 24 hours; its repository must not outlive it, so the sweep removes
// the repository first and marks the visitor second. A refusal keeps the row for the next sweep, so the
// next pass retries exactly the work that is left, and a repository that is already gone is not a
// failure. Nothing a job needs is deleted: a swept visitor's job still settles through the tick.

import type { DatabaseSync } from "node:sqlite";
import type { ClientRepoRemoval } from "./github.ts";
import type { Instant } from "./ids.ts";
import { expiredVisitors, sweepVisitor } from "./visitors.ts";

/** What the sweep needs of the App, and nothing else. */
export type ClientRepoDeleter = { deleteClientRepo(request: { readonly repository: string; readonly source: string;
	readonly id: number | null }): Promise<ClientRepoRemoval> };

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
