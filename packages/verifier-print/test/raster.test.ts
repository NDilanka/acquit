import assert from "node:assert/strict";
import test from "node:test";
import { areaMm2, countUnits, fillEdges, gridOver, iou, ringEdges, stampSegment } from "../src/raster.ts";
import type { Ring } from "../src/raster.ts";

const square = (x0: number, y0: number, side: number): Ring => [
	[x0, y0],
	[x0 + side, y0],
	[x0 + side, y0 + side],
	[x0, y0 + side],
];

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

// All rings go into one winding fill, the way a mesh section's outer rings and holes do.
function filled(rings: readonly Ring[], bounds: Bounds) {
	const grid = gridOver(bounds, 1);
	fillEdges(grid, rings.flatMap(ring => ringEdges(ring)));
	return grid;
}

const SECTION_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const WIDE_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 15, maxY: 10 };

test("a square footprint on a square section of the same size has IoU 1", () => {
	const section = filled([square(0, 0, 10)], SECTION_BOUNDS);
	const footprint = filled([square(0, 0, 10)], SECTION_BOUNDS);
	assert.ok(Math.abs(iou(footprint, section) - 1) < 1e-9);
});

test("a square shifted by half its side has IoU 1/3: 50 mm2 shared of 150 mm2 covered", () => {
	const section = filled([square(0, 0, 10)], WIDE_BOUNDS);
	const shifted = filled([square(5, 0, 10)], WIDE_BOUNDS);
	assert.ok(Math.abs(iou(shifted, section) - 1 / 3) < 0.001);
});

test("a 10 mm extrusion at 0.4 mm width covers its stadium: 4.1257 mm2 within 0.08", () => {
	const grid = gridOver({ minX: 0, minY: 0, maxX: 10, maxY: 0 }, 1);
	stampSegment(grid, [0, 0, 10, 0], 0.2);
	const stadium = 10 * 0.4 + Math.PI * 0.2 * 0.2;
	assert.ok(Math.abs(areaMm2(grid) - stadium) < 0.08);
});

test("a hole in a section leaves the annulus filled: 96 mm2 of the 100 mm2 square, within 0.1", () => {
	// Holes run clockwise, the opposite of the outer ring, so their winding cancels.
	const hole = square(4, 4, 2).slice().reverse();
	const grid = filled([square(0, 0, 10), hole], SECTION_BOUNDS);
	assert.ok(Math.abs(areaMm2(grid) - 96) < 0.1);
});

test("an empty footprint has IoU 0 against any section", () => {
	const section = filled([square(0, 0, 10)], SECTION_BOUNDS);
	const empty = gridOver(SECTION_BOUNDS, 1);
	assert.equal(iou(empty, section), 0);
});

test("two disjoint squares count as two units, and a fragment under 1 mm2 is not a unit", () => {
	const grid = gridOver({ minX: 0, minY: 0, maxX: 12, maxY: 3 }, 1);
	fillEdges(grid, ringEdges(square(0, 0, 2)));
	fillEdges(grid, ringEdges(square(5, 0, 2)));
	fillEdges(grid, ringEdges(square(10, 0, 0.5)));
	assert.equal(countUnits(grid, 1), 2);
});
