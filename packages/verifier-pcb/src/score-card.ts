// Runs the bundled honest board and frauds through the checker. Pure: the samples are data in samples.ts.

import { SAMPLE_FRAUD_RULES, SAMPLE_FRAUDS, SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "./samples.ts";
import { validateHidden, validateSpec } from "./spec.ts";
import { verify } from "./verify.ts";

export type PcbCaseResult = {
	readonly id: string;
	readonly kind: "honest" | "fraud";
	readonly intendedRule: string | undefined;
	readonly failingPublic: readonly string[];
	readonly failingHidden: readonly string[];
	readonly caught: boolean; // fraud: failed its intended rule and nothing else public
	readonly passed: boolean; // honest: every finding ok
};

export type PcbScoreCard = {
	readonly cases: readonly PcbCaseResult[];
	readonly honest: number;
	readonly honestPassed: number;
	readonly frauds: number;
	readonly fraudsCaught: number;
};

/**
 * Hidden rules that may co-fail on a fraud. A probe on a broken net also sees the break, and a public clearance
 * break is also below the tighter hidden clearance limit.
 */
const ALWAYS_CO_FAILS: readonly string[] = ["hidden-probe"];
const CO_FAILS: Readonly<Record<string, readonly string[]>> = {
	clearance: ["hidden-clearance"],
};

export function runPcbScoreCard(): PcbScoreCard {
	const specResult = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!specResult.ok) throw new Error(`bundled spec is invalid: ${specResult.error}`);
	const spec = specResult.spec;
	const hiddenResult = validateHidden(JSON.parse(SAMPLE_HIDDEN_JSON), spec);
	if (!hiddenResult.ok) throw new Error(`bundled hidden sample is invalid: ${hiddenResult.error}`);
	const hidden = hiddenResult.hidden;

	const cases: PcbCaseResult[] = [];
	const honest = verify(spec, SAMPLE_HONEST_PCB, hidden);
	const honestFailing = honest.findings.filter(f => !f.ok).map(f => f.rule);
	cases.push({
		id: "honest-status-light",
		kind: "honest",
		intendedRule: undefined,
		failingPublic: honestFailing,
		failingHidden: [],
		caught: false,
		passed: honest.pass,
	});

	for (const [id, text] of Object.entries(SAMPLE_FRAUDS)) {
		const expect = SAMPLE_FRAUD_RULES[id];
		if (!expect) throw new Error(`no intended rule recorded for ${id}`);
		const verdict = verify(spec, text, hidden);
		const failing = verdict.findings.filter(f => !f.ok).map(f => f.rule);
		const failingPublic = failing.filter(r => !isHiddenRule(r));
		const failingHidden = failing.filter(r => isHiddenRule(r));
		const intendedFailed = failing.includes(expect.rule);
		const publicOnlyIntended = expect.hidden
			? failingPublic.length === 0
			: failingPublic.every(r => r === expect.rule);
		const allowedHidden = [expect.rule, ...ALWAYS_CO_FAILS, ...(CO_FAILS[expect.rule] ?? [])];
		const hiddenOnlyAllowed = failingHidden.every(r => allowedHidden.includes(r));
		cases.push({
			id,
			kind: "fraud",
			intendedRule: expect.rule,
			failingPublic,
			failingHidden,
			caught: intendedFailed && publicOnlyIntended && hiddenOnlyAllowed,
			passed: false,
		});
	}

	const fraudCases = cases.filter(c => c.kind === "fraud");
	const honestCases = cases.filter(c => c.kind === "honest");
	return {
		cases,
		honest: honestCases.length,
		honestPassed: honestCases.filter(c => c.passed).length,
		frauds: fraudCases.length,
		fraudsCaught: fraudCases.filter(c => c.caught).length,
	};
}

function isHiddenRule(rule: string): boolean {
	return rule === "hidden-probe" || rule === "hidden-clearance";
}

/** One line for the score card, in the same style as the print checker. */
export function formatPcbScoreCard(card: PcbScoreCard): string {
	return `PCB SCORE CARD caught ${card.fraudsCaught} of ${card.frauds} known frauds, passed ${card.honestPassed} of ${card.honest} honest boards; the file is verified, the flying-probe run is simulated.`;
}
