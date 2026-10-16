// The witness coupon on the plate. Its footprint must match the design at a tile layer and at a cell layer,
// and the sixteen cell positions at the cell layer decode to the frozen marker id.

import { COUPON_GRID, COUPON_TILE_MM, couponCellCentreMm } from "./coupon.ts";
import { footprintOf, layerIndexAt, partMovesByLayer } from "./conform.ts";
import type { Placement } from "./conform.ts";
import { CELL_MM, fillRings, gridOver, iou, rectRing } from "./raster.ts";
import type { Rect } from "./raster.ts";
import type { Coupon, ParsedGcode, PrintRejectReason } from "./types.ts";

export const COUPON_IOU_MIN = 0.95;
/** Heights on the contract grid. The tile is 4 mm tall, so 2 mm is inside it, and 5 mm is inside the raised cells. */
const TILE_Z_MM = 2;
const CELL_Z_MM = 5;
const MARGIN_MM = 2;

export type CouponCheck = {
	readonly reasons: readonly PrintRejectReason[];
	readonly measured: { readonly tileIou: number; readonly cellIou: number; readonly decoded: number | null };
};

export function checkCoupon(input: {
	readonly gcode: ParsedGcode;
	readonly layerHeightMm: number;
	readonly coupon: Coupon;
	/** The tile's min corner in plate coordinates. */
	readonly origin: readonly [number, number];
	readonly placement: Placement;
}): CouponCheck {
	const { gcode, coupon, origin, placement } = input;
	const tileIndex = layerIndexAt(gcode, Math.round(TILE_Z_MM / input.layerHeightMm) * input.layerHeightMm);
	const cellIndex = layerIndexAt(gcode, Math.round(CELL_Z_MM / input.layerHeightMm) * input.layerHeightMm);
	if (tileIndex < 0 || cellIndex < 0) {
		return { reasons: [{ kind: "COUPON_MISSING" }], measured: { tileIou: 0, cellIou: 0, decoded: null } };
	}

	const rect: Rect = {
		minX: origin[0],
		minY: origin[1],
		maxX: origin[0] + COUPON_TILE_MM[0],
		maxY: origin[1] + COUPON_TILE_MM[1],
	};
	const byLayer = partMovesByLayer(gcode);

	const tileRef = gridOver(rect, MARGIN_MM);
	fillRings(tileRef, [rectRing(rect)]);
	const tileIou = iou(footprintOf(byLayer.get(tileIndex) ?? [], placement.dx, placement.dy, rect), tileRef);

	const raised = coupon.raisedCells.map((cell): Rect => ({
		minX: origin[0] + cell.min[0],
		minY: origin[1] + cell.min[1],
		maxX: origin[0] + cell.max[0],
		maxY: origin[1] + cell.max[1],
	}));
	const cellRef = gridOver(rect, MARGIN_MM);
	fillRings(cellRef, raised.map(rectRing));
	const cellFootprint = footprintOf(byLayer.get(cellIndex) ?? [], placement.dx, placement.dy, rect);
	const cellIou = iou(cellFootprint, cellRef);

	let decoded = 0;
	for (let row = 0; row < COUPON_GRID; row++) {
		for (let col = 0; col < COUPON_GRID; col++) {
			const [cx, cy] = couponCellCentreMm(row, col);
			const c = Math.floor((origin[0] + cx - cellFootprint.x0) / CELL_MM);
			const r = Math.floor((origin[1] + cy - cellFootprint.y0) / CELL_MM);
			if (cellFootprint.on[r * cellFootprint.cols + c] === 1) decoded |= 1 << (row * COUPON_GRID + col);
		}
	}

	const reasons: PrintRejectReason[] = [];
	const worst = Math.min(tileIou, cellIou);
	if (worst < COUPON_IOU_MIN) reasons.push({ kind: "COUPON_IOU_LOW", iou: worst });
	if (decoded !== coupon.markerId) reasons.push({ kind: "COUPON_MARKER_MISMATCH", expected: coupon.markerId, found: decoded });
	return { reasons, measured: { tileIou, cellIou, decoded } };
}
