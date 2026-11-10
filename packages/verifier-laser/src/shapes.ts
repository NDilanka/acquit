// Ideal shapes that drawn cuts are matched against, in mm. A cut fits a shape when every drawn vertex lies on the
// shape's outline and every sample of that outline lies on the cut, each within a tolerance. Bounding boxes are not
// enough: a diamond, a triangle or a chamfered corner has the right box and fails here.

import { boundsOf, centreOf, edgesOf, heightOf, pointEdgeDistance, widthOf } from "./geometry.ts";
import type { Vec2 } from "./types.ts";

/** Sides of the polygon that stands in for a circle. Its chord error is far below any tolerance the spec allows. */
const CIRCLE_SIDES = 64;
/** Segments per quarter of a rounded corner. */
const ARC_STEPS = 16;
/** Segments along each straight side, so a cut cannot hide a bulge between two samples. */
const SIDE_STEPS = 4;

/** The most points any ideal ring has. Used to bound the work a shape test can cost. */
export const RING_POINTS_MAX = Math.max(CIRCLE_SIDES, 4 * (ARC_STEPS + 1) + 4 * (SIDE_STEPS - 1));

/**
 * The least fit tolerance, in mm. Curves are flattened to 0.02 mm and an ideal polygon adds under 0.01 mm of chord
 * error, so a tolerance below this would reject honest curves.
 */
const FIT_FLOOR_MM = 0.05;

/** The tolerance a shape fit uses for a spec tolerance: the spec's own, but never under the floor. */
export const fitTolerance = (toleranceMm: number): number => Math.max(toleranceMm, FIT_FLOOR_MM);

/** A circle as a polygon, starting at angle zero and running counter-clockwise in the drawing's frame. */
export function circleRing(centre: Vec2, radius: number): Vec2[] {
	const ring: Vec2[] = [];
	for (let i = 0; i < CIRCLE_SIDES; i++) {
		const angle = (2 * Math.PI * i) / CIRCLE_SIDES;
		ring.push([centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)]);
	}
	return ring;
}

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

/** True when a closed cut is a circle: its box is square within tol and every vertex lies on that circle. */
export function isRoundCut(points: readonly Vec2[], closed: boolean, tol: number): boolean {
	const box = boundsOf(points);
	if (box === null) return false;
	const width = widthOf(box);
	const height = heightOf(box);
	if (Math.abs(width - height) > tol) return false;
	return fitsRing(points, closed, circleRing(centreOf(box), (width + height) / 4), tol);
}
