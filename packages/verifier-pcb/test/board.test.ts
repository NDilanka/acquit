import assert from "node:assert/strict";
import test from "node:test";
import { readBoard } from "../src/board.ts";

const near = (a: number, b: number, tol = 1e-6): void => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);

const ROTATED = `(kicad_pcb
	(footprint "Test:Part" (layer "F.Cu") (at 10 10 90)
		(property "Reference" "R9" (at 0 0 0) (layer "F.SilkS"))
		(pad "1" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 1 "VIN"))
	)
	(gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts") (stroke (width 0.05) (type default)))
	(gr_line (start 20 0) (end 20 20) (layer "Edge.Cuts") (stroke (width 0.05) (type default)))
	(gr_line (start 20 20) (end 0 20) (layer "Edge.Cuts") (stroke (width 0.05) (type default)))
	(gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (stroke (width 0.05) (type default)))
)`;

test("footprint rotation moves pads about the footprint origin", () => {
	const b = readBoard(ROTATED);
	assert.equal(b.ok, true);
	const pad = b.pads.find(p => p.id === "R9.1");
	assert.ok(pad, "pad R9.1 is read");
	near(pad.center[0], 10);
	near(pad.center[1], 9);
	assert.equal(pad.netName, "VIN");
});

test("a closed Edge.Cuts chain becomes one outline loop", () => {
	const b = readBoard(ROTATED);
	assert.equal(b.outlineLoops.length, 1);
	assert.equal(b.outlineOpen, false);
});

test("a file with no kicad_pcb head is rejected without throwing", () => {
	const b = readBoard("(something_else)");
	assert.equal(b.ok, false);
});
