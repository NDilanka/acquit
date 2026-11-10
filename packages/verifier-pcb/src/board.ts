// Reads a KiCad 7/8 .kicad_pcb file into a plain board model. Only the copper that the rules need is kept:
// F.Cu and B.Cu tracks, pads, and vias, plus the Edge.Cuts outline. Anything else is ignored, and a parse that
// cannot be read comes back with an error instead of a throw.

import { arcPoints, add, circlePolygon, dist, ovalPolygon, rectPolygon, rotate } from "./geometry.ts";
import { child, children, num, parseSexprs, type SExpr } from "./sexpr.ts";
import type { Vec2 } from "./types.ts";

export type CopperLayer = "F.Cu" | "B.Cu";

export type Track = {
	readonly id: string;
	readonly layer: CopperLayer;
	readonly a: Vec2;
	readonly b: Vec2;
	readonly width: number;
	readonly netName: string; // the file's label; geometry never trusts it
};

export type PadInst = {
	readonly id: string; // "REF.pad"
	readonly ref: string;
	readonly name: string;
	readonly type: "smd" | "thru_hole" | "np_thru_hole" | "other";
	readonly shape: string;
	readonly center: Vec2;
	readonly size: Vec2;
	readonly angle: number; // absolute, degrees
	readonly poly: readonly Vec2[];
	readonly layers: readonly CopperLayer[];
	readonly drill: number | undefined;
	readonly netName: string;
	readonly footprintRot: number;
	readonly footprintOrigin: Vec2;
	readonly localOffset: Vec2; // the pad's offset from its footprint origin in the file, unrotated
};

export type Via = {
	readonly id: string;
	readonly at: Vec2;
	readonly size: number;
	readonly drill: number;
	readonly netName: string;
	readonly poly: readonly Vec2[];
};

export type Footprint = {
	readonly ref: string;
	readonly name: string;
	readonly at: Vec2;
	readonly rotation: number;
	readonly pads: readonly PadInst[];
};

export type Board = {
	readonly ok: boolean;
	readonly error?: string;
	readonly hasZones: boolean;
	readonly outlineLoops: readonly (readonly Vec2[])[];
	readonly outlineOpen: boolean; // true when an Edge.Cuts chain does not close
	readonly tracks: readonly Track[];
	readonly pads: readonly PadInst[];
	readonly vias: readonly Via[];
	readonly footprints: readonly Footprint[];
};

const EMPTY: Board = {
	ok: false,
	hasZones: false,
	outlineLoops: [],
	outlineOpen: false,
	tracks: [],
	pads: [],
	vias: [],
	footprints: [],
};

const MAX_ARC_ERROR = 0.02;
const JOIN_TOLERANCE = 0.001;

function point(list: readonly SExpr[] | undefined): Vec2 | undefined {
	const x = num(list, 1);
	const y = num(list, 2);
	return x === undefined || y === undefined ? undefined : [x, y];
}

function layerOf(list: readonly SExpr[] | undefined): CopperLayer | undefined {
	const v = list?.[1];
	return v === "F.Cu" || v === "B.Cu" ? v : undefined;
}

function netNameOf(list: readonly SExpr[]): string {
	const net = child(list, "net");
	if (!net) return "";
	const v = net[2];
	return typeof v === "string" ? v : "";
}

function copperLayersOf(list: readonly SExpr[] | undefined): CopperLayer[] {
	const out: CopperLayer[] = [];
	for (const v of list?.slice(1) ?? []) {
		if (v === "F.Cu" || v === "B.Cu") out.push(v);
		else if (v === "*.Cu") return ["F.Cu", "B.Cu"];
	}
	return out;
}

function propertyReference(fp: readonly SExpr[]): string {
	for (const p of children(fp, "property")) {
		if (p[1] === "Reference" && typeof p[2] === "string") return p[2];
	}
	for (const t of children(fp, "fp_text")) {
		if (t[1] === "reference" && typeof t[2] === "string") return t[2];
	}
	return "";
}

function padPolygon(center: Vec2, shape: string, size: Vec2, angle: number): Vec2[] {
	if (shape === "circle") return circlePolygon(center, size[0] / 2);
	if (shape === "oval") return ovalPolygon(center, size, angle);
	return rectPolygon(center, size, angle);
}

/** Splits an arc into straight pieces within the chord-error budget. */
function arcTrack(list: readonly SExpr[]): Vec2[] | undefined {
	const s = point(child(list, "start"));
	const m = point(child(list, "mid"));
	const e = point(child(list, "end"));
	if (!s || !m || !e) return undefined;
	return arcPoints(s, m, e, MAX_ARC_ERROR);
}

function sameKey(a: Vec2, b: Vec2): boolean {
	return dist(a, b) < JOIN_TOLERANCE;
}

/** Chains outline segments into loops. Returns the loops and whether any chain failed to close. */
function chainLoops(edges: readonly (readonly [Vec2, Vec2])[]): { loops: Vec2[][]; open: boolean } {
	const used = edges.map(() => false);
	const loops: Vec2[][] = [];
	let open = false;
	for (let start = 0; start < edges.length; start++) {
		if (used[start]) continue;
		used[start] = true;
		const first = edges[start] as readonly [Vec2, Vec2];
		const loop: Vec2[] = [first[0], first[1]];
		let closed = false;
		let grew = true;
		while (grew && !closed) {
			grew = false;
			for (let k = 0; k < edges.length; k++) {
				if (used[k]) continue;
				const [p, q] = edges[k] as readonly [Vec2, Vec2];
				const tail = loop[loop.length - 1] as Vec2;
				if (sameKey(tail, p)) {
					loop.push(q);
				} else if (sameKey(tail, q)) {
					loop.push(p);
				} else {
					continue;
				}
				used[k] = true;
				grew = true;
				if (sameKey(loop[loop.length - 1] as Vec2, loop[0] as Vec2)) {
					loop.pop();
					closed = true;
					break;
				}
			}
		}
		if (closed) loops.push(loop);
		else open = true;
	}
	return { loops, open };
}

export function readBoard(text: string): Board {
	const parsed = parseSexprs(text);
	if (!parsed.ok) return { ...EMPTY, error: parsed.error };
	const root = parsed.value.find(item => Array.isArray(item) && item[0] === "kicad_pcb") as readonly SExpr[] | undefined;
	if (!root) return { ...EMPTY, error: "not a kicad_pcb file" };

	const hasZones = children(root, "zone").length > 0;

	const edges: [Vec2, Vec2][] = [];
	const loops: Vec2[][] = [];
	for (const g of children(root, "gr_line")) {
		if (child(g, "layer")?.[1] !== "Edge.Cuts") continue;
		const a = point(child(g, "start"));
		const b = point(child(g, "end"));
		if (a && b) edges.push([a, b]);
	}
	for (const g of children(root, "gr_rect")) {
		if (child(g, "layer")?.[1] !== "Edge.Cuts") continue;
		const a = point(child(g, "start"));
		const b = point(child(g, "end"));
		if (!a || !b) continue;
		const c: Vec2 = [b[0], a[1]];
		const d: Vec2 = [a[0], b[1]];
		edges.push([a, c], [c, b], [b, d], [d, a]);
	}
	for (const g of children(root, "gr_arc")) {
		if (child(g, "layer")?.[1] !== "Edge.Cuts") continue;
		const pts = arcTrack(g);
		if (!pts) continue;
		for (let i = 0; i + 1 < pts.length; i++) edges.push([pts[i] as Vec2, pts[i + 1] as Vec2]);
	}
	for (const g of children(root, "gr_circle")) {
		if (child(g, "layer")?.[1] !== "Edge.Cuts") continue;
		const c = point(child(g, "center"));
		const e = point(child(g, "end"));
		if (c && e) loops.push(circlePolygon(c, dist(c, e)));
	}
	const chained = chainLoops(edges);
	loops.push(...chained.loops);

	const tracks: Track[] = [];
	for (const seg of children(root, "segment")) {
		const layer = layerOf(child(seg, "layer"));
		const a = point(child(seg, "start"));
		const b = point(child(seg, "end"));
		const width = num(child(seg, "width"), 1);
		if (!layer || !a || !b || width === undefined) continue;
		tracks.push({ id: `track-${tracks.length}`, layer, a, b, width, netName: netNameOf(seg) });
	}
	for (const arc of children(root, "arc")) {
		const layer = layerOf(child(arc, "layer"));
		const width = num(child(arc, "width"), 1);
		const pts = arcTrack(arc);
		if (!layer || width === undefined || !pts) continue;
		for (let i = 0; i + 1 < pts.length; i++) {
			tracks.push({
				id: `track-${tracks.length}`,
				layer,
				a: pts[i] as Vec2,
				b: pts[i + 1] as Vec2,
				width,
				netName: netNameOf(arc),
			});
		}
	}

	const vias: Via[] = [];
	for (const v of children(root, "via")) {
		const at = point(child(v, "at"));
		const size = num(child(v, "size"), 1);
		const drill = num(child(v, "drill"), 1);
		if (!at || size === undefined || drill === undefined) continue;
		vias.push({
			id: `via-${vias.length}`,
			at,
			size,
			drill,
			netName: netNameOf(v),
			poly: circlePolygon(at, size / 2),
		});
	}

	const footprints: Footprint[] = [];
	const pads: PadInst[] = [];
	for (const fp of children(root, "footprint")) {
		const at0 = point(child(fp, "at"));
		const origin: Vec2 = at0 ?? [0, 0];
		const rot = num(child(fp, "at"), 3) ?? 0;
		const ref = propertyReference(fp);
		const fpPads: PadInst[] = [];
		for (const p of children(fp, "pad")) {
			const name = typeof p[1] === "string" ? p[1] : "";
			const typeAtom = typeof p[2] === "string" ? p[2] : "";
			const shape = typeof p[3] === "string" ? p[3] : "";
			const offset = point(child(p, "at")) ?? [0, 0];
			const size = point(child(p, "size"));
			if (!size) continue;
			const padRot = num(child(p, "at"), 3) ?? 0;
			const center = add(origin, rotate(offset, rot));
			const angle = rot + padRot;
			const drillList = child(p, "drill");
			const drill = num(drillList, 1);
			const type: PadInst["type"] =
				typeAtom === "smd" ? "smd" : typeAtom === "thru_hole" ? "thru_hole" : typeAtom === "np_thru_hole" ? "np_thru_hole" : "other";
			const inst: PadInst = {
				id: `${ref}.${name}`,
				ref,
				name,
				type,
				shape,
				center,
				size,
				angle,
				poly: padPolygon(center, shape, size, angle),
				layers: copperLayersOf(child(p, "layers")),
				drill,
				netName: netNameOf(p),
				footprintRot: rot,
				footprintOrigin: origin,
				localOffset: offset,
			};
			fpPads.push(inst);
			if (inst.layers.length > 0) pads.push(inst);
		}
		footprints.push({ ref, name: typeof fp[1] === "string" ? fp[1] : "", at: origin, rotation: rot, pads: fpPads });
	}

	return {
		ok: true,
		hasZones,
		outlineLoops: loops,
		outlineOpen: chained.open,
		tracks,
		pads,
		vias,
		footprints,
	};
}
