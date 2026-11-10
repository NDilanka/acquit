import assert from "node:assert/strict";
import test from "node:test";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Verdict } from "../src/types.ts";

// Contact is physical. Two copper items are joined only when their copper overlaps or meets within float roundoff.
// A positive gap of any manufacturing size is an open circuit, and curved copper that might or might not touch within
// its approximation error must fail closed as a parse finding.

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const hidden: HiddenSample = (() => {
	const r = validateHidden(JSON.parse(SAMPLE_HIDDEN_JSON), spec);
	if (!r.ok) throw new Error(r.error);
	return r.hidden;
})();

const LED_RISE = '(segment (start 127.95 103) (end 127.95 106) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';
const LED_RUN = '(segment (start 122.95 103) (end 127.95 103) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';

/** Replaces one honest item, asserting the item is present so a test never passes on an unchanged board. */
const edit = (from: string, to: string): string => {
	assert.ok(SAMPLE_HONEST_PCB.includes(from), `the honest board lacks: ${from}`);
	return SAMPLE_HONEST_PCB.replace(from, to);
};

const verdictFor = (text: string): Verdict => verify(spec, text, hidden);
/** The ok flag of the named finding, or undefined when the rule reported nothing. */
const okOf = (v: Verdict, rule: string): boolean | undefined => v.findings.find(f => f.rule === rule)?.ok;
const parseFailed = (text: string): boolean => verdictFor(text).findings.some(f => !f.ok && f.rule === "parse");

test("the honest board passes with its hidden sample", () => {
	assert.equal(verdictFor(SAMPLE_HONEST_PCB).pass, true);
});

test("a 0.005 mm air gap between a track end and its pad is an open net", () => {
	const v = verdictFor(edit(LED_RISE, '(segment (start 127.95 103) (end 127.95 105.22) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))'));
	assert.equal(okOf(v, "connected"), false);
	assert.equal(okOf(v, "hidden-probe"), false);
	assert.equal(v.pass, false);
});

test("a 0.005 mm air gap in the middle of a track splits the net", () => {
	const halves =
		'(segment (start 122.95 103) (end 125 103) (width 0.25) (layer "F.Cu") (net 4 "LED_A")) ' +
		'(segment (start 125.255 103) (end 127.95 103) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';
	const v = verdictFor(edit(LED_RUN, halves));
	assert.equal(okOf(v, "connected"), false);
	assert.equal(okOf(v, "hidden-probe"), false);
	assert.equal(v.pass, false);
});

test("contact is decided by copper overlap, and a positive gap of any size stays open", () => {
	// The track end is a cap of radius 0.125 mm, and the pad D1.2 edge is at y = 105.35 mm. The end at y gives a gap
	// of 105.225 - y mm, so y = 105.225 is exactly tangent.
	const cases: [number, boolean, string][] = [
		[105.275, true, "overlaps the pad by 0.05 mm"],
		[105.225, true, "exactly tangent"],
		[105.224, false, "0.001 mm gap"],
		[105.22, false, "0.005 mm gap"],
		[105.215, false, "0.010 mm gap"],
	];
	for (const [y, touches, label] of cases) {
		const v = verdictFor(edit(LED_RISE, `(segment (start 127.95 103) (end 127.95 ${y}) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))`));
		assert.equal(okOf(v, "connected"), touches, `${label}: connected`);
		assert.equal(okOf(v, "hidden-probe"), touches, `${label}: hidden-probe`);
	}
});

test("a branch that meets the middle of a track, at its centre or its edge, is connected", () => {
	const centre = '(segment (start 125 103) (end 125 104.5) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';
	const edge = '(segment (start 125 103.25) (end 125 104.5) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';
	for (const [label, branch] of [
		["centre", centre],
		["edge", edge],
	] as const) {
		const v = verdictFor(edit(LED_RUN, `${LED_RUN} ${branch}`));
		assert.equal(okOf(v, "connected"), true, `${label} branch must join the track`);
	}
});

test("a zero-length track is a parse failure, not a copper dot", () => {
	const dot = '(segment (start 125 103) (end 125 103) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';
	assert.equal(parseFailed(edit(LED_RUN, `${LED_RUN} ${dot}`)), true);
});

test("curved copper that only nearly touches other copper fails closed as a parse failure", () => {
	// The GND via sits at (126.05, 108.5) with radius 0.3 mm. This stub ends 0.425 mm from its centre, so its cap is
	// exactly tangent to the true via edge. The checker cannot decide that contact within the via's approximation.
	const stub = '(segment (start 125.625 108.5) (end 124.5 108.5) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';
	assert.equal(parseFailed(edit(LED_RUN, `${LED_RUN} ${stub}`)), true);
});

test("curved copper with a real 0.005 mm gap is open, not joined", () => {
	// The same stub moved 0.005 mm further from the via. The gap is far enough from zero to decide, so it is not a
	// parse failure, and the stub joins no other net.
	const stub = '(segment (start 125.62 108.5) (end 124.5 108.5) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';
	const v = verdictFor(edit(LED_RUN, `${LED_RUN} ${stub}`));
	assert.equal(v.findings.some(f => !f.ok && f.rule === "parse"), false);
	assert.equal(okOf(v, "no-shorts"), true);
	assert.equal(okOf(v, "clearance"), false);
});
