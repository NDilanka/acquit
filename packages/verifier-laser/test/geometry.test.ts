import assert from "node:assert/strict";
import test from "node:test";
import { boundsOf, centreOf, edgeListDistance, edgesOf, heightOf, pointInPolygon, roundMm, segmentDistance, shapeKey, widthOf } from "../src/geometry.ts";

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

test("a shape key is the same for the same outline from any start point or direction", () => {
	const a = shapeKey([[0, 0], [1, 0], [1, 1], [0, 1]]);
	const b = shapeKey([[1, 1], [0, 1], [0, 0], [1, 0]]);
	const c = shapeKey([[0, 0], [2, 0], [2, 1], [0, 1]]);
	assert.equal(a, b);
	assert.notEqual(a, c);
});

test("rounding keeps three decimal places of mm", () => {
	assert.equal(roundMm(1.23456), 1.235);
	assert.equal(roundMm(0.0004), 0);
});
