import assert from "node:assert/strict";
import test from "node:test";
import { readBoard } from "../src/board.ts";
import { SAMPLE_HONEST_PCB } from "../src/samples.ts";

// A KiCad record carries each single-valued field once. A repeated field is ambiguous, so the board fails the parse
// whichever copy comes first. Each case appends one record to the honest board, repeats one field of it in both
// orders, and asserts that the parse names the repeated field.

const withRecord = (record: string): string => SAMPLE_HONEST_PCB.replace(/\)\s*$/, `${record}\n)`);

const SEG = '(segment (start 122.95 110) (end 127.95 110) (width 0.25) (layer "F.Cu") (net 4))';
const ARC = '(arc (start 130 110) (mid 131 111) (end 132 110) (width 0.2) (layer "F.Cu") (net 5))';
const VIA = '(via (at 145 110) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 5))';
const FP =
	'(footprint "Test:P" (layer "F.Cu") (at 150 100) (property "Reference" "X1") ' +
	'(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "VIN")) ' +
	'(pad "2" thru_hole circle (at 2 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net 2 "GND")))';
const FPL =
	'(footprint "Test:L" (layer "F.Cu") (at 190 100) (property "Reference" "L1") ' +
	'(fp_line (start -1 -1) (end 1 -1) (stroke (width 0.12) (type solid)) (layer "F.SilkS")))';
const GRL = '(gr_line (start 100 90) (end 140 90) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))';
const GRC = '(gr_circle (center 150 90) (end 153 90) (stroke (width 0.12) (type solid)) (fill none) (layer "F.SilkS"))';
const GRR = '(gr_rect (start 160 90) (end 165 95) (stroke (width 0.12) (type solid)) (fill none) (layer "F.SilkS"))';
const GRA = '(gr_arc (start 170 90) (mid 171 91) (end 172 90) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))';
const GRT = '(gr_text "T1" (at 180 90) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))';
const MULTI =
	'(footprint "Test:Q" (layer "F.Cu") (at 160 100) (property "Reference" "Q1") (property "Value" "Q") ' +
	'(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VIN")) ' +
	'(pad "1" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 1 "VIN")))';

type Case = {
	readonly name: string;
	readonly record: string;
	readonly anchor: string; // the field that is repeated; it occurs once in the record
	readonly dup: string; // the repeated copy, with a different value
	readonly expect: string; // the parse error must name the repeated field and its record
};

const CASES: readonly Case[] = [
	{ name: "segment end", record: SEG, anchor: "(end 127.95 110)", dup: "(end 127.95 109)", expect: "(end) repeated in (segment)" },
	{ name: "segment width", record: SEG, anchor: "(width 0.25)", dup: "(width 0.1)", expect: "(width) repeated in (segment)" },
	{ name: "segment layer", record: SEG, anchor: '(layer "F.Cu")', dup: '(layer "B.Cu")', expect: "(layer) repeated in (segment)" },
	{ name: "segment net", record: SEG, anchor: "(net 4)", dup: "(net 5)", expect: "(net) repeated in (segment)" },
	{ name: "arc mid", record: ARC, anchor: "(mid 131 111)", dup: "(mid 131 112)", expect: "(mid) repeated in (arc)" },
	{ name: "arc width", record: ARC, anchor: "(width 0.2)", dup: "(width 0.3)", expect: "(width) repeated in (arc)" },
	{ name: "via at", record: VIA, anchor: "(at 145 110)", dup: "(at 146 110)", expect: "(at) repeated in (via)" },
	{ name: "via drill", record: VIA, anchor: "(drill 0.3)", dup: "(drill 0.5)", expect: "(drill) repeated in (via)" },
	{ name: "via layers", record: VIA, anchor: '(layers "F.Cu" "B.Cu")', dup: '(layers "B.Cu" "F.Cu")', expect: "(layers) repeated in (via)" },
	{ name: "pad size", record: FP, anchor: "(size 1 1)", dup: "(size 2 2)", expect: "(size) repeated in (pad)" },
	{ name: "pad drill", record: FP, anchor: "(drill 1)", dup: "(drill 0.5)", expect: "(drill) repeated in (pad)" },
	{
		name: "pad layers",
		record: FP,
		anchor: '(layers "F.Cu" "F.Paste" "F.Mask")',
		dup: '(layers "B.Cu")',
		expect: "(layers) repeated in (pad)",
	},
	{ name: "pad net", record: FP, anchor: '(net 1 "VIN")', dup: '(net 2 "GND")', expect: "(net) repeated in (pad)" },
	{ name: "pad at", record: FP, anchor: "(at 0 0)", dup: "(at 1 0)", expect: "(at) repeated in (pad)" },
	{ name: "footprint at", record: FP, anchor: "(at 150 100)", dup: "(at 151 100)", expect: "(at) repeated in (footprint)" },
	{
		name: "footprint layer",
		record: FP,
		anchor: '(layer "F.Cu")',
		dup: '(layer "B.Cu")',
		expect: "(layer) repeated in (footprint)",
	},
	{
		name: "footprint property key",
		record: FP,
		anchor: '(property "Reference" "X1")',
		dup: '(property "Reference" "X2")',
		expect: '"Reference" repeated in (footprint)',
	},
	{ name: "footprint line layer", record: FPL, anchor: '(layer "F.SilkS")', dup: '(layer "F.Cu")', expect: "(layer) repeated in (fp_line)" },
	{ name: "silk line end", record: GRL, anchor: "(end 140 90)", dup: "(end 141 90)", expect: "(end) repeated in (gr_line)" },
	{ name: "silk line layer", record: GRL, anchor: '(layer "F.SilkS")', dup: '(layer "F.Cu")', expect: "(layer) repeated in (gr_line)" },
	{ name: "silk circle center", record: GRC, anchor: "(center 150 90)", dup: "(center 151 90)", expect: "(center) repeated in (gr_circle)" },
	{ name: "silk rect start", record: GRR, anchor: "(start 160 90)", dup: "(start 161 90)", expect: "(start) repeated in (gr_rect)" },
	{ name: "silk arc mid", record: GRA, anchor: "(mid 171 91)", dup: "(mid 171 92)", expect: "(mid) repeated in (gr_arc)" },
	{ name: "silk text at", record: GRT, anchor: "(at 180 90)", dup: "(at 181 90)", expect: "(at) repeated in (gr_text)" },
];

for (const c of CASES) {
	test(`a repeated ${c.name} fails the parse in either order`, () => {
		assert.equal(c.record.split(c.anchor).length, 2, `the anchor must occur once in ${c.name}`);
		const last = c.record.replace(c.anchor, `${c.anchor} ${c.dup}`);
		const first = c.record.replace(c.anchor, `${c.dup} ${c.anchor}`);
		for (const variant of [last, first]) {
			const board = readBoard(withRecord(variant));
			assert.equal(board.ok, false, variant);
			assert.ok(board.error?.includes(c.expect), `${c.name}: ${String(board.error)}`);
		}
	});
}

test("the honest board with each of these records added still parses", () => {
	for (const record of [SEG, ARC, VIA, FP, FPL, GRL, GRC, GRR, GRA, GRT, MULTI]) {
		const board = readBoard(withRecord(record));
		assert.equal(board.ok, true, `${record}: ${String(board.error)}`);
	}
});

test("pads that share a name and properties with distinct keys still parse", () => {
	const board = readBoard(withRecord(`${MULTI}\n(net 9 "EXTRA")`));
	assert.equal(board.ok, true, String(board.error));
});

test("a repeated version on the board root fails the parse in either order", () => {
	const last = SAMPLE_HONEST_PCB.replace("(version 20240108)", "(version 20240108) (version 20230101)");
	const first = SAMPLE_HONEST_PCB.replace("(version 20240108)", "(version 20230101) (version 20240108)");
	for (const variant of [last, first]) {
		const board = readBoard(variant);
		assert.equal(board.ok, false, variant);
		assert.ok(board.error?.includes("(version) repeated in (kicad_pcb)"), String(board.error));
	}
});

const EDGE_RIGHT = '(gr_line (start 140 100) (end 140 125) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))';

test("a repeated end point on an outline edge fails the parse in either order", () => {
	assert.ok(SAMPLE_HONEST_PCB.includes(EDGE_RIGHT), "the honest outline lacks its right edge");
	const last = EDGE_RIGHT.replace("(end 140 125)", "(end 140 125) (end 140 124)");
	const first = EDGE_RIGHT.replace("(end 140 125)", "(end 140 124) (end 140 125)");
	for (const variant of [last, first]) {
		const board = readBoard(SAMPLE_HONEST_PCB.replace(EDGE_RIGHT, variant));
		assert.equal(board.ok, false, variant);
		assert.ok(board.error?.includes("(end) repeated in (gr_line)"), String(board.error));
	}
});

test("a segment nested inside a (locked ...) field fails the parse", () => {
	const nested = SEG.replace(
		"(width 0.25)",
		'(locked (segment (start 133.08 118) (end 135.62 118) (width 0.3) (layer "F.Cu"))) (width 0.25)',
	);
	const board = readBoard(withRecord(nested));
	assert.equal(board.ok, false);
	assert.ok(board.error?.includes("(locked) in (segment) holds a nested record"), String(board.error));
});

test("a record nested inside a graphic fails the parse", () => {
	const nested = GRL.replace(
		"(stroke",
		'(segment (start 133.08 118) (end 135.62 118) (width 0.3) (layer "F.Cu")) (stroke',
	);
	const board = readBoard(withRecord(nested));
	assert.equal(board.ok, false);
	assert.ok(board.error?.includes("(segment) nested in (gr_line)"), String(board.error));
});

test("a midpoint on a straight segment is not one of its geometry fields", () => {
	const board = readBoard(withRecord(SEG.replace("(width 0.25)", "(mid 125 110) (width 0.25)")));
	assert.equal(board.ok, false);
	assert.ok(board.error?.includes("(mid) is not a geometry field of (segment)"), String(board.error));
});
