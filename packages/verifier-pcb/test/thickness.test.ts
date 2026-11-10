import assert from "node:assert/strict";
import test from "node:test";
import { readBoard } from "../src/board.ts";
import { validateSpec } from "../src/spec.ts";
import { SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { Verdict } from "../src/types.ts";

// Board thickness. The checker models one board: a 1.6 mm FR4 core, the KiCad default. A declared thickness that is
// not a finite positive number is impossible and fails the parse. A positive thickness other than 1.6 mm is not
// modelled, so it also fails the parse rather than being drawn as a 1.6 mm board. Each case changes only the general
// record (or the setup line) of the honest board, so a failure is caused by that one declaration.

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const GENERAL = "(general (thickness 1.6))";
const SETUP = "(setup (pad_to_mask_clearance 0))";

const verdictOf = (text: string): Verdict => verify(spec, text);
const parseFailed = (text: string): boolean => verdictOf(text).findings.some(f => !f.ok && f.rule === "parse");

/** The honest board with its general record replaced. The replacement must change the board. */
const withGeneral = (record: string): string => {
	assert.ok(SAMPLE_HONEST_PCB.includes(GENERAL), "the honest board declares a general record");
	return SAMPLE_HONEST_PCB.replace(GENERAL, record);
};

const assertRejected = (text: string, label: string): void => {
	assert.equal(readBoard(text).ok, false, `${label} must fail the board read`);
	assert.equal(parseFailed(text), true, `${label} must be a parse failure`);
	assert.equal(verdictOf(text).pass, false, `${label} must not pass`);
};

test("the honest board, declaring 1.6 mm, still passes every rule", () => {
	assert.equal(readBoard(SAMPLE_HONEST_PCB).ok, true);
	assert.equal(verdictOf(SAMPLE_HONEST_PCB).pass, true);
});

test("a declared thickness that is not a finite positive number fails parse", () => {
	for (const t of ["-1.6", "0", "-0", "NaN", "Infinity", "-Infinity", "1e309", "1e-400"]) {
		assertRejected(withGeneral(`(general (thickness ${t}))`), `thickness ${t}`);
	}
});

test("a positive thickness other than 1.6 mm fails parse, with the supported value named", () => {
	for (const t of ["1", "0.8", "2.4", "1.60001"]) {
		const text = withGeneral(`(general (thickness ${t}))`);
		assertRejected(text, `thickness ${t}`);
		assert.ok(String(readBoard(text).error).includes("1.6 mm"), `thickness ${t}: ${readBoard(text).error}`);
	}
});

test("a thickness field that is not a single plain number fails parse", () => {
	for (const field of ["(thickness)", "(thickness (1.6))", "(thickness 1.6 1.6)", "(thickness 1.6mm)"]) {
		assertRejected(withGeneral(`(general ${field})`), field);
	}
});

test("a repeated or contradictory general record or thickness fails parse", () => {
	const twice = withGeneral("(general (thickness 1.6))\n\t(general (thickness 1.6))");
	assertRejected(twice, "two general records");
	assertRejected(withGeneral("(general (thickness 1.6) (thickness 1.6))"), "identical thickness fields");
	assertRejected(withGeneral("(general (thickness 1.6) (thickness 0.8))"), "contradictory thickness fields");
});

test("geometry, unknown fields, or nested lists inside general fail parse", () => {
	const cases = [
		'(general (thickness 1.6) (gr_line (start 0 0) (end 1 1) (layer "F.Cu")))',
		"(general (thickness 1.6) (tracks (segment (start 0 0))))",
		"(general (thickness 1.6) (stackup_override 1))",
		"(general (thickness 1.6) bare)",
	];
	for (const record of cases) assertRejected(withGeneral(record), record);
});

/** The honest board with its setup line replaced. The replacement must change the board. */
const withSetup = (setup: string): string => {
	const text = SAMPLE_HONEST_PCB.replace(SETUP, setup);
	assert.notEqual(text, SAMPLE_HONEST_PCB, "the setup line was replaced");
	return text;
};

/** The honest board with a setup stackup holding these layer records. */
const withStackup = (layers: string): string => withSetup(`(setup (stackup ${layers}) (pad_to_mask_clearance 0))`);

const copperLayer = (name: string, t: string): string => `(layer "${name}" (type "copper") (thickness ${t}))`;
const FRONT = copperLayer("F.Cu", "0.035");
const BACK = copperLayer("B.Cu", "0.035");
const core = (t: string): string => `(layer "dielectric 1" (type "core") (thickness ${t}) (material "FR4"))`;
const mask = (name: string, type: string): string => `(layer "${name}" (type "${type}") (thickness 0.01))`;

/** The stackup KiCad 8 writes for a default two-layer board: masks, silkscreen and paste around the copper and core. */
const KICAD_DEFAULT = [
	'(layer "F.SilkS" (type "Top Silk Screen"))',
	'(layer "F.Paste" (type "Top Solder Paste"))',
	mask("F.Mask", "Top Solder Mask"),
	FRONT,
	core("1.51"),
	BACK,
	mask("B.Mask", "Bottom Solder Mask"),
	'(layer "B.Paste" (type "Bottom Solder Paste"))',
	'(layer "B.SilkS" (type "Bottom Silk Screen"))',
	'(copper_finish "None")',
	"(dielectric_constraints no)",
].join(" ");

const assertStackupRejected = (layers: string, label: string): void => {
	const text = withStackup(layers);
	assertRejected(text, label);
	assert.match(String(readBoard(text).error), /stackup/, `${label}: the message names the stackup`);
};

test("a stackup that declares the modelled two-layer board passes, whichever total it counts", () => {
	const accepted = [
		KICAD_DEFAULT,
		[FRONT, core("1.53"), BACK].join(" "),
		[FRONT, core("1.53"), BACK, mask("F.Mask", "Top Solder Mask")].join(" "),
		'(layer "F.Cu" (type "copper") (thickness 0.07)) (layer "dielectric 1" (type "core") (thickness 1.46))' +
			' (layer "B.Cu" (type "copper") (thickness 0.07))',
	];
	for (const layers of accepted) {
		const text = withStackup(layers);
		assert.equal(readBoard(text).ok, true, `${layers.slice(0, 60)}: ${readBoard(text).error}`);
		assert.equal(verdictOf(text).pass, true, layers.slice(0, 60));
	}
});

test("a stackup that contradicts the modelled board fails parse, naming the stackup", () => {
	const contradictions: [string, string][] = [
		["a 0.8 mm total", [FRONT, core("0.73"), BACK].join(" ")],
		["a 2.4 mm total", [FRONT, core("2.33"), BACK].join(" ")],
		["two cores", [FRONT, core("0.765"), core("0.765"), BACK].join(" ")],
		["an inner copper layer", [FRONT, core("0.765"), copperLayer("In1.Cu", "0.035"), core("0.765"), BACK].join(" ")],
		["a single copper layer", [FRONT, core("1.6")].join(" ")],
		["a core stacked before F.Cu", [core("1.53"), FRONT, BACK].join(" ")],
		["B.Cu stacked before the core", [FRONT, BACK, core("1.53")].join(" ")],
		["a core alone at 1.6 mm", core("1.6")],
	];
	for (const [label, layers] of contradictions) assertStackupRejected(layers, label);
});

test("a malformed or unsupported stackup record fails parse", () => {
	const cases: [string, string][] = [
		["an unknown record", [FRONT, core("1.53"), BACK, "(foo 1)"].join(" ")],
		["an unknown layer field", [FRONT, core("1.53"), '(layer "B.Cu" (type "copper") (thickness 0.035) (x 1))'].join(" ")],
		["a copper layer with no thickness", ['(layer "F.Cu" (type "copper"))', core("1.53"), BACK].join(" ")],
		["a layer with no type", ['(layer "F.Cu" (thickness 0.035))', core("1.53"), BACK].join(" ")],
		["a core of infinite thickness", [FRONT, core("1e309"), BACK].join(" ")],
		["a negative copper thickness", [copperLayer("F.Cu", "-0.035"), core("1.53"), BACK].join(" ")],
	];
	for (const [label, layers] of cases) assertRejected(withStackup(layers), label);
	const twice = withSetup(
		`(setup (stackup ${[FRONT, core("1.53"), BACK].join(" ")}) (stackup ${KICAD_DEFAULT}) (pad_to_mask_clearance 0))`,
	);
	assertRejected(twice, "two stackups in one setup");
});

test("the old restated 1.6 mm core alone still fails parse, since it has no copper", () => {
	assertStackupRejected(
		'(layer "dielectric 1" (type "core") (thickness 1.6) (material "FR4"))',
		"a restated 1.6 mm core alone",
	);
});

test("harmless general and title metadata still passes, and so does a board with no general record", () => {
	const variants = [
		SAMPLE_HONEST_PCB.replace(GENERAL, "(general (thickness 1.6) (legacy_teardrops no))"),
		SAMPLE_HONEST_PCB.replace(GENERAL, "(general (thickness 1.6) (drawings 4) (tracks 12) (zones 0) (modules 3) (nets 7))"),
		SAMPLE_HONEST_PCB.replace('(paper "A4")', '(paper "A3")'),
		SAMPLE_HONEST_PCB.replace("(kicad_pcb ", '(kicad_pcb (title_block (title "Test") (rev "1")) '),
		SAMPLE_HONEST_PCB.replace(`\t${GENERAL}\n`, ""),
	];
	for (const text of variants) {
		assert.notEqual(text, SAMPLE_HONEST_PCB, "the variant differs from the honest board");
		assert.equal(readBoard(text).ok, true, text.slice(0, 80));
		assert.equal(verdictOf(text).pass, true, text.slice(0, 80));
	}
});
