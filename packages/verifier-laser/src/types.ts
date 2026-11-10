// The laser checker's data shapes. The shared contract (Vec2, Finding, ScenePath, Scene, Verdict) is the one
// every checker package exports. Spec and HiddenSample are this package's own inputs; the contract names them
// without defining them. All geometry is in millimetres, with the SVG y axis (down) kept as the file has it.

export type Vec2 = readonly [number, number];

export type Finding = {
	readonly rule: string;
	readonly ok: boolean;
	readonly hidden: boolean;
	readonly message: string;
	readonly at?: readonly [number, number, number];
	readonly refs?: readonly string[];
};

export type ScenePath = {
	readonly id: string;
	readonly kind: "outline" | "cut" | "engrave" | "copper" | "pad" | "via" | "drill" | "part" | "extrusion" | "travel";
	readonly layer: string;
	readonly z: number;
	readonly width?: number;
	readonly closed: boolean;
	readonly net?: string;
	readonly order?: number;
	readonly points: readonly Vec2[];
};

export type Scene = {
	readonly units: "mm";
	readonly size: readonly [number, number, number];
	readonly stock?: { readonly size: readonly [number, number, number]; readonly material: string };
	readonly paths: readonly ScenePath[];
	readonly probes?: readonly { readonly a: readonly [number, number, number]; readonly b: readonly [number, number, number]; readonly expect: "continuity" | "isolation"; readonly ok: boolean }[];
};

export type Verdict = {
	readonly workflow: "laser-cut" | "pcb" | "print-fdm";
	readonly pass: boolean;
	readonly findings: readonly Finding[];
	readonly measured: Readonly<Record<string, number | string>>;
	readonly scene: Scene;
};

/**
 * A hole the panel must carry. Centre is in the part frame: origin at the lower-left corner of the outer cut,
 * y up, in mm. The part frame is the file's own drawing, so a hole only moves when its drawn position moves.
 */
export type SpecHole = { readonly id: string; readonly centreMm: Vec2; readonly diameterMm: number };

/** A rectangular cut of this finished size. Its position is free: the thin-web rule constrains where it can go. */
export type SpecSlot = { readonly id: string; readonly sizeMm: Vec2 };

/**
 * The job the panel is cut for. Dimensions are finished sizes. The outer cut must be partMm plus kerfMm in each
 * axis, so the beam's kerf falls outside the finished part; interior cuts are drawn at their finished size.
 */
export type Spec = {
	readonly material: string;
	readonly thicknessMm: number;
	readonly bedMm: Vec2;
	readonly partMm: Vec2;
	readonly kerfMm: number;
	readonly toleranceMm: number;
	readonly minWebMm: number;
	readonly holes: readonly SpecHole[];
	readonly slots: readonly SpecSlot[];
};

/** Part-frame points the agent cannot see. Each must stay material: no cut may enclose it. */
export type HiddenSample = { readonly keepMaterialMm: readonly Vec2[] };

/** Every rule id this package can emit. A finding carries one of these. */
export const RULES = [
	"parse",
	"units-mm",
	"layers",
	"closed-paths",
	"feature-cut",
	"kerf-compensation",
	"cut-order",
	"no-duplicate-cuts",
	"fits-bed",
	"min-web",
	"hidden-material",
] as const;
export type Rule = (typeof RULES)[number];

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly FieldError[] };
export type FieldError = { readonly path: string; readonly message: string };

/** A cut or engrave path read from the SVG, already in mm and flattened. One per subpath. */
export type SvgPath = {
	readonly id: string;
	readonly stroke: string | null;
	readonly closed: boolean;
	readonly order: number;
	readonly points: readonly Vec2[];
};

export type SvgDoc = {
	/** The unit the root width and height were written in, or "" when none was given. */
	readonly unit: string;
	readonly widthMm: number;
	readonly heightMm: number;
	readonly paths: readonly SvgPath[];
};

/** The laser colours. Anything else on a drawn path is a failed layers finding. */
export const CUT_STROKE = "#ff0000";
export const ENGRAVE_STROKE = "#0000ff";
