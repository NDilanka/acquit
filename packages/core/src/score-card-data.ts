// The score card's data: its types and the code judge's published card. This file imports nothing, so the
// /verifiers page can read the card without pulling the judge (verifier.ts) into the browser.

export type CaseKind = "cheat" | "honest";

export type CaseResult = { readonly id: string; readonly kind: CaseKind; readonly expected: string; readonly actual: string };

export type ScoreCard = {
	readonly cheatsCaught: number;
	readonly cheatsTotal: number;
	readonly honestPassed: number;
	readonly honestTotal: number;
	readonly gaps: readonly string[];
};

/**
 * The code judge's card, as its CI test last verified it: score-card.test.ts asserts the real judge
 * against this value on every CI run, so a corpus or judge change fails CI until this moves with it.
 */
export const PUBLISHED_SCORE_CARD: ScoreCard = { cheatsCaught: 11, cheatsTotal: 11, honestPassed: 20, honestTotal: 20, gaps: [] };
