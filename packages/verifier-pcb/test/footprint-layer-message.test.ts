import assert from "node:assert/strict";
import test from "node:test";
import { validateSpec } from "../src/spec.ts";
import { SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";

// A footprint's side comes from its (layer ...) declaration. When that declaration is missing, the parse failure must
// say the layer is missing, not print the absent value as "undefined". A footprint on the back layer keeps its own
// message.

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const R1_HEAD = '(footprint "Resistor_SMD:R_0805_2012Metric" (layer "F.Cu")';

/** The parse failure message, or undefined when the board parses. */
const parseMessage = (text: string): string | undefined =>
	verify(spec, text).findings.find(f => !f.ok && f.rule === "parse")?.message;

test("the honest board's footprint header carries the layer declaration this file removes", () => {
	assert.ok(SAMPLE_HONEST_PCB.includes(R1_HEAD), "the honest board lacks the R1 footprint header");
});

test("a footprint without a (layer ...) declaration is a parse failure that names the missing layer", () => {
	const text = SAMPLE_HONEST_PCB.replace(R1_HEAD, '(footprint "Resistor_SMD:R_0805_2012Metric"');
	const message = parseMessage(text);
	assert.ok(message, "the board must fail the parse");
	assert.ok(message.includes("without a (layer"), message);
	assert.ok(!message.includes("undefined"), message);
});

test("a footprint on the back layer keeps its own parse message", () => {
	const text = SAMPLE_HONEST_PCB.replace(R1_HEAD, '(footprint "Resistor_SMD:R_0805_2012Metric" (layer "B.Cu")');
	const message = parseMessage(text);
	assert.ok(message?.includes("footprint on layer B.Cu; only front-side footprints are supported"), message);
});
