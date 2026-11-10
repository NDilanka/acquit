// Writes the status-light sample: one job spec, one honest delivery, a hidden sample, and the frauds, each
// breaking one named rule. Run with `node packages/verifier-pcb/samples/generate.ts` from the repo root. It also
// writes src/samples.ts so the package can ship the same text without file I/O.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");

type Xy = readonly [number, number];

const NET: Record<string, number> = { "": 0, VIN: 1, GND: 2, "3V3": 3, LED_A: 4, SIG1: 5, SIG2: 6 };

type PadDef = {
	readonly name: string;
	readonly off: Xy;
	readonly kind: "smd" | "thru" | "np";
	readonly shape: "rect" | "circle";
	readonly size: Xy;
	readonly drill?: number;
	readonly net: string;
};
type PartDef = { readonly ref: string; readonly lib: string; readonly at: Xy; readonly pads: readonly PadDef[] };

const SMD_RECT = { kind: "smd", shape: "rect", size: [1.0, 1.3] } as const;
const SOT = { kind: "smd", shape: "rect", size: [0.6, 0.7] } as const;
const HEADER = { kind: "thru", shape: "circle", size: [1.7, 1.7], drill: 1.0 } as const;
const HOLE = { kind: "np", shape: "circle", size: [3.2, 3.2], drill: 3.2 } as const;

function parts(): PartDef[] {
	return [
		{
			ref: "J1",
			lib: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
			at: [102, 106],
			pads: [
				{ name: "1", off: [0, 0], net: "VIN", ...HEADER },
				{ name: "2", off: [0, 2.54], net: "GND", ...HEADER },
			],
		},
		{
			ref: "U1",
			lib: "Package_TO_SOT_SMD:SOT-23",
			at: [112, 106],
			pads: [
				{ name: "1", off: [-1, -0.95], net: "VIN", ...SOT },
				{ name: "2", off: [-1, 0.95], net: "GND", ...SOT },
				{ name: "3", off: [1, 0], net: "3V3", ...SOT },
			],
		},
		{
			ref: "C1",
			lib: "Capacitor_SMD:C_0805_2012Metric",
			at: [108, 112],
			pads: [
				{ name: "1", off: [-0.95, 0], net: "VIN", ...SMD_RECT, size: [1.0, 1.3] },
				{ name: "2", off: [0.95, 0], net: "GND", ...SMD_RECT, size: [1.0, 1.3] },
			],
		},
		{
			ref: "C2",
			lib: "Capacitor_SMD:C_0805_2012Metric",
			at: [118, 112],
			pads: [
				{ name: "1", off: [-0.95, 0], net: "3V3", ...SMD_RECT, size: [1.0, 1.3] },
				{ name: "2", off: [0.95, 0], net: "GND", ...SMD_RECT, size: [1.0, 1.3] },
			],
		},
		{
			ref: "R1",
			lib: "Resistor_SMD:R_0805_2012Metric",
			at: [122, 106],
			pads: [
				{ name: "1", off: [-0.95, 0], net: "3V3", ...SMD_RECT, size: [1.0, 1.3] },
				{ name: "2", off: [0.95, 0], net: "LED_A", ...SMD_RECT, size: [1.0, 1.3] },
			],
		},
		{
			ref: "D1",
			lib: "LED_SMD:LED_0805_2012Metric",
			at: [127, 106],
			pads: [
				{ name: "1", off: [-0.95, 0], net: "GND", ...SMD_RECT, size: [1.0, 1.3] },
				{ name: "2", off: [0.95, 0], net: "LED_A", ...SMD_RECT, size: [1.0, 1.3] },
			],
		},
		{
			ref: "J2",
			lib: "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical",
			at: [128, 118],
			pads: [
				{ name: "1", off: [0, 0], net: "3V3", ...HEADER },
				{ name: "2", off: [2.54, 0], net: "GND", ...HEADER },
				{ name: "3", off: [5.08, 0], net: "SIG1", ...HEADER },
				{ name: "4", off: [7.62, 0], net: "SIG2", ...HEADER },
			],
		},
		{ ref: "H1", lib: "MountingHole:MountingHole_3.2mm", at: [102, 102], pads: [{ name: "1", off: [0, 0], net: "", ...HOLE }] },
		{ ref: "H2", lib: "MountingHole:MountingHole_3.2mm", at: [138, 102], pads: [{ name: "1", off: [0, 0], net: "", ...HOLE }] },
		{ ref: "H3", lib: "MountingHole:MountingHole_3.2mm", at: [102, 123], pads: [{ name: "1", off: [0, 0], net: "", ...HOLE }] },
		{ ref: "H4", lib: "MountingHole:MountingHole_3.2mm", at: [138, 123], pads: [{ name: "1", off: [0, 0], net: "", ...HOLE }] },
	];
}

export type Options = {
	readonly dropLed?: boolean; // leave the LED_A net unrouted
	readonly ledEndY?: number; // where the LED lane's last track ends (default 106, on the pad)
	readonly viaDY?: number; // y of the GND via under D1 (default 108.5)
	readonly viaDrill?: number; // default 0.3
	readonly narrowPathC?: boolean; // 3V3 branch to J2 at 0.2 mm
	readonly movePadU13?: boolean; // U1 pad 3 sits 0.5 mm off its footprint
	readonly relabelJ23?: string; // label J2 pin 3 with another net
	readonly extra?: readonly string[]; // extra raw elements appended to the board
};

function netAttr(net: string): string {
	return net === "" ? "" : ` (net ${NET[net] ?? 0} "${net}")`;
}

function padText(p: PadDef, off: Xy, labelNet: string): string {
	const at = `(at ${off[0]} ${off[1]})`;
	const size = `(size ${p.size[0]} ${p.size[1]})`;
	if (p.kind === "smd") {
		return `\t\t(pad "${p.name}" smd ${p.shape} ${at} ${size} (layers "F.Cu" "F.Paste" "F.Mask")${netAttr(labelNet)})`;
	}
	if (p.kind === "np") {
		return `\t\t(pad "${p.name}" np_thru_hole ${p.shape} ${at} ${size} (drill ${p.drill}) (layers "*.Cu" "*.Mask"))`;
	}
	return `\t\t(pad "${p.name}" thru_hole ${p.shape} ${at} ${size} (drill ${p.drill}) (layers "*.Cu" "*.Mask")${netAttr(labelNet)})`;
}

function footprintText(part: PartDef, o: Options): string {
	const pads = part.pads.map(p => {
		let off = p.off;
		let label = p.net;
		if (part.ref === "U1" && p.name === "3" && o.movePadU13) off = [1.5, 0];
		if (part.ref === "J2" && p.name === "3" && o.relabelJ23) label = o.relabelJ23;
		return padText(p, off, label);
	});
	return [
		`\t(footprint "${part.lib}" (layer "F.Cu") (at ${part.at[0]} ${part.at[1]})`,
		`\t\t(property "Reference" "${part.ref}" (at 0 -2 0) (layer "F.SilkS"))`,
		...pads,
		"\t)",
	].join("\n");
}

function seg(a: Xy, b: Xy, w: number, layer: string, net: string): string {
	return `\t(segment (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (width ${w}) (layer "${layer}")${netAttr(net)})`;
}

function via(at: Xy, drill: number): string {
	return `\t(via (at ${at[0]} ${at[1]}) (size 0.6) (drill ${drill}) (layers "F.Cu" "B.Cu")${netAttr("GND")})`;
}

function edge(a: Xy, b: Xy): string {
	return `\t(gr_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))`;
}

export function build(o: Options = {}): string {
	const via1: Xy = [111, 109.3];
	const via2: Xy = [108.95, 109.3];
	const via3: Xy = [118.95, 115];
	const via4: Xy = [126.05, o.viaDY ?? 108.5];
	const drill = o.viaDrill ?? 0.3;
	const ledEnd = o.ledEndY ?? 106;
	const wC = o.narrowPathC ? 0.2 : 0.5;

	const tracks: string[] = [];
	if (!o.dropLed) {
		tracks.push(seg([122.95, 106], [122.95, 103], 0.25, "F.Cu", "LED_A"));
		tracks.push(seg([122.95, 103], [127.95, 103], 0.25, "F.Cu", "LED_A"));
		tracks.push(seg([127.95, 103], [127.95, ledEnd], 0.25, "F.Cu", "LED_A"));
	}
	// VIN
	tracks.push(seg([102, 106], [107.05, 106], 0.5, "F.Cu", "VIN"));
	tracks.push(seg([107.05, 106], [107.05, 112], 0.5, "F.Cu", "VIN"));
	tracks.push(seg([107.05, 106], [111, 105.05], 0.5, "F.Cu", "VIN"));
	// GND stubs to the vias
	tracks.push(seg([111, 106.95], via1, 0.5, "F.Cu", "GND"));
	tracks.push(seg([108.95, 112], via2, 0.5, "F.Cu", "GND"));
	tracks.push(seg([118.95, 112], via3, 0.5, "F.Cu", "GND"));
	tracks.push(seg([126.05, 106], via4, 0.5, "F.Cu", "GND"));
	// 3V3
	tracks.push(seg([113, 106], [115.5, 106], 0.5, "F.Cu", "3V3"));
	tracks.push(seg([115.5, 106], [115.5, 112], 0.5, "F.Cu", "3V3"));
	tracks.push(seg([115.5, 112], [117.05, 112], 0.5, "F.Cu", "3V3"));
	tracks.push(seg([117.05, 112], [117.05, 110], 0.5, "F.Cu", "3V3"));
	tracks.push(seg([117.05, 110], [121.05, 110], 0.5, "F.Cu", "3V3"));
	tracks.push(seg([121.05, 110], [121.05, 106], 0.5, "F.Cu", "3V3"));
	tracks.push(seg([121.05, 110], [128, 110], wC, "F.Cu", "3V3"));
	tracks.push(seg([128, 110], [128, 118], wC, "F.Cu", "3V3"));
	// GND bus on B.Cu
	tracks.push(seg([102, 108.54], [102, 120.5], 0.5, "B.Cu", "GND"));
	tracks.push(seg([102, 120.5], [130.54, 120.5], 0.5, "B.Cu", "GND"));
	tracks.push(seg(via1, [111, 120.5], 0.5, "B.Cu", "GND"));
	tracks.push(seg(via2, [108.95, 120.5], 0.5, "B.Cu", "GND"));
	tracks.push(seg(via3, [118.95, 120.5], 0.5, "B.Cu", "GND"));
	tracks.push(seg(via4, [126.05, 120.5], 0.5, "B.Cu", "GND"));
	tracks.push(seg([130.54, 118], [130.54, 120.5], 0.5, "B.Cu", "GND"));

	const vias = [via(via1, drill), via(via2, drill), via(via3, drill), via(via4, drill)];
	const outline = [
		edge([100, 100], [140, 100]),
		edge([140, 100], [140, 125]),
		edge([140, 125], [100, 125]),
		edge([100, 125], [100, 100]),
	];
	const body = [
		...parts().map(p => footprintText(p, o)),
		...tracks,
		...vias,
		...(o.extra ?? []),
	];
	const nets = Object.entries(NET).map(([name, n]) => `\t(net ${n} "${name}")`);
	return [
		`(kicad_pcb (version 20240108) (generator "verifier-pcb-samples")`,
		`\t(general (thickness 1.6))`,
		`\t(paper "A4")`,
		`\t(layers`,
		`\t\t(0 "F.Cu" signal)`,
		`\t\t(31 "B.Cu" signal)`,
		`\t\t(37 "F.SilkS" user)`,
		`\t\t(44 "Edge.Cuts" user)`,
		`\t)`,
		`\t(setup (pad_to_mask_clearance 0))`,
		...nets,
		...outline,
		...body,
		`)`,
		``,
	].join("\n");
}

export const SPEC = {
	name: "status-light",
	board: { size: [40, 25], tolerance: 0.05 },
	parts: parts().map(p => ({
		ref: p.ref,
		footprint: p.lib,
		at: p.at,
		pads: p.pads.map(pad => ({
			name: pad.name,
			offset: pad.off,
			size: pad.size,
			shape: pad.shape === "circle" ? "circle" : "rect",
			type: pad.kind === "smd" ? "smd" : "thru_hole",
			...(pad.drill !== undefined ? { drill: pad.drill } : {}),
		})),
	})),
	netlist: {
		VIN: ["J1.1", "U1.1", "C1.1"],
		GND: ["J1.2", "U1.2", "C1.2", "C2.2", "D1.1", "J2.2"],
		"3V3": ["U1.3", "C2.1", "R1.1", "J2.1"],
		LED_A: ["R1.2", "D1.2"],
		SIG1: ["J2.3"],
		SIG2: ["J2.4"],
	},
	rules: {
		minTrackWidth: 0.2,
		minClearance: 0.2,
		minViaDrill: 0.3,
		minAnnularRing: 0.15,
		edgeClearance: 0.3,
		powerNets: { VIN: 0.5, "3V3": 0.5, GND: 0.5 },
	},
	keepouts: [{ name: "antenna-zone", min: [112, 114], max: [116, 116.5] }],
	mountingHoles: [
		{ at: [102, 102], drill: 3.2 },
		{ at: [138, 102], drill: 3.2 },
		{ at: [102, 123], drill: 3.2 },
		{ at: [138, 123], drill: 3.2 },
	],
};

export const HIDDEN = {
	probes: [
		{ a: "J1.1", b: "U1.1", expect: "continuity" },
		{ a: "J1.2", b: "U1.2", expect: "continuity" },
		{ a: "J2.1", b: "U1.3", expect: "continuity" },
		{ a: "R1.2", b: "D1.2", expect: "continuity" },
		{ a: "C1.2", b: "C2.2", expect: "continuity" },
		{ a: "D1.1", b: "J2.2", expect: "continuity" },
		{ a: "C2.1", b: "R1.1", expect: "continuity" },
		{ a: "J1.1", b: "J1.2", expect: "isolation" },
		{ a: "U1.3", b: "U1.2", expect: "isolation" },
		{ a: "R1.1", b: "D1.2", expect: "isolation" },
		{ a: "C1.1", b: "C2.2", expect: "isolation" },
		{ a: "J2.3", b: "J2.4", expect: "isolation" },
	],
	minClearance: 0.25,
};

/** Each fraud breaks one rule. Frauds with a hidden probe or limit are scored with the hidden sample. */
export const FRAUDS: readonly { readonly id: string; readonly rule: string; readonly hidden: boolean; readonly text: string }[] = [
	{
		id: "fraud-01-unrouted-net",
		rule: "connected",
		hidden: false,
		text: build({ dropLed: true }),
	},
	{
		id: "fraud-02-shorted-nets",
		rule: "no-shorts",
		hidden: false,
		text: build({
			extra: [seg([133.08, 118], [135.62, 118], 0.2, "F.Cu", "SIG1")],
		}),
	},
	{
		id: "fraud-03-power-thin",
		rule: "power-width",
		hidden: false,
		text: build({ narrowPathC: true }),
	},
	{
		id: "fraud-04-clearance-0.1",
		rule: "clearance",
		hidden: false,
		text: build({ viaDY: 109.35 }),
	},
	{
		id: "fraud-05-via-drill",
		rule: "via-rules",
		hidden: false,
		text: build({ viaDrill: 0.2 }),
	},
	{
		id: "fraud-06-outside-edge",
		rule: "inside-board",
		hidden: false,
		text: build({ extra: [seg([110, 127], [116, 127], 0.2, "F.Cu", "")] }),
	},
	{
		id: "fraud-07-pad-moved",
		rule: "parts-placed",
		hidden: false,
		text: build({ movePadU13: true }),
	},
	{
		id: "fraud-08-track-misses-pad",
		rule: "connected",
		hidden: false,
		text: build({ ledEndY: 104.5 }),
	},
	{
		id: "fraud-09-wrong-pad-net",
		rule: "pad-nets",
		hidden: false,
		text: build({ relabelJ23: "SIG2" }),
	},
	{
		id: "fraud-10-hidden-clearance",
		rule: "hidden-clearance",
		hidden: true,
		text: build({ viaDY: 109.23 }),
	},
	{
		id: "fraud-11-bore-cut",
		rule: "clearance",
		hidden: false,
		text: build({ extra: [seg([135.62, 118], [138, 123], 0.2, "F.Cu", "SIG2")] }),
	},
];

function main(): void {
	const specJson = `${JSON.stringify(SPEC, null, "\t")}\n`;
	const hiddenJson = `${JSON.stringify(HIDDEN, null, "\t")}\n`;
	const honest = build();
	mkdirSync(join(here, "frauds"), { recursive: true });
	writeFileSync(join(here, "status-light.spec.json"), specJson);
	writeFileSync(join(here, "status-light.hidden.example.json"), hiddenJson);
	writeFileSync(join(here, "honest.kicad_pcb"), honest);
	for (const f of FRAUDS) writeFileSync(join(here, "frauds", `${f.id}.kicad_pcb`), f.text);

	const lines = [
		"// Generated by samples/generate.ts. Do not edit by hand; run the generator to refresh it.",
		"",
		`export const SAMPLE_SPEC_JSON = ${JSON.stringify(specJson)};`,
		`export const SAMPLE_HIDDEN_JSON = ${JSON.stringify(hiddenJson)};`,
		`export const SAMPLE_HONEST_PCB = ${JSON.stringify(honest)};`,
		"export const SAMPLE_FRAUDS: Readonly<Record<string, string>> = {",
		...FRAUDS.map(f => `\t${JSON.stringify(f.id)}: ${JSON.stringify(f.text)},`),
		"};",
		"export const SAMPLE_FRAUD_RULES: Readonly<Record<string, { readonly rule: string; readonly hidden: boolean }>> = {",
		...FRAUDS.map(f => `\t${JSON.stringify(f.id)}: { rule: ${JSON.stringify(f.rule)}, hidden: ${f.hidden === true} },`),
		"};",
		"",
	];
	writeFileSync(join(pkg, "src", "samples.ts"), lines.join("\n"));
}

main();
