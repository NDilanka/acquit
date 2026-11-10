import assert from "node:assert/strict";
import test from "node:test";
import { validateSpec } from "../src/spec.ts";
import { SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const failing = (text: string): string[] =>
	verify(spec, text).findings.filter(f => !f.ok).map(f => f.rule);

test("the honest board is connected with vias joining F.Cu and B.Cu", () => {
	assert.deepEqual(failing(SAMPLE_HONEST_PCB), []);
});

test("without vias the B.Cu ground bus is cut off from the front copper", () => {
	const noVias = SAMPLE_HONEST_PCB.split("\n")
		.filter(line => !line.trimStart().startsWith("(via "))
		.join("\n");
	assert.ok(failing(noVias).includes("connected"));
});

test("track net labels are never trusted: relabelling the LED lane keeps the copper connected", () => {
	const relabelled = SAMPLE_HONEST_PCB.split("\n")
		.map(line => (line.trimStart().startsWith("(segment ") ? line.replace("(net 4)", "(net 1)") : line))
		.join("\n");
	assert.notEqual(relabelled, SAMPLE_HONEST_PCB);
	assert.ok(!failing(relabelled).includes("connected"));
});
