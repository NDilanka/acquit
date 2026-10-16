// The witness coupon is a 24 x 24 x 4 mm tile with a 4 x 4 grid of 2 mm cells raised 2 mm on top. The
// sixteen cells are the bits of a per-job marker id drawn from the seed, so the coupon is reproducible
// from (jobId, seed) and differs between seeds.

import type { JobId } from "../../core/src/ids.ts";
import { seededDraw } from "./digest.ts";
import { vec3 } from "./types.ts";
import type { Box, Coupon } from "./types.ts";

const TILE = [24, 24, 4] as const;
const GRID = 4;
const CELL_MM = 2;
const RAISED_MM = 2;
const ORIGIN_MM = (TILE[0] - GRID * CELL_MM) / 2;
const MARKER_MAX = 0xffff;

export const COUPON_TILE_MM = TILE;
export const COUPON_GRID = GRID;
export const COUPON_CELL_MM = CELL_MM;
export const COUPON_RAISED_MM = RAISED_MM;

/** Centre of cell (row, col) in tile coordinates, in mm. The decoder samples the footprint here. */
export function couponCellCentreMm(row: number, col: number): readonly [number, number] {
	return [ORIGIN_MM + col * CELL_MM + CELL_MM / 2, ORIGIN_MM + row * CELL_MM + CELL_MM / 2];
}

export function coupon(jobId: JobId, seed: Uint8Array): Coupon {
	const markerId = 1 + seededDraw(seed, `coupon:${jobId}`)(MARKER_MAX);
	const markerCells: boolean[][] = [];
	const raisedCells: Box[] = [];
	for (let row = 0; row < GRID; row++) {
		const cells: boolean[] = [];
		for (let col = 0; col < GRID; col++) {
			const raised = ((markerId >> (row * GRID + col)) & 1) === 1;
			cells.push(raised);
			if (!raised) continue;
			const x = ORIGIN_MM + col * CELL_MM;
			const y = ORIGIN_MM + row * CELL_MM;
			raisedCells.push({
				min: vec3(x, y, TILE[2]),
				max: vec3(x + CELL_MM, y + CELL_MM, TILE[2] + RAISED_MM),
			});
		}
		markerCells.push(cells);
	}
	return { jobId, markerId, markerCells, tileMm: vec3(TILE[0], TILE[1], TILE[2]), raisedCells };
}
