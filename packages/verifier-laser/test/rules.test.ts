import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../src/spec.ts";
import { RULES } from "../src/types.ts";
import type { HiddenSample, Spec } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const sample = (name: string): string => readFileSync(fileURLToPath(new URL(`../samples/${name}`, import.meta.url)), "utf8");

function loadSpec(): Spec {
	const result = validateSpec(JSON.parse(sample("enclosure-panel.spec.json")));
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.value;
}

const spec = loadSpec();
const hidden = JSON.parse(sample("enclosure-panel.hidden.json")) as HiddenSample;
const honest = sample("honest.svg");

const STANDARD_RULES = [
	"parse",
	"units-mm",
	"colours",
	"closed-paths",
	"no-duplicates",
	"fits-bed",
	"outer-size",
	"holes",
	"cutouts",
	"engrave-inside",
	"min-web",
	"cut-order",
	"no-self-intersection",
	"hidden-material",
];

function failedRules(text: string): string[] {
	return verify(spec, text, hidden).findings.filter(finding => !finding.ok).map(finding => finding.rule);
}

test("the rule ids are the standardized list", () => {
	assert.deepEqual([...RULES], STANDARD_RULES);
});

test("the honest panel reports every rule in the standard order and passes", () => {
	const verdict = verify(spec, honest, hidden);
	assert.equal(verdict.pass, true);
	assert.deepEqual(verdict.findings.map(finding => finding.rule), STANDARD_RULES);
});

test("a red bow-tie fails no-self-intersection", () => {
	const text = honest.replace('<path id="outline"', `<path id="bow" d="M95 35 L105 45 L95 45 L105 35 Z" stroke="#ff0000" fill="none"/>\n  <path id="outline"`);
	assert.deepEqual(failedRules(text), ["cutouts", "no-self-intersection"]);
});

test("a blue path outside the part fails engrave-inside", () => {
	const text = honest.replace('d="M20 80.2 H60"', 'd="M200 180 H240"');
	assert.deepEqual(failedRules(text), ["engrave-inside"]);
});

test("a blue path inside the window fails engrave-inside", () => {
	const text = honest.replace('d="M20 80.2 H60"', 'd="M60 50 H80"');
	assert.deepEqual(failedRules(text), ["engrave-inside"]);
});

test("a stray guide line in the wrong colour fails colours only", () => {
	const text = honest.replace('<path id="outline"', `<path id="guide" d="M30 30 H40" stroke="#00aa00" fill="none"/>\n  <path id="outline"`);
	assert.deepEqual(failedRules(text), ["colours"]);
});

test("a label engraved in the wrong colour fails colours and engrave-inside", () => {
	const text = honest.replace('d="M20 80.2 H60" stroke="#0000ff"', 'd="M20 80.2 H60" stroke="#00ff00"');
	assert.deepEqual(failedRules(text), ["colours", "engrave-inside"]);
});
