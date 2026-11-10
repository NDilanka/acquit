import assert from "node:assert/strict";
import test from "node:test";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Spec, Verdict } from "../src/types.ts";

// The honest board has four ordinary through vias, each on one line with (layers "F.Cu" "B.Cu"). The checker models only
// that span. Any other span, a missing or repeated layer list, or an option that removes copper must fail the parse and
// name the construct. Metadata that leaves the copper alone (free, locked, tenting) must keep the board passing.

const spec: Spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const hidden: HiddenSample = (() => {
	const r = validateHidden(JSON.parse(SAMPLE_HIDDEN_JSON), spec);
	if (!r.ok) throw new Error(r.error);
	return r.hidden;
})();

const VIA_LINES = SAMPLE_HONEST_PCB.split("\n").filter(line => line.includes("(via ")).length;

/**
 * The honest board with one textual change made on every via line. Asserts that every via line was changed, so a
 * variant never passes because it touched nothing.
 */
function onVias(from: string, to: string): string {
	assert.ok(VIA_LINES > 0, "the honest board has no vias");
	let changed = 0;
	const out = SAMPLE_HONEST_PCB.split("\n").map(line => {
		if (!line.includes("(via ") || !line.includes(from)) return line;
		changed++;
		return line.replace(from, to);
	});
	assert.equal(changed, VIA_LINES, `every via line must contain: ${from}`);
	return out.join("\n");
}

const verdictFor = (text: string): Verdict => verify(spec, text, hidden);
const parseFailed = (text: string): boolean => verdictFor(text).findings.some(f => !f.ok && f.rule === "parse");

test("via-span-matrix: a via on a span other than F.Cu and B.Cu fails the parse", () => {
	const variants: readonly (readonly [string, string])[] = [
		["same layer F.Cu/F.Cu", onVias('(layers "F.Cu" "B.Cu")', '(layers "F.Cu" "F.Cu")')],
		["inner layer F.Cu/In1.Cu", onVias('(layers "F.Cu" "B.Cu")', '(layers "F.Cu" "In1.Cu")')],
		["inner layers In1.Cu/In2.Cu", onVias('(layers "F.Cu" "B.Cu")', '(layers "In1.Cu" "In2.Cu")')],
		["three layers", onVias('(layers "F.Cu" "B.Cu")', '(layers "F.Cu" "In1.Cu" "B.Cu")')],
		["blind type", onVias("(via ", "(via blind ")],
		["micro type", onVias("(via ", "(via micro ")],
		["missing layers", onVias('(layers "F.Cu" "B.Cu") ', "")],
		["repeated layers", onVias('(layers "F.Cu" "B.Cu")', '(layers "F.Cu" "B.Cu") (layers "F.Cu" "B.Cu")')],
	];
	for (const [label, text] of variants) {
		assert.equal(parseFailed(text), true, `${label} must fail the parse`);
	}
});

test("via-span-matrix: copper-removal options on ordinary through vias fail the parse", () => {
	const variants: readonly (readonly [string, string])[] = [
		["remove_unused_layers", onVias('(net 2 "GND")', '(net 2 "GND") (remove_unused_layers yes)')],
		["keep_end_layers", onVias('(net 2 "GND")', '(net 2 "GND") (keep_end_layers yes)')],
	];
	for (const [label, text] of variants) {
		assert.equal(parseFailed(text), true, `${label} must fail the parse`);
	}
});

test("via-span-matrix: ordinary F.Cu/B.Cu through vias pass, in either layer order", () => {
	assert.equal(verdictFor(SAMPLE_HONEST_PCB).pass, true);
	assert.equal(verdictFor(onVias('(layers "F.Cu" "B.Cu")', '(layers "B.Cu" "F.Cu")')).pass, true);
});

test("benign-via-options: free, locked and tenting metadata on ordinary through vias keep the board passing", () => {
	const variants: readonly (readonly [string, string])[] = [
		["free yes", onVias('(net 2 "GND")', '(net 2 "GND") (free yes)')],
		["locked yes", onVias('(net 2 "GND")', '(net 2 "GND") (locked yes)')],
		["tenting front back", onVias('(net 2 "GND")', '(net 2 "GND") (tenting front back)')],
	];
	for (const [label, text] of variants) {
		const v = verdictFor(text);
		assert.equal(v.findings.some(f => !f.ok && f.rule === "parse"), false, `${label} must not fail the parse`);
		assert.equal(v.pass, true, `${label} must keep the board passing`);
	}
});
