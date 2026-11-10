import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SAMPLE_FRAUDS, SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";

const here = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");

test("src/samples.ts matches the files written by samples/generate.ts", () => {
	assert.equal(readFileSync(join(here, "status-light.spec.json"), "utf8"), SAMPLE_SPEC_JSON);
	assert.equal(readFileSync(join(here, "status-light.hidden.example.json"), "utf8"), SAMPLE_HIDDEN_JSON);
	assert.equal(readFileSync(join(here, "honest.kicad_pcb"), "utf8"), SAMPLE_HONEST_PCB);
	const onDisk = readdirSync(join(here, "frauds")).filter(f => f.endsWith(".kicad_pcb")).sort();
	assert.deepEqual(onDisk, Object.keys(SAMPLE_FRAUDS).map(id => `${id}.kicad_pcb`).sort());
	for (const [id, text] of Object.entries(SAMPLE_FRAUDS)) {
		assert.equal(readFileSync(join(here, "frauds", `${id}.kicad_pcb`), "utf8"), text, id);
	}
});
