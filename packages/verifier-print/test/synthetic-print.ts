// Test-only prints that run with no slicer. The part meshes come from manifold. The honest G-code cuts each
// layer's mesh section into an external perimeter 0.2 mm inside the outline and parallel infill lines across
// the interior, spaced to the infill percentage. Each fraud edits these inputs or this output.

import { NOZZLE_WIDTH_MM } from "../src/conform.ts";
import type { Ring } from "../src/raster.ts";
import { toBinaryStl } from "../src/plate.ts";
import { interiorRings, kernel, solidOf } from "../src/section.ts";
import { meshStats } from "../src/stl.ts";

export const LAYER_MM = 0.2;
/** Parts are this tall, so every plate sits within 40 layers. */
export const PART_HEIGHT_MM = 8;
const PERIMETER_INSET_MM = 0.2;
const WALL_INSET_MM = 2 * NOZZLE_WIDTH_MM;
const EXTRUSION_MM_PER_MM = 0.05;
const TRAVEL_FEED = 3000;
const PRINT_FEED = 1800;

export type PartKind = "cube" | "cylinder" | "l-bracket";

/** A part as an STL: a cube of the given side, a cylinder of the given radius, or an L of the given side. */
export async function partStl(kind: PartKind, size: number): Promise<Uint8Array> {
	const { Manifold } = await kernel();
	const solid = (() => {
		if (kind === "cube") return Manifold.cube([size, size, PART_HEIGHT_MM]);
		if (kind === "cylinder") return Manifold.cylinder(PART_HEIGHT_MM, size, size, 48);
		const base = Manifold.cube([size, size / 3, PART_HEIGHT_MM]);
		const upright = Manifold.cube([size / 3, size, PART_HEIGHT_MM]);
		return Manifold.union([base, upright]);
	})();
	const stl = toBinaryStl(solid);
	solid.delete();
	return stl;
}

/** The same solid scaled about the origin. A print at 95% is the honest plate scaled by 0.95. */
export async function scaledStl(stl: Uint8Array, factor: number): Promise<Uint8Array> {
	const solid = await solidOf(stl);
	const scaled = solid.scale(factor);
	solid.delete();
	const bytes = toBinaryStl(scaled);
	scaled.delete();
	return bytes;
}

export type PrintPlan = {
	readonly infillPct: number;
	readonly skipInfill?: boolean;
	/** Moves every island whose min X is below boundaryX by mm along X on one sampled layer. */
	readonly shift?: { readonly layer: number; readonly mm: number; readonly boundaryX: number };
};

/** G-code for the plate, cut layer by layer from its mesh. Layer n sits at z = n x 0.2 mm, cut at its mid height. */
export async function syntheticGcode(stl: Uint8Array, plan: PrintPlan): Promise<string> {
	const mesh = meshStats(stl);
	if (!mesh.ok) throw new Error("plate STL is invalid");
	const layers = Math.ceil(mesh.value.bboxMm.max[2] / LAYER_MM - 1e-9);
	const lines = ["G21", "G90", "M82", "G92 E0"];
	let e = 0;
	const spacing = (NOZZLE_WIDTH_MM * 100) / plan.infillPct;

	const walk = (points: readonly (readonly [number, number])[], feature: string) => {
		lines.push(`;TYPE:${feature}`);
		const [sx, sy] = points[0];
		lines.push(`G1 X${sx.toFixed(3)} Y${sy.toFixed(3)} F${TRAVEL_FEED}`);
		let [px, py] = [sx, sy];
		for (const [x, y] of [...points.slice(1), points[0]]) {
			e += Math.hypot(x - px, y - py) * EXTRUSION_MM_PER_MM;
			lines.push(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} E${e.toFixed(5)} F${PRINT_FEED}`);
			[px, py] = [x, y];
		}
	};

	for (let layer = 1; layer <= layers; layer++) {
		const z = layer * LAYER_MM;
		const mid = (layer - 0.5) * LAYER_MM;
		const perimeter = await interiorRings(stl, mid, PERIMETER_INSET_MM);
		if (perimeter.length === 0) continue;
		const interior = await interiorRings(stl, mid, WALL_INSET_MM);
		const shift = plan.shift?.layer === layer ? plan.shift : undefined;
		const moved = (rings: readonly Ring[]): Ring[] =>
			shift ? rings.map(ring => (minX(ring) < shift.boundaryX ? ring.map(([x, y]): [number, number] => [x + shift.mm, y]) : ring)) : [...rings];
		const walls = moved(perimeter);
		const region = moved(interior);

		lines.push(";LAYER_CHANGE", `G1 Z${z.toFixed(3)} F1200`);
		for (const ring of walls) walk(ring, "External perimeter");

		if (plan.skipInfill) continue;
		const ys = region.flatMap(ring => ring.map(([, y]) => y));
		const [yMin, yMax] = [Math.min(...ys), Math.max(...ys)];
		const rows = Math.max(1, Math.ceil((yMax - yMin) / spacing - 1e-9));
		const step = (yMax - yMin) / rows;
		lines.push(";TYPE:Internal infill");
		for (let row = 0; row < rows; row++) {
			const y = yMin + (row + 0.5) * step;
			const xs = crossings(region, y);
			for (let i = 0; i + 1 < xs.length; i += 2) {
				const [x0, x1] = [xs[i], xs[i + 1]];
				lines.push(`G1 X${x0.toFixed(3)} Y${y.toFixed(3)} F${TRAVEL_FEED}`);
				e += (x1 - x0) * EXTRUSION_MM_PER_MM;
				lines.push(`G1 X${x1.toFixed(3)} Y${y.toFixed(3)} E${e.toFixed(5)} F${PRINT_FEED}`);
			}
		}
	}
	return lines.join("\n");
}

function minX(ring: Ring): number {
	return Math.min(...ring.map(([x]) => x));
}

/** X positions where the horizontal line at y crosses the rings' edges, sorted. Half-open, so a vertex counts once. */
function crossings(rings: readonly Ring[], y: number): number[] {
	const xs: number[] = [];
	for (const ring of rings) {
		for (let i = 0; i < ring.length; i++) {
			const [ax, ay] = ring[i];
			const [bx, by] = ring[(i + 1) % ring.length];
			if ((ay <= y) !== (by <= y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
		}
	}
	return xs.sort((a, b) => a - b);
}

/** Removes the extrusion from every infill move, as a seller would before printing an edited file. */
export function stripInfill(gcode: string): string {
	let feature = "";
	return gcode
		.split("\n")
		.map(line => {
			const trimmed = line.trim();
			if (trimmed.startsWith(";TYPE:")) feature = trimmed.slice(6).trim();
			if (/infill/i.test(feature) && /^G1\b/.test(trimmed)) return line.replace(/ E-?\d*\.?\d+/, "");
			return line;
		})
		.join("\n");
}
