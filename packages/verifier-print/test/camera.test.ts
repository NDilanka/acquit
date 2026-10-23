import assert from "node:assert/strict";
import test from "node:test";
import { checkPhotos, dHash, hashDistance, photoGrid, windowFor } from "../src/camera.ts";
import type { Photo } from "../src/camera.ts";
import { conform } from "../src/conform.ts";
import { capturePhotos } from "../src/sim/camera.ts";
import { SQUARE_LAYERS, SQUARE_MESH, squareConformInput, squareGcode } from "./square-gcode.ts";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 3) & 0xff);

function photosOf(gcodeText: string, placement: { dx: number; dy: number }) {
	const input = squareConformInput(gcodeText);
	const window = windowFor(SQUARE_MESH, placement);
	const photos = capturePhotos({
		gcode: input.gcode,
		sampleLayers: SQUARE_LAYERS,
		layerHeightMm: 0.2,
		window,
		seed: SEED,
	});
	return { photos, sections: input.sections };
}

test("hash distance counts differing bits: one bit in the low byte is 1, and all 64 bits are 64", () => {
	assert.equal(hashDistance("0000000000000000", "0000000000000001"), 1);
	assert.equal(hashDistance("0000000000000000", "00000000000000ff"), 8);
	assert.equal(hashDistance("0000000000000000", "ffffffffffffffff"), 64);
});

test("the honest print's photos match the contract: no reasons, and every layer's IoU is above 0.9", () => {
	const honest = conform(squareConformInput(squareGcode(20, 5, true)));
	const { photos, sections } = photosOf(squareGcode(20, 5, true), honest.measured.placement);
	assert.ok(photos.every(photo => photo.simulated === true));
	const check = checkPhotos({ photos, sections, placement: honest.measured.placement, meshBox: SQUARE_MESH, archive: [] });
	assert.deepEqual(check.reasons, []);
	for (const layer of check.measured.layers) assert.ok(layer.iou > 0.9, `layer ${layer.layer} iou ${layer.iou}`);
});

test("a 2 mm shift on layer 3 fails GEOMETRY_MISMATCH on that photo and no other", () => {
	const honest = conform(squareConformInput(squareGcode(20, 5, true)));
	const shifted = squareGcode(20, 5, true, { layer: 3, mm: 2 });
	const { photos, sections } = photosOf(shifted, honest.measured.placement);
	const check = checkPhotos({ photos, sections, placement: honest.measured.placement, meshBox: SQUARE_MESH, archive: [] });
	assert.deepEqual(check.reasons.map(reason => [reason.kind, "layer" in reason ? reason.layer : null]), [["GEOMETRY_MISMATCH", 3]]);
	const layer = check.measured.layers.find(item => item.layer === 3);
	assert.ok(layer && layer.iou < 0.9 && layer.iou > 0.7, `layer 3 iou ${layer?.iou}`);
});

test("a photo whose fingerprint is archived from another job is PHOTO_REUSED at distance 0", () => {
	const honest = conform(squareConformInput(squareGcode(20, 5, true)));
	const { photos, sections } = photosOf(squareGcode(20, 5, true), honest.measured.placement);
	const archive = [{ layer: 1, fingerprint: dHash(photos[0]) }];
	const check = checkPhotos({ photos, sections, placement: honest.measured.placement, meshBox: SQUARE_MESH, archive });
	assert.ok(check.reasons.some(reason => reason.kind === "PHOTO_REUSED" && reason.layer === 1 && reason.distance === 0));
});

test("each layer's pass flag follows the overlap: an honest print passes all three layers, a shift fails only layer 3", () => {
	const honest = conform(squareConformInput(squareGcode(20, 5, true)));
	const clean = photosOf(squareGcode(20, 5, true), honest.measured.placement);
	const passing = checkPhotos({ photos: clean.photos, sections: clean.sections, placement: honest.measured.placement, meshBox: SQUARE_MESH, archive: [] });
	assert.deepEqual(passing.measured.layers.map(layer => [layer.layer, layer.readable, layer.pass, layer.distance]), [[1, true, true, null], [3, true, true, null], [5, true, true, null]]);
	assert.strictEqual(passing.measured.layers[0].photo, clean.photos[0], "the judge keeps the photo it received");

	const shifted = photosOf(squareGcode(20, 5, true, { layer: 3, mm: 2 }), honest.measured.placement);
	const failing = checkPhotos({ photos: shifted.photos, sections: shifted.sections, placement: honest.measured.placement, meshBox: SQUARE_MESH, archive: [] });
	assert.deepEqual(failing.measured.layers.map(layer => [layer.layer, layer.pass]), [[1, true], [3, false], [5, true]]);
	assert.equal(failing.measured.layers[1].reference.cols, shifted.photos[1].cols);
});

test("an archived fingerprint within 4 bits fails its row; on this simple square the other layers are within 4 bits too", () => {
	const honest = conform(squareConformInput(squareGcode(20, 5, true)));
	const { photos, sections } = photosOf(squareGcode(20, 5, true), honest.measured.placement);
	const archive = [{ layer: 1, fingerprint: dHash(photos[0]) }];
	const check = checkPhotos({ photos, sections, placement: honest.measured.placement, meshBox: SQUARE_MESH, archive });
	// The distances are 0, 2 and 3: a 9 by 8 hash of a plain square changes little from layer to layer.
	assert.deepEqual(check.measured.layers.map(layer => [layer.layer, layer.pass, layer.distance]), [[1, false, 0], [3, false, 2], [5, false, 3]]);
	assert.deepEqual(check.reasons.map(reason => [reason.kind, "layer" in reason ? reason.layer : null]), [["PHOTO_REUSED", 1], ["PHOTO_REUSED", 3], ["PHOTO_REUSED", 5]]);
});

test("a blank photo with no fiducials is PHOTO_UNREADABLE", () => {
	const honest = conform(squareConformInput(squareGcode(20, 5, true)));
	const grid = photoGrid(windowFor(SQUARE_MESH, honest.measured.placement));
	const blank: Photo = { layer: 1, cols: grid.cols, rows: grid.rows, pixels: new Uint8Array(grid.cols * grid.rows).fill(80) };
	const { sections } = photosOf(squareGcode(20, 5, true), honest.measured.placement);
	const check = checkPhotos({ photos: [blank], sections, placement: honest.measured.placement, meshBox: SQUARE_MESH, archive: [] });
	assert.deepEqual(check.reasons, [{ kind: "PHOTO_UNREADABLE", layer: 1 }]);
});
