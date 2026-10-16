import assert from "node:assert/strict";
import test from "node:test";
import { conform } from "../src/conform.ts";
import { squareConformInput, squareGcode } from "./square-gcode.ts";

const kinds = (reasons: readonly { readonly kind: string }[]) => [...new Set(reasons.map(reason => reason.kind))];

test("the honest 20 mm square at 20% passes: no reasons, one unit, footprint IoU above 0.98, no outside material", () => {
	const result = conform(squareConformInput(squareGcode(20, 5, true)));
	assert.deepEqual(result.reasons, []);
	assert.equal(result.measured.units, 1);
	assert.deepEqual(result.measured.placement, { dx: 0, dy: 0 });
	for (const layer of result.measured.layers) {
		assert.ok(layer.iou > 0.98, `layer ${layer.layer} iou ${layer.iou}`);
		assert.ok(layer.outsidePct < 0.5, `layer ${layer.layer} outside ${layer.outsidePct}`);
	}
});

test("honest infill is 169.2 mm per layer against 169.28 mm expected over the 18.4 mm interior at 20% and 0.4 mm", () => {
	const result = conform(squareConformInput(squareGcode(20, 5, true)));
	for (const layer of result.measured.layers) {
		assert.ok(Math.abs(layer.infillMm - 169.2) < 0.01, `infill ${layer.infillMm}`);
		assert.ok(Math.abs(layer.expectedMm - 169.28) < 0.01, `expected ${layer.expectedMm}`);
	}
});

test("G-code with the infill stripped is rejected only for INFILL_BELOW_CONTRACT, on every sampled layer", () => {
	const result = conform(squareConformInput(squareGcode(20, 5, false)));
	assert.deepEqual(kinds(result.reasons), ["INFILL_BELOW_CONTRACT"]);
	assert.equal(result.reasons.length, 3);
	assert.deepEqual(result.reasons[0], { kind: "INFILL_BELOW_CONTRACT", layer: 1, pct: 0, contractPct: 20 });
});

test("a 19 mm part against the 20 mm contract fails scale and footprint, with IoU 0.9025", () => {
	const result = conform(squareConformInput(squareGcode(19, 5, true)));
	assert.deepEqual(kinds(result.reasons), ["SCALE_OUT_OF_TOLERANCE", "FOOTPRINT_MISMATCH"]);
	const scaleX = result.measured.scale.find(item => item.axis === "X");
	assert.ok(scaleX && Math.abs(scaleX.gcodeMm - 19) < 0.01);
	const layer = result.measured.layers[0];
	assert.ok(Math.abs(layer.iou - 361 / 400) < 0.01, `iou ${layer.iou}`);
});

test("a 2 mm shift on one sampled layer fails that layer alone: footprint and outside material, nothing else", () => {
	const result = conform(squareConformInput(squareGcode(20, 5, true, { layer: 3, mm: 2 })));
	assert.deepEqual(result.measured.placement, { dx: 0, dy: 0 });
	assert.deepEqual(result.reasons.map(reason => [reason.kind, "layer" in reason ? reason.layer : null]), [
		["FOOTPRINT_MISMATCH", 3],
		["OUTSIDE_MATERIAL", 3],
	]);
	const shifted = result.measured.layers.find(layer => layer.layer === 3);
	assert.ok(shifted && Math.abs(shifted.iou - 360 / 440) < 0.01, `iou ${shifted?.iou}`);
	assert.ok(shifted && Math.abs(shifted.outsidePct - 10) < 0.5, `outside ${shifted?.outsidePct}`);
});

test("one unit against an expected two gives UNIT_COUNT_MISMATCH with expected 2 and found 1", () => {
	const result = conform(squareConformInput(squareGcode(20, 5, true), { expectedUnits: 2 }));
	assert.deepEqual(result.reasons, [{ kind: "UNIT_COUNT_MISMATCH", expected: 2, found: 1 }]);
});

test("a part past the bed's right edge is rejected with BED_OUT_OF_BOUNDS on X, against the bed's 15 mm", () => {
	const result = conform(squareConformInput(squareGcode(20, 5, true), { bedMm: { x: 15, y: 210 } }));
	const bed = result.reasons.find(reason => reason.kind === "BED_OUT_OF_BOUNDS");
	assert.ok(bed && bed.kind === "BED_OUT_OF_BOUNDS");
	assert.equal(bed.axis, "X");
	assert.equal(bed.boundMm, 15);
	assert.ok(Math.abs(bed.gcodeMm - 20) < 0.01, `gcode edge ${bed.gcodeMm}`);
});
