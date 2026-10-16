// Mesh cross-sections from the contract's STL, through manifold-3d. The section a layer is checked
// against is cut from the same bytes whose digest the spec binds, so the seller cannot slice a different part.

import Module from "manifold-3d";
import { stlCorners } from "./stl.ts";
import type { Ring } from "./raster.ts";

type Wasm = Awaited<ReturnType<typeof Module>>;

let loaded: Promise<Wasm> | undefined;

function wasm(): Promise<Wasm> {
	loaded ??= Module().then(instance => {
		instance.setup();
		return instance;
	});
	return loaded;
}

/** Outer rings are positive and holes negative. Throws if the STL does not close into a solid. */
export async function sectionRings(stl: Uint8Array, zMm: number): Promise<Ring[]> {
	const corners = stlCorners(stl);
	if (!corners) throw new Error("section input is not an STL");
	const { Mesh, Manifold } = await wasm();
	const vertProperties = new Float32Array(corners.length * 3);
	corners.forEach((point, i) => vertProperties.set(point, i * 3));
	const mesh = new Mesh({ numProp: 3, vertProperties, triVerts: new Uint32Array(corners.length).map((_, i) => i) });
	mesh.merge();
	const solid = new Manifold(mesh);
	if (solid.status() !== "NoError") throw new Error(`mesh is not a solid: ${solid.status()}`);
	const section = solid.slice(zMm);
	const rings = section.toPolygons();
	section.delete();
	solid.delete();
	return rings;
}
