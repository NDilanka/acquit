// The public types of the PCB checker. Scene and Verdict match the physical-workflows contract; Spec and
// HiddenSample are this package's own job and sample shapes.

/** A point in millimetres. */
export type Vec2 = readonly [number, number];

export type Finding = {
	readonly rule: string; // stable id, e.g. "closed-paths"
	readonly ok: boolean;
	readonly hidden: boolean; // true when the rule or its sample points are not published
	readonly message: string; // one plain sentence, no jargon
	readonly at?: readonly [number, number, number]; // where to point the camera, mm
	readonly refs?: readonly string[]; // ids of scene paths involved
};

export type ScenePath = {
	readonly id: string;
	readonly kind: "outline" | "cut" | "engrave" | "copper" | "pad" | "via" | "drill" | "part" | "extrusion" | "travel";
	readonly layer: string; // e.g. "cut", "F.Cu", "B.Cu", "layer-12"
	readonly z: number; // mm
	readonly width?: number; // mm, stroke or trace width
	readonly closed: boolean;
	readonly net?: string;
	readonly order?: number; // machine order, for playback
	readonly points: readonly Vec2[]; // curves flattened to <= 0.05 mm error
};

export type Scene = {
	readonly units: "mm";
	readonly size: readonly [number, number, number]; // bounding box
	readonly stock?: { readonly size: readonly [number, number, number]; readonly material: string };
	readonly paths: readonly ScenePath[];
	readonly probes?: readonly {
		readonly a: readonly [number, number, number];
		readonly b: readonly [number, number, number];
		readonly expect: "continuity" | "isolation";
		readonly ok: boolean;
	}[];
};

export type Verdict = {
	readonly workflow: "laser-cut" | "pcb" | "print-fdm";
	readonly pass: boolean; // true only when every finding is ok
	readonly findings: readonly Finding[];
	readonly measured: Readonly<Record<string, number | string>>;
	readonly scene: Scene;
};

/** A pad reference such as "J1.1". Pads are named by footprint reference and pad name. */
export type PadRef = string;

export type PadSpec = {
	readonly name: string;
	readonly offset: Vec2; // relative to the footprint origin, before rotation
	readonly size: Vec2;
	readonly shape: "rect" | "roundrect" | "circle" | "oval";
	readonly type: "smd" | "thru_hole";
	readonly drill?: number;
};

export type PartSpec = {
	readonly ref: string;
	readonly footprint: string;
	readonly at: Vec2;
	readonly rotation?: number; // degrees, counter-clockwise on screen (default 0)
	readonly pads: readonly PadSpec[];
};

/** The job the agent is asked to build. Public: the agent sees all of it. */
export type Spec = {
	readonly name: string;
	readonly board: { readonly size: Vec2; readonly tolerance: number };
	readonly parts: readonly PartSpec[];
	readonly netlist: Readonly<Record<string, readonly PadRef[]>>;
	readonly rules: {
		readonly minTrackWidth: number;
		readonly minClearance: number;
		readonly minViaDrill: number;
		readonly minAnnularRing: number;
		readonly edgeClearance: number;
		readonly powerNets: Readonly<Record<string, number>>; // net name -> minimum track width
	};
	readonly keepouts: readonly { readonly name: string; readonly min: Vec2; readonly max: Vec2 }[];
	readonly mountingHoles: readonly { readonly at: Vec2; readonly drill: number }[];
};

/** Checks the agent cannot see. The probe pairs and any tighter limit are published only to the verifier. */
export type HiddenSample = {
	readonly probes: readonly {
		readonly a: PadRef;
		readonly b: PadRef;
		readonly expect: "continuity" | "isolation";
	}[];
	readonly minClearance?: number; // tighter than the public clearance rule
};
