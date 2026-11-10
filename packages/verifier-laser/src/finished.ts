// The finished part the laser leaves, read from the drawn cut lines. The beam removes kerf: an outer cut is drawn
// kerf/2 outside its finished edge, and an inner cut is drawn kerf/2 inside its finished edge. So the finished part
// is the drawn outer shrunk by kerf/2, and each finished void is the drawn inner grown by kerf/2. Every rule reads
// geometry through this module, so the holes, cutouts, outer size, webs, engravings and hidden samples agree.

import { boundsOf, edgesOf, heightOf, pointEdgeDistance, pointInPolygon, segmentDistance, widthOf } from "./geometry.ts";
import type { Vec2 } from "./types.ts";

type Ring = { readonly points: readonly Vec2[]; readonly edges: readonly (readonly [Vec2, Vec2])[] };

/** A point this close to a finished edge counts as on it, so float noise never flips a boundary sample. */
const EDGE_EPS = 1e-6;

export type FinishedPart = {
	readonly kerfMm: number;
	/** Drawing x of the finished left edge. */
	readonly leftMm: number;
	/** Drawing y of the finished bottom edge. The drawing's y axis points down, so the bottom is the larger y. */
	readonly bottomMm: number;
	/** Finished size: the drawn outer size less one kerf in each axis. */
	readonly widthMm: number;
	readonly heightMm: number;
	readonly outer: Ring;
	readonly voids: readonly Ring[];
};

const ringOf = (points: readonly Vec2[]): Ring => ({ points, edges: edgesOf(points, true) });

/** The finished part for a drawn outer cut and the drawn inner cuts. Null when the outer cut has no points. */
export function finishedPart(outer: readonly Vec2[], inner: readonly (readonly Vec2[])[], kerfMm: number): FinishedPart | null {
	const box = boundsOf(outer);
	if (box === null) return null;
	const half = kerfMm / 2;
	return {
		kerfMm,
		leftMm: box.minX + half,
		bottomMm: box.maxY - half,
		widthMm: widthOf(box) - kerfMm,
		heightMm: heightOf(box) - kerfMm,
		outer: ringOf(outer),
		voids: inner.map(ringOf),
	};
}

/** Drawing point to the part frame: origin at the finished lower-left corner, y up, in mm. */
export const toPart = (part: FinishedPart, [x, y]: Vec2): Vec2 => [x - part.leftMm, part.bottomMm - y];

/** Part frame point back to the drawing. */
export const toDrawing = (part: FinishedPart, [px, py]: Vec2): Vec2 => [px + part.leftMm, part.bottomMm - py];

/** The finished size of an inner cut drawn at a given size: kerf widens each void by kerf/2 per side. */
export const finishedInnerSize = (part: FinishedPart, drawnMm: number): number => drawnMm + part.kerfMm;

function inVoid(ring: Ring, point: Vec2, half: number): boolean {
	if (pointInPolygon(point, ring.points)) return true;
	return pointEdgeDistance(point, ring.edges) <= half + EDGE_EPS;
}

/**
 * True when a drawn point is strictly inside the finished part: inside the drawn outer and more than kerf/2 from its
 * line, and not inside or on any finished void. A point on a finished edge is not kept, on either side, because the
 * machine's edge is not a reliable place to keep material.
 */
export function isMaterial(part: FinishedPart, point: Vec2): boolean {
	const half = part.kerfMm / 2;
	if (!pointInPolygon(point, part.outer.points)) return false;
	if (pointEdgeDistance(point, part.outer.edges) <= half + EDGE_EPS) return false;
	return !part.voids.some(ring => inVoid(ring, point, half));
}

/**
 * Distance from a material point to the nearest finished edge, outer or void. The finished edge lies kerf/2 from
 * each drawn line, so the drawn distance less kerf/2 is exact. Meaningful only for a point that isMaterial.
 */
export function clearanceOf(part: FinishedPart, point: Vec2): number {
	const half = part.kerfMm / 2;
	let nearest = pointEdgeDistance(point, part.outer.edges) - half;
	for (const ring of part.voids) nearest = Math.min(nearest, pointEdgeDistance(point, ring.edges) - half);
	return nearest;
}

/** True when a material point keeps at least clearanceMm from every finished edge. */
export function keepsClearance(part: FinishedPart, point: Vec2, clearanceMm: number): boolean {
	return isMaterial(part, point) && clearanceOf(part, point) >= clearanceMm - EDGE_EPS;
}

/**
 * True when a drawn point lies strictly inside a finished void: inside a drawn inner cut, or less than kerf/2 from its
 * line. A point on the finished boundary is not in the void, so it fails an expected-void probe.
 */
export function isVoidPoint(part: FinishedPart, point: Vec2): boolean {
	const half = part.kerfMm / 2;
	return part.voids.some(ring => pointInPolygon(point, ring.points) || pointEdgeDistance(point, ring.edges) < half - EDGE_EPS);
}

/**
 * True when the whole segment from a to b is finished material. Both ends must be material, and no outer or void edge
 * may come within kerf/2 of the segment. Then no point of the segment reaches a finished edge.
 */
export function isMaterialSegment(part: FinishedPart, a: Vec2, b: Vec2): boolean {
	const half = part.kerfMm / 2;
	if (!isMaterial(part, a) || !isMaterial(part, b)) return false;
	const rings = [part.outer, ...part.voids];
	return rings.every(ring => ring.edges.every(([c, d]) => segmentDistance(a, b, c, d) > half + EDGE_EPS));
}
