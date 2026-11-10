// Plane geometry in millimetres. Distances return 0 when shapes touch or overlap.

import type { Vec2 } from "./types.ts";

/** Rotates a point about the origin. KiCad angles are counter-clockwise on screen, and the y axis points down. */
export function rotate(p: Vec2, degrees: number): Vec2 {
	const t = (degrees * Math.PI) / 180;
	const c = Math.cos(t);
	const s = Math.sin(t);
	return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
}

export function add(a: Vec2, b: Vec2): Vec2 {
	return [a[0] + b[0], a[1] + b[1]];
}

export function dist(a: Vec2, b: Vec2): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	if (len2 === 0) return dist(p, a);
	let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
	return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
	return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

export function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
	const d1 = orient(b1, b2, a1);
	const d2 = orient(b1, b2, a2);
	const d3 = orient(a1, a2, b1);
	const d4 = orient(a1, a2, b2);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
	if (d1 === 0 && onSegment(b1, b2, a1)) return true;
	if (d2 === 0 && onSegment(b1, b2, a2)) return true;
	if (d3 === 0 && onSegment(a1, a2, b1)) return true;
	if (d4 === 0 && onSegment(a1, a2, b2)) return true;
	return false;
}

export function segmentSegmentDistance(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
	if (segmentsIntersect(a1, a2, b1, b2)) return 0;
	return Math.min(
		pointSegmentDistance(a1, b1, b2),
		pointSegmentDistance(a2, b1, b2),
		pointSegmentDistance(b1, a1, a2),
		pointSegmentDistance(b2, a1, a2),
	);
}

/** Ray-casting test. Points on the boundary may land either way; callers never rely on that. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i] as Vec2;
		const b = poly[j] as Vec2;
		if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
			inside = !inside;
		}
	}
	return inside;
}

/** Distance between a segment and a closed polygon. */
export function segmentPolygonDistance(a: Vec2, b: Vec2, poly: readonly Vec2[]): number {
	if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return 0;
	let best = Infinity;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i] as Vec2;
		const q = poly[(i + 1) % poly.length] as Vec2;
		best = Math.min(best, segmentSegmentDistance(a, b, p, q));
		if (best === 0) return 0;
	}
	return best;
}

/** Distance between two closed polygons. */
export function polygonDistance(A: readonly Vec2[], B: readonly Vec2[]): number {
	if (pointInPolygon(A[0] as Vec2, B) || pointInPolygon(B[0] as Vec2, A)) return 0;
	let best = Infinity;
	for (let i = 0; i < A.length; i++) {
		const p = A[i] as Vec2;
		const q = A[(i + 1) % A.length] as Vec2;
		best = Math.min(best, segmentPolygonDistance(p, q, B));
		if (best === 0) return 0;
	}
	return best;
}

/** Sides of the polygon that stands in for a circle. Its vertices lie on the circle, so it lies inside it. */
const CIRCLE_SIDES = 64;
/** Straight pieces in each half-turn of an oval's cap. The cap vertices lie on the cap's circle. */
const OVAL_STEPS = 16;

/**
 * Two copper items whose gap is at or below this are touching. It is float roundoff. A KiCad file states positions
 * to 1e-6 mm, so every positive gap it can express is far above this.
 */
export const ROUNDOFF = 1e-9;

/** The area enclosed by a closed polygon, mm squared. Zero for a polygon with no area. */
export function shoelaceArea(poly: readonly Vec2[]): number {
	let s = 0;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i] as Vec2;
		const q = poly[(i + 1) % poly.length] as Vec2;
		s += p[0] * q[1] - q[0] * p[1];
	}
	return Math.abs(s) / 2;
}

/** The largest distance between a circle of radius r and its polygon. The polygon lies inside the circle. */
export function circleError(r: number): number {
	return r * (1 - Math.cos(Math.PI / CIRCLE_SIDES));
}

/** The largest distance between an oval's outline and its polygon. The straight sides are exact; the caps are not. */
export function ovalError(size: Vec2): number {
	return (Math.min(size[0], size[1]) / 2) * (1 - Math.cos(Math.PI / (2 * OVAL_STEPS)));
}

/** A circle as a CIRCLE_SIDES-sided polygon. circleError gives how far it can fall short of the true circle. */
export function circlePolygon(c: Vec2, r: number): Vec2[] {
	const out: Vec2[] = [];
	for (let i = 0; i < CIRCLE_SIDES; i++) {
		const t = (2 * Math.PI * i) / CIRCLE_SIDES;
		out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
	}
	return out;
}

/** A rectangle of the given size centred at c, turned by degrees. */
export function rectPolygon(c: Vec2, size: Vec2, degrees: number): Vec2[] {
	const hx = size[0] / 2;
	const hy = size[1] / 2;
	const corners: Vec2[] = [
		[-hx, -hy],
		[hx, -hy],
		[hx, hy],
		[-hx, hy],
	];
	return corners.map(p => add(c, rotate(p, degrees)));
}

/**
 * A stadium (capsule) of the given size. It is built horizontally, long side on x, and a pad taller than it is wide
 * has that capsule turned 90 degrees first, so the long side follows the pad's longer size. Then the pad's
 * orientation is applied to the whole capsule.
 */
export function ovalPolygon(c: Vec2, size: Vec2, degrees: number): Vec2[] {
	const tall = size[1] > size[0];
	const r = Math.min(size[0], size[1]) / 2;
	const half = Math.max(size[0], size[1]) / 2 - r;
	const place = (p: Vec2): Vec2 => add(c, rotate(tall ? rotate(p, 90) : p, degrees));
	const out: Vec2[] = [];
	// Arc around the +x end, then around the -x end.
	for (let i = 0; i <= OVAL_STEPS; i++) {
		const t = -Math.PI / 2 + (Math.PI * i) / OVAL_STEPS;
		out.push(place([half + r * Math.cos(t), r * Math.sin(t)]));
	}
	for (let i = 0; i <= OVAL_STEPS; i++) {
		const t = Math.PI / 2 + (Math.PI * i) / OVAL_STEPS;
		out.push(place([-half + r * Math.cos(t), r * Math.sin(t)]));
	}
	return out;
}

/** How an arc flattens: its circle, start angle, signed sweep, and the number of straight pieces it needs. */
export type ArcPlan =
	| {
			readonly ok: true;
			readonly cx: number;
			readonly cy: number;
			readonly r: number;
			readonly a0: number;
			readonly sweep: number;
			readonly pieces: number;
	  }
	| { readonly ok: false; readonly reason: "degenerate" | "too-many-pieces" };

/**
 * Plans the flattening of a circular arc through start, mid and end, with chord error at most maxError. It
 * allocates nothing, so a caller can add up the pieces of every arc before any point is built. A near-straight arc
 * whose chord-error step rounds to zero needs unbounded pieces and reports too-many-pieces, as does any count above
 * maxPieces.
 */
export function planArc(start: Vec2, mid: Vec2, end: Vec2, maxError: number, maxPieces: number): ArcPlan {
	const d = 2 * (start[0] * (mid[1] - end[1]) + mid[0] * (end[1] - start[1]) + end[0] * (start[1] - mid[1]));
	if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return { ok: false, reason: "degenerate" }; // collinear: no finite circle
	const s2 = start[0] ** 2 + start[1] ** 2;
	const m2 = mid[0] ** 2 + mid[1] ** 2;
	const e2 = end[0] ** 2 + end[1] ** 2;
	const cx = (s2 * (mid[1] - end[1]) + m2 * (end[1] - start[1]) + e2 * (start[1] - mid[1])) / d;
	const cy = (s2 * (end[0] - mid[0]) + m2 * (start[0] - end[0]) + e2 * (mid[0] - start[0])) / d;
	const r = Math.hypot(start[0] - cx, start[1] - cy);
	if (!Number.isFinite(r) || r <= 0) return { ok: false, reason: "degenerate" };
	const a0 = Math.atan2(start[1] - cy, start[0] - cx);
	const am = Math.atan2(mid[1] - cy, mid[0] - cx);
	const a1 = Math.atan2(end[1] - cy, end[0] - cx);
	// Sweep from a0 to a1 in the direction that passes through the mid point.
	const twoPi = 2 * Math.PI;
	const norm = (x: number): number => ((x % twoPi) + twoPi) % twoPi;
	const ccw = norm(am - a0) < norm(a1 - a0);
	const sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1);
	const step = 2 * Math.acos(Math.max(-1, 1 - maxError / r));
	const raw = Math.abs(sweep) / step; // Infinity when the step rounds to zero
	if (!(raw <= maxPieces)) return { ok: false, reason: "too-many-pieces" };
	return { ok: true, cx, cy, r, a0, sweep, pieces: Math.max(1, Math.ceil(raw)) };
}

/** Flattens an arc planned by planArc into points. The end points are exact, not recomputed. */
export function arcPoints(start: Vec2, end: Vec2, plan: Extract<ArcPlan, { ok: true }>): Vec2[] {
	const { cx, cy, r, a0, sweep, pieces: n } = plan;
	const out: Vec2[] = [];
	for (let i = 0; i <= n; i++) {
		const t = a0 + (sweep * i) / n;
		out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
	}
	out[0] = start;
	out[n] = end;
	return out;
}
