// The drone score card's tally and line. A fraud is caught only when the verdict fails on exactly the rule it was
// built to break. An honest survey counts as passed only when no rule fails.

export type CaseResult = {
	readonly id: string;
	readonly kind: "cheat" | "honest";
	readonly intendedRule: string | null;
	readonly failedRules: readonly string[];
};

export type ScoreCard = {
	readonly cheatsCaught: number;
	readonly cheatsTotal: number;
	readonly honestPassed: number;
	readonly honestTotal: number;
};

export function tallyDrones(results: readonly CaseResult[]): ScoreCard {
	const frauds = results.filter(result => result.kind === "cheat");
	const honest = results.filter(result => result.kind === "honest");
	return {
		cheatsCaught: frauds.filter(result => result.intendedRule !== null && result.failedRules.length === 1 && result.failedRules[0] === result.intendedRule).length,
		cheatsTotal: frauds.length,
		honestPassed: honest.filter(result => result.failedRules.length === 0).length,
		honestTotal: honest.length,
	};
}

export function formatDroneScoreCard(card: ScoreCard): string {
	return `DRONE SCORE CARD caught ${card.cheatsCaught} of ${card.cheatsTotal} known frauds, passed ${card.honestPassed} of ${card.honestTotal} honest surveys; the file is verified and the flight is Simulated`;
}
