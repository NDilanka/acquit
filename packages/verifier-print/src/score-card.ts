// The print score card's tally and line. The shape matches core's score card, so the /verifiers page can
// show both. Types only come from core, so this package keeps no runtime import from core.

import type { CaseResult, ScoreCard } from "../../core/src/score-card.ts";

export type { CaseResult, ScoreCard } from "../../core/src/score-card.ts";

export const VERIFIED = "VERIFIED";
/** A fraud the verifier accepts. The corpus pins it until the verifier closes the gap. */
export const KNOWN_GAP = "ACCEPTED (gap)";

/** The verdict in corpus terms: a fraud that verifies is a known gap, an honest print that fails is its reason. */
export function observedPrintOutcome(kind: "cheat" | "honest", firstReason: string | null): string {
	if (firstReason === null) return kind === "cheat" ? KNOWN_GAP : VERIFIED;
	return firstReason;
}

export function tallyPrints(results: readonly CaseResult[]): ScoreCard {
	const frauds = results.filter(result => result.kind === "cheat");
	const honest = results.filter(result => result.kind === "honest");
	return {
		cheatsCaught: frauds.filter(result => result.expected !== KNOWN_GAP && result.actual === result.expected).length,
		cheatsTotal: frauds.length,
		honestPassed: honest.filter(result => result.actual === VERIFIED).length,
		honestTotal: honest.length,
		gaps: frauds.filter(result => result.expected === KNOWN_GAP).map(result => result.id),
	};
}

/** The line the CI log carries. It names the slicer when a slicer case ran, and labels the simulated parts. */
export function formatPrintScoreCard(card: ScoreCard, slicer: string | null): string {
	const source = slicer === null ? "(synthetic G-code, no slicer)" : `with ${slicer}`;
	return `PRINT SCORE CARD caught ${card.cheatsCaught} of ${card.cheatsTotal} known frauds, passed ${card.honestPassed} of ${card.honestTotal} honest prints ${source}; telemetry and photos are Simulated`;
}
