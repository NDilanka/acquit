// Test-only STL writers. Triangles are listed counter-clockwise seen from outside, so the signed volume is positive.

import { Buffer } from "node:buffer";

export type Point = readonly [number, number, number];
export type Triangle = readonly [Point, Point, Point];

export function cube(size: number): Triangle[] {
	const s = size;
	const v: Point[] = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
	const faces: [number, number, number][] = [
		[0, 3, 2], [0, 2, 1],
		[4, 5, 6], [4, 6, 7],
		[0, 1, 5], [0, 5, 4],
		[3, 7, 6], [3, 6, 2],
		[0, 4, 7], [0, 7, 3],
		[1, 2, 6], [1, 6, 5],
	];
	return faces.map(([a, b, c]) => [v[a], v[b], v[c]] as const);
}

export function toBinaryStl(triangles: readonly Triangle[]): Uint8Array {
	const buffer = Buffer.alloc(84 + 50 * triangles.length);
	buffer.write("binary fixture", 0, "latin1");
	buffer.writeUInt32LE(triangles.length, 80);
	triangles.forEach((triangle, t) => {
		triangle.forEach((point, corner) => {
			point.forEach((coordinate, axis) => {
				buffer.writeFloatLE(coordinate, 84 + t * 50 + 12 + corner * 12 + axis * 4);
			});
		});
	});
	return buffer;
}

export function toAsciiStl(triangles: readonly Triangle[]): Uint8Array {
	const facets = triangles.map(triangle => [
		"  facet normal 0 0 0",
		"    outer loop",
		...triangle.map(point => `      vertex ${point.join(" ")}`),
		"    endloop",
		"  endfacet",
	].join("\n"));
	return Buffer.from(`solid fixture\n${facets.join("\n")}\nendsolid fixture\n`, "latin1");
}
