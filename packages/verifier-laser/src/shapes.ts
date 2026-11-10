// Ideal shapes that drawn cuts are matched against, in mm. A fit is a two-way distance check sampled at a quarter
// of the tolerance: every drawn edge is sampled and each sample must lie within the tolerance of the ideal outline,
// and the ideal outline is sampled and each sample must lie within the tolerance of the drawn cut. The cut must
// also run once round the centre. A polygon whose chords stand off a true arc fails, and so does a contour that
// hugs the ideal outline inside the tolerance band but leaves a stretch of it uncut, like a stepped corner.
//
// Each fit reports the pair tests it may run, counted from the geometry before any distance is measured: grid
// cells touched, samples taken, candidate edges and the winding pass. The caller refuses the file when the fits
// would spend more than the work budget leaves, so a shape too large for the requested tolerance fails the parse
// rule instead of running unbounded.

import {
	areaOf,
	boundsOf,
	centreOf,
	edgesOf,
	heightOf,
	lengthOfEdges,
	pointEdgeDistance,
	pointEdgeDistanceAt,
	selfCrosses,
	selfOverlaps,
	widthOf,
	windingAround,
} from "./geometry.ts";
import type { Vec2 } from "./types.ts";

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

/** Whether a cut fits its ideal shape, and the pair tests the fit may run. */
export type FitResult = { readonly ok: boolean; readonly cost: number };

/** One distance test against the exact rounded-rectangle outline: four sides and four corner arcs. */
const OUTLINE_TESTS = 8;

/** Samples of a stretch of the given length, both ends included: one more than the steps needed at the spacing. */
const sampleCount = (length: number, spacing: number): number => Math.max(1, Math.ceil(length / spacing)) + 1;

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

/** The four sides and four corner arcs of the exact outline, clockwise in the y-down drawing: top-right first. */
type OutlinePieces = {
	readonly sides: readonly (readonly [Vec2, Vec2])[];
	readonly arcs: readonly (readonly [number, number, number])[];
	readonly radius: number;
};

function outlinePieces(centre: Vec2, halfWidth: number, halfHeight: number, radius: number): OutlinePieces {
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
	// Each corner's arc centre and start angle: top-right, bottom-right, bottom-left, top-left.
	const arcs: (readonly [number, number, number])[] =
		r > 0 ? [[right - r, top + r, -HALF_PI], [right - r, bottom - r, 0], [left + r, bottom - r, HALF_PI], [left + r, top + r, Math.PI]] : [];
	return { sides, arcs, radius: r };
}

/**
 * Exact distance from a point to the outline of a rounded rectangle: four straight sides and four quarter-circle
 * arcs. The radius is clamped to half the smaller side, and zero gives square corners.
 */
function outlineDistance(point: Vec2, centre: Vec2, halfWidth: number, halfHeight: number, radius: number): number {
	const pieces = outlinePieces(centre, halfWidth, halfHeight, radius);
	let best = pointEdgeDistance(point, pieces.sides);
	for (const [ox, oy, start] of pieces.arcs) best = Math.min(best, arcDistance(point, [ox, oy], pieces.radius, start));
	return best;
}

/** Calls visit on points of the segment from a to b, spaced at most spacing apart along it, ends included. */
function visitLineSamples(a: Vec2, b: Vec2, spacing: number, visit: (point: Vec2) => void): void {
	const steps = sampleCount(Math.hypot(b[0] - a[0], b[1] - a[1]), spacing) - 1;
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		visit([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
	}
}

/** Calls visit on points of the quarter-circle arc from the start angle, spaced at most spacing apart along it. */
function visitArcSamples(centre: Vec2, radius: number, start: number, spacing: number, visit: (point: Vec2) => void): void {
	const steps = sampleCount(HALF_PI * radius, spacing) - 1;
	for (let i = 0; i <= steps; i++) {
		const angle = start + (HALF_PI * i) / steps;
		visit([centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)]);
	}
}

/** Samples the exact outline needs at the spacing: each side and each corner arc, ends counted per piece. */
function outlineSampleCount(centre: Vec2, halfWidth: number, halfHeight: number, radius: number, spacing: number): number {
	const pieces = outlinePieces(centre, halfWidth, halfHeight, radius);
	let count = 0;
	for (const [a, b] of pieces.sides) count += sampleCount(Math.hypot(b[0] - a[0], b[1] - a[1]), spacing);
	return count + pieces.arcs.length * sampleCount(HALF_PI * pieces.radius, spacing);
}

/** Calls visit on samples of the exact outline, spaced at most spacing apart along it. */
function visitOutlineSamples(centre: Vec2, halfWidth: number, halfHeight: number, radius: number, spacing: number, visit: (point: Vec2) => void): void {
	const pieces = outlinePieces(centre, halfWidth, halfHeight, radius);
	for (const [a, b] of pieces.sides) visitLineSamples(a, b, spacing, visit);
	for (const [ox, oy, start] of pieces.arcs) visitArcSamples([ox, oy], pieces.radius, start, spacing, visit);
}

/**
 * Drawn edges bucketed by the grid cells their tolerance-wide neighbourhood touches, so an ideal sample only tests
 * the edges that can lie within tol of it: the edges in the cells the sample's own tolerance-wide box touches. The
 * cell side is at least the tolerance, so that box touches at most nine cells, and at least a 256th of the outline
 * box, so the grid has at most about 66,000 cells.
 */
type EdgeGrid = { readonly cell: number; readonly buckets: Map<number, readonly number[]> };

// Cell indices are offset by 2^25 each so keys stay non-negative integers. Beyond that range keys can collide, and
// a collision only ever adds candidate edges, never removes one.
const gridKey = (ix: number, iy: number): number => (ix + 33554432) * 67108864 + (iy + 33554432);

/** The grid cells one edge's tolerance-wide neighbourhood touches, counted without building them. */
function edgeCells([a, b]: readonly [Vec2, Vec2], tol: number, cell: number): number {
	const across = Math.floor((Math.max(a[0], b[0]) + tol) / cell) - Math.floor((Math.min(a[0], b[0]) - tol) / cell) + 1;
	const along = Math.floor((Math.max(a[1], b[1]) + tol) / cell) - Math.floor((Math.min(a[1], b[1]) - tol) / cell) + 1;
	return across * along;
}

function buildGrid(edges: readonly (readonly [Vec2, Vec2])[], tol: number, cell: number): EdgeGrid {
	const buckets = new Map<number, number[]>();
	edges.forEach(([a, b], index) => {
		const minX = Math.floor((Math.min(a[0], b[0]) - tol) / cell);
		const maxX = Math.floor((Math.max(a[0], b[0]) + tol) / cell);
		const minY = Math.floor((Math.min(a[1], b[1]) - tol) / cell);
		const maxY = Math.floor((Math.max(a[1], b[1]) + tol) / cell);
		for (let ix = minX; ix <= maxX; ix++) {
			for (let iy = minY; iy <= maxY; iy++) {
				const key = gridKey(ix, iy);
				const bucket = buckets.get(key);
				if (bucket === undefined) buckets.set(key, [index]);
				else bucket.push(index);
			}
		}
	});
	return { cell, buckets };
}

/** Calls visit on each bucket the point's tolerance-wide box touches. An edge may appear in more than one bucket. */
function visitBuckets(grid: EdgeGrid, point: Vec2, tol: number, visit: (bucket: readonly number[]) => void): void {
	const minX = Math.floor((point[0] - tol) / grid.cell);
	const maxX = Math.floor((point[0] + tol) / grid.cell);
	const minY = Math.floor((point[1] - tol) / grid.cell);
	const maxY = Math.floor((point[1] + tol) / grid.cell);
	for (let ix = minX; ix <= maxX; ix++) {
		for (let iy = minY; iy <= maxY; iy++) {
			const bucket = grid.buckets.get(gridKey(ix, iy));
			if (bucket !== undefined) visit(bucket);
		}
	}
}

/**
 * True when a closed cut is a rectangle with rounded corners of the given radius, at its own bounding box. The fit
 * is a two-way sampled distance check at a quarter of the tolerance: every drawn edge is sampled and each sample
 * must lie within tol of the exact outline, the exact outline (four sides and four quarter arcs) is sampled and
 * each sample must lie within tol of the drawn cut, and the cut must run once round the centre. A radius of zero
 * gives square corners. An open cut never fits. Every drawn or ideal point is within tol / 4 of a sample, so a
 * contour cannot hug the ideal outline inside the tolerance band while leaving a stretch of it uncut, and a stretch
 * more than about 1.25 tol off the ideal always fails. The pair tests the fit may run are counted from the geometry
 * before any distance is measured, and a fit that would overrun the budget reports its cost without running.
 */
export function fitsRoundedRect(points: readonly Vec2[], closed: boolean, radius: number, tol: number, budget: number): FitResult {
	if (!closed || points.length < 3 || !(tol > 0)) return { ok: false, cost: 0 };
	const box = boundsOf(points);
	if (box === null) return { ok: false, cost: 0 };
	const centre = centreOf(box);
	const halfWidth = widthOf(box) / 2;
	const halfHeight = heightOf(box) / 2;
	const edges = edgesOf(points, true);
	const spacing = tol / 4;
	let drawnSamples = 0;
	for (const [a, b] of edges) drawnSamples += sampleCount(Math.hypot(b[0] - a[0], b[1] - a[1]), spacing);
	const idealSamples = outlineSampleCount(centre, halfWidth, halfHeight, radius, spacing);
	const cell = Math.max(tol, lengthOfEdges(edges) / edges.length, (widthOf(box) + heightOf(box)) / 256);
	let insertions = 0;
	for (const edge of edges) insertions += edgeCells(edge, tol, cell);
	// Grid insertions, each drawn sample against the outline's pieces, each ideal sample, and the winding pass.
	let cost = insertions + drawnSamples * OUTLINE_TESTS + idealSamples + edges.length;
	if (cost > budget) return { ok: false, cost };
	const grid = buildGrid(edges, tol, cell);
	// The candidate edges the ideal samples will test, counted exactly before any distance is measured.
	let candidates = 0;
	visitOutlineSamples(centre, halfWidth, halfHeight, radius, spacing, point => {
		visitBuckets(grid, point, tol, bucket => {
			candidates += bucket.length;
		});
	});
	cost += candidates;
	if (cost > budget) return { ok: false, cost };
	let near = true;
	for (const [a, b] of edges) {
		visitLineSamples(a, b, spacing, point => {
			if (outlineDistance(point, centre, halfWidth, halfHeight, radius) > tol) near = false;
		});
	}
	if (!near) return { ok: false, cost };
	let covered = true;
	visitOutlineSamples(centre, halfWidth, halfHeight, radius, spacing, point => {
		let distance = Infinity;
		visitBuckets(grid, point, tol, bucket => {
			distance = Math.min(distance, pointEdgeDistanceAt(point, edges, bucket));
		});
		if (distance > tol) covered = false;
	});
	if (!covered) return { ok: false, cost };
	return { ok: Math.abs(windingAround(points, centre)) === 1, cost };
}

/**
 * True when a closed cut is a circle within tol, and the pair tests the check may run. Its box must be square
 * within tol, every vertex and every edge midpoint must lie within tol of the circle at the box's centre and size,
 * and no edge may come within radius - tol of the centre. The loop must not cross or double back on itself, must
 * run once round the centre, and must enclose an area the tolerance allows. No arc of the circle may be left uncut
 * for longer than 2 tol.
 *
 * Unlike the rectangle, the circle's two-way check is exact without sampling. Distance from the centre is convex
 * along each straight edge, so an edge's furthest point from the circle is an end and its nearest point is caught
 * by the centre test. And a loop that runs once round the centre while every point of it lies within tol of the
 * circle crosses every direction from the centre inside that band, so every point of the circle lies within tol of
 * the loop; roundIsCovered keeps an explicit guard on top. A polygon with the right vertices but straight sides
 * fails, and so do a loop that runs round only part of a circle and a C-shaped loop whose two arcs lie within tol
 * of the circle.
 */
export function isRoundCut(points: readonly Vec2[], closed: boolean, tol: number, budget: number): FitResult {
	if (!closed || points.length < 3 || !(tol > 0)) return { ok: false, cost: 0 };
	const box = boundsOf(points);
	if (box === null) return { ok: false, cost: 0 };
	const edges = edgesOf(points, true);
	// The crossing and overlap tests cost about the square of the edge count; the rest are passes over the edges.
	const cost = 2 * edges.length * edges.length + 8 * edges.length;
	if (cost > budget) return { ok: false, cost };
	const width = widthOf(box);
	const height = heightOf(box);
	if (Math.abs(width - height) > tol) return { ok: false, cost };
	const radius = (width + height) / 4;
	// The direction test needs the centre clear of the cut, so a circle no wider than its tolerance is refused.
	if (radius <= tol) return { ok: false, cost };
	const centre = centreOf(box);
	const onCircle = (point: Vec2): boolean => Math.abs(Math.hypot(point[0] - centre[0], point[1] - centre[1]) - radius) <= tol;
	if (!points.every(onCircle)) return { ok: false, cost };
	if (!edges.every(([a, b]) => onCircle([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]))) return { ok: false, cost };
	if (pointEdgeDistance(centre, edges) < radius - tol) return { ok: false, cost };
	// A simple loop that runs once round the centre encloses the disc of radius - tol and lies inside the disc of
	// radius + tol, so its area falls between the two. The annulus test alone does not give this: a loop can keep to
	// the annulus and still cross itself, or run round the centre zero or two times.
	if (selfCrosses(points, true) || selfOverlaps(points, true)) return { ok: false, cost };
	if (Math.abs(windingAround(points, centre)) !== 1) return { ok: false, cost };
	const area = Math.abs(areaOf(points));
	if (area < Math.PI * (radius - tol) ** 2 || area > Math.PI * (radius + tol) ** 2) return { ok: false, cost };
	return { ok: roundIsCovered(edges, centre, radius, tol), cost };
}

/**
 * True when the edges leave no arc of the circle uncovered for more than 2 tol. Each edge lies within tol of the
 * circle, so it covers every direction from the centre that it spans, and every point on those directions is within
 * tol of it.
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
