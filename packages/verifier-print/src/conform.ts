// Conformance of sliced G-code against the contract mesh. The part's placement is measured from the
// G-code: for each sampled layer, the offset between the centre of its part extrusion and the centre of
// its mesh section, then the median over the layers. One bad layer therefore moves no other layer's check.
// Infill is expected over the section pulled inward by the wall count, not over the whole section.

import { areaMm2, countUnits, fillEdges, fillRings, gridOver, iou, ringsBox, stampSegment } from "./raster.ts";
import type { Grid, Rect, Ring, Segment } from "./raster.ts";
import type { Box, GcodeMove, ParsedGcode, PrintRejectReason } from "./types.ts";

/** The extrusion width the profile sets for every feature. Walls and infill are stamped at this width. */
export const NOZZLE_WIDTH_MM = 0.4;
/** The design note sets 0.92 for a sampled layer. */
export const FOOTPRINT_MIN_IOU = 0.92;
/** Measured on the honest print of the P3 cube plus coupon. See the slicer test for the number. */
export const INFILL_MIN_RATIO = 0.5;
/** The design note allows 2% of the footprint outside the mesh section. */
export const OUTSIDE_MAX_PCT = 2;
/** Smaller islands are wipe strokes or seams, not units. */
export const MIN_UNIT_AREA_MM2 = 1;

const LAYER_Z_EPSILON_MM = 1e-3;
const MARGIN_MM = 2;
const WALL_FEATURE = /^external perimeter$/i;
const PART_FEATURE = /perimeter|infill|gap fill|bridge/i;
const INFILL_FEATURE = /infill/i;

/** Offset from the G-code frame (the bed) to the mesh frame: mesh = bed + placement. */
export type Placement = { readonly dx: number; readonly dy: number };

export type ConformInput = {
	readonly gcode: ParsedGcode;
	/** The whole plate, part and coupon. Z height is read from here. */
	readonly meshBox: Box;
	readonly layerHeightMm: number;
	readonly sampleLayers: readonly number[];
	/** Mesh section rings at each sampled layer's mid height, keyed by layer number, in the mesh frame. */
	readonly sections: ReadonlyMap<number, readonly Ring[]>;
	/** The same sections inset inward by walls x NOZZLE_WIDTH_MM. */
	readonly interiors: ReadonlyMap<number, readonly Ring[]>;
	readonly infillPct: number;
	readonly toleranceMm: number;
	/** The quantity plus any coupon objects on the plate. */
	readonly expectedUnits: number;
	readonly bedMm: { readonly x: number; readonly y: number };
};

export type LayerMeasure = {
	readonly layer: number;
	readonly iou: number;
	readonly infillMm: number;
	readonly expectedMm: number;
	readonly outsidePct: number;
};

export type Conformance = {
	readonly reasons: readonly PrintRejectReason[];
	readonly measured: {
		readonly placement: Placement;
		readonly scale: readonly { readonly axis: "X" | "Y" | "Z"; readonly gcodeMm: number; readonly meshMm: number }[];
		readonly layers: readonly LayerMeasure[];
		readonly units: number;
	};
};

export function isPartMove(move: GcodeMove): boolean {
	return move.deltaEMm > 0 && PART_FEATURE.test(move.feature);
}

/** Part extrusion grouped by layer index. Moves before the first layer are not grouped. */
export function partMovesByLayer(gcode: ParsedGcode): Map<number, GcodeMove[]> {
	const byLayer = new Map<number, GcodeMove[]>();
	for (const move of gcode.moves) {
		if (move.layer < 0 || !isPartMove(move)) continue;
		const bucket = byLayer.get(move.layer) ?? [];
		bucket.push(move);
		byLayer.set(move.layer, bucket);
	}
	return byLayer;
}

/** The index of the G-code layer at height zMm, or -1 when no layer sits there. */
export function layerIndexAt(gcode: ParsedGcode, zMm: number): number {
	return gcode.layers.findIndex(layer => Math.abs(layer.z - zMm) < LAYER_Z_EPSILON_MM);
}

/** The bounding box of the path points, in the frame the moves are in. Empty input gives an empty box. */
export function extentOf(moves: readonly GcodeMove[]): Rect {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const move of moves) {
		for (const [x, y] of move.path) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}
	return { minX, minY, maxX, maxY };
}

export function conform(input: ConformInput): Conformance {
	const parts = input.gcode.moves.filter(isPartMove);
	if (parts.length === 0) {
		return {
			reasons: [{ kind: "UNIT_COUNT_MISMATCH", expected: input.expectedUnits, found: 0 }],
			measured: { placement: { dx: 0, dy: 0 }, scale: [], layers: [], units: 0 },
		};
	}

	const reasons: PrintRejectReason[] = [];
	const half = NOZZLE_WIDTH_MM / 2;
	const bed = extentOf(parts);
	if (bed.minX - half < 0) reasons.push({ kind: "BED_OUT_OF_BOUNDS", axis: "X", gcodeMm: bed.minX - half, boundMm: 0 });
	if (bed.maxX + half > input.bedMm.x) {
		reasons.push({ kind: "BED_OUT_OF_BOUNDS", axis: "X", gcodeMm: bed.maxX + half, boundMm: input.bedMm.x });
	}
	if (bed.minY - half < 0) reasons.push({ kind: "BED_OUT_OF_BOUNDS", axis: "Y", gcodeMm: bed.minY - half, boundMm: 0 });
	if (bed.maxY + half > input.bedMm.y) {
		reasons.push({ kind: "BED_OUT_OF_BOUNDS", axis: "Y", gcodeMm: bed.maxY + half, boundMm: input.bedMm.y });
	}

	const byLayer = partMovesByLayer(input.gcode);
	const samples = input.sampleLayers.map(layerNumber => {
		const rings = input.sections.get(layerNumber);
		const interior = input.interiors.get(layerNumber);
		if (!rings || !interior) throw new Error(`no mesh section for sampled layer ${layerNumber}`);
		const index = layerIndexAt(input.gcode, layerNumber * input.layerHeightMm);
		const moves = index >= 0 ? (byLayer.get(index) ?? []) : [];
		return { layerNumber, rings, interior, moves, section: ringsBox(rings) };
	});
	const printed = samples.filter(sample => sample.moves.length > 0);

	const offsets = printed.map(sample => {
		const gcodeBox = extentOf(sample.moves);
		return {
			dx: centre(sample.section, "X") - centre(gcodeBox, "X"),
			dy: centre(sample.section, "Y") - centre(gcodeBox, "Y"),
		};
	});
	const placement: Placement = { dx: median(offsets.map(offset => offset.dx)), dy: median(offsets.map(offset => offset.dy)) };

	const gcodeHeight = input.gcode.layers.reduce((top, layer) => Math.max(top, layer.z), 0);
	const { min, max } = input.meshBox;
	const scale = [
		{
			axis: "X" as const,
			gcodeMm: median(printed.map(sample => extentOf(sample.moves).maxX - extentOf(sample.moves).minX + NOZZLE_WIDTH_MM)),
			meshMm: median(samples.map(sample => sample.section.maxX - sample.section.minX)),
		},
		{
			axis: "Y" as const,
			gcodeMm: median(printed.map(sample => extentOf(sample.moves).maxY - extentOf(sample.moves).minY + NOZZLE_WIDTH_MM)),
			meshMm: median(samples.map(sample => sample.section.maxY - sample.section.minY)),
		},
		{ axis: "Z" as const, gcodeMm: gcodeHeight, meshMm: max[2] - min[2] },
	];
	for (const item of scale) {
		if (Math.abs(item.gcodeMm - item.meshMm) > input.toleranceMm) {
			reasons.push({ kind: "SCALE_OUT_OF_TOLERANCE", axis: item.axis, gcodeMm: item.gcodeMm, meshMm: item.meshMm });
		}
	}

	const rect: Rect = { minX: min[0], minY: min[1], maxX: max[0], maxY: max[1] };
	const layers: LayerMeasure[] = [];
	let units = 0;
	samples.forEach((sample, order) => {
		const section = gridOver(rect, MARGIN_MM);
		fillRings(section, sample.rings);
		const interior = gridOver(rect, MARGIN_MM);
		fillRings(interior, sample.interior);
		const footprint = footprintOf(sample.moves, placement.dx, placement.dy, rect);
		const score = iou(footprint, section);
		if (order === 0) units = countUnits(footprint, MIN_UNIT_AREA_MM2);

		const infillMm = sample.moves.filter(move => INFILL_FEATURE.test(move.feature)).reduce((sum, move) => sum + move.xyzMm, 0);
		const interiorMm2 = areaMm2(interior);
		const expectedMm = (interiorMm2 * input.infillPct) / 100 / NOZZLE_WIDTH_MM;
		const outsidePct = outsideOf(footprint, section);
		layers.push({ layer: sample.layerNumber, iou: score, infillMm, expectedMm, outsidePct });

		if (score < FOOTPRINT_MIN_IOU) reasons.push({ kind: "FOOTPRINT_MISMATCH", layer: sample.layerNumber, iou: score });
		if (outsidePct > OUTSIDE_MAX_PCT) reasons.push({ kind: "OUTSIDE_MATERIAL", layer: sample.layerNumber, pct: round1(outsidePct) });
		if (infillMm < INFILL_MIN_RATIO * expectedMm) {
			const pct = interiorMm2 > 0 ? (infillMm * NOZZLE_WIDTH_MM * 100) / interiorMm2 : 0;
			reasons.push({
				kind: "INFILL_BELOW_CONTRACT",
				layer: sample.layerNumber,
				pct: round1(pct),
				contractPct: input.infillPct,
			});
		}
	});

	if (units !== input.expectedUnits) {
		reasons.push({ kind: "UNIT_COUNT_MISMATCH", expected: input.expectedUnits, found: units });
	}
	return { reasons, measured: { placement, scale, layers, units } };
}

/**
 * Stamps a layer's part extrusion into grid, at the placement. Walls are filled, so sparse infill leaves
 * no hole in the footprint; every stroke is stamped at nozzle width on top.
 */
export function stampFootprint(grid: Grid, moves: readonly GcodeMove[], dx: number, dy: number): void {
	const walls: Segment[] = [];
	const strokes: Segment[] = [];
	for (const move of moves) {
		const wall = WALL_FEATURE.test(move.feature);
		for (let i = 0; i + 1 < move.path.length; i++) {
			const [ax, ay] = move.path[i];
			const [bx, by] = move.path[i + 1];
			const segment: Segment = [ax + dx, ay + dy, bx + dx, by + dy];
			if (wall) walls.push(segment);
			strokes.push(segment);
		}
	}
	fillEdges(grid, walls);
	for (const stroke of strokes) stampSegment(grid, stroke, NOZZLE_WIDTH_MM / 2);
}

export function footprintOf(moves: readonly GcodeMove[], dx: number, dy: number, rect: Rect): Grid {
	const grid = gridOver(rect, MARGIN_MM);
	stampFootprint(grid, moves, dx, dy);
	return grid;
}

function outsideOf(footprint: Grid, section: Grid): number {
	let inside = 0;
	let outside = 0;
	for (let i = 0; i < footprint.on.length; i++) {
		inside += footprint.on[i];
		outside += footprint.on[i] & (1 - section.on[i]);
	}
	return inside === 0 ? 0 : (outside * 100) / inside;
}

function centre(box: Rect, axis: "X" | "Y"): number {
	return axis === "X" ? (box.minX + box.maxX) / 2 : (box.minY + box.maxY) / 2;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}
