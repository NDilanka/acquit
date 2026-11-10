// Checks a KiCad PCB file against a job spec. Public rules come first, then the hidden checks when a hidden
// sample is given. Connectivity is geometric: a track joins a pad only where the copper touches, and the
// file's net labels on tracks are never used for it.

import { readBoard, type Board, type CopperLayer, type Hole, type PadInst, type Via } from "./board.ts";
import {
	circlePolygon,
	dist,
	pointInPolygon,
	polygonDistance,
	rectPolygon,
	ROUNDOFF,
	segmentPolygonDistance,
	segmentSegmentDistance,
} from "./geometry.ts";
import { MAX_SEGMENT_TESTS } from "./limits.ts";
import type { Finding, HiddenSample, ScenePath, Scene, Spec, Verdict, Vec2 } from "./types.ts";

/** Tolerance for comparing a measured value to a limit, so float noise never fails a clean board. */
const EPS = 1e-4;
const TOP_Z = 1.6;
const DRILL_TOL = 0.01;
const MAX_MEASURE = 1;

type Box = readonly [number, number, number, number];

// slop is how far the modelled copper may differ from the true copper, to either side (see board.ts).
type TrackGeo = {
	readonly kind: "track";
	readonly layers: readonly CopperLayer[];
	readonly a: Vec2;
	readonly b: Vec2;
	readonly width: number;
	readonly box: Box;
	readonly length: number;
	readonly slop: number;
};
type PolyGeo = {
	readonly kind: "poly";
	readonly layers: readonly CopperLayer[];
	readonly poly: readonly Vec2[];
	readonly box: Box;
	readonly slop: number;
	readonly pad?: PadInst;
	readonly via?: Via;
	readonly hole?: Hole; // a bore: removed material, never copper and never a contact
};
type Geo = TrackGeo | PolyGeo;

function boxOf(points: readonly Vec2[], margin: number): Box {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		minX = Math.min(minX, p[0]);
		minY = Math.min(minY, p[1]);
		maxX = Math.max(maxX, p[0]);
		maxY = Math.max(maxY, p[1]);
	}
	return [minX - margin, minY - margin, maxX + margin, maxY + margin];
}

function boxGap(a: Box, b: Box): number {
	const dx = Math.max(a[0] - b[2], b[0] - a[2], 0);
	const dy = Math.max(a[1] - b[3], b[1] - a[3], 0);
	return Math.hypot(dx, dy);
}

function sharedLayer(a: Geo, b: Geo): CopperLayer | undefined {
	for (const l of a.layers) if (b.layers.includes(l)) return l;
	return undefined;
}

/** The gap between two copper items. Zero or less means they touch or overlap. */
function gap(x: Geo, y: Geo): number {
	if (x.kind === "track") {
		if (y.kind === "track") return segmentSegmentDistance(x.a, x.b, y.a, y.b) - (x.width + y.width) / 2;
		return segmentPolygonDistance(x.a, x.b, y.poly) - x.width / 2;
	}
	if (y.kind === "track") return segmentPolygonDistance(y.a, y.b, x.poly) - y.width / 2;
	return polygonDistance(x.poly, y.poly);
}

/**
 * The segment-pair tests left for one verification. Every scan draws on the same budget, and once it is spent it
 * stays spent, so no later scan does any work.
 */
type Budget = { left: number; spent: boolean };

/** Takes tests from the budget. Returns false, and keeps returning false, once the budget is spent. */
function take(budget: Budget, tests: number): boolean {
	if (budget.spent) return false;
	budget.left -= tests;
	if (budget.left < 0) budget.spent = true;
	return !budget.spent;
}

/** The straight edges a copper item costs in a distance test: one for a track, one per side for a polygon. */
function edgesOf(g: Geo): number {
	return g.kind === "track" ? 1 : g.poly.length;
}

/**
 * Calls cb for each pair of items that share a layer and whose modelled gap may be within limit. A box lies around
 * its copper, so the box gap is never more than the copper gap, and the limit is widened by both items' slop so no
 * pair that could be within limit is skipped. Each pair is charged its edge-pair count before it is measured, and the
 * scan stops as soon as the budget is spent.
 */
function forEachNearPair(
	geos: readonly Geo[],
	limit: number,
	budget: Budget,
	cb: (i: number, j: number, g: number) => void,
): void {
	for (let i = 0; i < geos.length; i++) {
		const x = geos[i] as Geo;
		for (let j = i + 1; j < geos.length; j++) {
			const y = geos[j] as Geo;
			if (!sharedLayer(x, y)) continue;
			if (boxGap(x.box, y.box) > limit + x.slop + y.slop) continue;
			if (!take(budget, edgesOf(x) * edgesOf(y))) return;
			cb(i, j, gap(x, y));
		}
	}
}

function representative(g: Geo): Vec2 {
	if (g.kind === "track") return [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
	let x = 0;
	let y = 0;
	for (const p of g.poly) {
		x += p[0];
		y += p[1];
	}
	return [x / g.poly.length, y / g.poly.length];
}

function zOf(layer: CopperLayer | undefined): number {
	return layer === "F.Cu" ? TOP_Z : 0;
}

function fmt(n: number): string {
	return n.toFixed(2);
}

function shoelaceArea(poly: readonly Vec2[]): number {
	let s = 0;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i] as Vec2;
		const q = poly[(i + 1) % poly.length] as Vec2;
		s += p[0] * q[1] - q[0] * p[1];
	}
	return Math.abs(s) / 2;
}

/**
 * The disjoint-set root of each item, and the first pair whose contact cannot be decided. Items touch only when the
 * true gap is within float roundoff. The true gap lies within slop of the modelled gap, so a pair is joined when its
 * modelled gap is within roundoff even after allowing for slop, and is open when its modelled gap exceeds slop plus
 * roundoff. A pair in between could go either way, so it is reported rather than guessed.
 */
function connectedComponents(geos: readonly Geo[], budget: Budget): { comp: number[]; ambiguous: Pair | undefined } {
	const parent = geos.map((_, i) => i);
	const find = (i: number): number => {
		let r = i;
		while (parent[r] !== r) r = parent[r] as number;
		let c = i;
		while (parent[c] !== r) {
			const next = parent[c] as number;
			parent[c] = r;
			c = next;
		}
		return r;
	};
	let ambiguous: Pair | undefined;
	forEachNearPair(geos, ROUNDOFF, budget, (i, j, g) => {
		const s = (geos[i] as Geo).slop + (geos[j] as Geo).slop;
		if (g + s <= ROUNDOFF) parent[find(i)] = find(j);
		else if (g - s <= ROUNDOFF && !ambiguous) ambiguous = { i, j, g };
	});
	return { comp: geos.map((_, i) => find(i)), ambiguous };
}

type Pair = { readonly i: number; readonly j: number; readonly g: number };

/**
 * The closest pair that breaks a clearance limit, scanned in item order so the choice is stable. A pair breaks the
 * limit when its gap is short even after allowing for the slop of its curved items, since the true gap may be that short.
 */
function worstClearance(geos: readonly Geo[], comp: readonly number[], limit: number, budget: Budget): Pair | undefined {
	let worst: Pair | undefined;
	forEachNearPair(geos, limit, budget, (i, j, g) => {
		if (comp[i] === comp[j]) return;
		const s = (geos[i] as Geo).slop + (geos[j] as Geo).slop;
		if (g - s < limit - EPS && (!worst || g < worst.g)) worst = { i, j, g };
	});
	return worst;
}

/**
 * The copper item that comes closest to a bore while breaking the limit, or undefined. Every copper item is checked
 * against every bore, whatever its net, since a bore has no net. The same slop allowance as worstClearance applies.
 */
function worstBoreClearance(
	geos: readonly Geo[],
	bores: readonly PolyGeo[],
	limit: number,
	budget: Budget,
): { geo: Geo; bore: PolyGeo; g: number } | undefined {
	let worst: { geo: Geo; bore: PolyGeo; g: number } | undefined;
	for (const bore of bores) {
		for (const geo of geos) {
			if (boxGap(geo.box, bore.box) > limit + geo.slop + bore.slop) continue;
			if (!take(budget, edgesOf(geo) * edgesOf(bore))) return worst;
			const g = gap(geo, bore);
			if (g - (geo.slop + bore.slop) < limit - EPS && (!worst || g < worst.g)) worst = { geo, bore, g };
		}
	}
	return worst;
}

/** Names the curved item of an undecidable contact, so the parse failure says what the checker cannot model. */
function curvedName(g: Geo): string {
	if (g.kind === "track") return "an arc";
	return g.via ? "a via" : "a round or oval pad";
}

function minClearanceFound(geos: readonly Geo[], comp: readonly number[], budget: Budget): number {
	let best = MAX_MEASURE;
	forEachNearPair(geos, MAX_MEASURE, budget, (i, j, g) => {
		if (comp[i] !== comp[j] && g < best) best = g;
	});
	return best;
}

function netOfPad(spec: Spec): Map<string, string> {
	const map = new Map<string, string>();
	for (const [net, pads] of Object.entries(spec.netlist)) {
		for (const p of pads) if (!map.has(p)) map.set(p, net);
	}
	return map;
}

function specPadIds(spec: Spec): string[] {
	const ids: string[] = [];
	for (const part of spec.parts) for (const p of part.pads) ids.push(`${part.ref}.${p.name}`);
	return ids;
}

function missingFinding(rule: string, message: string, at?: Vec2, z = 0, hidden = false): Finding {
	return at ? { rule, ok: false, hidden, message, at: [at[0], at[1], z] } : { rule, ok: false, hidden, message };
}

function okFinding(rule: string, message: string, hidden = false): Finding {
	return { rule, ok: true, hidden, message };
}

function failedParse(spec: Spec, error: string): Verdict {
	return {
		workflow: "pcb",
		pass: false,
		findings: [
			{ rule: "parse", ok: false, hidden: false, message: `The file could not be read as a KiCad PCB: ${error}.` },
		],
		measured: {},
		scene: {
			units: "mm",
			size: [spec.board.size[0], spec.board.size[1], TOP_Z],
			paths: [],
		},
	};
}

export function verify(spec: Spec, artefact: string, hidden?: HiddenSample): Verdict {
	const board: Board = readBoard(artefact);
	if (!board.ok) return failedParse(spec, board.error ?? "the file is empty or malformed");

	const findings: Finding[] = [];
	const geos: Geo[] = [];
	for (const t of board.tracks) {
		geos.push({
			kind: "track",
			layers: [t.layer],
			a: t.a,
			b: t.b,
			width: t.width,
			box: boxOf([t.a, t.b], t.width / 2),
			length: dist(t.a, t.b),
			slop: t.slop,
		});
	}
	for (const p of board.pads) {
		geos.push({ kind: "poly", layers: p.layers, poly: p.poly, box: boxOf(p.poly, 0), slop: p.slop, pad: p });
	}
	for (const v of board.vias) {
		geos.push({ kind: "poly", layers: ["F.Cu", "B.Cu"], poly: v.poly, box: boxOf(v.poly, 0), slop: v.slop, via: v });
	}
	// Bores are kept apart from geos: they conduct nothing, so they take no part in connectivity or net checks. Copper
	// must still clear them, and they must lie inside the board.
	const bores: PolyGeo[] = [];
	for (const h of board.holes) {
		bores.push({ kind: "poly", layers: ["F.Cu", "B.Cu"], poly: h.poly, box: boxOf(h.poly, 0), slop: h.slop, hole: h });
	}
	const budget: Budget = { left: MAX_SEGMENT_TESTS, spent: false };
	const { comp, ambiguous } = connectedComponents(geos, budget);
	if (ambiguous) {
		const x = geos[ambiguous.i] as Geo;
		const y = geos[ambiguous.j] as Geo;
		const curved = x.slop > 0 ? x : y;
		return failedParse(
			spec,
			`a curved item (${curvedName(curved)}) lies within its approximation error of other copper, so its contact cannot be decided`,
		);
	}

	const padGeo = new Map<string, number>();
	geos.forEach((g, i) => {
		if (g.kind === "poly" && g.pad && !padGeo.has(g.pad.id)) padGeo.set(g.pad.id, i);
	});

	// Outline: the largest closed loop is the board.
	let boardPoly: readonly Vec2[] | undefined;
	for (const loop of board.outlineLoops) {
		if (!boardPoly || shoelaceArea(loop) > shoelaceArea(boardPoly)) boardPoly = loop;
	}
	const bbox = boardPoly ? boxOf(boardPoly, 0) : undefined;
	const boardW = bbox ? bbox[2] - bbox[0] : 0;
	const boardH = bbox ? bbox[3] - bbox[1] : 0;

	// zones
	findings.push(
		board.hasZones
			? { rule: "no-zones", ok: false, hidden: false, message: "The file has a copper zone, which this checker does not model." }
			: okFinding("no-zones", "The file has no copper zones."),
	);

	// outline
	{
		const tol = spec.board.tolerance;
		if (!boardPoly || board.outlineOpen) {
			findings.push({
				rule: "outline",
				ok: false,
				hidden: false,
				message: "The board outline is missing or does not close.",
			});
		} else if (Math.abs(boardW - spec.board.size[0]) > tol || Math.abs(boardH - spec.board.size[1]) > tol) {
			findings.push({
				rule: "outline",
				ok: false,
				hidden: false,
				message: `The board outline is ${fmt(boardW)} by ${fmt(boardH)} mm; the spec asks for ${fmt(spec.board.size[0])} by ${fmt(spec.board.size[1])} mm.`,
			});
		} else {
			findings.push(okFinding("outline", "The board outline is closed and matches the spec size."));
		}
	}

	// parts-placed
	{
		let bad: string | undefined;
		let at: Vec2 | undefined;
		for (const part of spec.parts) {
			const fp = board.footprints.find(f => f.ref === part.ref);
			if (!fp) {
				bad = `Part ${part.ref} is missing from the board.`;
				break;
			}
			if (dist(fp.at, part.at) > 0.01) {
				bad = `Part ${part.ref} sits at (${fmt(fp.at[0])}, ${fmt(fp.at[1])}); the spec places it at (${fmt(part.at[0])}, ${fmt(part.at[1])}).`;
				at = fp.at;
				break;
			}
			for (const sp of part.pads) {
				const pad = fp.pads.find(p => p.name === sp.name);
				if (!pad) {
					bad = `Pad ${part.ref}.${sp.name} is missing from the board.`;
					at = fp.at;
					break;
				}
				if (dist(pad.localOffset, sp.offset) > 0.01) {
					bad = `Pad ${part.ref}.${sp.name} is ${fmt(dist(pad.localOffset, sp.offset))} mm from its footprint position; the limit is 0.01 mm.`;
					at = pad.center;
					break;
				}
				if (dist(pad.size, sp.size) > 0.01) {
					bad = `Pad ${part.ref}.${sp.name} has the wrong size.`;
					at = pad.center;
					break;
				}
			}
			if (bad) break;
		}
		findings.push(
			bad
				? missingFinding("parts-placed", bad, at, 1.6)
				: okFinding("parts-placed", "Every pad sits where the footprint puts it."),
		);
	}

	// inside-board
	{
		if (!boardPoly) {
			findings.push({
				rule: "inside-board",
				ok: false,
				hidden: false,
				message: "There is no closed outline to check the copper against.",
			});
		} else {
			const edges: [Vec2, Vec2][] = [];
			for (let i = 0; i < boardPoly.length; i++) {
				edges.push([boardPoly[i] as Vec2, boardPoly[(i + 1) % boardPoly.length] as Vec2]);
			}
			let worst: { g: number; at: Vec2; layer: CopperLayer | undefined; outside: boolean; hole: boolean } | undefined;
			[...geos, ...bores].forEach(g => {
				const pts = g.kind === "track" ? [g.a, g.b] : g.poly;
				// Each item is tested against every outline edge, and each of its points against the whole outline.
				if (!take(budget, (edgesOf(g) + pts.length) * edges.length)) return;
				const outside = !pts.every(p => pointInPolygon(p, boardPoly));
				let minEdge = Infinity;
				for (const [e0, e1] of edges) {
					const d = g.kind === "track" ? segmentSegmentDistance(g.a, g.b, e0, e1) - g.width / 2 : segmentPolygonDistance(e0, e1, g.poly);
					minEdge = Math.min(minEdge, d);
				}
				if (outside || minEdge < spec.rules.edgeClearance - EPS) {
					const score = outside ? -1 : minEdge;
					if (!worst || score < worst.g)
						worst = { g: score, at: representative(g), layer: g.layers[0], outside, hole: g.kind === "poly" && g.hole !== undefined };
				}
			});
			if (!worst) {
				findings.push(okFinding("inside-board", "All copper and every drilled hole is inside the board, clear of the edge."));
			} else {
				const w = worst as { g: number; at: Vec2; layer: CopperLayer | undefined; outside: boolean; hole: boolean };
				const item = w.hole ? "A drilled hole" : "A copper item";
				findings.push({
					rule: "inside-board",
					ok: false,
					hidden: false,
					message: w.outside
						? `${item} lies outside the board outline.`
						: `${item} is ${fmt(w.g)} mm from the board edge; the minimum is ${fmt(spec.rules.edgeClearance)} mm.`,
					at: [w.at[0], w.at[1], zOf(w.layer)],
				});
			}
		}
	}

	// pad-nets: the file's pad labels must match the netlist.
	const expectedNet = netOfPad(spec);
	{
		const specIds = new Set(specPadIds(spec));
		let bad: { id: string; got: string; want: string; at: Vec2 } | undefined;
		for (const part of board.footprints) {
			for (const p of part.pads) {
				if (!specIds.has(p.id)) continue;
				const want = expectedNet.get(p.id) ?? "";
				if (p.netName !== want && !bad) bad = { id: p.id, got: p.netName, want, at: p.center };
			}
		}
		findings.push(
			bad
				? missingFinding(
						"pad-nets",
						`Pad ${bad.id} is labelled ${bad.got || "unconnected"}; the netlist says ${bad.want || "unconnected"}.`,
						bad.at,
						TOP_Z,
					)
				: okFinding("pad-nets", "Every pad carries the net the netlist gives it."),
		);
	}

	// connected: pads of one net must share a component.
	{
		let bad: string | undefined;
		let at: Vec2 | undefined;
		for (const [net, pads] of Object.entries(spec.netlist)) {
			const roots = new Set<number>();
			let first: string | undefined;
			for (const pad of pads) {
				const idx = padGeo.get(pad);
				if (idx === undefined) {
					bad = `Pad ${pad} is missing from the board.`;
					break;
				}
				const root = comp[idx] as number;
				if (first === undefined) first = pad;
				roots.add(root);
			}
			if (bad) break;
			if (roots.size > 1) {
				const lone = pads.find(p => comp[padGeo.get(p) as number] !== comp[padGeo.get(first as string) as number]);
				bad = `Net ${net} is not connected: ${first} and ${lone} are not joined by copper.`;
				const g = geos[padGeo.get(lone as string) as number];
				at = g ? representative(g) : undefined;
				break;
			}
		}
		findings.push(
			bad
				? missingFinding("connected", bad, at, TOP_Z)
				: okFinding("connected", "Every net is joined by copper across all of its pads."),
		);
	}

	// no-shorts: a component must not hold pads of two nets.
	{
		let bad: string | undefined;
		let at: Vec2 | undefined;
		const netsByRoot = new Map<number, Set<string>>();
		for (const [pad, net] of expectedNet) {
			const idx = padGeo.get(pad);
			if (idx === undefined) continue;
			const root = comp[idx] as number;
			const set = netsByRoot.get(root) ?? new Set<string>();
			set.add(net);
			netsByRoot.set(root, set);
		}
		for (const [root, nets] of netsByRoot) {
			if (nets.size > 1) {
				const names = [...nets].sort();
				bad = `Nets ${names[0]} and ${names[1]} touch through copper.`;
				const idx = geos.findIndex((_, i) => comp[i] === root && geos[i]?.kind === "poly");
				const g = geos[idx];
				at = g ? representative(g) : undefined;
				break;
			}
		}
		findings.push(
			bad
				? missingFinding("no-shorts", bad, at, TOP_Z)
				: okFinding("no-shorts", "No two nets touch."),
		);
	}

	// clearance: copper of different nets, and any copper against a drilled hole (a bore has no net, so the net rule
	// does not excuse copper entering it). The closer breaking pair is reported.
	{
		const limit = spec.rules.minClearance;
		const worst = worstClearance(geos, comp, limit, budget);
		const bore = worstBoreClearance(geos, bores, limit, budget);
		if (!worst && !bore) {
			findings.push(
				okFinding(
					"clearance",
					`Copper of different nets keeps at least ${fmt(limit)} mm apart, and copper keeps at least ${fmt(limit)} mm from every drilled hole.`,
				),
			);
		} else if (bore && (!worst || bore.g <= worst.g)) {
			const at = representative(bore.geo);
			findings.push({
				rule: "clearance",
				ok: false,
				hidden: false,
				message: `Copper is ${fmt(bore.g)} mm from a drilled hole; the minimum is ${fmt(limit)} mm.`,
				at: [at[0], at[1], zOf(sharedLayer(bore.geo, bore.bore))],
			});
		} else if (worst) {
			const a = geos[worst.i] as Geo;
			const b = geos[worst.j] as Geo;
			const mid = representative(a);
			const other = representative(b);
			const at: Vec2 = [(mid[0] + other[0]) / 2, (mid[1] + other[1]) / 2];
			findings.push({
				rule: "clearance",
				ok: false,
				hidden: false,
				message: `Copper of two different nets is ${fmt(worst.g)} mm apart; the minimum is ${fmt(limit)} mm.`,
				at: [at[0], at[1], zOf(sharedLayer(a, b))],
			});
		}
	}

	// track-width
	{
		let worst: { w: number; at: Vec2 } | undefined;
		for (const g of geos) {
			if (g.kind !== "track") continue;
			if (g.width < spec.rules.minTrackWidth - EPS && (!worst || g.width < worst.w)) {
				worst = { w: g.width, at: representative(g) };
			}
		}
		findings.push(
			worst
				? missingFinding(
						"track-width",
						`A track is ${fmt(worst.w)} mm wide; the minimum is ${fmt(spec.rules.minTrackWidth)} mm.`,
						worst.at,
						TOP_Z,
					)
				: okFinding("track-width", `Every track is at least ${fmt(spec.rules.minTrackWidth)} mm wide.`),
		);
	}

	// power-width: a power net's tracks, wherever they run, meet the net's own minimum.
	{
		let worst: { net: string; w: number; min: number; at: Vec2 } | undefined;
		for (const [net, min] of Object.entries(spec.rules.powerNets)) {
			const firstPad = (spec.netlist[net] ?? [])[0];
			const idx = firstPad ? padGeo.get(firstPad) : undefined;
			if (idx === undefined) continue;
			const root = comp[idx] as number;
			geos.forEach((g, i) => {
				if (g.kind !== "track" || comp[i] !== root) return;
				if (g.width < min - EPS && (!worst || g.width < worst.w)) worst = { net, w: g.width, min, at: representative(g) };
			});
		}
		const w = worst as { net: string; w: number; min: number; at: Vec2 } | undefined;
		findings.push(
			w
				? missingFinding(
						"power-width",
						`The ${w.net} power net has a ${fmt(w.w)} mm track; it needs at least ${fmt(w.min)} mm.`,
						w.at,
						TOP_Z,
					)
				: okFinding("power-width", "Every power net is routed at its own minimum width."),
		);
	}

	// via-rules
	{
		let bad: { message: string; at: Vec2 } | undefined;
		for (const v of board.vias) {
			const ring = (v.size - v.drill) / 2;
			if (v.drill < spec.rules.minViaDrill - EPS) {
				bad = { message: `A via drill is ${fmt(v.drill)} mm; the minimum is ${fmt(spec.rules.minViaDrill)} mm.`, at: v.at };
				break;
			}
			if (ring < spec.rules.minAnnularRing - EPS) {
				bad = { message: `A via annular ring is ${fmt(ring)} mm; the minimum is ${fmt(spec.rules.minAnnularRing)} mm.`, at: v.at };
				break;
			}
		}
		findings.push(
			bad
				? missingFinding("via-rules", bad.message, bad.at, TOP_Z)
				: okFinding("via-rules", "Every via meets the drill and annular ring minimums."),
		);
	}

	// pad-rules: a plated pad's drill must leave the minimum annular ring around it, measured across its smallest copper
	// dimension so an oval or rectangle cannot hide a thin ring behind a wide one.
	{
		let bad: { message: string; at: Vec2 } | undefined;
		for (const p of board.pads) {
			if (p.type !== "thru_hole" || p.drill === undefined) continue;
			const ring = (Math.min(p.size[0], p.size[1]) - p.drill) / 2;
			if (ring < spec.rules.minAnnularRing - EPS) {
				bad = { message: `A pad annular ring is ${fmt(ring)} mm; the minimum is ${fmt(spec.rules.minAnnularRing)} mm.`, at: p.center };
				break;
			}
		}
		findings.push(
			bad
				? missingFinding("pad-rules", bad.message, bad.at, TOP_Z)
				: okFinding("pad-rules", "Every plated pad leaves the minimum annular ring around its drill."),
		);
	}

	// keepouts
	{
		let bad: { name: string; at: Vec2 } | undefined;
		for (const k of spec.keepouts) {
			const rect = rectPolygon(
				[(k.min[0] + k.max[0]) / 2, (k.min[1] + k.max[1]) / 2],
				[k.max[0] - k.min[0], k.max[1] - k.min[1]],
				0,
			);
			for (const g of geos) {
				// The keep-out rectangle has four sides.
				if (!take(budget, edgesOf(g) * 4)) continue;
				const d = g.kind === "track" ? segmentPolygonDistance(g.a, g.b, rect) - g.width / 2 : polygonDistance(g.poly, rect);
				if (d < 0.001 && !bad) bad = { name: k.name, at: representative(g) };
			}
		}
		findings.push(
			bad
				? missingFinding("keepouts", `Copper enters the keep-out ${bad.name}.`, bad.at, TOP_Z)
				: okFinding("keepouts", "No copper enters a keep-out area."),
		);
	}

	// mounting-holes
	{
		let bad: { at: Vec2; drill: number } | undefined;
		// A required mounting hole is a non-plated bore of the required diameter, matched on both sides of the tolerance.
		for (const h of spec.mountingHoles) {
			const found = board.holes.some(b => dist(b.center, h.at) <= 0.05 && Math.abs(b.drill - h.drill) <= DRILL_TOL);
			if (!found && !bad) bad = h;
		}
		findings.push(
			bad
				? missingFinding(
						"mounting-holes",
						`There is no ${fmt(bad.drill)} mm mounting hole at (${fmt(bad.at[0])}, ${fmt(bad.at[1])}).`,
						bad.at,
						TOP_Z,
					)
				: okFinding("mounting-holes", "Every required mounting hole is drilled."),
		);
	}

	// Hidden checks: flying-probe pairs, and any tighter clearance. These carry no positions in their messages.
	const probeEntries: { a: Vec2; b: Vec2; za: number; zb: number; expect: "continuity" | "isolation"; ok: boolean }[] = [];
	if (hidden) {
		let failed: { expect: "continuity" | "isolation" } | undefined;
		for (const probe of hidden.probes) {
			const ia = padGeo.get(probe.a);
			const ib = padGeo.get(probe.b);
			const connected = ia !== undefined && ib !== undefined && comp[ia] === comp[ib];
			const ok = (probe.expect === "continuity") === connected;
			if (!ok && !failed) failed = { expect: probe.expect };
			if (ia !== undefined && ib !== undefined) {
				const ga = geos[ia];
				const gb = geos[ib];
				if (ga && gb && ga.kind === "poly" && gb.kind === "poly") {
					probeEntries.push({
						a: representative(ga),
						b: representative(gb),
						za: zOf(ga.layers.includes("F.Cu") ? "F.Cu" : ga.layers[0]),
						zb: zOf(gb.layers.includes("F.Cu") ? "F.Cu" : gb.layers[0]),
						expect: probe.expect,
						ok,
					});
				}
			}
		}
		findings.push(
			failed
				? {
						rule: "hidden-probe",
						ok: false,
						hidden: true,
						message:
							failed.expect === "isolation"
								? "A hidden probe expected isolation and found a connection."
								: "A hidden probe expected continuity and found none.",
					}
				: okFinding("hidden-probe", "Every hidden probe pair behaved as expected.", true),
		);

		if (hidden.minClearance !== undefined) {
			const limit = hidden.minClearance;
			const tighter = worstClearance(geos, comp, limit, budget);
			const tighterBore = worstBoreClearance(geos, bores, limit, budget);
			findings.push(
				tighter || tighterBore
					? { rule: "hidden-clearance", ok: false, hidden: true, message: "A copper gap is narrower than the hidden limit." }
					: okFinding("hidden-clearance", "Every copper gap meets the hidden limit.", true),
			);
		}
	}

	// measured
	const trackLen = (layer: CopperLayer): number =>
		geos.reduce((s, g) => (g.kind === "track" && g.layers[0] === layer ? s + g.length : s), 0);
	const minTrack = geos.reduce((m, g) => (g.kind === "track" ? Math.min(m, g.width) : m), Infinity);
	const nets = new Set(Object.keys(spec.netlist));
	const measured: Record<string, number | string> = {
		board_width: round(boardW),
		board_height: round(boardH),
		track_length_F_Cu: round(trackLen("F.Cu")),
		track_length_B_Cu: round(trackLen("B.Cu")),
		via_count: board.vias.length,
		min_track_width: Number.isFinite(minTrack) ? round(minTrack) : 0,
		min_clearance: round(minClearanceFound(geos, comp, budget)),
		part_count: board.footprints.length,
		net_count: nets.size,
	};

	// scene
	const paths: ScenePath[] = [];
	const bodyId = (ref: string): string => `part-${ref}`;
	if (boardPoly) {
		paths.push({
			id: "outline",
			kind: "outline",
			layer: "Edge.Cuts",
			z: 0,
			closed: true,
			points: boardPoly,
		});
	}
	// The spec net of each component: the first pad in item order that carries one.
	const netOfRoot = new Map<number, string>();
	geos.forEach((g, i) => {
		if (g.kind !== "poly" || !g.pad) return;
		const net = expectedNet.get(g.pad.id);
		const root = comp[i] as number;
		if (net !== undefined && !netOfRoot.has(root)) netOfRoot.set(root, net);
	});
	geos.forEach((g, i) => {
		if (g.kind === "track") {
			const layer = g.layers[0] as CopperLayer;
			const net = netOfRoot.get(comp[i] as number);
			paths.push({
				id: `track-${i}`,
				kind: "copper",
				layer,
				z: zOf(layer),
				width: g.width,
				closed: false,
				net,
				points: [g.a, g.b],
			});
		} else if (g.pad) {
			for (const layer of g.layers) {
				paths.push({
					id: `pad-${g.pad.id}-${layer}`,
					kind: "pad",
					layer,
					z: zOf(layer),
					closed: true,
					net: netOfRoot.get(comp[i] as number),
					points: g.poly,
				});
			}
		} else if (g.via) {
			paths.push({
				id: `via-${g.via.id}`,
				kind: "via",
				layer: "F.Cu",
				z: TOP_Z,
				closed: true,
				net: netOfRoot.get(comp[i] as number),
				points: g.poly,
			});
		}
	});
	for (const p of board.pads) {
		if (p.drill !== undefined && p.drill > 0) {
			paths.push({ id: `drill-${p.id}`, kind: "drill", layer: "drill", z: 0, closed: true, points: circlePolygon(p.center, p.drill / 2) });
		}
	}
	for (const v of board.vias) {
		paths.push({ id: `drill-${v.id}`, kind: "drill", layer: "drill", z: 0, closed: true, points: circlePolygon(v.at, v.drill / 2) });
	}
	for (const h of board.holes) {
		paths.push({ id: `drill-${h.id}`, kind: "drill", layer: "drill", z: 0, closed: true, points: circlePolygon(h.center, h.drill / 2) });
	}
	for (const fp of board.footprints) {
		if (fp.pads.length === 0) continue;
		const pts = fp.pads.flatMap(p => p.poly);
		const box = boxOf(pts, 0.5);
		paths.push({
			id: bodyId(fp.ref || fp.name),
			kind: "part",
			layer: "F.Cu",
			z: TOP_Z,
			closed: true,
			points: rectPolygon(
				[(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
				[box[2] - box[0], box[3] - box[1]],
				0,
			),
		});
	}

	const scene: Scene = {
		units: "mm",
		size: [round(boardW), round(boardH), TOP_Z],
		stock: { size: [round(boardW), round(boardH), TOP_Z], material: "FR4" },
		paths,
		probes: probeEntries.map(p => ({ a: [p.a[0], p.a[1], p.za], b: [p.b[0], p.b[1], p.zb], expect: p.expect, ok: p.ok })),
	};

	// A scan that ran out of budget saw only part of the board, so no verdict is given on it.
	if (budget.spent) return failedParse(spec, `the board needs more than ${MAX_SEGMENT_TESTS} segment-pair tests to check`);

	return {
		workflow: "pcb",
		pass: findings.every(f => f.ok),
		findings,
		measured,
		scene,
	};
}

function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}

