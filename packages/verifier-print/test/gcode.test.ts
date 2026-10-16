import assert from "node:assert/strict";
import test from "node:test";
import { parseGcode } from "../src/gcode.ts";

// Two layers, PrusaSlicer-style comments, a retraction, a Z hop, a relative section, a G92 reset and a
// G3 arc. Every expected value below is worked by hand from these lines.
const FIXTURE = [
	"G21",
	"G90",
	"M82",
	"G28",
	"G92 E0",
	";LAYER_CHANGE",
	";Z:0.2",
	";TYPE:Perimeter",
	"G1 Z0.2 F1200",
	"G1 X20 E1.0 F1800",
	"G1 Y20 E2.0",
	"G1 E1.2 F2400",
	"G1 X0 F3000",
	"G1 E2.0 F2400",
	";LAYER_CHANGE",
	";Z:0.4",
	";TYPE:Infill",
	"G1 Z0.4 F1200",
	"G1 X0 Y0 E2.8 F1800",
	"M83",
	"G91",
	"G1 X10 E0.5 F1800",
	"G90",
	"M82",
	"G92 E0",
	"G3 X15 Y5 I0 J5 E0.6 F1200",
].join("\n");

function parsed(text: string) {
	const result = parseGcode(text);
	if (!result.ok) throw new Error(`expected a parse, got ${JSON.stringify(result.reason)}`);
	return result.value;
}

test("the fixture has two layers, at z 0.2 and z 0.4", () => {
	const g = parsed(FIXTURE);
	assert.equal(g.layers.length, 2);
	assert.deepEqual(g.layers.map(layer => layer.z), [0.2, 0.4]);
});

test("total extrusion is the sum of positive E moves, and retraction is not subtracted", () => {
	assert.ok(Math.abs(parsed(FIXTURE).extrudedMm - 4.7) < 1e-9);
});

test("per-layer extrusion and path length match the hand values", () => {
	const [first, second] = parsed(FIXTURE).layers;
	assert.ok(Math.abs(first.extrudedMm - 2.8) < 1e-9);
	assert.ok(Math.abs(second.extrudedMm - 1.9) < 1e-9);
	assert.ok(Math.abs(first.pathLengthMm - 40) < 1e-9);
	assert.ok(Math.abs(second.pathLengthMm - (20 + 10 + (5 * Math.PI) / 2)) < 1e-9);
});

test("moves are attributed to the layer open when they run", () => {
	const g = parsed(FIXTURE);
	assert.equal(g.layers[0].moveCount, 6);
	assert.equal(g.layers[1].moveCount, 3);
	assert.equal(g.moves[0].layer, -1);
	assert.equal(g.moves[0].line, 9);
	assert.ok(Math.abs(g.moves[0].xyzMm - 0.2) < 1e-9);
});

test("G28 from the origin moves nothing and is not recorded", () => {
	assert.ok(parsed(FIXTURE).moves.every(move => move.line !== 4));
});

test("the arc length is the planar sweep, radius times angle", () => {
	const arcMove = parsed(FIXTURE).moves.find(move => move.line === 26);
	assert.ok(arcMove);
	assert.ok(Math.abs(arcMove.xyzMm - (5 * Math.PI) / 2) < 1e-9);
	assert.ok(Math.abs(arcMove.deltaEMm - 0.6) < 1e-9);
});

test("feedrates are F over 60 in mm/s, modal, and each move carries its feature", () => {
	const g = parsed(FIXTURE);
	const at = (line: number) => g.moves.find(move => move.line === line);
	assert.equal(at(10)?.feedMmPerSec, 30);
	assert.equal(at(12)?.feedMmPerSec, 40);
	assert.equal(at(13)?.feedMmPerSec, 50);
	assert.equal(at(10)?.feature, "Perimeter");
	assert.equal(at(19)?.feature, "Infill");
});

test("a relative E section adds to the running E position", () => {
	const move = parsed(FIXTURE).moves.find(item => item.line === 22);
	assert.ok(move);
	assert.ok(Math.abs(move.deltaEMm - 0.5) < 1e-9);
});

test("layers open on Z change alone, and a hop back to the open layer's Z opens none", () => {
	const g = parsed(["G21", "G1 Z0.2 F1200", "G1 X10 E1 F1800", "G1 Z0.5", "G1 Z0.2", "G1 X20 E2", "G1 Z0.4", "G1 X30 E3"].join("\n"));
	assert.deepEqual(g.layers.map(layer => layer.z), [0.2, 0.4]);
});

test("a ;Z: comment that disagrees with the move's Z refuses the file at the comment's line", () => {
	const result = parseGcode([";LAYER_CHANGE", ";Z:0.3", "G1 Z0.2 F1200", "G1 X10 E1 F1800"].join("\n"));
	assert.deepEqual(result, { ok: false, reason: { kind: "GCODE_UNPARSEABLE", line: 2 } });
});

test("lines that cannot be read with certainty are refused at their line", () => {
	const cases: [string, number][] = [
		["G21\nG20", 2],
		["G1 X1\nG2 X10 Y0 R5", 2],
		["G1 X10 F0", 1],
		["G4 P100", 1],
		["G1 Xabc", 1],
		["T1", 1],
	];
	for (const [text, line] of cases) {
		assert.deepEqual(parseGcode(text), { ok: false, reason: { kind: "GCODE_UNPARSEABLE", line } }, text);
	}
});
