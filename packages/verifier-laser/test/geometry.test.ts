import assert from "node:assert/strict";
import test from "node:test";
import { boundsOf, centreOf, edgeListDistance, edgesOf, edgesOverlap, heightOf, pointInPolygon, roundMm, segmentDistance, selfOverlaps, widthOf } from "../src/geometry.ts";

const square: [number, number][] = [[0, 0], [4, 0], [4, 2], [0, 2]];

test("bounds, width, height and centre of a set of points", () => {
	const box = boundsOf([[1, 2], [5, 2], [5, 8]]);
	assert.ok(box !== null);
	assert.equal(widthOf(box), 4);
	assert.equal(heightOf(box), 6);
	assert.deepEqual(centreOf(box), [3, 5]);
	assert.equal(boundsOf([]), null);
});

test("a point inside a polygon is in, a point outside is out", () => {
	assert.equal(pointInPolygon([2, 1], square), true);
	assert.equal(pointInPolygon([5, 1], square), false);
	assert.equal(pointInPolygon([-1, -1], square), false);
});

test("the distance between two segments is the gap, and zero when they cross", () => {
	assert.equal(segmentDistance([0, 0], [10, 0], [0, 3], [10, 3]), 3);
	assert.equal(segmentDistance([0, 0], [10, 10], [0, 10], [10, 0]), 0);
});

test("the distance between two edge lists is the nearest gap between them", () => {
	const left = edgesOf([[0, 0], [2, 0], [2, 2], [0, 2]], true);
	const right = edgesOf([[4, 0], [6, 0], [6, 2], [4, 2]], true);
	assert.equal(edgeListDistance(left, right), 2);
});

test("two edges along one line overlap whatever their direction and start", () => {
	assert.equal(edgesOverlap([0, 0], [10, 0], [2, 0], [8, 0]), true);
	assert.equal(edgesOverlap([0, 0], [10, 0], [8, 0], [2, 0]), true);
	assert.equal(edgesOverlap([0, 0], [10, 0], [8, 0], [14, 0]), true);
});

test("edges that only meet at a corner, or lie apart, do not overlap", () => {
	assert.equal(edgesOverlap([0, 0], [10, 0], [10, 0], [10, 5]), false);
	assert.equal(edgesOverlap([0, 0], [10, 0], [10, 0], [20, 0]), false);
	assert.equal(edgesOverlap([0, 0], [10, 0], [0, 0.5], [10, 0.5]), false);
});

test("an edge 0.01 mm off the line still overlaps it", () => {
	assert.equal(edgesOverlap([0, 0], [10, 0], [0, 0.01], [10, 0.01]), true);
});

test("a path that doubles back on itself overlaps itself, a plain square and a corner do not", () => {
	assert.equal(selfOverlaps([[10, 10], [90, 10], [50, 10], [130, 10], [130, 90], [10, 90]], true), true);
	assert.equal(selfOverlaps([[0, 0], [10, 0], [5, 0]], false), true);
	assert.equal(selfOverlaps(square, true), false);
});

test("rounding keeps three decimal places of mm", () => {
	assert.equal(roundMm(1.23456), 1.235);
	assert.equal(roundMm(0.0004), 0);
});
