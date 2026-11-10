import { validateSpec } from "../src/spec.ts";
import { verify } from "../src/verify.ts";
import type { Spec, Verdict } from "../src/types.ts";

// A small board and its spec, built from one description so the two cannot drift apart. The outline is the honest
// 40 by 25 mm board at (100, 100). Every pad names the net it belongs to. Copper names its net too, and the net
// number written to the file is taken from the order the names first appear. This file is a helper, not a test: the
// test runner only picks up *.test.ts.

export type Vec = readonly [number, number];

export type PadDesc = {
	readonly name: string;
	readonly offset: Vec;
	readonly size: Vec;
	readonly shape: "rect" | "circle" | "oval";
	readonly type: "smd" | "thru_hole" | "np_thru_hole";
	readonly drill?: number;
	readonly net?: string;
};

export type PartDesc = { readonly ref: string; readonly at: Vec; readonly pads: readonly PadDesc[] };

export type Item =
	| {
			readonly kind: "segment";
			readonly from: Vec;
			readonly to: Vec;
			readonly width: number;
			readonly layer: "F.Cu" | "B.Cu";
			readonly net: string;
	  }
	| {
			readonly kind: "arc";
			readonly start: Vec;
			readonly mid: Vec;
			readonly end: Vec;
			readonly width: number;
			readonly layer: "F.Cu" | "B.Cu";
			readonly net: string;
	  }
	| { readonly kind: "via"; readonly at: Vec; readonly size: number; readonly drill: number; readonly net: string };

export type Fixture = {
	readonly parts: readonly PartDesc[];
	readonly copper?: readonly Item[];
	readonly keepouts?: readonly { readonly name: string; readonly min: Vec; readonly max: Vec }[];
	readonly powerNets?: Readonly<Record<string, number>>;
};

/** An SMD rectangle on the front copper layer. */
export const smdPad = (name: string, net: string, size: Vec = [1, 1], offset: Vec = [0, 0]): PadDesc => ({
	name,
	offset,
	size,
	shape: "rect",
	type: "smd",
	net,
});

/** A plated through-hole circle: copper on both outer layers, with a drill. */
export const thruPad = (name: string, net: string, size: Vec = [1.7, 1.7], drill = 1): PadDesc => ({
	name,
	offset: [0, 0],
	size,
	shape: "circle",
	type: "thru_hole",
	drill,
	net,
});

/** A non-plated mounting hole: removed material of the given drill, with no net. */
export const npthPad = (drill: number): PadDesc => ({
	name: "1",
	offset: [0, 0],
	size: [drill, drill],
	shape: "circle",
	type: "np_thru_hole",
	drill,
});

export const part = (ref: string, at: Vec, ...pads: PadDesc[]): PartDesc => ({ ref, at, pads });

export const segment = (from: Vec, to: Vec, width: number, layer: "F.Cu" | "B.Cu", net: string): Item => ({
	kind: "segment",
	from,
	to,
	width,
	layer,
	net,
});

export const arc = (start: Vec, mid: Vec, end: Vec, width: number, layer: "F.Cu" | "B.Cu", net: string): Item => ({
	kind: "arc",
	start,
	mid,
	end,
	width,
	layer,
	net,
});

/** A through via of the default 0.6 mm pad and 0.3 mm drill, which meets both minimums. */
export const via = (at: Vec, net: string, size = 0.6, drill = 0.3): Item => ({ kind: "via", at, size, drill, net });

function netNumbers(f: Fixture): Map<string, number> {
	const names: string[] = [];
	const add = (name: string | undefined): void => {
		if (name !== undefined && name !== "" && !names.includes(name)) names.push(name);
	};
	for (const p of f.parts) for (const pad of p.pads) add(pad.net);
	for (const item of f.copper ?? []) add(item.net);
	return new Map(names.map((name, i) => [name, i + 1]));
}

function netOf(nets: Map<string, number>, name: string): number {
	const n = nets.get(name);
	if (n === undefined) throw new Error(`net ${name} has no number`);
	return n;
}

function padRecord(pad: PadDesc, nets: Map<string, number>): string {
	if (pad.type !== "smd" && pad.drill === undefined) throw new Error(`pad ${pad.name} needs a drill`);
	const layers = pad.type === "smd" ? '"F.Cu" "F.Paste" "F.Mask"' : '"*.Cu" "*.Mask"';
	const drill = pad.type === "smd" ? "" : ` (drill ${pad.drill})`;
	const net = pad.net === undefined ? "" : ` (net ${netOf(nets, pad.net)} "${pad.net}")`;
	return (
		`(pad "${pad.name}" ${pad.type} ${pad.shape} (at ${pad.offset[0]} ${pad.offset[1]})` +
		` (size ${pad.size[0]} ${pad.size[1]})${drill} (layers ${layers})${net})`
	);
}

function copperRecord(item: Item, nets: Map<string, number>): string {
	const n = netOf(nets, item.net);
	switch (item.kind) {
		case "segment":
			return (
				`(segment (start ${item.from[0]} ${item.from[1]}) (end ${item.to[0]} ${item.to[1]})` +
				` (width ${item.width}) (layer "${item.layer}") (net ${n}))`
			);
		case "arc":
			return (
				`(arc (start ${item.start[0]} ${item.start[1]}) (mid ${item.mid[0]} ${item.mid[1]})` +
				` (end ${item.end[0]} ${item.end[1]}) (width ${item.width}) (layer "${item.layer}") (net ${n}))`
			);
		case "via":
			return (
				`(via (at ${item.at[0]} ${item.at[1]}) (size ${item.size}) (drill ${item.drill})` +
				` (layers "F.Cu" "B.Cu") (net ${n}))`
			);
	}
}

/** The KiCad 8 text of the fixture's board. */
export function boardText(f: Fixture): string {
	const nets = netNumbers(f);
	const netLines = [...nets].map(([name, n]) => `\t(net ${n} "${name}")`);
	const footprints = f.parts.flatMap(p => [
		`\t(footprint "Test:${p.ref}" (layer "F.Cu") (at ${p.at[0]} ${p.at[1]})`,
		`\t\t(property "Reference" "${p.ref}" (at 0 -2 0) (layer "F.SilkS"))`,
		...p.pads.map(pad => `\t\t${padRecord(pad, nets)}`),
		"\t)",
	]);
	const copper = (f.copper ?? []).map(item => `\t${copperRecord(item, nets)}`);
	return [
		'(kicad_pcb (version 20240108) (generator "verifier-pcb-test")',
		"\t(general (thickness 1.6))",
		'\t(paper "A4")',
		"\t(layers",
		'\t\t(0 "F.Cu" signal)',
		'\t\t(31 "B.Cu" signal)',
		'\t\t(37 "F.SilkS" user)',
		'\t\t(44 "Edge.Cuts" user)',
		"\t)",
		"\t(setup (pad_to_mask_clearance 0))",
		'\t(net 0 "")',
		...netLines,
		'\t(gr_line (start 100 100) (end 140 100) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))',
		'\t(gr_line (start 140 100) (end 140 125) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))',
		'\t(gr_line (start 140 125) (end 100 125) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))',
		'\t(gr_line (start 100 125) (end 100 100) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))',
		...footprints,
		...copper,
		")",
	].join("\n");
}

/** The spec for the fixture, with the public minimums and no mounting holes. Throws if the spec is malformed. */
export function specOf(f: Fixture): Spec {
	const netlist: Record<string, string[]> = {};
	for (const p of f.parts) {
		for (const pad of p.pads) {
			if (pad.net === undefined) continue;
			(netlist[pad.net] ??= []).push(`${p.ref}.${pad.name}`);
		}
	}
	const json = {
		name: "synthetic",
		board: { size: [40, 25], tolerance: 0.05 },
		parts: f.parts.map(p => ({
			ref: p.ref,
			footprint: `Test:${p.ref}`,
			at: [...p.at],
			pads: p.pads.map(pad => ({
				name: pad.name,
				offset: [...pad.offset],
				size: [...pad.size],
				shape: pad.shape,
				type: pad.type,
				...(pad.drill === undefined ? {} : { drill: pad.drill }),
			})),
		})),
		netlist,
		rules: {
			minTrackWidth: 0.2,
			minClearance: 0.2,
			minViaDrill: 0.3,
			minAnnularRing: 0.15,
			edgeClearance: 0.3,
			powerNets: f.powerNets ?? {},
		},
		keepouts: f.keepouts ?? [],
		mountingHoles: [],
	};
	const r = validateSpec(json);
	if (!r.ok) throw new Error(`synthetic spec: ${r.error}`);
	return r.spec;
}

/** Verifies the fixture's board against its own spec. */
export function run(f: Fixture): Verdict {
	return verify(specOf(f), boardText(f));
}

/** The ok flag of the named finding, or undefined when the rule reported nothing. */
export const okOf = (v: Verdict, rule: string): boolean | undefined => v.findings.find(x => x.rule === rule)?.ok;

/** True when the fixture's board failed to parse, so no rule was judged. */
export const parseFailed = (v: Verdict): boolean => v.findings.some(x => !x.ok && x.rule === "parse");
