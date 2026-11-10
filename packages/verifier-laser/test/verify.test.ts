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

const hidden = JSON.parse(sample("enclosure-panel.hidden.json")) as HiddenSample;

test("garbage input gives one failed parse finding and never throws", () => {
	const spec = loadSpec();
	for (const text of ["", "not an svg", "<svg"]) {
		const verdict = verify(spec, text);
		assert.equal(verdict.pass, false);
		assert.equal(verdict.workflow, "laser-cut");
		assert.equal(verdict.findings.length, 1);
		assert.equal(verdict.findings[0]?.rule, "parse");
		assert.equal(verdict.findings[0]?.ok, false);
		assert.deepEqual(verdict.measured, {});
	}
});

test("the honest panel passes every rule and reports the measured values", () => {
	const verdict = verify(loadSpec(), sample("honest.svg"), hidden);
	assert.equal(verdict.pass, true);
	assert.deepEqual(verdict.findings.map(finding => finding.rule), [...RULES]);
	assert.equal(verdict.measured.holesMatched, 4);
	assert.equal(verdict.measured.holesExpected, 4);
	assert.equal(verdict.measured.cutoutsMatched, 1);
	assert.equal(verdict.measured.cutoutsExpected, 1);
	assert.equal(verdict.measured.outlineWidthMm, 120.2);
	assert.equal(verdict.measured.outlineHeightMm, 80.2);
	assert.deepEqual(verdict.scene.size, [300, 200, 3]);
});

test("without hidden samples the hidden-material rule is not run", () => {
	const verdict = verify(loadSpec(), sample("honest.svg"));
	assert.equal(verdict.findings.some(finding => finding.rule === "hidden-material"), false);
	assert.equal(verdict.pass, true);
});

test("every finding names a rule the contract lists", () => {
	const verdict = verify(loadSpec(), sample("fraud-no-kerf.svg"), hidden);
	for (const finding of verdict.findings) assert.ok((RULES as readonly string[]).includes(finding.rule), finding.rule);
});
