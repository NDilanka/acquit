// Reads a KiCad 7/8 .kicad_pcb file into a plain board model. Only the copper that the rules need is kept:
// F.Cu and B.Cu tracks, pads, and vias, plus the Edge.Cuts outline. A non-plated hole is kept apart as a bore,
// since it removes material and conducts nothing. Metadata layers (silkscreen, fab, courtyard)
// are accepted and not modelled. Any construct outside the supported subset fails the parse with its name. A
// recognised record with a missing, non-finite, out-of-range, or non-positive mandatory field fails the parse too,
// and a parse that cannot be read comes back with an error instead of a throw.

import {
	add,
	arcPoints,
	circleError,
	circlePolygon,
	dist,
	ovalError,
	ovalPolygon,
	planArc,
	rectPolygon,
	ROUNDOFF,
	rotate,
	type ArcPlan,
} from "./geometry.ts";
import {
	CIRCLE_VERTICES,
	MAX_ARC_PIECES,
	MAX_COPPER_ITEMS,
	MAX_OUTLINE_EDGES,
	MAX_VERTICES,
} from "./limits.ts";
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
	readonly slop: number; // mm; how far the modelled copper may differ from the true copper (0 for a straight track)
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
	readonly slop: number; // mm; how far the modelled outline may differ from the true pad (0 for a rectangle)
};

export type Via = {
	readonly id: string;
	readonly at: Vec2;
	readonly size: number;
	readonly drill: number;
	readonly netName: string;
	readonly poly: readonly Vec2[];
	readonly slop: number; // mm; how far the modelled polygon may differ from the true via
};

/** A non-plated hole. It is removed material on every layer: it conducts nothing and no copper may enter it. */
export type Hole = {
	readonly id: string; // "hole-N"; the file's own labels are not trusted for identity
	readonly ref: string;
	readonly name: string;
	readonly center: Vec2;
	readonly drill: number; // mm; the bore's diameter
	readonly poly: readonly Vec2[]; // the bore's outline
	readonly slop: number; // mm; how far the modelled bore may differ from the true bore
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
	readonly pads: readonly PadInst[]; // conducting pads only; a non-plated hole is in holes
	readonly vias: readonly Via[];
	readonly holes: readonly Hole[];
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
	holes: [],
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

/** How far a pad's polygon may differ from its true outline. A rectangle is exact; a circle and an oval are not. */
function padError(shape: string, size: Vec2): number {
	if (shape === "circle") return circleError(size[0] / 2);
	if (shape === "oval") return ovalError(size);
	return 0;
}

/** An arc's end points and its plan, or undefined when a mandatory point is missing. */
function arcOf(list: readonly SExpr[]): { readonly start: Vec2; readonly end: Vec2; readonly plan: ArcPlan } | undefined {
	const s = point(child(list, "start"));
	const m = point(child(list, "mid"));
	const e = point(child(list, "end"));
	if (!s || !m || !e) return undefined;
	return { start: s, end: e, plan: planArc(s, m, e, MAX_ARC_ERROR, MAX_ARC_PIECES) };
}

/** Splits an arc into straight pieces within the chord-error budget, or undefined when it cannot be flattened. */
function arcTrack(list: readonly SExpr[]): Vec2[] | undefined {
	const arc = arcOf(list);
	if (!arc || !arc.plan.ok) return undefined;
	return arcPoints(arc.start, arc.end, arc.plan);
}

/** The straight pieces an arc flattens to, counted without building them. Zero when it cannot be flattened. */
function arcPieces(list: readonly SExpr[]): number {
	const arc = arcOf(list);
	return arc && arc.plan.ok ? arc.plan.pieces : 0;
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

// The supported subset. A construct outside these lists fails the parse with its name, so it is never silently
// ignored. A zone is the one exception: it is recognised at any depth and reported by the no-zones rule.
const ROOT_HEADS = new Set([
	"version",
	"generator",
	"generator_version",
	"general",
	"paper",
	"title_block",
	"layers",
	"setup",
	"net",
	"footprint",
	"segment",
	"arc",
	"via",
	"gr_line",
	"gr_rect",
	"gr_arc",
	"gr_circle",
	"gr_text",
	"gr_poly",
	"gr_curve",
]);
const FOOTPRINT_HEADS = new Set([
	"layer",
	"at",
	"uuid",
	"tstamp",
	"tedit",
	"locked",
	"placed",
	"descr",
	"tags",
	"path",
	"attr",
	"property",
	"fp_text",
	"fp_line",
	"fp_rect",
	"fp_circle",
	"fp_arc",
	"fp_poly",
	"fp_curve",
	"pad",
	"model",
	"solder_mask_margin",
	"solder_paste_margin",
	"solder_paste_ratio",
]);
const PAD_HEADS = new Set([
	"at",
	"size",
	"drill",
	"layers",
	"net",
	"uuid",
	"tstamp",
	"pinfunction",
	"pintype",
	"solder_mask_margin",
	"solder_paste_margin",
	"solder_paste_ratio",
]);
const TRACK_HEADS = new Set(["start", "mid", "end", "width", "layer", "net", "locked", "tstamp", "uuid", "status"]);
const VIA_HEADS = new Set(["at", "size", "drill", "layers", "net", "free", "locked", "tenting", "uuid", "tstamp"]);
const PAD_TYPES = new Set(["smd", "thru_hole", "np_thru_hole"]);
// A roundrect is not modelled: its corner ratio would change the copper, so it is refused rather than drawn square.
const PAD_SHAPES = new Set(["rect", "circle", "oval"]);
const PAD_LAYER = /^(F|B|\*)\.(Cu|Mask|Paste)$/;
/** Two lengths within this of each other are the same length, mm. */
const BORE_TOL = 0.001;
const EDGE_HEADS = new Set(["gr_line", "gr_rect", "gr_arc", "gr_circle"]);
const METADATA_LAYER = /^(F|B)\.(SilkS|Fab|CrtYd)$|^(Dwgs|Cmts|Eco1|Eco2)\.User$|^User\.[1-9]$/;
// A finite decimal written in plain notation. Longer forms such as 0x10 or NaN are rejected as malformed.
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MAX_COORD = 1_000_000; // millimetres; a coordinate or length beyond this is malformed
const COORD_HEADS = new Set(["start", "mid", "end", "center", "at", "xy"]);
const ARC_HEADS = new Set(["arc", "gr_arc", "fp_arc"]);
/** The mandatory point fields of each record head. A record missing one fails the parse. */
const REQUIRED_POINTS = new Map<string, readonly string[]>([
	["segment", ["start", "end"]],
	["arc", ["start", "mid", "end"]],
	["via", ["at"]],
	["footprint", ["at"]],
	["pad", ["at"]],
	["gr_line", ["start", "end"]],
	["gr_rect", ["start", "end"]],
	["gr_arc", ["start", "mid", "end"]],
	["gr_circle", ["center", "end"]],
	["fp_line", ["start", "end"]],
	["fp_rect", ["start", "end"]],
	["fp_arc", ["start", "mid", "end"]],
	["fp_circle", ["center", "end"]],
]);

function listOf(item: SExpr | undefined): readonly SExpr[] | undefined {
	return Array.isArray(item) ? (item as readonly SExpr[]) : undefined;
}

/** The first child of a list that is outside its allowlist, named for the error, or undefined. Zones are skipped. */
function unexpectedChild(list: readonly SExpr[], allowed: ReadonlySet<string>, atoms: number): string | undefined {
	const owner = String(list[0]);
	for (let i = 1; i < list.length; i++) {
		const item = list[i] as SExpr;
		if (typeof item === "string") {
			if (i > atoms) return `unexpected "${item}" in (${owner})`;
			continue;
		}
		const head = item[0];
		if (head === "zone") continue;
		if (typeof head !== "string" || !allowed.has(head)) {
			return `unsupported (${typeof head === "string" ? head : "?"}) in (${owner})`;
		}
	}
	return undefined;
}

function isCoordinate(v: SExpr | undefined): boolean {
	return typeof v === "string" && NUMBER.test(v) && Math.abs(Number(v)) <= MAX_COORD;
}

/** A mandatory length: a finite, positive number within the cap. */
function isLength(v: SExpr | undefined): boolean {
	return isCoordinate(v) && Number(v) > 0;
}

function isAngle(v: SExpr | undefined): boolean {
	return typeof v === "string" && NUMBER.test(v) && Number.isFinite(Number(v));
}

/** One coordinate field: two coordinates, and for `at` an optional third value that is a finite angle. */
function coordinateFieldProblem(field: readonly SExpr[]): string | undefined {
	const head = String(field[0]);
	const atoms = field.slice(1);
	const ok =
		head === "at"
			? (atoms.length === 2 || (atoms.length === 3 && isAngle(atoms[2]))) && isCoordinate(atoms[0]) && isCoordinate(atoms[1])
			: atoms.length === 2 && isCoordinate(atoms[0]) && isCoordinate(atoms[1]);
	return ok ? undefined : `malformed (${head}) coordinates`;
}

/** The first malformed coordinate field inside a record, at any depth. Zones are skipped. */
function coordinateProblem(record: readonly SExpr[]): string | undefined {
	const stack: (readonly SExpr[])[] = [record];
	while (stack.length > 0) {
		const list = stack.pop() as readonly SExpr[];
		const head = list[0];
		if (head === "zone") continue;
		if (typeof head === "string" && COORD_HEADS.has(head)) {
			const problem = coordinateFieldProblem(list);
			if (problem) return problem;
		}
		for (const item of list) {
			const sub = listOf(item);
			if (sub) stack.push(sub);
		}
	}
	return undefined;
}

function requiredProblem(record: readonly SExpr[], names: readonly string[] | undefined): string | undefined {
	for (const name of names ?? []) {
		if (!child(record, name)) return `(${name}) missing from (${String(record[0])})`;
	}
	return undefined;
}

/** A mandatory length field: exactly `count` positive lengths after its head. */
function lengthsProblem(record: readonly SExpr[], name: string, count: number): string | undefined {
	const owner = String(record[0]);
	const field = child(record, name);
	if (!field) return `(${name}) missing from (${owner})`;
	const values = field.slice(1);
	return values.length === count && values.every(v => isLength(v)) ? undefined : `invalid (${name}) in (${owner})`;
}

/** An arc that is collinear, or that needs more straight pieces than the budget allows, is not supported. */
function arcProblem(arc: readonly SExpr[]): string | undefined {
	const planned = arcOf(arc)?.plan;
	if (!planned || planned.ok) return undefined;
	const head = String(arc[0]);
	return planned.reason === "degenerate"
		? `degenerate (${head}): its three points are collinear`
		: `(${head}) needs more than ${MAX_ARC_PIECES} straight pieces`;
}

/** The mandatory points, the coordinates, and the arc geometry of one record, or undefined when all are sound. */
function numericProblem(record: readonly SExpr[]): string | undefined {
	const head = String(record[0]);
	const problem = requiredProblem(record, REQUIRED_POINTS.get(head)) ?? coordinateProblem(record);
	if (problem) return problem;
	return ARC_HEADS.has(head) ? arcProblem(record) : undefined;
}

function graphicProblem(g: readonly SExpr[], inFootprint: boolean): string | undefined {
	const head = String(g[0]);
	const layer = child(g, "layer")?.[1];
	if (typeof layer !== "string") return `(${head}) without a layer`;
	if (layer === "Edge.Cuts") {
		if (inFootprint || !EDGE_HEADS.has(head)) return `(${head}) on Edge.Cuts`;
	} else if (!METADATA_LAYER.test(layer)) {
		return `(${head}) on layer ${layer}`;
	}
	return numericProblem(g);
}

/** A straight track of no length has no direction, so the checker cannot place its copper. */
function zeroLengthProblem(t: readonly SExpr[]): string | undefined {
	if (t[0] !== "segment") return undefined;
	const a = point(child(t, "start"));
	const b = point(child(t, "end"));
	return a && b && dist(a, b) <= ROUNDOFF ? "(segment) of zero length" : undefined;
}

function trackProblem(t: readonly SExpr[]): string | undefined {
	const bad = unexpectedChild(t, TRACK_HEADS, 0);
	if (bad) return bad;
	const layer = child(t, "layer")?.[1];
	if (layer !== "F.Cu" && layer !== "B.Cu") return `(${String(t[0])}) on layer ${String(layer)}`;
	return numericProblem(t) ?? lengthsProblem(t, "width", 1) ?? zeroLengthProblem(t);
}

function viaProblem(v: readonly SExpr[]): string | undefined {
	return (
		unexpectedChild(v, VIA_HEADS, 0) ?? numericProblem(v) ?? lengthsProblem(v, "size", 1) ?? lengthsProblem(v, "drill", 1)
	);
}

/**
 * A non-plated hole is a round bore of its drill. Copper around it is unsupported, since the bore would then not be
 * the only removed material. Copper is allowed only when it is exactly the bore: a round pad of the drill's diameter.
 * A hole with mask layers only has no copper at all, so it is a bore and nothing more.
 */
function boreProblem(p: readonly SExpr[], name: string, ref: string, shape: string, copper: boolean): string | undefined {
	const drillProblem = lengthsProblem(p, "drill", 1);
	if (drillProblem) return drillProblem;
	if (!copper) return undefined;
	const drill = num(child(p, "drill"), 1);
	const size = point(child(p, "size"));
	const exact =
		shape === "circle" &&
		drill !== undefined &&
		size !== undefined &&
		Math.abs(size[0] - drill) <= BORE_TOL &&
		Math.abs(size[1] - drill) <= BORE_TOL;
	return exact ? undefined : `non-plated hole ${name} on ${ref} has copper beyond its bore, which is unsupported`;
}

function padProblem(p: readonly SExpr[], ref: string): string | undefined {
	const bad = unexpectedChild(p, PAD_HEADS, 3);
	if (bad) return bad;
	const name = p[1];
	const type = p[2];
	const shape = p[3];
	if (typeof name !== "string") return `pad without a name on ${ref}`;
	if (typeof type !== "string" || !PAD_TYPES.has(type)) return `pad type ${String(type)} on ${ref}`;
	if (typeof shape !== "string" || !PAD_SHAPES.has(shape)) return `pad shape ${String(shape)} on ${ref}`;
	const layers = child(p, "layers");
	for (const layer of (layers ?? []).slice(1)) {
		if (typeof layer !== "string" || !PAD_LAYER.test(layer)) return `pad layer ${String(layer)} on ${ref}`;
	}
	const copper = copperLayersOf(layers);
	// A through-hole or SMD pad is copper, so it needs a copper layer. A non-plated hole may be a mask-only bore.
	if (type !== "np_thru_hole" && copper.length === 0) return `pad ${name} on ${ref} has no copper layer`;
	const structural = numericProblem(p) ?? lengthsProblem(p, "size", 2);
	if (structural) return structural;
	if (type === "np_thru_hole") return boreProblem(p, name, ref, shape, copper.length > 0);
	// An SMD pad is a flat land and never carries a hole. A through-hole pad needs its drill.
	return type === "smd"
		? child(p, "drill")
			? `smd pad ${name} on ${ref} carries a drill`
			: undefined
		: lengthsProblem(p, "drill", 1);
}

function footprintProblem(fp: readonly SExpr[]): string | undefined {
	const bad = unexpectedChild(fp, FOOTPRINT_HEADS, 1);
	if (bad) return bad;
	if (typeof fp[1] !== "string") return "footprint without a library name";
	const layer = child(fp, "layer")?.[1];
	if (layer !== "F.Cu") return `footprint on layer ${String(layer)}; only front-side footprints are supported`;
	const ref = propertyReference(fp) || String(fp[1]);
	const structural = numericProblem(fp);
	if (structural) return structural;
	for (const item of fp.slice(2)) {
		const list = listOf(item);
		const head = list?.[0];
		if (!list || typeof head !== "string") continue;
		const problem = head === "pad" ? padProblem(list, ref) : head.startsWith("fp_") ? graphicProblem(list, true) : undefined;
		if (problem) return problem;
	}
	return undefined;
}

/** The first construct in the board that is outside the supported subset, or undefined. */
function boardProblem(root: readonly SExpr[]): string | undefined {
	const bad = unexpectedChild(root, ROOT_HEADS, 0);
	if (bad) return bad;
	for (const item of root.slice(1)) {
		const list = listOf(item);
		const head = list?.[0];
		if (!list || typeof head !== "string") continue;
		const problem =
			head === "segment" || head === "arc"
				? trackProblem(list)
				: head === "via"
					? viaProblem(list)
					: head === "footprint"
						? footprintProblem(list)
						: head.startsWith("gr_")
							? graphicProblem(list, false)
							: undefined;
		if (problem) return problem;
	}
	return undefined;
}

/** True when a zone appears anywhere in the tree, at any depth. */
function containsZone(root: readonly SExpr[]): boolean {
	const stack: (readonly SExpr[])[] = [root];
	while (stack.length > 0) {
		const list = stack.pop() as readonly SExpr[];
		if (list[0] === "zone") return true;
		for (const item of list) {
			const sub = listOf(item);
			if (sub) stack.push(sub);
		}
	}
	return false;
}

/**
 * The work the board would cost, counted before any point or polygon is built: outline edges, flattened vertices,
 * and copper items. Counts only over-estimate, so a board that passes is within every limit. The first limit
 * exceeded is named.
 */
function admissionProblem(root: readonly SExpr[]): string | undefined {
	const onEdge = (g: readonly SExpr[]): boolean => child(g, "layer")?.[1] === "Edge.Cuts";
	let edges = 0;
	let vertices = 0;
	let copper = 0;
	for (const g of children(root, "gr_line")) if (onEdge(g)) edges += 1;
	for (const g of children(root, "gr_rect")) if (onEdge(g)) edges += 4;
	for (const g of children(root, "gr_arc")) {
		const pieces = arcPieces(g);
		vertices += pieces;
		if (onEdge(g)) edges += pieces;
	}
	for (const g of children(root, "gr_circle")) if (onEdge(g)) vertices += CIRCLE_VERTICES;
	for (const a of children(root, "arc")) {
		const pieces = arcPieces(a);
		vertices += pieces;
		copper += pieces;
	}
	copper += children(root, "segment").length + children(root, "via").length;
	for (const fp of children(root, "footprint")) copper += children(fp, "pad").length;
	if (edges > MAX_OUTLINE_EDGES) return `outline has more than ${MAX_OUTLINE_EDGES} edges`;
	if (vertices > MAX_VERTICES) return `too many flattened vertices (more than ${MAX_VERTICES})`;
	if (copper > MAX_COPPER_ITEMS) return `too many copper items (more than ${MAX_COPPER_ITEMS})`;
	return undefined;
}

export function readBoard(text: string): Board {
	const parsed = parseSexprs(text);
	if (!parsed.ok) return { ...EMPTY, error: parsed.error };
	const top = parsed.value;
	const root = top.length === 1 ? listOf(top[0]) : undefined;
	if (!root || root[0] !== "kicad_pcb") return { ...EMPTY, error: "not a single kicad_pcb board" };

	const hasZones = containsZone(root);
	const problem = boardProblem(root);
	if (problem) return { ...EMPTY, hasZones, error: `unsupported construct: ${problem}` };
	const limit = admissionProblem(root);
	if (limit) return { ...EMPTY, hasZones, error: limit };

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
		tracks.push({ id: `track-${tracks.length}`, layer, a, b, width, netName: netNameOf(seg), slop: 0 });
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
				// Each piece's chord lies within MAX_ARC_ERROR of the true arc (see planArc).
				slop: MAX_ARC_ERROR,
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
			slop: circleError(size / 2),
		});
	}

	const footprints: Footprint[] = [];
	const pads: PadInst[] = [];
	const holes: Hole[] = [];
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
				slop: padError(shape, size),
			};
			fpPads.push(inst);
			if (type === "np_thru_hole") {
				// A non-plated hole is removed material on every layer. It is not copper, so it joins no net.
				if (drill !== undefined) {
					holes.push({
						id: `hole-${holes.length}`,
						ref,
						name,
						center,
						drill,
						poly: circlePolygon(center, drill / 2),
						slop: circleError(drill / 2),
					});
				}
			} else if (inst.layers.length > 0) {
				pads.push(inst);
			}
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
		holes,
		footprints,
	};
}
