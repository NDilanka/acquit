// Ideal shapes that drawn cuts are matched against, in mm. A closed cut fits a rounded rectangle when every drawn vertex and
// every edge midpoint lies within a tolerance of the exact outline, and the cut runs once round the centre. A round hole
// fits when its loop is simple, runs once round the centre, and every point of it lies within a tolerance of the true
// circle. Bounding boxes are not enough: a diamond, a triangle, a chamfered corner, or a polygon whose chords stand off a
// true arc has the right box and fails here.

import { areaOf, boundsOf, centreOf, edgesOf, heightOf, pointEdgeDistance, selfCrosses, selfOverlaps, widthOf, windingAround } from "./geometry.ts";
import type { Vec2 } from "./types.ts";

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

/** Distance from a point to the arc of a circle that starts at the given angle and runs a quarter turn. */
function arcDistance(point: Vec2, centre: Vec2, radius: number, start: number): number {
	const vx = point[0] - centre[0];
	const vy = point[1] - centre[1];
	const turned = (((Math.atan2(vy, vx) - start) % TWO_PI) + TWO_PI) % TWO_PI;
	if (turned <= HALF_PI) return Math.abs(Math.hypot(vx, vy) - radius);
	const first: Vec2 = [centre[0] + radius * Math.cos(start), centre[1] + radius * Math.sin(start)];
	const last: Vec2 = [centre[0] + radius * Math.cos(start + HALF_PI), centre[1] + radius * Math.sin(start + HALF_PI)];
	return Math.min(Math.hypot(point[0] - first[0], point[1] - first[1]), Math.hypot(point[0] - last[0], point[1] - last[1]));
}

/**
 * Exact distance from a point to the outline of a rounded rectangle: four straight sides and four quarter-circle arcs.
 * The radius is clamped to half the smaller side, and zero gives square corners.
 */
function outlineDistance(point: Vec2, centre: Vec2, halfWidth: number, halfHeight: number, radius: number): number {
	const r = Math.max(0, Math.min(radius, halfWidth, halfHeight));
	const left = centre[0] - halfWidth;
	const right = centre[0] + halfWidth;
	const top = centre[1] - halfHeight;
	const bottom = centre[1] + halfHeight;
	const sides: (readonly [Vec2, Vec2])[] = [
		[[left + r, top], [right - r, top]],
		[[right, top + r], [right, bottom - r]],
		[[right - r, bottom], [left + r, bottom]],
		[[left, bottom - r], [left, top + r]],
	];
	let best = pointEdgeDistance(point, sides);
	if (r > 0) {
		// Each corner's arc centre and start angle, clockwise in the y-down drawing: top-right, bottom-right, bottom-left,
		// top-left.
		const arcs: readonly (readonly [number, number, number])[] = [
			[right - r, top + r, -HALF_PI],
			[right - r, bottom - r, 0],
			[left + r, bottom - r, HALF_PI],
			[left + r, top + r, Math.PI],
		];
		for (const [ox, oy, start] of arcs) best = Math.min(best, arcDistance(point, [ox, oy], r, start));
	}
	return best;
}

/**
 * True when a closed cut is a rectangle with rounded corners of the given radius, at its own bounding box. Every vertex and
 * every edge midpoint must lie within tol of the exact outline, and the cut must run once round the centre. A radius of
 * zero gives square corners. An open cut never fits.
 */
export function fitsRoundedRect(points: readonly Vec2[], closed: boolean, radius: number, tol: number): boolean {
	if (!closed || points.length < 3) return false;
	const box = boundsOf(points);
	if (box === null) return false;
	const centre = centreOf(box);
	const halfWidth = widthOf(box) / 2;
	const halfHeight = heightOf(box) / 2;
	const near = (point: Vec2): boolean => outlineDistance(point, centre, halfWidth, halfHeight, radius) <= tol;
	if (!points.every(near)) return false;
	if (!edgesOf(points, true).every(([a, b]) => near([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]))) return false;
	return Math.abs(windingAround(points, centre)) === 1;
}

/**
 * True when a closed cut is a circle within tol. Its box must be square within tol, and every vertex and every edge
 * midpoint must lie within tol of the circle at the box's centre and size. No edge may come within radius - tol of the
 * centre. The loop must not cross or double back on itself, must run once round the centre, and must enclose an area the
 * tolerance allows. No arc of the circle may be left uncut for longer than 2 tol. The test works on the cut's edges, not
 * on samples, so a polygon with the right vertices but straight sides fails, and so do a loop that runs round only part
 * of a circle and a C-shaped loop whose two arcs lie within tol of the circle.
 */
export function isRoundCut(points: readonly Vec2[], closed: boolean, tol: number): boolean {
	if (!closed || points.length < 3) return false;
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
	// Every vertex and every edge midpoint must lie within tol of the circle. Distance from the centre is convex along
	// each edge, so the furthest point of an edge is an end, and the nearest point of the cut bounds it from inside.
	const onCircle = (point: Vec2): boolean => Math.abs(Math.hypot(point[0] - centre[0], point[1] - centre[1]) - radius) <= tol;
	if (!points.every(onCircle)) return false;
	if (!edges.every(([a, b]) => onCircle([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]))) return false;
	if (pointEdgeDistance(centre, edges) < radius - tol) return false;
	// A simple loop that runs once round the centre encloses the disc of radius - tol and lies inside the disc of
	// radius + tol, so its area falls between the two. The annulus test alone does not give this: a loop can keep to the
	// annulus and still cross itself, or run round the centre zero or two times.
	if (selfCrosses(points, true) || selfOverlaps(points, true)) return false;
	if (Math.abs(windingAround(points, centre)) !== 1) return false;
	const area = Math.abs(areaOf(points));
	if (area < Math.PI * (radius - tol) ** 2 || area > Math.PI * (radius + tol) ** 2) return false;
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
