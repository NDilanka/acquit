import assert from "node:assert/strict";
import test from "node:test";
import type { JobId } from "../../core/src/ids.ts";
import { coupon } from "../src/coupon.ts";
import { checkCoupon } from "../src/witness.ts";
import { parseGcode } from "../src/gcode.ts";
import type { Rect } from "../src/raster.ts";
import type { Coupon, ParsedGcode } from "../src/types.ts";
import { squareGcode } from "./square-gcode.ts";

const JOB = "job_witness01" as JobId;
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 7) & 0xff);
const ORIGIN: [number, number] = [25, 0];
const TILE_LAYERS = 20;
const TOP_LAYERS = 30;
const INSET = 0.2;

/** Walls only: a loop per rectangle on every layer. Tile layers 1 to 20, raised cells 21 to 30. */
function couponGcode(witness: Coupon, skipCell?: number): ParsedGcode {
	const tile: Rect = { minX: ORIGIN[0], minY: ORIGIN[1], maxX: ORIGIN[0] + 24, maxY: ORIGIN[1] + 24 };
	const raised: Rect[] = witness.raisedCells
		.filter((_, index) => index !== skipCell)
		.map(cell => ({
			minX: ORIGIN[0] + cell.min[0],
			minY: ORIGIN[1] + cell.min[1],
			maxX: ORIGIN[0] + cell.max[0],
			maxY: ORIGIN[1] + cell.max[1],
		}));
	const lines = ["G21", "G90", "M82", "G92 E0"];
	let e = 0;
	for (let layer = 1; layer <= TOP_LAYERS; layer++) {
		const z = (layer * 0.2).toFixed(1);
		const rects = layer <= TILE_LAYERS ? [tile] : raised;
		lines.push(";LAYER_CHANGE", `;Z:${z}`, ";TYPE:External perimeter", `G1 Z${z} F1200`);
		for (const rect of rects) {
			const [x0, y0, x1, y1] = [rect.minX + INSET, rect.minY + INSET, rect.maxX - INSET, rect.maxY - INSET];
			const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
			lines.push(`G1 X${x0.toFixed(3)} Y${y0.toFixed(3)} F3000`);
			let [px, py] = [x0, y0];
			for (const [x, y] of corners.slice(1)) {
				e += Math.hypot(x - px, y - py) * 0.05;
				lines.push(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} E${e.toFixed(5)} F1800`);
				[px, py] = [x, y];
			}
		}
	}
	const parsed = parseGcode(lines.join("\n"));
	if (!parsed.ok) throw new Error("coupon fixture does not parse");
	return parsed.value;
}

function firstRaisedBit(witness: Coupon): number {
	for (let row = 0; row < 4; row++) {
		for (let col = 0; col < 4; col++) {
			if (witness.markerCells[row][col]) return row * 4 + col;
		}
	}
	throw new Error("marker has no raised cell");
}

test("a coupon printed to its design passes: the footprints match and the marker decodes to the frozen id", () => {
	const witness = coupon(JOB, SEED);
	const result = checkCoupon({ gcode: couponGcode(witness), layerHeightMm: 0.2, coupon: witness, origin: ORIGIN, placement: { dx: 0, dy: 0 } });
	assert.deepEqual(result.reasons, []);
	assert.equal(result.measured.decoded, witness.markerId);
	assert.ok(result.measured.tileIou > 0.95, `tile iou ${result.measured.tileIou}`);
	assert.ok(result.measured.cellIou > 0.95, `cell iou ${result.measured.cellIou}`);
});

test("a coupon with one raised cell missing fails COUPON_IOU_LOW and COUPON_MARKER_MISMATCH with the bit cleared", () => {
	const witness = coupon(JOB, SEED);
	const bit = firstRaisedBit(witness);
	const removedIndex = witness.raisedCells.findIndex(() => true);
	const result = checkCoupon({
		gcode: couponGcode(witness, removedIndex),
		layerHeightMm: 0.2,
		coupon: witness,
		origin: ORIGIN,
		placement: { dx: 0, dy: 0 },
	});
	assert.deepEqual(result.reasons.map(reason => reason.kind), ["COUPON_IOU_LOW", "COUPON_MARKER_MISMATCH"]);
	const marker = result.reasons[1];
	assert.ok(marker.kind === "COUPON_MARKER_MISMATCH");
	assert.equal(marker.expected, witness.markerId);
	assert.equal(marker.found, witness.markerId & ~(1 << bit));
});

test("a plate with no coupon on it fails the coupon: zero IoU and a decoded id of 0", () => {
	const witness = coupon(JOB, SEED);
	const parsed = parseGcode(squareGcode(20, 30, true));
	if (!parsed.ok) throw new Error("fixture does not parse");
	const result = checkCoupon({ gcode: parsed.value, layerHeightMm: 0.2, coupon: witness, origin: ORIGIN, placement: { dx: 0, dy: 0 } });
	assert.deepEqual(result.reasons, [
		{ kind: "COUPON_IOU_LOW", iou: 0 },
		{ kind: "COUPON_MARKER_MISMATCH", expected: witness.markerId, found: 0 },
	]);
});
