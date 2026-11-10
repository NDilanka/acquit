// Flat-earth geometry for a survey a few kilometres across. Pure maths, no I/O.

import type { Vec2 } from "./types.ts";

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Local metres east (x) and north (y) of the origin, equirectangular around the origin latitude. */
export function toLocal(origin: readonly [number, number], lat: number, lon: number): Vec2 {
	const x = (lon - origin[1]) * DEG * EARTH_RADIUS_M * Math.cos(origin[0] * DEG);
	const y = (lat - origin[0]) * DEG * EARTH_RADIUS_M;
	return [x, y];
}

/** The inverse of toLocal, so the generator and the checker share one projection. */
export function toLatLon(origin: readonly [number, number], x: number, y: number): [number, number] {
	const lat = origin[0] + y / (DEG * EARTH_RADIUS_M);
	const lon = origin[1] + x / (DEG * EARTH_RADIUS_M * Math.cos(origin[0] * DEG));
	return [lat, lon];
}

/** Ray-casting test. Points on the boundary may fall either way, so callers keep samples off edges. */
export function pointInPolygon(p: Vec2, polygon: readonly Vec2[]): boolean {
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

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
	const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	return Math.abs(value) < 1e-9 ? 0 : Math.sign(value);
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
	return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
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

export function centroid(points: readonly Vec2[]): Vec2 {
	let sx = 0;
	let sy = 0;
	for (const p of points) {
		sx += p[0];
		sy += p[1];
	}
	return [sx / points.length, sy / points.length];
}
