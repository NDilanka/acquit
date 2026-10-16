import { Buffer } from "node:buffer";
import type { Digest } from "../../core/src/ids.ts";
import { sha256Hex } from "./digest.ts";
import { mm3, vec3 } from "./types.ts";
import type { Checked, MeshStats, PrintRejectReason } from "./types.ts";

type Point = readonly [number, number, number];

const BINARY_HEADER = 84;
const BINARY_TRIANGLE = 50;

function parseBinary(bytes: Buffer): Point[] | null {
	if (bytes.length < BINARY_HEADER) return null;
	const count = bytes.readUInt32LE(80);
	if (bytes.length !== BINARY_HEADER + count * BINARY_TRIANGLE) return null;
	const points: Point[] = [];
	for (let t = 0; t < count; t++) {
		for (let v = 0; v < 3; v++) {
			// Skip the 12-byte normal; readers recompute it, and the volume and watertight checks do not use it.
			const at = BINARY_HEADER + t * BINARY_TRIANGLE + 12 + v * 12;
			points.push([bytes.readFloatLE(at), bytes.readFloatLE(at + 4), bytes.readFloatLE(at + 8)]);
		}
	}
	return points;
}

function parseAscii(bytes: Buffer): Point[] | null {
	const text = bytes.toString("latin1");
	if (!/^\s*solid/.test(text)) return null;
	const points: Point[] = [];
	for (const match of text.matchAll(/^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)\s*$/gm)) {
		const point: Point = [Number(match[1]), Number(match[2]), Number(match[3])];
		if (!point.every(Number.isFinite)) return null;
		points.push(point);
	}
	return points.length > 0 && points.length % 3 === 0 ? points : null;
}

function cross(a: Point, b: Point): Point {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Point, b: Point): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Keys are micrometre integers, so two vertices that differ only by float noise share an edge.
function pointKey(p: Point): string {
	return p.map(value => Math.round(value * 1e6)).join(",");
}

function edgeKey(p: Point, q: Point): string {
	const [first, second] = [pointKey(p), pointKey(q)].sort();
	return `${first}|${second}`;
}

function refuse(message: string): Checked<MeshStats> {
	return { ok: false, errors: [{ path: "model", message }] };
}

export function meshStats(bytes: Uint8Array): Checked<MeshStats> {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const binary = parseBinary(buffer);
	const points = binary ?? parseAscii(buffer);
	if (!points) return refuse("STL is neither binary nor ASCII");
	if (points.length === 0) return refuse("STL has no triangles");
	const format: MeshStats["format"] = binary ? "binary" : "ascii";

	const lo = [Infinity, Infinity, Infinity];
	const hi = [-Infinity, -Infinity, -Infinity];
	const edges = new Map<string, number>();
	let volume = 0;
	for (let i = 0; i < points.length; i += 3) {
		const a = points[i];
		const b = points[i + 1];
		const c = points[i + 2];
		for (const p of [a, b, c]) {
			for (let axis = 0; axis < 3; axis++) {
				lo[axis] = Math.min(lo[axis], p[axis]);
				hi[axis] = Math.max(hi[axis], p[axis]);
			}
		}
		volume += dot(a, cross(b, c)) / 6;
		for (const [p, q] of [[a, b], [b, c], [c, a]]) {
			const key = edgeKey(p, q);
			edges.set(key, (edges.get(key) ?? 0) + 1);
		}
	}

	return {
		ok: true,
		value: {
			format,
			triangles: points.length / 3,
			bboxMm: { min: vec3(lo[0], lo[1], lo[2]), max: vec3(hi[0], hi[1], hi[2]) },
			sizeMm: vec3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]),
			volumeMm3: mm3(volume),
			watertight: [...edges.values()].every(count => count === 2),
			digest: sha256Hex(bytes) as Digest,
		},
	};
}

export function meshRejection(stats: MeshStats): PrintRejectReason | null {
	return stats.watertight ? null : { kind: "MESH_NOT_MANIFOLD" };
}
