import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../src/spec.ts";
import { formatLaserScoreCard, observedLaserOutcome, tallyLasers, VERIFIED } from "../src/score-card.ts";
import type { CaseResult, ScoreCard } from "../src/score-card.ts";
import type { HiddenSample } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const sample = (name: string): string => readFileSync(fileURLToPath(new URL(`../samples/${name}`, import.meta.url)), "utf8");

const specResult = validateSpec(JSON.parse(sample("enclosure-panel.spec.json")));
if (!specResult.ok) throw new Error(JSON.stringify(specResult.errors));
const spec = specResult.value;
const hidden = JSON.parse(sample("enclosure-panel.hidden.json")) as HiddenSample;

// Each fraud breaks exactly one named rule. The chamfered corner is the known gap: the spec defines a rectangular
// part, so no rule sees the missing corner.
const cases: { id: string; kind: "cheat" | "honest"; expected: string }[] = [
	{ id: "honest", kind: "honest", expected: VERIFIED },
	{ id: "fraud-no-kerf", kind: "cheat", expected: "kerf-compensation" },
	{ id: "fraud-open-path", kind: "cheat", expected: "closed-paths" },
	{ id: "fraud-hole-engraved", kind: "cheat", expected: "feature-cut" },
	{ id: "fraud-hole-moved", kind: "cheat", expected: "feature-cut" },
	{ id: "fraud-pixel-units", kind: "cheat", expected: "units-mm" },
	{ id: "fraud-duplicate-cut", kind: "cheat", expected: "no-duplicate-cuts" },
	{ id: "fraud-oversize-bed", kind: "cheat", expected: "fits-bed" },
	{ id: "fraud-order", kind: "cheat", expected: "cut-order" },
	{ id: "fraud-thin-web", kind: "cheat", expected: "min-web" },
	{ id: "fraud-hidden-notch", kind: "cheat", expected: "hidden-material" },
	{ id: "fraud-wrong-colour", kind: "cheat", expected: "layers" },
	{ id: "fraud-chamfered-corner", kind: "cheat", expected: "ACCEPTED (gap)" },
];

const results: CaseResult[] = [];

for (const item of cases) {
	test(item.id, () => {
		const verdict = verify(spec, sample(`${item.id}.svg`), hidden);
		const failed = verdict.findings.filter(finding => !finding.ok).map(finding => finding.rule);
		const actual = observedLaserOutcome(item.kind, failed);
		results.push({ id: item.id, kind: item.kind, expected: item.expected, actual });
		assert.equal(actual, item.expected);
		assert.equal(verdict.pass, failed.length === 0);
	});
}

test("the laser score card tallies every case and prints one line", () => {
	const card: ScoreCard = tallyLasers(results);
	assert.deepEqual(card, {
		cheatsCaught: 11,
		cheatsTotal: 12,
		honestPassed: 1,
		honestTotal: 1,
		gaps: ["fraud-chamfered-corner"],
	});
	console.log(formatLaserScoreCard(card));
	for (const gap of card.gaps) console.log(`FINDING known gap: ${gap} passes the laser verifier`);
});
