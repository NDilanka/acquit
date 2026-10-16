// Synthetic G-code for a square part: one external wall loop per layer, and nine infill lines 2 mm apart
// when infill is on. Layers sit on the contract grid at 0.2 mm. A shift moves one layer's extrusion along X,
// as a bad layer on a real print would.

import type { ConformInput } from "../src/conform.ts";
import { parseGcode } from "../src/gcode.ts";
import type { Ring } from "../src/raster.ts";
import { vec3 } from "../src/types.ts";

export type LayerShift = { readonly layer: number; readonly mm: number };

export const SQUARE_LAYERS = [1, 3, 5];
export const SQUARE_MESH = { min: vec3(0, 0, 0), max: vec3(20, 20, 1) };
const SQUARE: Ring = [[0, 0], [20, 0], [20, 20], [0, 20]];
// The 20 mm square inset by two walls at 0.4 mm each.
const INTERIOR: Ring = [[0.8, 0.8], [19.2, 0.8], [19.2, 19.2], [0.8, 19.2]];

export function squareGcode(size: number, layers: number, infill: boolean, shift?: LayerShift): string {
	const inset = 0.2;
	const low = inset;
	const high = size - inset;
	const lines = ["G21", "G90", "M82", "G92 E0"];
	let e = 0;
	for (let layer = 1; layer <= layers; layer++) {
		const ox = shift && shift.layer === layer ? shift.mm : 0;
		const z = (layer * 0.2).toFixed(1);
		lines.push(";LAYER_CHANGE", `;Z:${z}`, ";TYPE:External perimeter", `G1 Z${z} F1200`, `G1 X${(low + ox).toFixed(3)} Y${low} F3000`);
		let x = low + ox;
		let y = low;
		for (const [nx, ny] of [[high + ox, low], [high + ox, high], [low + ox, high], [low + ox, low]]) {
			e += Math.hypot(nx - x, ny - y) * 0.05;
			lines.push(`G1 X${nx.toFixed(3)} Y${ny.toFixed(3)} E${e.toFixed(5)} F1800`);
			x = nx;
			y = ny;
		}
		if (infill) {
			lines.push(";TYPE:Internal infill");
			for (let line = 1; line <= 9; line++) {
				const row = 2 * line;
				e += (size - 1.2) * 0.05;
				lines.push(`G1 X${(0.6 + ox).toFixed(3)} Y${row} F3000`, `G1 X${(size - 0.6 + ox).toFixed(3)} Y${row} E${e.toFixed(5)} F1800`);
			}
		}
	}
	return lines.join("\n");
}

/** Conform input for the 20 mm square against the square contract, with overrides for one test. */
export function squareConformInput(gcodeText: string, overrides: Partial<ConformInput> = {}): ConformInput {
	const parsed = parseGcode(gcodeText);
	if (!parsed.ok) throw new Error(`fixture G-code does not parse: ${JSON.stringify(parsed.reason)}`);
	return {
		gcode: parsed.value,
		meshBox: SQUARE_MESH,
		layerHeightMm: 0.2,
		sampleLayers: SQUARE_LAYERS,
		sections: new Map(SQUARE_LAYERS.map(layer => [layer, [SQUARE]])),
		interiors: new Map(SQUARE_LAYERS.map(layer => [layer, [INTERIOR]])),
		infillPct: 20,
		toleranceMm: 0.2,
		expectedUnits: 1,
		bedMm: { x: 250, y: 210 },
		...overrides,
	};
}
