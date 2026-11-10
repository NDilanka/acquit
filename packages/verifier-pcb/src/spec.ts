// The job spec's shape check. It takes plain JSON from an untrusted source and returns either a Spec or a
// plain reason. It never throws.

import type { HiddenSample, PadRef, PadSpec, PartSpec, Spec, Vec2 } from "./types.ts";

export type SpecResult = { readonly ok: true; readonly spec: Spec } | { readonly ok: false; readonly error: string };
export type HiddenResult = { readonly ok: true; readonly hidden: HiddenSample } | { readonly ok: false; readonly error: string };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function vec2(v: unknown): Vec2 | undefined {
	if (!Array.isArray(v) || v.length !== 2) return undefined;
	const x = num(v[0]);
	const y = num(v[1]);
	return x === undefined || y === undefined ? undefined : [x, y];
}

function padSpec(v: unknown): PadSpec | string {
	if (!isObj(v)) return "a pad is not an object";
	const name = typeof v.name === "string" ? v.name : undefined;
	const offset = vec2(v.offset);
	const size = vec2(v.size);
	const shape = v.shape;
	const type = v.type;
	if (name === undefined || !offset || !size) return "a pad needs a name, offset and size";
	if (shape !== "rect" && shape !== "roundrect" && shape !== "circle" && shape !== "oval") return `pad ${name} has an unknown shape`;
	if (type !== "smd" && type !== "thru_hole" && type !== "np_thru_hole") return `pad ${name} has an unknown type`;
	const drill = v.drill === undefined ? undefined : num(v.drill);
	if (v.drill !== undefined && drill === undefined) return `pad ${name} has a bad drill`;
	const rotation = v.rotation === undefined ? undefined : num(v.rotation);
	if (v.rotation !== undefined && rotation === undefined) return `pad ${name} has a bad rotation`;
	return { name, offset, size, shape, type, drill, rotation };
}

function partSpec(v: unknown): PartSpec | string {
	if (!isObj(v)) return "a part is not an object";
	if (typeof v.ref !== "string" || typeof v.footprint !== "string") return "a part needs a ref and footprint";
	const at = vec2(v.at);
	if (!at) return `part ${v.ref} needs an at position`;
	const rotation = v.rotation === undefined ? undefined : num(v.rotation);
	if (v.rotation !== undefined && rotation === undefined) return `part ${v.ref} has a bad rotation`;
	if (!Array.isArray(v.pads)) return `part ${v.ref} needs a pad list`;
	const pads: PadSpec[] = [];
	for (const p of v.pads) {
		const r = padSpec(p);
		if (typeof r === "string") return `part ${v.ref}: ${r}`;
		pads.push(r);
	}
	return { ref: v.ref, footprint: v.footprint, at, rotation, pads };
}

export function validateSpec(value: unknown): SpecResult {
	if (!isObj(value)) return { ok: false, error: "the spec is not an object" };
	if (typeof value.name !== "string") return { ok: false, error: "the spec needs a name" };

	const board = value.board;
	if (!isObj(board)) return { ok: false, error: "the spec needs a board" };
	const size = vec2(board.size);
	const tolerance = num(board.tolerance);
	if (!size || tolerance === undefined) return { ok: false, error: "the board needs a size and tolerance" };

	if (!Array.isArray(value.parts)) return { ok: false, error: "the spec needs a parts list" };
	const parts: PartSpec[] = [];
	const refs = new Set<string>();
	for (const p of value.parts) {
		const r = partSpec(p);
		if (typeof r === "string") return { ok: false, error: r };
		if (refs.has(r.ref)) return { ok: false, error: `duplicate reference ${r.ref}` };
		refs.add(r.ref);
		parts.push(r);
	}

	const padIds = new Set<string>();
	for (const part of parts) for (const p of part.pads) padIds.add(`${part.ref}.${p.name}`);

	if (!isObj(value.netlist)) return { ok: false, error: "the spec needs a netlist" };
	const netlist: Record<string, readonly PadRef[]> = {};
	for (const [net, list] of Object.entries(value.netlist)) {
		if (!Array.isArray(list) || !list.every(x => typeof x === "string")) return { ok: false, error: `net ${net} needs a list of pads` };
		for (const pad of list as string[]) {
			if (!padIds.has(pad)) return { ok: false, error: `net ${net} names pad ${pad}, which the parts do not define` };
		}
		netlist[net] = list as string[];
	}

	if (!isObj(value.rules)) return { ok: false, error: "the spec needs rules" };
	const r = value.rules;
	const minTrackWidth = num(r.minTrackWidth);
	const minClearance = num(r.minClearance);
	const minViaDrill = num(r.minViaDrill);
	const minAnnularRing = num(r.minAnnularRing);
	const edgeClearance = num(r.edgeClearance);
	if (
		minTrackWidth === undefined ||
		minClearance === undefined ||
		minViaDrill === undefined ||
		minAnnularRing === undefined ||
		edgeClearance === undefined
	) {
		return { ok: false, error: "rules need minTrackWidth, minClearance, minViaDrill, minAnnularRing and edgeClearance" };
	}
	if (!isObj(r.powerNets)) return { ok: false, error: "rules.powerNets must be an object" };
	const powerNets: Record<string, number> = {};
	for (const [net, w] of Object.entries(r.powerNets)) {
		const n = num(w);
		if (n === undefined) return { ok: false, error: `power net ${net} needs a width` };
		powerNets[net] = n;
	}

	const keepouts: Spec["keepouts"][number][] = [];
	if (value.keepouts !== undefined) {
		if (!Array.isArray(value.keepouts)) return { ok: false, error: "keepouts must be a list" };
		for (const k of value.keepouts) {
			if (!isObj(k) || typeof k.name !== "string") return { ok: false, error: "a keepout needs a name" };
			const min = vec2(k.min);
			const max = vec2(k.max);
			if (!min || !max) return { ok: false, error: `keepout ${k.name} needs min and max` };
			keepouts.push({ name: k.name, min, max });
		}
	}

	const mountingHoles: { at: Vec2; drill: number }[] = [];
	if (value.mountingHoles !== undefined) {
		if (!Array.isArray(value.mountingHoles)) return { ok: false, error: "mountingHoles must be a list" };
		for (const h of value.mountingHoles) {
			const at = isObj(h) ? vec2(h.at) : undefined;
			const drill = isObj(h) ? num(h.drill) : undefined;
			if (!at || drill === undefined) return { ok: false, error: "a mounting hole needs at and drill" };
			mountingHoles.push({ at, drill });
		}
	}

	return {
		ok: true,
		spec: {
			name: value.name,
			board: { size, tolerance },
			parts,
			netlist,
			rules: { minTrackWidth, minClearance, minViaDrill, minAnnularRing, edgeClearance, powerNets },
			keepouts,
			mountingHoles,
		},
	};
}

/** The hidden sample's shape check. Its pad references must name pads in the spec. */
export function validateHidden(value: unknown, spec: Spec): HiddenResult {
	if (!isObj(value) || !Array.isArray(value.probes)) return { ok: false, error: "the hidden sample needs a probes list" };
	const padIds = new Set<string>();
	for (const part of spec.parts) for (const p of part.pads) padIds.add(`${part.ref}.${p.name}`);
	const probes: HiddenSample["probes"][number][] = [];
	for (const p of value.probes) {
		if (!isObj(p) || typeof p.a !== "string" || typeof p.b !== "string") return { ok: false, error: "a probe needs pads a and b" };
		if (p.expect !== "continuity" && p.expect !== "isolation") return { ok: false, error: "a probe expects continuity or isolation" };
		if (!padIds.has(p.a) || !padIds.has(p.b)) return { ok: false, error: `probe ${p.a}-${p.b} names an unknown pad` };
		probes.push({ a: p.a, b: p.b, expect: p.expect });
	}
	const minClearance = value.minClearance === undefined ? undefined : num(value.minClearance);
	if (value.minClearance !== undefined && minClearance === undefined) return { ok: false, error: "minClearance must be a number" };
	return { ok: true, hidden: { probes, minClearance } };
}
