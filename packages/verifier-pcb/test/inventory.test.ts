import assert from "node:assert/strict";
import test from "node:test";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Verdict } from "../src/types.ts";

// The parts and pads are an exact inventory. Every footprint and pad on the board is one the spec asks for, exactly
// once, with the spec's footprint name, placement, rotation, type, shape, drill, layers, size and offset. Each board
// here is the honest board with one change, so the named rule is the one that reports it.

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

/** Adds a whole footprint block before the board's closing parenthesis. */
const addFootprint = (block: string): string => {
	const close = SAMPLE_HONEST_PCB.lastIndexOf(")");
	assert.ok(close > 0, "the honest board has no closing parenthesis");
	return `${SAMPLE_HONEST_PCB.slice(0, close)}\t${block}\n${SAMPLE_HONEST_PCB.slice(close)}`;
};

const verdictFor = (text: string): Verdict => verify(spec, text, hidden);
/** The ok flag of the named finding, or undefined when the rule reported nothing. */
const okOf = (v: Verdict, rule: string): boolean | undefined => v.findings.find(f => f.rule === rule)?.ok;
const parseFailed = (text: string): boolean => verdictFor(text).findings.some(f => !f.ok && f.rule === "parse");

/** The board fails parts-placed, and the verdict fails with it. */
const partsPlacedFails = (text: string, label: string): void => {
	const v = verdictFor(text);
	assert.equal(okOf(v, "parts-placed"), false, label);
	assert.equal(v.pass, false, label);
};

const EMPTY_AT_CORNER =
	'(footprint "Test:Empty" (layer "F.Cu") (at -500 -500) (property "Reference" "X2" (at 0 -2 0) (layer "F.SilkS")))';

test("the honest board's parts and pads match the spec exactly", () => {
	assert.equal(okOf(verdictFor(SAMPLE_HONEST_PCB), "parts-placed"), true);
});

test("outside-part: a footprint at (-500,-500) that the spec does not list fails parts-placed", () => {
	partsPlacedFails(addFootprint(EMPTY_AT_CORNER), "empty part at (-500,-500)");
});

test("exact-parts-pads: an extra part, a duplicate reference, or an extra pad fails parts-placed", () => {
	const unlisted =
		'(footprint "Test:Pad" (layer "F.Cu") (at 105 116) (property "Reference" "X1" (at 0 -2 0) (layer "F.SilkS")) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))';
	partsPlacedFails(addFootprint(unlisted), "unlisted footprint X1 with one pad");
	const duplicate = '(footprint "Test:Dup" (layer "F.Cu") (at 50 50) (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS")))';
	partsPlacedFails(addFootprint(duplicate), "second footprint with reference R1");
	partsPlacedFails(
		inFootprint("J2", '(pad "1" thru_hole', '(pad "9" smd rect (at -2 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")) (pad "1" thru_hole'),
		"unlisted pad 9 on J2",
	);
	partsPlacedFails(
		inFootprint(
			"R1",
			'(pad "2" smd rect (at 0.95 0)',
			'(pad "1" smd rect (at -5 0) (size 1 1.3) (layers "F.Cu" "F.Paste" "F.Mask")) (pad "2" smd rect (at 0.95 0)',
		),
		"pad 1 named twice on R1",
	);
});

test("exact-parts-pads: a footprint whose name, placement or rotation differs from the spec fails parts-placed", () => {
	partsPlacedFails(edit('(footprint "Package_TO_SOT_SMD:SOT-23"', '(footprint "Fake:Wrong"'), "U1 with another library name");
	partsPlacedFails(edit('(layer "F.Cu") (at 122 106)', '(layer "F.Cu") (at 122 106 90)'), "R1 rotated 90 degrees");
});

test("exact-parts-pads: a pad whose type, shape, drill, layers, size, orientation or position differs fails parts-placed", () => {
	// H1 made plated keeps its size, drill, shape and layers, so its type alone differs from the spec.
	partsPlacedFails(
		inFootprint("H1", '(pad "1" np_thru_hole circle', '(pad "1" thru_hole circle'),
		"H1 plated, its type alone differs",
	);
	partsPlacedFails(inFootprint("R1", '(pad "2" smd rect', '(pad "2" smd circle'), "R1.2 circle instead of rect");
	partsPlacedFails(
		inFootprint("R1", '(pad "2" smd rect (at 0.95 0)', '(pad "2" smd rect (at 0.95 0 90)'),
		"R1.2 rotated 90 degrees",
	);
	partsPlacedFails(inFootprint("J1", "(drill 1)", "(drill 1.2)"), "J1.1 drill 1.2 against the spec's 1");
	partsPlacedFails(
		inFootprint(
			"R1",
			'(pad "2" smd rect (at 0.95 0) (size 1 1.3) (layers "F.Cu" "F.Paste" "F.Mask")',
			'(pad "2" smd rect (at 0.95 0) (size 1 1.3) (layers "B.Cu" "B.Paste" "B.Mask")',
		),
		"R1.2 on the back copper",
	);
	partsPlacedFails(
		inFootprint("R1", '(pad "2" smd rect (at 0.95 0) (size 1 1.3)', '(pad "2" smd rect (at 0.95 0) (size 1 1.2)'),
		"R1.2 size 1 by 1.2",
	);
	partsPlacedFails(
		inFootprint("J2", '(pad "4" thru_hole circle (at 7.62 0)', '(pad "4" thru_hole circle (at 7.62 0.5)'),
		"J2.4 moved 0.5 mm",
	);
});

test("back-footprint-unsupported: a footprint placed on the back side fails the parse", () => {
	assert.equal(parseFailed(edit('(layer "F.Cu") (at 122 106)', '(layer "B.Cu") (at 122 106)')), true);
});

test("the bundled mounting holes are non-plated in the spec, not thru_hole", () => {
	for (const ref of ["H1", "H2", "H3", "H4"]) {
		const part = spec.parts.find(p => p.ref === ref);
		assert.ok(part, `the spec lacks ${ref}`);
		assert.equal(part.pads[0]?.type, "np_thru_hole", ref);
	}
});
