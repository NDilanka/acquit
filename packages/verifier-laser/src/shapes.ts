// Ideal shapes that drawn cuts are matched against, in mm. A cut fits a shape when every drawn vertex lies on the
// shape's outline and every sample of that outline lies on the cut, each within a tolerance. Bounding boxes are not
// enough: a diamond, a triangle or a chamfered corner has the right box and fails here.

import { boundsOf, centreOf, edgesOf, heightOf, pointEdgeDistance, widthOf } from "./geometry.ts";
import type { Vec2 } from "./types.ts";

/** Segments per quarter of a rounded corner. */
const ARC_STEPS = 16;
/** Segments along each straight side, so a cut cannot hide a bulge between two samples. */
const SIDE_STEPS = 4;

/** The most points any ideal ring has. Used to bound the work a shape test can cost. */
export const RING_POINTS_MAX = 4 * (ARC_STEPS + 1) + 4 * (SIDE_STEPS - 1);

const TWO_PI = 2 * Math.PI;

/**
 * An axis-aligned rectangle with rounded corners, from its centre, size and corner radius. The radius is clamped to
 * half the smaller side, so a radius of zero gives square corners.
 */
export function roundedRectRing(centre: Vec2, width: number, height: number, radius: number): Vec2[] {
	const [cx, cy] = centre;
	const hw = width / 2;
	const hh = height / 2;
	const r = Math.max(0, Math.min(radius, hw, hh));
	// Each corner's arc centre and start angle, clockwise in the y-down drawing: top-right, bottom-right,
	// bottom-left, top-left. Each arc runs a quarter turn.
	const corners: readonly (readonly [number, number, number])[] = [
		[cx + hw - r, cy - hh + r, -Math.PI / 2],
		[cx + hw - r, cy + hh - r, 0],
		[cx - hw + r, cy + hh - r, Math.PI / 2],
		[cx - hw + r, cy - hh + r, Math.PI],
	];
	const arcs: Vec2[][] = corners.map(([ox, oy, start]) => {
		const arc: Vec2[] = [];
		for (let i = 0; i <= ARC_STEPS; i++) {
			const angle = start + (Math.PI / 2) * (i / ARC_STEPS);
			arc.push([ox + r * Math.cos(angle), oy + r * Math.sin(angle)]);
		}
		return arc;
	});
	const ring: Vec2[] = [];
	for (let k = 0; k < arcs.length; k++) {
		const arc = arcs[k]!;
		const next = arcs[(k + 1) % arcs.length]![0]!;
		ring.push(...arc);
		const last = arc[arc.length - 1]!;
		for (let s = 1; s < SIDE_STEPS; s++) {
			const t = s / SIDE_STEPS;
			ring.push([last[0] + (next[0] - last[0]) * t, last[1] + (next[1] - last[1]) * t]);
		}
	}
	return ring;
}

/**
 * True when a cut fits an ideal outline: the cut is closed, every vertex lies within tol of the outline, and every
 * outline sample lies within tol of the cut. An open cut never fits.
 */
export function fitsRing(points: readonly Vec2[], closed: boolean, ring: readonly Vec2[], tol: number): boolean {
	if (!closed || points.length === 0 || ring.length === 0) return false;
	const ringEdges = edgesOf(ring, true);
	const cutEdges = edgesOf(points, true);
	if (!points.every(point => pointEdgeDistance(point, ringEdges) <= tol)) return false;
	return ring.every(point => pointEdgeDistance(point, cutEdges) <= tol);
}

/** True when a closed cut is an axis-aligned rectangle with square corners, at its own bounding box. */
export function fitsRectangle(points: readonly Vec2[], closed: boolean, tol: number): boolean {
	const box = boundsOf(points);
	if (box === null) return false;
	return fitsRing(points, closed, roundedRectRing(centreOf(box), widthOf(box), heightOf(box), 0), tol);
}

/**
 * True when a closed cut is a circle within tol. Its box must be square within tol. Every vertex must lie within tol of
 * the circle at the box's centre and size, and no point of the cut may lie inside that circle by more than tol. The
 * cut must then cover every direction round the circle, apart from gaps no longer than 2 tol of arc. The test works on
 * the cut's edges, not on samples, so a polygon with the right vertices but straight sides fails, and so does a loop
 * that runs round only part of a circle.
 */
export function isRoundCut(points: readonly Vec2[], closed: boolean, tol: number): boolean {
	if (!closed) return false;
	const box = boundsOf(points);
	if (box === null) return false;
	const width = widthOf(box);
	const height = heightOf(box);
	if (Math.abs(width - height) > tol) return false;
	const radius = (width + height) / 4;
	// The direction test needs the centre clear of the cut, so a circle no wider than its tolerance is refused.
	if (radius <= tol) return false;
	const centre = centreOf(box);
	const edges = edgesOf(points, true);
	if (edges.length === 0) return false;
	// Distance from the centre is convex along each edge, so the furthest point of an edge is an end: checking the
	// vertices bounds the whole cut from outside, and the nearest point of the cut bounds it from inside.
	if (!points.every(([x, y]) => Math.hypot(x - centre[0], y - centre[1]) <= radius + tol)) return false;
	if (pointEdgeDistance(centre, edges) < radius - tol) return false;
	return roundIsCovered(edges, centre, radius, tol);
}

/**
 * True when the edges leave no arc of the circle uncovered for more than 2 tol. Each edge lies within tol of the circle,
 * so it covers every direction from the centre that it spans, and every point on those directions is within tol of it.
 */
function roundIsCovered(edges: readonly (readonly [Vec2, Vec2])[], centre: Vec2, radius: number, tol: number): boolean {
	const angleOf = ([x, y]: Vec2): number => Math.atan2(y - centre[1], x - centre[0]);
	const arcs: [number, number][] = [];
	for (const [a, b] of edges) {
		// The shorter way round from a to b, which is the span of the edge as seen from the centre.
		let sweep = (angleOf(b) - angleOf(a)) % TWO_PI;
		if (sweep > Math.PI) sweep -= TWO_PI;
		if (sweep < -Math.PI) sweep += TWO_PI;
		const from = sweep >= 0 ? angleOf(a) : angleOf(a) + sweep;
		const lo = ((from % TWO_PI) + TWO_PI) % TWO_PI;
		const hi = lo + Math.abs(sweep);
		if (hi > TWO_PI) arcs.push([lo, TWO_PI], [0, hi - TWO_PI]);
		else arcs.push([lo, hi]);
	}
	if (arcs.length === 0) return false;
	arcs.sort((p, q) => p[0] - q[0]);
	const maxGap = (2 * tol) / radius;
	let reach = arcs[0]![1];
	for (let i = 1; i < arcs.length; i++) {
		const [lo, hi] = arcs[i]!;
		if (lo - reach > maxGap) return false;
		reach = Math.max(reach, hi);
	}
	// The gap that runs through zero: from the furthest reach round to the first start.
	return arcs[0]![0] + TWO_PI - reach <= maxGap;
}
