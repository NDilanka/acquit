import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

// Each sample fraud breaks exactly its named rule, and the honest panel passes. A blue hole breaks
// two rules (holes and engrave-inside), so shapes.test.ts covers it rather than a sample.
const cases: { id: string; kind: "cheat" | "honest"; expected: string }[] = [
	{ id: "honest", kind: "honest", expected: VERIFIED },
	{ id: "fraud-no-kerf", kind: "cheat", expected: "outer-size" },
	{ id: "fraud-open-path", kind: "cheat", expected: "closed-paths" },
	{ id: "fraud-hole-moved", kind: "cheat", expected: "holes" },
	{ id: "fraud-pixel-units", kind: "cheat", expected: "units-mm" },
	{ id: "fraud-duplicate-cut", kind: "cheat", expected: "no-duplicates" },
	{ id: "fraud-oversize-bed", kind: "cheat", expected: "fits-bed" },
	{ id: "fraud-order", kind: "cheat", expected: "cut-order" },
	{ id: "fraud-thin-web", kind: "cheat", expected: "min-web" },
	{ id: "fraud-hidden-notch", kind: "cheat", expected: "hidden-material" },
	{ id: "fraud-wrong-colour", kind: "cheat", expected: "colours" },
	{ id: "fraud-chamfered-corner", kind: "cheat", expected: "outer-size" },
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
		cheatsTotal: 11,
		honestPassed: 1,
		honestTotal: 1,
		gaps: [],
	});
	console.log(formatLaserScoreCard(card));
});

test("the fraud samples are exactly the isolated frauds in this table", () => {
	const onDisk = readdirSync(fileURLToPath(new URL("../samples/", import.meta.url)))
		.filter(name => name.startsWith("fraud-"))
		.map(name => name.replace(/\.svg$/, ""))
		.sort();
	const listed = cases
		.filter(item => item.kind === "cheat")
		.map(item => item.id)
		.sort();
	assert.deepEqual(onDisk, listed);
});
