import assert from "node:assert/strict";
import test from "node:test";
import {
	arcPoints,
	circlePolygon,
	planArc,
	pointInPolygon,
	pointSegmentDistance,
	polygonDistance,
	rectPolygon,
	rotate,
	segmentPolygonDistance,
	segmentSegmentDistance,
} from "../src/geometry.ts";

const near = (a: number, b: number, tol = 1e-6): void => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);

test("rotate follows KiCad: 90 degrees counter-clockwise on screen, y down", () => {
	const [x, y] = rotate([1, 0], 90);
	near(x, 0);
	near(y, -1);
});

test("point to segment distance covers the middle and the ends", () => {
	near(pointSegmentDistance([1, 1], [0, 0], [2, 0]), 1);
	near(pointSegmentDistance([-3, 4], [0, 0], [2, 0]), 5);
});

test("segment to segment distance is zero when they cross", () => {
	near(segmentSegmentDistance([0, 0], [2, 2], [0, 2], [2, 0]), 0);
	near(segmentSegmentDistance([0, 0], [2, 0], [0, 1], [2, 1]), 1);
});

test("point in polygon is a ray cast", () => {
	const square: [number, number][] = [
		[0, 0],
		[4, 0],
		[4, 4],
		[0, 4],
	];
	assert.equal(pointInPolygon([2, 2], square), true);
	assert.equal(pointInPolygon([5, 2], square), false);
});

test("polygon distance is zero on overlap and the gap otherwise", () => {
	const a = rectPolygon([0, 0], [2, 2], 0);
	const b = rectPolygon([1, 0], [2, 2], 0);
	const c = rectPolygon([5, 0], [2, 2], 0);
	near(polygonDistance(a, b), 0);
	near(polygonDistance(a, c), 3);
	near(segmentPolygonDistance([-5, 0], [-4, 0], a), 3);
});

test("a rotated rectangle keeps its size", () => {
	const r = rectPolygon([0, 0], [4, 2], 90);
	const xs = r.map(p => p[0]);
	const ys = r.map(p => p[1]);
	near(Math.max(...xs) - Math.min(...xs), 2);
	near(Math.max(...ys) - Math.min(...ys), 4);
});

test("a circle is a 64-gon with the given radius", () => {
	const c = circlePolygon([0, 0], 1);
	assert.equal(c.length, 64);
	for (const p of c) near(Math.hypot(p[0], p[1]), 1, 1e-9);
});

test("arcs flatten within the error budget and reject collinear points", () => {
	const plan = planArc([1, 0], [0, 1], [-1, 0], 0.01, 1024);
	assert.ok(plan.ok);
	const pts = plan.ok ? arcPoints([1, 0], [-1, 0], plan) : [];
	assert.ok(pts.length > 4);
	for (const p of pts) near(Math.hypot(p[0], p[1]), 1, 0.011);
	assert.deepEqual(planArc([0, 0], [1, 0], [2, 0], 0.01, 1024), { ok: false, reason: "degenerate" });
});

test("arcs that need more pieces than the limit, or whose step rounds to zero, are reported as too many pieces", () => {
	// A semicircle of radius 1,000,000 needs about 7,800 pieces at a 0.02 mm chord error.
	assert.deepEqual(planArc([-1e6, 0], [0, 1e6], [1e6, 0], 0.02, 1024), { ok: false, reason: "too-many-pieces" });
	// A nearly straight arc of radius about 5e17: the chord-error step rounds to zero.
	assert.deepEqual(planArc([-1e6, 0], [0, 1e-6], [1e6, 0], 0.02, 1024), { ok: false, reason: "too-many-pieces" });
});
