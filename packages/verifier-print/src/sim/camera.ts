// SIMULATED camera. It renders a layer's part extrusion and the bed fiducials, then applies a pose (a
// rotation and a shift the verifier must recover from the fiducials), a lighting gradient, and noise.
// Every photo carries simulated: true. The pixel levels match the thresholds in camera.ts.

import { createHash } from "node:crypto";
import { fiducialCentres, FIDUCIAL_SIDE_MM, photoGrid } from "../camera.ts";
import type { Photo } from "../camera.ts";
import { layerIndexAt, partMovesByLayer, stampFootprint } from "../conform.ts";
import { CELL_MM } from "../raster.ts";
import type { Rect } from "../raster.ts";
import type { GcodeMove, ParsedGcode } from "../types.ts";

export type Pose = { readonly rotationDeg: number; readonly shiftMm: readonly [number, number] };
export type SimPhoto = Photo & { readonly simulated: true };

const BED_LEVEL = 80;
const PART_LEVEL = 200;
const FIDUCIAL_LEVEL = 10;
const NOISE_MM = 12;

/** A different pose for each layer, within 1.5 degrees and 0.8 mm. */
export function poseFor(layer: number): Pose {
	return {
		rotationDeg: ((layer * 5) % 7 - 3) * 0.5,
		shiftMm: [((layer * 3) % 5 - 2) * 0.4, ((layer * 11) % 5 - 2) * 0.4],
	};
}

export function renderPhoto(input: {
	readonly layer: number;
	/** The layer's part moves in the bed frame, as the printer runs them. */
	readonly moves: readonly GcodeMove[];
	readonly window: Rect;
	readonly pose: Pose;
	readonly seed: Uint8Array;
}): SimPhoto {
	const scene = photoGrid(input.window);
	stampFootprint(scene, input.moves, 0, 0);
	const fiducial = new Uint8Array(scene.on.length);
	const half = FIDUCIAL_SIDE_MM / 2;
	for (const [cx, cy] of fiducialCentres(input.window)) {
		for (let r = 0; r < scene.rows; r++) {
			for (let c = 0; c < scene.cols; c++) {
				const x = scene.x0 + (c + 0.5) * CELL_MM;
				const y = scene.y0 + (r + 0.5) * CELL_MM;
				if (Math.abs(x - cx) <= half && Math.abs(y - cy) <= half) fiducial[r * scene.cols + c] = 1;
			}
		}
	}

	const { cols, rows } = scene;
	const theta = (input.pose.rotationDeg * Math.PI) / 180;
	const cosT = Math.cos(theta);
	const sinT = Math.sin(theta);
	const shiftX = input.pose.shiftMm[0] / CELL_MM;
	const shiftY = input.pose.shiftMm[1] / CELL_MM;
	const centreX = cols / 2;
	const centreY = rows / 2;
	const noise = levelGenerator(input.seed, input.layer);
	const pixels = new Uint8Array(cols * rows);

	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const dx = c + 0.5 - centreX - shiftX;
			const dy = r + 0.5 - centreY - shiftY;
			const sc = Math.floor(centreX + cosT * dx + sinT * dy);
			const sr = Math.floor(centreY - sinT * dx + cosT * dy);
			let base = BED_LEVEL;
			if (sc >= 0 && sr >= 0 && sc < cols && sr < rows) {
				const index = sr * cols + sc;
				if (fiducial[index] === 1) base = FIDUCIAL_LEVEL;
				else if (scene.on[index] === 1) base = PART_LEVEL;
			}
			const gain = 0.85 + 0.3 * (c / cols);
			const value = Math.round(base * gain + (noise() * 2 - 1) * NOISE_MM);
			pixels[r * cols + c] = Math.min(255, Math.max(0, value));
		}
	}
	return { simulated: true, layer: input.layer, cols, rows, pixels };
}

/** The sampled layers' photos. Each layer is rendered from its own G-code moves, in the bed window. */
export function capturePhotos(input: {
	readonly gcode: ParsedGcode;
	readonly sampleLayers: readonly number[];
	readonly layerHeightMm: number;
	readonly window: Rect;
	readonly seed: Uint8Array;
}): SimPhoto[] {
	const byLayer = partMovesByLayer(input.gcode);
	return input.sampleLayers.map(layer => {
		const index = layerIndexAt(input.gcode, layer * input.layerHeightMm);
		return renderPhoto({
			layer,
			moves: index >= 0 ? (byLayer.get(index) ?? []) : [],
			window: input.window,
			pose: poseFor(layer),
			seed: input.seed,
		});
	});
}

/** Uniform values in [0, 1) from a seed. Mulberry32, seeded from the SHA-256 of the seed and the layer. */
function levelGenerator(seed: Uint8Array, layer: number): () => number {
	let state = createHash("sha256").update("photo\0").update(seed).update(String(layer)).digest().readUInt32BE(0);
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
