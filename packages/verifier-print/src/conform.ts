// Conformance of sliced G-code against the contract mesh. Four checks: the part's scale, each sampled
// layer's footprint, each sampled layer's infill length, and the unit count. The G-code is moved so its
// centre sits on the mesh's centre first, so bed placement is not checked here.

import { areaMm2, countUnits, fillEdges, gridOver, iou, ringEdges, stampSegment } from "./raster.ts";
import type { Grid, Rect, Ring, Segment } from "./raster.ts";
import type { Box, GcodeMove, ParsedGcode, PrintRejectReason } from "./types.ts";

/** The extrusion width the profile sets for every feature. Walls and infill are stamped at this width. */
export const NOZZLE_WIDTH_MM = 0.4;
/** The design note sets 0.92 for a sampled layer. */
export const FOOTPRINT_MIN_IOU = 0.92;
/**
 * The implied infill length counts the whole section, not the interior the walls leave, so an honest
 * print sits above this and a skipped infill sits at zero.
 */
export const INFILL_MIN_RATIO = 0.5;
/** Smaller islands are wipe strokes or seams, not units. */
export const MIN_UNIT_AREA_MM2 = 1;

const LAYER_Z_EPSILON_MM = 1e-3;
const MARGIN_MM = 2;
const WALL_FEATURE = /^external perimeter$/i;
const PART_FEATURE = /perimeter|infill|gap fill|bridge/i;
const INFILL_FEATURE = /infill/i;

export type ConformInput = {
	readonly gcode: ParsedGcode;
	readonly meshBox: Box;
	readonly layerHeightMm: number;
	readonly sampleLayers: readonly number[];
	/** Mesh section rings at each sampled layer's mid height, keyed by layer number. */
	readonly sections: ReadonlyMap<number, readonly Ring[]>;
	readonly infillPct: number;
	readonly toleranceMm: number;
	/** The quantity plus any coupon objects on the plate. */
	readonly expectedUnits: number;
};

export type LayerMeasure = { readonly layer: number; readonly iou: number; readonly infillMm: number; readonly expectedMm: number };

export type Conformance = {
	readonly reasons: readonly PrintRejectReason[];
	readonly measured: {
		readonly scale: readonly { readonly axis: "X" | "Y" | "Z"; readonly gcodeMm: number; readonly meshMm: number }[];
		readonly layers: readonly LayerMeasure[];
		readonly units: number;
	};
};

export function conform(input: ConformInput): Conformance {
	const parts = input.gcode.moves.filter(move => move.deltaEMm > 0 && PART_FEATURE.test(move.feature));
	if (parts.length === 0) {
		return {
			reasons: [{ kind: "UNIT_COUNT_MISMATCH", expected: input.expectedUnits, found: 0 }],
			measured: { scale: [], layers: [], units: 0 },
		};
	}

	const half = NOZZLE_WIDTH_MM / 2;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const move of parts) {
		for (const [x, y] of move.path) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}
	const gcodeWidth = maxX - minX + NOZZLE_WIDTH_MM;
	const gcodeDepth = maxY - minY + NOZZLE_WIDTH_MM;
	const gcodeHeight = input.gcode.layers.reduce((top, layer) => Math.max(top, layer.z), 0);
	const { min, max } = input.meshBox;
	const meshWidth = max[0] - min[0];
	const meshDepth = max[1] - min[1];
	const meshHeight = max[2] - min[2];

	const scale = [
		{ axis: "X" as const, gcodeMm: gcodeWidth, meshMm: meshWidth },
		{ axis: "Y" as const, gcodeMm: gcodeDepth, meshMm: meshDepth },
		{ axis: "Z" as const, gcodeMm: gcodeHeight, meshMm: meshHeight },
	];
	const reasons: PrintRejectReason[] = scale
		.filter(item => Math.abs(item.gcodeMm - item.meshMm) > input.toleranceMm)
		.map((item): PrintRejectReason => ({ kind: "SCALE_OUT_OF_TOLERANCE", axis: item.axis, gcodeMm: item.gcodeMm, meshMm: item.meshMm }));

	const dx = (min[0] + max[0]) / 2 - (minX + maxX) / 2;
	const dy = (min[1] + max[1]) / 2 - (minY + maxY) / 2;
	const rect: Rect = { minX: min[0], minY: min[1], maxX: max[0], maxY: max[1] };
	const movesByLayer = new Map<number, GcodeMove[]>();
	for (const move of parts) {
		if (move.layer < 0) continue;
		const bucket = movesByLayer.get(move.layer) ?? [];
		bucket.push(move);
		movesByLayer.set(move.layer, bucket);
	}

	const layers: LayerMeasure[] = [];
	let units = 0;
	input.sampleLayers.forEach((layerNumber, order) => {
		const rings = input.sections.get(layerNumber);
		if (!rings) throw new Error(`no mesh section for sampled layer ${layerNumber}`);
		const section = gridOver(rect, MARGIN_MM);
		fillEdges(section, rings.flatMap(ring => ringEdges(ring)));

		const z = layerNumber * input.layerHeightMm;
		const index = input.gcode.layers.findIndex(layer => Math.abs(layer.z - z) < LAYER_Z_EPSILON_MM);
		const moves = index >= 0 ? (movesByLayer.get(index) ?? []) : [];
		const footprint = footprintOf(moves, dx, dy, rect);
		const score = iou(footprint, section);
		if (order === 0) units = countUnits(footprint, MIN_UNIT_AREA_MM2);

		const infillMm = moves.filter(move => INFILL_FEATURE.test(move.feature)).reduce((sum, move) => sum + move.xyzMm, 0);
		const sectionMm2 = areaMm2(section);
		const expectedMm = (sectionMm2 * input.infillPct) / 100 / NOZZLE_WIDTH_MM;
		layers.push({ layer: layerNumber, iou: score, infillMm, expectedMm });

		if (score < FOOTPRINT_MIN_IOU) reasons.push({ kind: "FOOTPRINT_MISMATCH", layer: layerNumber, iou: score });
		if (infillMm < INFILL_MIN_RATIO * expectedMm) {
			const pct = sectionMm2 > 0 ? (infillMm * NOZZLE_WIDTH_MM * 100) / sectionMm2 : 0;
			reasons.push({
				kind: "INFILL_BELOW_CONTRACT",
				layer: layerNumber,
				pct: Math.round(pct * 10) / 10,
				contractPct: input.infillPct,
			});
		}
	});

	if (units !== input.expectedUnits) {
		reasons.push({ kind: "UNIT_COUNT_MISMATCH", expected: input.expectedUnits, found: units });
	}
	return { reasons, measured: { scale, layers, units } };
}

/**
 * The layer's footprint in mesh coordinates: the region inside its external wall, plus every part
 * extrusion stamped at nozzle width. Sparse infill leaves the interior open, so the walls are filled.
 */
function footprintOf(moves: readonly GcodeMove[], dx: number, dy: number, rect: Rect): Grid {
	const footprint = gridOver(rect, MARGIN_MM);
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
	fillEdges(footprint, walls);
	for (const stroke of strokes) stampSegment(footprint, stroke, NOZZLE_WIDTH_MM / 2);
	return footprint;
}
