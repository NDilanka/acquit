// Flat-earth geometry for a survey a few kilometres across. Pure maths, no I/O.

import type { Vec2 } from "./types.ts";

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Brings a longitude into [-180, 180]. An in-range value is returned unchanged. */
function wrapLongitude(lon: number): number {
	if (lon >= -180 && lon <= 180) return lon;
	return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Local metres east (x) and north (y) of the origin, equirectangular around the origin latitude. The longitude
 * difference is wrapped first, so a point across the antimeridian is measured the short way round.
 */
export function toLocal(origin: readonly [number, number], lat: number, lon: number): Vec2 {
	const x = wrapLongitude(lon - origin[1]) * DEG * EARTH_RADIUS_M * Math.cos(origin[0] * DEG);
	const y = (lat - origin[0]) * DEG * EARTH_RADIUS_M;
	return [x, y];
}

/** The inverse of toLocal, so the generator and the checker share one projection. Longitudes come back in [-180, 180]. */
export function toLatLon(origin: readonly [number, number], x: number, y: number): [number, number] {
	const lat = origin[0] + y / (DEG * EARTH_RADIUS_M);
	const lon = wrapLongitude(origin[1] + x / (DEG * EARTH_RADIUS_M * Math.cos(origin[0] * DEG)));
	return [lat, lon];
}

/** True when a local point is finite and lies within `limitM` metres of the origin on both axes. */
export function withinLocal(p: Vec2, limitM: number): boolean {
	return Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= limitM && Math.abs(p[1]) <= limitM;
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
	const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	return Math.abs(value) < 1e-9 ? 0 : Math.sign(value);
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
	return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

/** True when p lies on an edge or at a corner of the polygon. */
function onBoundary(p: Vec2, polygon: readonly Vec2[]): boolean {
	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i]!;
		const b = polygon[(i + 1) % polygon.length]!;
		if (orientation(a, b, p) === 0 && onSegment(a, b, p)) return true;
	}
	return false;
}

/**
 * Whether a point is inside the polygon. The boundary is inside: an edge or corner counts, whichever way the polygon
 * is wound. Other points use a ray cast.
 */
export function pointInPolygon(p: Vec2, polygon: readonly Vec2[]): boolean {
	if (onBoundary(p, polygon)) return true;
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i]!;
		const b = polygon[j]!;
		if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
			inside = !inside;
		}
	}
	return inside;
}

/** True when segments ab and cd touch or cross. */
export function segmentsTouch(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
	const o1 = orientation(a, b, c);
	const o2 = orientation(a, b, d);
	const o3 = orientation(c, d, a);
	const o4 = orientation(c, d, b);
	if (o1 !== o2 && o3 !== o4) return true;
	if (o1 === 0 && onSegment(a, b, c)) return true;
	if (o2 === 0 && onSegment(a, b, d)) return true;
	if (o3 === 0 && onSegment(c, d, a)) return true;
	if (o4 === 0 && onSegment(c, d, b)) return true;
	return false;
}

/** True when the segment enters the polygon: an end inside, or any crossing of an edge. */
export function segmentHitsPolygon(a: Vec2, b: Vec2, polygon: readonly Vec2[]): boolean {
	if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return true;
	for (let i = 0; i < polygon.length; i++) {
		const edgeEnd = polygon[(i + 1) % polygon.length]!;
		if (segmentsTouch(a, b, polygon[i]!, edgeEnd)) return true;
	}
	return false;
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const raw = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
	const t = Math.min(1, Math.max(0, raw));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** The distance from a point to the nearest edge of the polygon. */
function boundaryDistance(p: Vec2, polygon: readonly Vec2[]): number {
	let best = Infinity;
	for (let i = 0; i < polygon.length; i++) {
		best = Math.min(best, pointSegmentDistance(p, polygon[i]!, polygon[(i + 1) % polygon.length]!));
	}
	return best;
}

/**
 * The shortest distance from the segment ab to the polygon, interior included. It is 0 when the segment touches or
 * enters the polygon, including a grazed corner or a segment running along an edge.
 */
export function segmentDistanceToPolygon(a: Vec2, b: Vec2, polygon: readonly Vec2[]): number {
	if (segmentHitsPolygon(a, b, polygon)) return 0;
	let best = Infinity;
	for (let i = 0; i < polygon.length; i++) {
		const c = polygon[i]!;
		const d = polygon[(i + 1) % polygon.length]!;
		best = Math.min(
			best,
			pointSegmentDistance(a, c, d),
			pointSegmentDistance(b, c, d),
			pointSegmentDistance(c, a, b),
			pointSegmentDistance(d, a, b),
		);
	}
	return best;
}

/**
 * Whether the whole segment ab lies inside the polygon, boundary included, to within tol metres. The segment is cut
 * at every point where it meets the boundary, and each piece is tested at its midpoint, so a notch between the two
 * ends of a concave polygon is seen.
 */
export function segmentInsidePolygon(a: Vec2, b: Vec2, polygon: readonly Vec2[], tol: number): boolean {
	const inside = (p: Vec2): boolean => pointInPolygon(p, polygon) || boundaryDistance(p, polygon) <= tol;
	if (!inside(a) || !inside(b)) return false;
	const rx = b[0] - a[0];
	const ry = b[1] - a[1];
	const len2 = rx * rx + ry * ry;
	if (len2 === 0) return true;
	const cuts = [0, 1];
	for (let i = 0; i < polygon.length; i++) {
		const c = polygon[i]!;
		const d = polygon[(i + 1) % polygon.length]!;
		const sx = d[0] - c[0];
		const sy = d[1] - c[1];
		const qx = c[0] - a[0];
		const qy = c[1] - a[1];
		const denom = rx * sy - ry * sx;
		if (Math.abs(denom) > 1e-12 * Math.sqrt(len2) * Math.hypot(sx, sy)) {
			const t = (qx * sy - qy * sx) / denom;
			const u = (qx * ry - qy * rx) / denom;
			if (t >= 0 && t <= 1 && u >= 0 && u <= 1) cuts.push(t);
		}
		// Collinear or nearly collinear edge ends: their projections bound any overlap with the segment.
		for (const p of [c, d]) {
			if (Math.abs(rx * (p[1] - a[1]) - ry * (p[0] - a[0])) / Math.sqrt(len2) <= tol) {
				const t = ((p[0] - a[0]) * rx + (p[1] - a[1]) * ry) / len2;
				if (t > 0 && t < 1) cuts.push(t);
			}
		}
	}
	cuts.sort((x, y) => x - y);
	for (let i = 0; i + 1 < cuts.length; i++) {
		const t0 = cuts[i]!;
		const t1 = cuts[i + 1]!;
		if (t1 - t0 <= 1e-12) continue;
		const tm = (t0 + t1) / 2;
		if (!inside([a[0] + tm * rx, a[1] + tm * ry])) return false;
	}
	return true;
}

/**
 * A survey heading: a unit vector (ux, uy) in local metres. The across axis is (-uy, ux), a quarter turn anticlockwise.
 * Survey legs and their footprints are measured in this frame, so a survey flown at any heading is checked the same way.
 */
export type Frame = { readonly ux: number; readonly uy: number };

/** The frame whose along axis runs from a towards b, or null when the two points coincide. */
export function frameFrom(a: Vec2, b: Vec2): Frame | null {
	const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
	if (!(length > 0) || !Number.isFinite(length)) return null;
	return { ux: (b[0] - a[0]) / length, uy: (b[1] - a[1]) / length };
}

/** The along-heading position s and the across-heading position t of a local point. */
export function toFrame(frame: Frame, p: Vec2): [number, number] {
	return [p[0] * frame.ux + p[1] * frame.uy, -p[0] * frame.uy + p[1] * frame.ux];
}

/** The local point at along-heading position s and across-heading position t. The inverse of toFrame. */
export function fromFrame(frame: Frame, s: number, t: number): Vec2 {
	return [s * frame.ux - t * frame.uy, s * frame.uy + t * frame.ux];
}
