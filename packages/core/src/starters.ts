// The House client's supervisor. Every lasting account's workspace holds starter jobs the House client
// opened; this pass keeps them moving. It opens the account's first two, opens the next one whenever the
// account has none open, accepts the best bid about 30 seconds after the account's operator bids, and
// approves about 60 seconds after the work is Verified. Each act is an ordinary command the House client
// sends, so the table's own guards decide it, exactly as they would for a person.
//
// Restart safety: nothing here is remembered between passes. Each due time is computed from instants the
// job row already stores (a bid's placedAt, the review's endsAt), and each command carries a request key
// derived from what it acts on (the account and the starter's ordinal, the job and its funding round, the
// job and the judged commit). A pass that runs twice, or again after a restart, sends the same key, and
// the request record answers REPLAY instead of acting twice.

import type { CommandOutcome, UserCommand } from "./acquit.ts";
import { derivedRequestKey, executeCommand } from "./effects.ts";
import type { Ports } from "./effects.ts";
import type { FixtureContract } from "./fixtures.ts";
import { matchFixture } from "./fixtures.ts";
import { HOUSE_CLIENT_ID, houseClientActor, isStarterJob } from "./house-client.ts";
import { addHours, hours, instant } from "./ids.ts";
import type { Instant, JobId, VisitorId } from "./ids.ts";
import type { UsdCents } from "./ledger.ts";
import { releaseHeld, TERMS } from "./job.ts";
import type { JobRow } from "./job.ts";

/** How many starter jobs an account's workspace opens with. */
export const STARTER_OPENING_COUNT = 2;
/** The starter budget: 400.00 USD, so the operator is paid 360.00 USD after the platform's 10 percent. */
export const STARTER_BUDGET = 40_000 as UsdCents;
/** The starter's delivery window. */
export const STARTER_DELIVERY_HOURS = 5 * 24;
export const HOUSE_ACCEPT_DELAY_MS = 30_000;
export const HOUSE_APPROVE_DELAY_MS = 60_000;
/** A starter whose card payment failed this many times is left for its bids to expire, so a failing card is not charged forever. */
export const HOUSE_ACCEPT_ROUNDS = 3;

/** One lasting account the House client trades with: its workspace and the fork its jobs open on. */
export type HouseAccount = { readonly id: VisitorId; readonly repository: string | null };

/** What the pass needs beside the ports: the jobs' funding choice, which lives beside the row. */
export type HouseClientPorts = Ports & { readonly fundWithCard: (jobId: JobId, at: Instant) => void };

/**
 * The fixtures a starter can be opened from on this account's repository, in a fixed order so the rotation is the
 * same in every process. A practice issue is never a starter: it belongs to qualification, not to the market.
 */
export function starterPool(fixtures: readonly FixtureContract[], repository: string | null): readonly FixtureContract[] {
	return fixtures
		.filter(fixture => fixture.practice !== true)
		.filter(fixture => matchFixture(fixtures, repository ?? fixture.repository, fixture.issue.number, repository) === fixture)
		.toSorted((a, b) => a.repository.localeCompare(b.repository) || a.issue.number - b.issue.number);
}

/** The account's starter jobs, oldest first. Their count is the ordinal the next starter opens under. */
function startersOf(jobs: readonly JobRow[], account: HouseAccount): readonly JobRow[] {
	return jobs.filter(row => row.tenant === account.id && isStarterJob(row))
		.toSorted((a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id));
}

const sinceMs = (at: Instant, now: Instant) => Date.parse(now) - Date.parse(at);

/** One pass over every account. Returns how many commands committed. */
export async function runHouseClients(ports: HouseClientPorts, accounts: readonly HouseAccount[]): Promise<number> {
	let acted = 0;
	for (const account of accounts) acted += await runHouseClient(ports, account);
	return acted;
}

export async function runHouseClient(ports: HouseClientPorts, account: HouseAccount): Promise<number> {
	const actor = houseClientActor(account.id, account.repository);
	const send = async (seed: string, command: UserCommand): Promise<CommandOutcome> =>
		executeCommand(ports, actor, derivedRequestKey(`${HOUSE_CLIENT_ID}:${seed}`), command);
	let acted = 0;
	const jobs = await ports.store.listJobs();
	const starters = startersOf(jobs, account);
	const open = starters.filter(row => row.state.status === "OPEN").length;
	// The opening pair, then one more whenever none is open. The ordinal is the count already opened, so a
	// replayed pass names the same starter, and the day's cap is the reservation OpenJob writes.
	const wanted = starters.length < STARTER_OPENING_COUNT ? STARTER_OPENING_COUNT - starters.length : open === 0 ? 1 : 0;
	const pool = starterPool(ports.fixtures, account.repository);
	for (let i = 0; i < wanted && pool.length > 0; i++) {
		const ordinal = starters.length + i;
		const fixture = pool[ordinal % pool.length]!;
		const now = ports.clock.now();
		const outcome = await send(`starter:${account.id}:${ordinal}`, { type: "OpenJob",
			repository: account.repository ?? fixture.repository, issueNumber: fixture.issue.number, budget: STARTER_BUDGET,
			deliveryEndsAt: addHours(now, hours(STARTER_DELIVERY_HOURS)) });
		if (outcome.kind === "DENIED") break;
		if (outcome.result.kind === "JOB") ports.fundWithCard(outcome.result.job.id, now);
		if (outcome.kind === "COMMITTED") acted++;
	}
	for (const row of starters) {
		const now = ports.clock.now();
		if (row.state.status === "OPEN" && row.state.phase.kind === "BIDDING" && row.state.phase.fundingRounds < HOUSE_ACCEPT_ROUNDS) {
			const pending = row.bids.filter(bid => bid.kind !== "HOUSE" && bid.status === "PENDING");
			if (pending.length === 0) continue;
			const first = pending.map(bid => bid.placedAt).toSorted()[0]!;
			if (sinceMs(first, now) < HOUSE_ACCEPT_DELAY_MS) continue;
			const best = pending.toSorted((a, b) => a.price - b.price || a.placedAt.localeCompare(b.placedAt) || a.id.localeCompare(b.id))[0]!;
			// The card is the starter's funding. Written again here, so a process that stopped between the open and
			// that write still accepts by card, never through a checkout no one will approve.
			ports.fundWithCard(row.id, now);
			const outcome = await send(`accept:${row.id}:${row.state.phase.fundingRounds}`, { type: "AcceptBid", jobId: row.id, bidId: best.id });
			if (outcome.kind === "COMMITTED") acted++;
		} else if (row.state.status === "VERIFIED" && row.state.review.phase === "AWAITING_CLIENT") {
			// A PayPal buyer dispute holds the release; the House client waits it out like a person would.
			if (releaseHeld(row)) continue;
			const verifiedAt = instant(new Date(Date.parse(row.state.review.endsAt) - TERMS.clientReviewHours * 3_600_000).toISOString());
			if (sinceMs(verifiedAt, now) < HOUSE_APPROVE_DELAY_MS) continue;
			const mergeCommit = row.state.passed.verdict.mergeCommit;
			const outcome = await send(`approve:${row.id}:${mergeCommit}`, { type: "Approve", jobId: row.id, mergeCommit });
			if (outcome.kind === "COMMITTED") acted++;
		}
	}
	return acted;
}
