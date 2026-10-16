// Mesh cross-sections from the contract's STL, through manifold-3d. The section a layer is checked
// against is cut from the same bytes whose digest the spec binds, so the seller cannot slice a different part.

import Module from "manifold-3d";
import { stlCorners } from "./stl.ts";
import type { Ring } from "./raster.ts";

type Wasm = Awaited<ReturnType<typeof Module>>;
export type Solid = InstanceType<Wasm["Manifold"]>;

let loaded: Promise<Wasm> | undefined;

export function kernel(): Promise<Wasm> {
	loaded ??= Module().then(instance => {
		instance.setup();
		return instance;
	});
	return loaded;
}

/** The STL as a closed solid. The caller deletes it. Throws if the bytes are not an STL or do not close. */
export async function solidOf(stl: Uint8Array): Promise<Solid> {
	const corners = stlCorners(stl);
	if (!corners) throw new Error("section input is not an STL");
	const { Mesh, Manifold } = await kernel();
	const vertProperties = new Float32Array(corners.length * 3);
	corners.forEach((point, i) => vertProperties.set(point, i * 3));
	const mesh = new Mesh({ numProp: 3, vertProperties, triVerts: new Uint32Array(corners.length).map((_, i) => i) });
	mesh.merge();
	const solid = new Manifold(mesh);
	if (solid.status() !== "NoError") throw new Error(`mesh is not a solid: ${solid.status()}`);
	return solid;
}

/** Outer rings are positive and holes negative. */
export async function sectionRings(stl: Uint8Array, zMm: number): Promise<Ring[]> {
	const solid = await solidOf(stl);
	const section = solid.slice(zMm);
	const rings = section.toPolygons();
	section.delete();
	solid.delete();
	return rings;
}

/** The same section pulled inward by insetMm. The infill expectation is taken over this interior. */
export async function interiorRings(stl: Uint8Array, zMm: number, insetMm: number): Promise<Ring[]> {
	const solid = await solidOf(stl);
	const section = solid.slice(zMm);
	const inner = section.offset(-insetMm, "Round");
	const rings = inner.toPolygons();
	inner.delete();
	section.delete();
	solid.delete();
	return rings;
}
