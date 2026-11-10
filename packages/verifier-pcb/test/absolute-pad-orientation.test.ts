import assert from "node:assert/strict";
import test from "node:test";
import { readBoard } from "../src/board.ts";
import { rotate } from "../src/geometry.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Spec, Verdict, Vec2 } from "../src/types.ts";

// A KiCad board footprint stores each pad's offset in the footprint's unrotated frame, and the pad's orientation on the
// board as one absolute angle (the footprint's turn plus the pad's own turn). The checker reads that stored angle as
// absolute and does not add the footprint turn a second time. This follows KiCad's board file format as the checker
// understands it. It has not been checked against a real KiCad round trip, because KiCad is not installed here.

const near = (a: number, b: number, tol = 1e-6): void => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);

/** A 2 by 1 pad at offset (1, 0) in a footprint turned footprintTurn degrees, stored at padAngle degrees on the board. */
const board = (footprintTurn: number, padAngle: number): string => `(kicad_pcb
	(footprint "Test:Part" (layer "F.Cu") (at 10 10 ${footprintTurn})
		(property "Reference" "X1" (at 0 0 0) (layer "F.SilkS"))
		(pad "1" smd rect (at 1 0 ${padAngle}) (size 2 1) (layers "F.Cu") (net 1 "VIN"))
	)
	(gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts") (stroke (width 0.05) (type default)))
	(gr_line (start 20 0) (end 20 20) (layer "Edge.Cuts") (stroke (width 0.05) (type default)))
	(gr_line (start 20 20) (end 0 20) (layer "Edge.Cuts") (stroke (width 0.05) (type default)))
	(gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (stroke (width 0.05) (type default)))
)`;

/** The pad X1.1 as the reader sees it. */
function onlyPad(text: string) {
	const b = readBoard(text);
	assert.equal(b.ok, true);
	const pad = b.pads.find(p => p.id === "X1.1");
	assert.ok(pad, "pad X1.1 is read");
	return pad;
}

/** The four corners of a 2 by 1 pad, offset from its centre and turned by angle, using the same rotation as the outline. */
const LOCAL_CORNERS: readonly Vec2[] = [
	[-1, -0.5],
	[1, -0.5],
	[1, 0.5],
	[-1, 0.5],
];

/** Each expected corner must be a vertex of the pad polygon; the order of the vertices does not matter. */
function assertCorners(poly: readonly Vec2[], center: Vec2, angle: number): void {
	for (const local of LOCAL_CORNERS) {
		const r = rotate(local, angle);
		const want: Vec2 = [center[0] + r[0], center[1] + r[1]];
		const hit = poly.some(p => Math.hypot(p[0] - want[0], p[1] - want[1]) <= 1e-6);
		assert.ok(hit, `no pad corner at (${want[0].toFixed(4)}, ${want[1].toFixed(4)}) for a pad turned ${angle} degrees`);
	}
}

/** The width of a polygon along one axis. */
const extent = (poly: readonly Vec2[], axis: 0 | 1): number => {
	const values = poly.map(p => p[axis]);
	return Math.max(...values) - Math.min(...values);
};

test("a pad stored at 90 degrees in a footprint turned 90 degrees is a 90-degree pad, not 180", () => {
	const pad = onlyPad(board(90, 90));
	near(pad.center[0], 10);
	near(pad.center[1], 9);
	near(pad.angle, 90);
	near(extent(pad.poly, 0), 1);
	near(extent(pad.poly, 1), 2);
	assertCorners(pad.poly, pad.center, 90);
});

test("a pad stored at 180 degrees in a footprint turned 180 degrees is a 180-degree pad, not 360", () => {
	const pad = onlyPad(board(180, 180));
	near(pad.center[0], 9);
	near(pad.center[1], 10);
	near(pad.angle, 180);
	assertCorners(pad.poly, pad.center, 180);
});

test("a pad stored at 270 degrees in a footprint turned 270 degrees is a 270-degree pad, not 540", () => {
	const pad = onlyPad(board(270, 270));
	near(pad.center[0], 10);
	near(pad.center[1], 11);
	near(pad.angle, 270);
	near(extent(pad.poly, 0), 1);
	near(extent(pad.poly, 1), 2);
	assertCorners(pad.poly, pad.center, 270);
});

test("a pad stored at 33 degrees in a footprint turned 33 degrees is a 33-degree pad, not 66", () => {
	const pad = onlyPad(board(33, 33));
	near(pad.angle, 33);
	assertCorners(pad.poly, pad.center, 33);
});

test("a pad's own turn inside a rotated footprint is the stored angle, not the footprint turn added again", () => {
	// The pad's own turn is 30 degrees; inside a footprint turned 90 degrees it is stored at 120 degrees.
	const pad = onlyPad(board(90, 120));
	near(pad.angle, 120);
	near(pad.center[0], 10);
	near(pad.center[1], 9);
	assertCorners(pad.poly, pad.center, 120);
});

// The verdict must follow the stored orientation as well: a spec that turns R1 by 90 degrees, with its pads stored at
// 90 degrees on the board, is the matching placement. Rotating the same part with its pads stored at 0 degrees is not.
const honestSpec: Spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const hidden: HiddenSample = (() => {
	const r = validateHidden(JSON.parse(SAMPLE_HIDDEN_JSON), honestSpec);
	if (!r.ok) throw new Error(r.error);
	return r.hidden;
})();

const turnedSpec: Spec = {
	...honestSpec,
	parts: honestSpec.parts.map(p => (p.ref === "R1" ? { ...p, rotation: 90 } : p)),
};

/** The honest board with footprint R1 turned 90 degrees, and its two pads stored at 90 degrees (or left at 0 when padsTurned is false). */
function turnR1(padsTurned: boolean): string {
	const marker = '(footprint "Resistor_SMD:R_0805_2012Metric" (layer "F.Cu") (at 122 106)';
	const start = SAMPLE_HONEST_PCB.indexOf(marker);
	assert.ok(start >= 0, "the honest board lacks footprint R1");
	const end = SAMPLE_HONEST_PCB.indexOf("\n\t)", start);
	let block = SAMPLE_HONEST_PCB.slice(start, end);
	const edits: readonly (readonly [string, string])[] = [
		["(at 122 106)", "(at 122 106 90)"],
		['(pad "1" smd rect (at -0.95 0)', padsTurned ? '(pad "1" smd rect (at -0.95 0 90)' : '(pad "1" smd rect (at -0.95 0)'],
		['(pad "2" smd rect (at 0.95 0)', padsTurned ? '(pad "2" smd rect (at 0.95 0 90)' : '(pad "2" smd rect (at 0.95 0)'],
	];
	for (const [from, to] of edits) {
		assert.ok(block.includes(from), `R1 lacks: ${from}`);
		block = block.replace(from, to);
	}
	return SAMPLE_HONEST_PCB.slice(0, start) + block + SAMPLE_HONEST_PCB.slice(end);
}

const verdictFor = (text: string): Verdict => verify(turnedSpec, text, hidden);
const okOf = (v: Verdict, rule: string): boolean | undefined => v.findings.find(f => f.rule === rule)?.ok;

test("a footprint turned 90 degrees with its pads stored at 90 degrees passes parts-placed against a 90-degree spec", () => {
	assert.equal(okOf(verdictFor(turnR1(true)), "parts-placed"), true);
});

test("a footprint turned 90 degrees with its pads stored at 0 degrees fails parts-placed against a 90-degree spec", () => {
	assert.equal(okOf(verdictFor(turnR1(false)), "parts-placed"), false);
});
