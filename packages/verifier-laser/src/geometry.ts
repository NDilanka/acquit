// Plane geometry on flattened paths, in mm. Pure numbers, no tolerance is applied here; the rules decide that.

import type { Vec2 } from "./types.ts";

export type Bounds = { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };

export function boundsOf(points: readonly Vec2[]): Bounds | null {
	if (points.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

export const widthOf = (box: Bounds): number => box.maxX - box.minX;
export const heightOf = (box: Bounds): number => box.maxY - box.minY;
export const centreOf = (box: Bounds): Vec2 => [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];

/** Edges of a path. A closed path adds the edge back to its first point. */
export function edgesOf(points: readonly Vec2[], closed: boolean): readonly (readonly [Vec2, Vec2])[] {
	const edges: (readonly [Vec2, Vec2])[] = [];
	for (let i = 0; i + 1 < points.length; i++) edges.push([points[i]!, points[i + 1]!]);
	if (closed && points.length > 2) edges.push([points[points.length - 1]!, points[0]!]);
	return edges;
}

/** Even-odd crossing test. The polygon closes itself. Points exactly on an edge may fall either side. */
export function pointInPolygon(point: Vec2, points: readonly Vec2[]): boolean {
	const [px, py] = point;
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const [xi, yi] = points[i]!;
		const [xj, yj] = points[j]!;
		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
	return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lengthSq = dx * dx + dy * dy;
	const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Shortest distance between two segments. Zero when they cross. */
export function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
	const d1 = orientation(c, d, a);
	const d2 = orientation(c, d, b);
	const d3 = orientation(a, b, c);
	const d4 = orientation(a, b, d);
	if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
	return Math.min(pointToSegment(a, c, d), pointToSegment(b, c, d), pointToSegment(c, a, b), pointToSegment(d, a, b));
}

/** Shortest distance between two edge lists. Infinity when either list is empty. */
export function edgeListDistance(first: readonly (readonly [Vec2, Vec2])[], second: readonly (readonly [Vec2, Vec2])[]): number {
	let best = Infinity;
	for (const [a, b] of first) {
		for (const [c, d] of second) {
			const distance = segmentDistance(a, b, c, d);
			if (distance < best) best = distance;
		}
	}
	return best;
}

/** Shortest distance from a point to a list of edges. Infinity when the list is empty. */
export function pointEdgeDistance(point: Vec2, edges: readonly (readonly [Vec2, Vec2])[]): number {
	let best = Infinity;
	for (const [a, b] of edges) {
		const distance = pointToSegment(point, a, b);
		if (distance < best) best = distance;
	}
	return best;
}

/** Orientation noise below this, in mm squared, counts as collinear. */
const TOUCH_EPS = 1e-9;

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
	return (
		Math.min(a[0], b[0]) - TOUCH_EPS <= p[0] &&
		p[0] <= Math.max(a[0], b[0]) + TOUCH_EPS &&
		Math.min(a[1], b[1]) - TOUCH_EPS <= p[1] &&
		p[1] <= Math.max(a[1], b[1]) + TOUCH_EPS
	);
}

/** True when segments ab and cd share any point, touching at an end included. */
export function segmentsTouch(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
	const d1 = orientation(c, d, a);
	const d2 = orientation(c, d, b);
	const d3 = orientation(a, b, c);
	const d4 = orientation(a, b, d);
	const straddles = (x: number, y: number): boolean => (x > TOUCH_EPS && y < -TOUCH_EPS) || (x < -TOUCH_EPS && y > TOUCH_EPS);
	if (straddles(d1, d2) && straddles(d3, d4)) return true;
	if (Math.abs(d1) <= TOUCH_EPS && onSegment(c, d, a)) return true;
	if (Math.abs(d2) <= TOUCH_EPS && onSegment(c, d, b)) return true;
	if (Math.abs(d3) <= TOUCH_EPS && onSegment(a, b, c)) return true;
	return Math.abs(d4) <= TOUCH_EPS && onSegment(a, b, d);
}

/**
 * True when two edges that do not share a vertex meet. Edges that share a vertex are skipped, so a corner is
 * never a crossing; a closed path's last and first edges share its start point.
 */
export function selfCrosses(points: readonly Vec2[], closed: boolean): boolean {
	const edges = edgesOf(points, closed);
	for (let i = 0; i < edges.length; i++) {
		for (let j = i + 2; j < edges.length; j++) {
			if (closed && i === 0 && j === edges.length - 1) continue;
			const [a, b] = edges[i]!;
			const [c, d] = edges[j]!;
			if (segmentsTouch(a, b, c, d)) return true;
		}
	}
	return false;
}

/**
 * A key that ignores start point, direction and rounding noise, so a path cut twice is found whatever its
 * starting corner. Two paths with the same key draw the same shape.
 */
export function shapeKey(points: readonly Vec2[]): string {
	const keys = points.map(([x, y]) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`);
	return keys.sort().join(";");
}

export const roundMm = (value: number): number => Math.round(value * 1000) / 1000;
