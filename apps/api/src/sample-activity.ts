// The operator's activity: the jobs one operator's agents hold or bid on, newest first. It reads stored rows only, so it
// sends no command and makes no PayPal call. The hosted sample runner's work is labelled as simulated. Another operator's
// bids, payees, capture ids and hidden case contents never appear here.

import type { OperatorId } from "../../../packages/core/src/ids.ts";
import { attemptHistory, heldPayee } from "../../../packages/core/src/exam.ts";
import { storedVertical } from "../../../packages/core/src/job.ts";
import type { Bid, JobRow, JobState } from "../../../packages/core/src/job.ts";
import type { HeldLine, LedgerLine } from "../../../packages/core/src/ledger.ts";
import { SAMPLE_RUNS_PER_DAY } from "../../../packages/core/src/sample-runner.ts";
import type { SampleRefusal, SampleStatus } from "../../../packages/core/src/sample-runner.ts";
import { reasonCode } from "../../../packages/core/src/score-card.ts";
import type { ReasonCode } from "../../../packages/core/src/score-card.ts";
import type { TestTally } from "../../../packages/core/src/verifier.ts";
import type { SampleRunnerStatus } from "./sample-runner.ts";

export const ACTIVITY_LABELS = { sample: "Sample agent · Simulated", verifier: "Real verifier run", money: "PayPal sandbox" } as const;
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
/** The bids that still count for an operator's activity. A NOT_SELECTED or RETURNED bid leaves the list once no lock remains. */
const ACTIVE_BIDS: ReadonlySet<string> = new Set(["PENDING", "CHOSEN", "ACCEPTED"]);

export type ActivityState = "BID_PLACED" | "FUNDING" | "MONEY_HELD" | "RETRYING" | "VERIFYING" | "REFUNDING"
	| "AWAITING_APPROVAL" | "DISPUTED" | "RELEASING" | "RELEASED" | "REFUNDED" | "CLOSED";

type Tally = { readonly passed: number; readonly expected: number };
type AttemptView = {
	readonly ordinal: number;
	readonly result: "VERIFIED" | "REJECTED";
	readonly at: string;
	readonly frozen: Tally | null;
	readonly hidden: Tally | null;
	readonly reasons: readonly ReasonCode[];
};
type ReviewView = { readonly endsAt: string }
	| { readonly disputed: true; readonly resolveBy: string }
	| { readonly endsAt: null; readonly disputed: false }
	| null;
type RunnerView = {
	readonly enabled: boolean;
	readonly status: SampleStatus;
	readonly reason: SampleRefusal | "WAITING_FOR_FREE_RUNNER" | null;
	readonly queuedSince: string | null;
	readonly runsToday: number;
	readonly runsPerDay: number;
};
type ReleaseView = { readonly at: string; readonly payoutCents: number; readonly authority: string | null; readonly payoutItemId: string } | null;

export type ActivityRow = {
	readonly jobId: string;
	readonly title: string;
	readonly vertical: string;
	readonly source: "SAMPLE_RUNNER" | "OWNER";
	readonly simulated: boolean;
	readonly label: string | null;
	readonly agentId: string | null;
	readonly state: ActivityState;
	readonly updatedAt: string;
	readonly bid: { readonly id: string; readonly priceCents: number; readonly placedAt: string } | null;
	readonly moneyHeld: { readonly heldCents: number; readonly heldAt: string } | null;
	readonly attempts: readonly AttemptView[];
	readonly review: ReviewView;
	readonly release: ReleaseView;
};

export type ActivityInput = {
	readonly operatorId: OperatorId;
	readonly limit: number;
	/**
	 * The stored rows that name the operator somewhere. A superset is fine: the rows the operator holds or bids on are
	 * picked here exactly, so the route only has to avoid reading the whole book.
	 */
	readonly rows: readonly JobRow[];
	/** The job ids the operator's sample runner holds a record for. */
	readonly sampleJobIds: ReadonlySet<string>;
	readonly enabled: boolean;
	/** The runner's status for the operator's visitor, or null when the operator has no visitor. */
	readonly runner: SampleRunnerStatus | null;
};

/** The limit a request asks for: 1 to 50, default 20. Null when the value is malformed. */
export function activityLimit(raw: string | null): number | null {
	if (raw === null) return LIMIT_DEFAULT;
	if (!/^\d+$/.test(raw)) return null;
	const limit = Number(raw);
	return limit >= 1 && limit <= LIMIT_MAX ? limit : null;
}

export function activityJson(input: ActivityInput) {
	const activity = input.rows
		.filter(row => involved(row, input.operatorId))
		.map(row => activityOf(row, input.operatorId, input.sampleJobIds.has(row.id)))
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.jobId.localeCompare(b.jobId))
		.slice(0, input.limit);
	return { sandbox: true, labels: ACTIVITY_LABELS, runner: runnerOf(input), activity };
}

/** The operator is the job's locked payee, or holds a bid that still counts. */
function involved(row: JobRow, operatorId: OperatorId): boolean {
	return heldPayee(row.state)?.operator === operatorId
		|| row.bids.some(bid => bid.operator === operatorId && ACTIVE_BIDS.has(bid.status));
}

function activityOf(row: JobRow, operatorId: OperatorId, sampled: boolean): ActivityRow {
	const bid = bidOf(row, operatorId);
	const held = heldLineOf(row.state);
	const attempts = attemptsOf(row.state);
	const release = releaseOf(row.state);
	const times: string[] = [];
	if (bid !== null) times.push(bid.placedAt);
	if (held !== null) times.push(held.at);
	for (const attempt of attempts) times.push(attempt.at);
	if (release !== null) times.push(release.at);
	return {
		jobId: row.id,
		title: row.title,
		vertical: storedVertical(row),
		source: sampled ? "SAMPLE_RUNNER" : "OWNER",
		simulated: sampled,
		label: sampled ? ACTIVITY_LABELS.sample : null,
		agentId: bid === null ? null : bid.agent,
		state: stateOf(row.state, bid),
		updatedAt: latest(times) ?? row.openedAt,
		bid: bid === null ? null : { id: bid.id, priceCents: bid.price, placedAt: bid.placedAt },
		moneyHeld: held === null ? null : { heldCents: held.cents, heldAt: held.at },
		attempts,
		review: reviewOf(row.state),
		release,
	};
}

/** The operator's own bid on the job: the one that still counts, else the operator's first. */
function bidOf(row: JobRow, operatorId: OperatorId): Bid | null {
	const own = row.bids.filter(bid => bid.operator === operatorId);
	return own.find(bid => ACTIVE_BIDS.has(bid.status)) ?? own[0] ?? null;
}

function latest(times: readonly string[]): string | null {
	let newest: string | null = null;
	for (const time of times) if (newest === null || Date.parse(time) > Date.parse(newest)) newest = time;
	return newest;
}

/** The job's state as the operator sees it. An open job reads FUNDING only when the operator's own bid was chosen. */
function stateOf(state: JobState, bid: Bid | null): ActivityState {
	switch (state.status) {
		case "OPEN": return bid?.status === "CHOSEN" ? "FUNDING" : "BID_PLACED";
		case "IN_PROGRESS": {
			if (state.attempts.phase === "VERIFYING") return "VERIFYING";
			if (state.attempts.phase === "REFUND_PENDING") return "REFUNDING";
			const history = attemptHistory(state);
			const last = history[history.length - 1];
			return last !== undefined && last.verdict.result === "REJECTED" ? "RETRYING" : "MONEY_HELD";
		}
		case "VERIFIED": {
			const review = state.review;
			if (review.phase === "AWAITING_CLIENT") return "AWAITING_APPROVAL";
			if (review.phase === "DISPUTED") return "DISPUTED";
			if (review.phase === "RELEASE_PENDING") return "RELEASING";
			return "REFUNDING";
		}
		case "PAID": return "RELEASED";
		case "REFUNDED": return "REFUNDED";
		case "CLOSED": return "CLOSED";
	}
}

/** The HELD ledger line, the money the job holds now, or the one a settled job held. Null when no hold was ever booked. */
function heldLineOf(state: JobState): { readonly cents: number; readonly at: string } | null {
	const lines: readonly LedgerLine[] | null = state.status === "IN_PROGRESS" || state.status === "VERIFIED" ? state.escrow.book
		: state.status === "PAID" || state.status === "REFUNDED" ? state.book
		: null;
	const held = lines?.find((line): line is HeldLine => line.kind === "HELD");
	return held === undefined ? null : { cents: held.cents, at: held.at };
}

function attemptsOf(state: JobState): AttemptView[] {
	return attemptHistory(state).map(record => {
		const verdict = record.verdict;
		if (verdict.result === "VERIFIED") {
			return { ordinal: record.ordinal, result: "VERIFIED", at: verdict.at, frozen: tallyOf(verdict.frozen), hidden: tallyOf(verdict.hidden), reasons: [] };
		}
		return {
			ordinal: record.ordinal,
			result: "REJECTED",
			at: verdict.at,
			frozen: verdict.tallies === null ? null : tallyOf(verdict.tallies.frozen),
			hidden: verdict.tallies === null ? null : tallyOf(verdict.tallies.hidden),
			reasons: verdict.reasons.map(reasonCode),
		};
	});
}

function tallyOf(tally: TestTally): Tally {
	return { passed: tally.passed, expected: tally.expected };
}

/** The review clock while the job is verified. Null before a verdict and after the money moves. */
function reviewOf(state: JobState): ReviewView {
	if (state.status !== "VERIFIED") return null;
	const review = state.review;
	if (review.phase === "AWAITING_CLIENT") return { endsAt: review.endsAt };
	if (review.phase === "DISPUTED") return { disputed: true, resolveBy: review.resolveBy };
	return { endsAt: null, disputed: false };
}

/** The operator's own payout, once the job is paid. */
function releaseOf(state: JobState): ReleaseView {
	if (state.status !== "PAID") return null;
	return { at: state.release.at, payoutCents: state.release.paid, authority: state.releaseAuthority, payoutItemId: state.release.payoutItemId };
}

/** The runner's status for the operator's visitor. With no visitor, nothing runs for the operator and the status reads OFF or IDLE. */
function runnerOf(input: ActivityInput): RunnerView {
	if (input.runner === null) {
		return { enabled: input.enabled, status: input.enabled ? "IDLE" : "OFF", reason: null, queuedSince: null, runsToday: 0, runsPerDay: SAMPLE_RUNS_PER_DAY };
	}
	const { decision, queuedSince, runsToday } = input.runner;
	return { enabled: input.enabled, status: decision.status, reason: decision.reason, queuedSince, runsToday, runsPerDay: SAMPLE_RUNS_PER_DAY };
}
