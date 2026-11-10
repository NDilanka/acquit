// The laser score card's tally and line. The shape matches core's score card, so the /verifiers page can show
// every checker side by side. Types only come from core, so this package keeps no runtime import from core.

import type { CaseResult, ScoreCard } from "../../core/src/score-card-data.ts";

export type { CaseResult, ScoreCard } from "../../core/src/score-card-data.ts";

export const VERIFIED = "VERIFIED";

/**
 * The observed outcome for one case. A panel with no failed rule is VERIFIED. A fraud that no rule catches is a
 * known gap. Otherwise the outcome is the failed rule ids, so a fraud that fails a second rule shows as a mismatch.
 */
export function observedLaserOutcome(kind: "cheat" | "honest", failedRules: readonly string[]): string {
	if (failedRules.length === 0) return kind === "cheat" ? "ACCEPTED (gap)" : VERIFIED;
	return failedRules.join(", ");
}

export function tallyLasers(results: readonly CaseResult[]): ScoreCard {
	const frauds = results.filter(result => result.kind === "cheat");
	const honest = results.filter(result => result.kind === "honest");
	return {
		cheatsCaught: frauds.filter(result => result.expected !== "ACCEPTED (gap)" && result.actual === result.expected).length,
		cheatsTotal: frauds.length,
		honestPassed: honest.filter(result => result.actual === VERIFIED).length,
		honestTotal: honest.length,
		gaps: frauds.filter(result => result.expected === "ACCEPTED (gap)").map(result => result.id),
	};
}

/** The line the CI log carries. The file is verified and the machine run is simulated, so the line says so. */
export function formatLaserScoreCard(card: ScoreCard): string {
	return `LASER SCORE CARD caught ${card.cheatsCaught} of ${card.cheatsTotal} known frauds, passed ${card.honestPassed} of ${card.honestTotal} honest panels; file verified, machine run simulated`;
}
