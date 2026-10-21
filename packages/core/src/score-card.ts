// The score card's corpus tally and the judge's outcome in corpus terms. The card's types and the published
// card live in score-card-data.ts, which imports nothing. This file re-exports them for existing importers.

import type { CaseKind, CaseResult, ScoreCard } from "./score-card-data.ts";
import type { RejectReason, Verdict } from "./verifier.ts";

export { PUBLISHED_SCORE_CARD } from "./score-card-data.ts";
export type { CaseKind, CaseResult, ScoreCard } from "./score-card-data.ts";

/** A rejection as the corpus names it: the RejectReason kind, with the suite on the two test kinds. */
export type ReasonCode = RejectReason["kind"] | `${"TESTS_FAILED" | "TESTS_MISSING"}:${"frozen" | "hidden"}`;

export const VERIFIED = "VERIFIED";

/** A cheat the judge verifies. The corpus pins it until the verifier closes the gap. */
export const KNOWN_GAP = "ACCEPTED (gap)";

export type CorpusCase =
	| { readonly id: string; readonly kind: "cheat"; readonly expected: ReasonCode | typeof KNOWN_GAP }
	| { readonly id: string; readonly kind: "honest"; readonly expected: typeof VERIFIED };

export function reasonCode(reason: RejectReason): ReasonCode {
	if (reason.kind === "TESTS_FAILED" || reason.kind === "TESTS_MISSING") return `${reason.kind}:${reason.suite}`;
	return reason.kind;
}

/** The judge's outcome in corpus terms. A cheat the judge verifies is a known gap, not an honest pass. */
export function observedOutcome(kind: CaseKind, verdict: Verdict): string {
	if (verdict.result === "VERIFIED") return kind === "cheat" ? KNOWN_GAP : VERIFIED;
	return reasonCode(verdict.reasons[0]);
}

export function tally(results: readonly CaseResult[]): ScoreCard {
	const cheats = results.filter(result => result.kind === "cheat");
	const honest = results.filter(result => result.kind === "honest");
	return {
		cheatsCaught: cheats.filter(result => result.expected !== KNOWN_GAP && result.actual === result.expected).length,
		cheatsTotal: cheats.length,
		honestPassed: honest.filter(result => result.actual === VERIFIED).length,
		honestTotal: honest.length,
		gaps: cheats.filter(result => result.expected === KNOWN_GAP).map(result => result.id),
	};
}

export function formatScoreCard(card: ScoreCard): string {
	return `SCORE CARD caught ${card.cheatsCaught} of ${card.cheatsTotal} known cheats, passed ${card.honestPassed} of ${card.honestTotal} honest submissions`;
}
