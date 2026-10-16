// The plate the seller slices: quantity copies of the contract part in a row, with the witness coupon
// beside them. It is one STL, fused with manifold, so the slicer sees one object and the coupon's raised
// cells are unioned into the tile instead of touching it.

import { Buffer } from "node:buffer";
import { COUPON_TILE_MM } from "./coupon.ts";
import type { Rect } from "./raster.ts";
import { kernel, solidOf } from "./section.ts";
import type { Solid } from "./section.ts";
import type { Box, Coupon } from "./types.ts";

export const PLATE_GAP_MM = 5;
/** Raised cells start this far inside the tile, so the union overlaps instead of meeting at one face. */
const FUSE_OVERLAP_MM = 0.1;

export type PlateLayout = {
	/** Min corner of each part copy, in plate coordinates. */
	readonly partOrigins: readonly (readonly [number, number])[];
	/** Min corner of the coupon tile, in plate coordinates. */
	readonly couponOrigin: readonly [number, number];
	/** The coupon tile's footprint in plate coordinates. */
	readonly couponRect: Rect;
};

export type Plate = { readonly stl: Uint8Array; readonly layout: PlateLayout };

export async function buildPlate(input: { partStl: Uint8Array; partBox: Box; coupon: Coupon; quantity: number }): Promise<Plate> {
	const { Manifold } = await kernel();
	const { partBox, coupon } = input;
	const pitch = partBox.max[0] - partBox.min[0] + PLATE_GAP_MM;
	const partOrigins = Array.from({ length: input.quantity }, (_, i): [number, number] => [i * pitch, 0]);
	const [tx, ty] = [input.quantity * pitch, 0];

	const part = await solidOf(input.partStl);
	const atOrigin = part.translate(-partBox.min[0], -partBox.min[1], -partBox.min[2]);
	part.delete();
	const pieces: Solid[] = partOrigins.map(([x, y]) => atOrigin.translate(x, y, 0));
	atOrigin.delete();

	pieces.push(Manifold.cube([COUPON_TILE_MM[0], COUPON_TILE_MM[1], COUPON_TILE_MM[2]]).translate(tx, ty, 0));
	for (const cell of coupon.raisedCells) {
		const size: [number, number, number] = [
			cell.max[0] - cell.min[0],
			cell.max[1] - cell.min[1],
			cell.max[2] - cell.min[2] + FUSE_OVERLAP_MM,
		];
		pieces.push(Manifold.cube(size).translate(cell.min[0] + tx, cell.min[1] + ty, cell.min[2] - FUSE_OVERLAP_MM));
	}

	const plate = Manifold.union(pieces);
	for (const piece of pieces) piece.delete();
	if (plate.status() !== "NoError") throw new Error(`plate is not a solid: ${plate.status()}`);
	const stl = toBinaryStl(plate);
	plate.delete();

	return {
		stl,
		layout: {
			partOrigins,
			couponOrigin: [tx, ty],
			couponRect: { minX: tx, minY: ty, maxX: tx + COUPON_TILE_MM[0], maxY: ty + COUPON_TILE_MM[1] },
		},
	};
}

/** Binary STL with zero normals. Readers recompute normals, and the checks here do not read them. */
export function toBinaryStl(solid: Solid): Uint8Array {
	const mesh = solid.getMesh();
	const count = mesh.triVerts.length / 3;
	const bytes = Buffer.alloc(84 + 50 * count);
	bytes.write("acquit print plate", 0, "latin1");
	bytes.writeUInt32LE(count, 80);
	for (let t = 0; t < count; t++) {
		for (let corner = 0; corner < 3; corner++) {
			const vertex = mesh.triVerts[3 * t + corner];
			for (let axis = 0; axis < 3; axis++) {
				bytes.writeFloatLE(mesh.vertProperties[vertex * mesh.numProp + axis], 84 + 50 * t + 12 + 12 * corner + 4 * axis);
			}
		}
	}
	return bytes;
}
