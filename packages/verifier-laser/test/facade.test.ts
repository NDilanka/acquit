import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RULES, SAMPLE_TEXT, validateSpec, verify } from "../src/index.ts";
import type { HiddenSample } from "../src/index.ts";
import { readSampleFiles, renderSamples, SAMPLE_DIR, SAMPLES_MODULE } from "../tools/render-samples.ts";

test("the facade exports verify, spec validation, the rule ids and the sample texts", () => {
	assert.equal(typeof verify, "function");
	assert.equal(typeof validateSpec, "function");
	assert.deepEqual(RULES, [
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
	]);
});

test("browser export synchronization: SAMPLE_TEXT holds every sample file byte for byte", () => {
	const onDisk = readdirSync(SAMPLE_DIR).sort();
	assert.deepEqual(Object.keys(SAMPLE_TEXT).sort(), onDisk);
	for (const name of onDisk) {
		const bytes = readFileSync(join(SAMPLE_DIR, name));
		assert.ok(Buffer.from(SAMPLE_TEXT[name], "utf8").equals(bytes), `${name} differs from its generated string`);
	}
});

test("the generated samples module is current with the sample files", () => {
	assert.equal(readFileSync(SAMPLES_MODULE, "utf8"), renderSamples(readSampleFiles()));
});

test("the facade verifies the shipped honest panel from its sample strings", () => {
	const specResult = validateSpec(JSON.parse(SAMPLE_TEXT["enclosure-panel.spec.json"]));
	if (!specResult.ok) throw new Error(JSON.stringify(specResult.errors));
	const hidden = JSON.parse(SAMPLE_TEXT["enclosure-panel.hidden.json"]) as HiddenSample;
	const verdict = verify(specResult.value, SAMPLE_TEXT["honest.svg"], hidden);
	assert.equal(verdict.pass, true);
});
