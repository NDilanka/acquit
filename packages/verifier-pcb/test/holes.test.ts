import assert from "node:assert/strict";
import test from "node:test";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Verdict } from "../src/types.ts";

// A non-plated hole is removed material. It conducts nothing, copper may not enter its bore, and a required mounting
// hole must be a non-plated hole of the drill the spec asks for. Each board here is the honest board with one change.

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

const LED_RUN = '(segment (start 122.95 103) (end 127.95 103) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';

/** Replaces one honest item, asserting the item is present so a test never passes on an unchanged board. */
const edit = (from: string, to: string): string => {
	assert.ok(SAMPLE_HONEST_PCB.includes(from), `the honest board lacks: ${from}`);
	return SAMPLE_HONEST_PCB.replace(from, to);
};

/** Replaces text inside one footprint, found by its reference, asserting the text is present in that footprint. */
const inFootprint = (ref: string, from: string, to: string): string => {
	const start = SAMPLE_HONEST_PCB.indexOf(`(property "Reference" "${ref}"`);
	assert.ok(start >= 0, `the honest board lacks footprint ${ref}`);
	const end = SAMPLE_HONEST_PCB.indexOf("\n\t)", start);
	const block = SAMPLE_HONEST_PCB.slice(start, end);
	assert.ok(block.includes(from), `footprint ${ref} lacks: ${from}`);
	return SAMPLE_HONEST_PCB.slice(0, start) + block.replace(from, to) + SAMPLE_HONEST_PCB.slice(end);
};

const verdictFor = (text: string): Verdict => verify(spec, text, hidden);
/** The ok flag of the named finding, or undefined when the rule reported nothing. */
const okOf = (v: Verdict, rule: string): boolean | undefined => v.findings.find(f => f.rule === rule)?.ok;
const parseFailed = (text: string): boolean => verdictFor(text).findings.some(f => !f.ok && f.rule === "parse");
/** True when the board is rejected, either as an unsupported file or by the named rule. */
const rejected = (v: Verdict, rule: string): boolean =>
	!v.pass && (v.findings.some(f => !f.ok && f.rule === "parse") || okOf(v, rule) === false);

const H5 =
	'(footprint "MountingHole:MountingHole_0.8mm" (layer "F.Cu") (at 125 103) (property "Reference" "H5" (at 0 -2 0) (layer "F.SilkS")) (pad "1" np_thru_hole circle (at 0 0) (size 0.8 0.8) (drill 0.8) (layers "*.Cu" "*.Mask")))';

test("a non-plated bore that cuts through a routed track fails clearance", () => {
	const v = verdictFor(edit(LED_RUN, `${LED_RUN} ${H5}`));
	assert.equal(okOf(v, "clearance"), false);
	assert.equal(v.pass, false);
});

test("a non-plated hole is not copper, so it cannot bridge a break in a net", () => {
	// The track is split with a 0.255 mm gap. The bore lies across the gap and cuts both track ends.
	const halves =
		'(segment (start 122.95 103) (end 125 103) (width 0.25) (layer "F.Cu") (net 4 "LED_A")) ' +
		'(segment (start 125.255 103) (end 127.95 103) (width 0.25) (layer "F.Cu") (net 4 "LED_A"))';
	const bridge =
		'(footprint "MountingHole:MountingHole_0.4mm" (layer "F.Cu") (at 125.1275 103) (property "Reference" "H6" (at 0 -2 0) (layer "F.SilkS")) (pad "1" np_thru_hole circle (at 0 0) (size 0.4 0.4) (drill 0.4) (layers "*.Cu" "*.Mask")))';
	const v = verdictFor(edit(LED_RUN, `${halves} ${bridge}`));
	assert.equal(okOf(v, "connected"), false);
	assert.equal(okOf(v, "hidden-probe"), false);
	assert.equal(v.pass, false);
});

test("a plated pad whose drill leaves no annular ring fails, and a missing plated drill fails the parse", () => {
	assert.equal(rejected(verdictFor(inFootprint("J1", "(drill 1)", "(drill 4)")), "pad-rules"), true);
	assert.equal(parseFailed(inFootprint("J1", " (drill 1)", "")), true);
});

test("a required mounting hole must be a non-plated hole of exactly the spec's drill", () => {
	// An oversized bore, whether copper-bearing (parse) or mask-only (mounting-holes), fails.
	assert.equal(rejected(verdictFor(inFootprint("H4", "(drill 3.2)", "(drill 80)")), "mounting-holes"), true);
	assert.equal(
		rejected(
			verdictFor(inFootprint("H4", '(size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask")', '(size 3.2 3.2) (drill 80) (layers "*.Mask")')),
			"mounting-holes",
		),
		true,
	);
	// A drill 0.2 mm under the spec fails.
	assert.equal(
		rejected(
			verdictFor(inFootprint("H4", '(size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask")', '(size 3.0 3.0) (drill 3.0) (layers "*.Mask")')),
			"mounting-holes",
		),
		true,
	);
	// A plated pad where the spec asks for a non-plated hole fails.
	assert.equal(rejected(verdictFor(inFootprint("H4", "np_thru_hole", "thru_hole")), "mounting-holes"), true);
	// The correct hole on mask layers only is a valid non-plated hole and passes.
	const maskOnly = verdictFor(inFootprint("H1", '(layers "*.Cu" "*.Mask")', '(layers "*.Mask")'));
	assert.equal(maskOnly.pass, true);
	assert.equal(okOf(maskOnly, "mounting-holes"), true);
});

test("a non-plated hole with copper beyond its bore is unsupported", () => {
	assert.equal(parseFailed(inFootprint("H4", "(size 3.2 3.2) (drill 3.2)", "(size 3.6 3.6) (drill 3.2)")), true);
});

test("a slot or offset drill is unsupported and fails the parse", () => {
	for (const drill of ["(drill oval 1 2)", "(drill 1 2)"]) {
		assert.equal(parseFailed(inFootprint("J1", "(drill 1)", drill)), true, drill);
	}
});
