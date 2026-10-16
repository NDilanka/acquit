import assert from "node:assert/strict";
import test from "node:test";
import { conform } from "../src/conform.ts";
import type { ConformInput } from "../src/conform.ts";
import { parseGcode } from "../src/gcode.ts";
import type { Ring } from "../src/raster.ts";
import { vec3 } from "../src/types.ts";

// A square part with one external wall loop per layer, and nine infill lines 2 mm apart when infill is on.
// Layers sit on the contract grid at 0.2 mm, so a 1 mm part has five layers.
function squareGcode(size: number, layers: number, infill: boolean): string {
	const inset = 0.2;
	const low = inset;
	const high = size - inset;
	const lines = ["G21", "G90", "M82", "G92 E0"];
	let e = 0;
	for (let layer = 1; layer <= layers; layer++) {
		const z = (layer * 0.2).toFixed(1);
		lines.push(";LAYER_CHANGE", `;Z:${z}`, ";TYPE:External perimeter", `G1 Z${z} F1200`, `G1 X${low} Y${low} F3000`);
		let x = low;
		let y = low;
		for (const [nx, ny] of [[high, low], [high, high], [low, high], [low, low]]) {
			e += (Math.hypot(nx - x, ny - y) * 0.05);
			lines.push(`G1 X${nx} Y${ny} E${e.toFixed(5)} F1800`);
			x = nx;
			y = ny;
		}
		if (infill) {
			lines.push(";TYPE:Internal infill");
			for (let line = 1; line <= 9; line++) {
				const row = 2 * line;
				e += (size - 1.2) * 0.05;
				lines.push(`G1 X${0.6} Y${row} F3000`, `G1 X${size - 0.6} Y${row} E${e.toFixed(5)} F1800`);
			}
		}
	}
	return lines.join("\n");
}

const LAYERS = [1, 3, 5];
const SQUARE: Ring = [[0, 0], [20, 0], [20, 20], [0, 20]];

function input(gcodeText: string, overrides: Partial<ConformInput> = {}): ConformInput {
	const parsed = parseGcode(gcodeText);
	if (!parsed.ok) throw new Error(`fixture G-code does not parse: ${JSON.stringify(parsed.reason)}`);
	return {
		gcode: parsed.value,
		meshBox: { min: vec3(0, 0, 0), max: vec3(20, 20, 1) },
		layerHeightMm: 0.2,
		sampleLayers: LAYERS,
		sections: new Map(LAYERS.map(layer => [layer, [SQUARE]])),
		infillPct: 20,
		toleranceMm: 0.2,
		expectedUnits: 1,
		...overrides,
	};
}

const kinds = (reasons: readonly { readonly kind: string }[]) => [...new Set(reasons.map(reason => reason.kind))];

test("the honest 20 mm square at 20% passes: no reasons, one unit, footprint IoU above 0.98 on each layer", () => {
	const result = conform(input(squareGcode(20, 5, true)));
	assert.deepEqual(result.reasons, []);
	assert.equal(result.measured.units, 1);
	for (const layer of result.measured.layers) assert.ok(layer.iou > 0.98, `layer ${layer.layer} iou ${layer.iou}`);
});

test("honest infill is 169.2 mm per layer against 200 mm implied by 20% of 400 mm2 at 0.4 mm width", () => {
	const result = conform(input(squareGcode(20, 5, true)));
	for (const layer of result.measured.layers) {
		assert.ok(Math.abs(layer.infillMm - 169.2) < 0.01, `infill ${layer.infillMm}`);
		assert.ok(Math.abs(layer.expectedMm - 200) < 1e-9, `expected ${layer.expectedMm}`);
	}
});

test("G-code with the infill stripped is rejected only for INFILL_BELOW_CONTRACT, on every sampled layer", () => {
	const result = conform(input(squareGcode(20, 5, false)));
	assert.deepEqual(kinds(result.reasons), ["INFILL_BELOW_CONTRACT"]);
	assert.equal(result.reasons.length, LAYERS.length);
	assert.deepEqual(result.reasons[0], { kind: "INFILL_BELOW_CONTRACT", layer: 1, pct: 0, contractPct: 20 });
});

test("a 19 mm part against the 20 mm contract fails scale and footprint, with IoU 0.9025", () => {
	const result = conform(input(squareGcode(19, 5, true), { meshBox: { min: vec3(0, 0, 0), max: vec3(20, 20, 1) } }));
	assert.deepEqual(kinds(result.reasons), ["SCALE_OUT_OF_TOLERANCE", "FOOTPRINT_MISMATCH"]);
	const scaleX = result.measured.scale.find(item => item.axis === "X");
	assert.ok(scaleX && Math.abs(scaleX.gcodeMm - 19) < 0.01);
	const layer = result.measured.layers[0];
	assert.ok(Math.abs(layer.iou - 361 / 400) < 0.01, `iou ${layer.iou}`);
});

test("one unit against an expected two gives UNIT_COUNT_MISMATCH with expected 2 and found 1", () => {
	const result = conform(input(squareGcode(20, 5, true), { expectedUnits: 2 }));
	assert.deepEqual(result.reasons, [{ kind: "UNIT_COUNT_MISMATCH", expected: 2, found: 1 }]);
});
