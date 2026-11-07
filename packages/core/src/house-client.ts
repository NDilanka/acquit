// The House client: Acquit's own client inside each lasting account's private workspace. It posts the starter jobs
// the account's operator side can win, accepts a bid on them, and approves the verified work, always through the
// same commands a person sends. It is never a principal: no session, saved link, or sign-in can act as it.

import type { Actor } from "./acquit.ts";
import { matchFixture } from "./fixtures.ts";
import type { FixtureContract } from "./fixtures.ts";
import type { ClientId, VisitorId } from "./ids.ts";
import type { JobRow } from "./job.ts";

export const HOUSE_CLIENT_ID = "house-client" as ClientId;

/** The name every view shows for the House client. */
export const HOUSE_CLIENT_LABEL = "House client";

/** The actor the House client sends its commands as, inside one account's workspace and on that account's fork. */
export function houseClientActor(tenant: VisitorId, repository: string | null): Actor {
	return { role: "CLIENT", clientId: HOUSE_CLIENT_ID, tenant, ...(repository === null ? {} : { repository }) };
}

export function isHouseClient(actor: Actor | { readonly role: string }): boolean {
	return actor.role === "CLIENT" && "clientId" in actor && actor.clientId === HOUSE_CLIENT_ID;
}

/** A starter job is one the House client opened. The job row's own client says so, so nothing else has to agree. */
export function isStarterJob(row: { readonly client: ClientId }): boolean {
	return row.client === HOUSE_CLIENT_ID;
}

/**
 * The fixtures a starter can be opened from on this account's repository, in a fixed order so the rotation is the
 * same in every process. A practice issue is never a starter: it belongs to qualification, not to the market.
 * On a fork, only the fixtures on the upstream the forks are made from are in the pool.
 */
export function starterPool(fixtures: readonly FixtureContract[], repository: string | null, upstream: string | null): readonly FixtureContract[] {
	return fixtures
		.filter(fixture => fixture.practice !== true)
		.filter(fixture => matchFixture(fixtures, repository ?? fixture.repository, fixture.issue.number, repository, upstream) === fixture)
		.toSorted((a, b) => a.repository.localeCompare(b.repository) || a.issue.number - b.issue.number);
}

/** A bid that still holds or could fund a starter: a PENDING one could be accepted, a CHOSEN one is being funded, an ACCEPTED one is funded. */
const liveBid = (bid: JobRow["bids"][number]): boolean => bid.status === "PENDING" || bid.status === "CHOSEN" || bid.status === "ACCEPTED";

/** Whether the pool no longer holds a starter's issue: no registry fixture matches its repository and issue, or the one that does is not in the pool. */
function offPool(row: JobRow, fixtures: readonly FixtureContract[], pool: readonly FixtureContract[], upstream: string | null): boolean {
	const done = row.contract.definitionOfDone;
	if (!done) return false;
	const fixture = matchFixture(fixtures, done.issue.repository, done.issue.number, done.issue.repository, upstream);
	return fixture === null || !pool.includes(fixture);
}

/**
 * Whether the House client may retire this row: its own starter, still OPEN, on an issue the account's pool no longer
 * holds, with no bid that could still fund it. The retire command asks this of the row each commit attempt reads, so a bid
 * or an accept that committed after the pass read its snapshot keeps the starter.
 */
export function retirable(row: JobRow, fixtures: readonly FixtureContract[], repository: string | null, upstream: string | null): boolean {
	return isStarterJob(row) && row.state.status === "OPEN" && !row.bids.some(liveBid)
		&& offPool(row, fixtures, starterPool(fixtures, repository, upstream), upstream);
}
