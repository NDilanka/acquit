// Shared contract types for the drone survey checker, as a superset of the workstream contract. Every shared
// member and union value is still accepted. The drone checker works in metres, so Scene.units also allows "m".

/** A 2D point in metres, east (x) and north (y) of the spec origin. */
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

/** A geographic position in degrees: latitude first, then longitude. */
export type LatLon = readonly [number, number];

export type Finding = {
	readonly rule: string;
	readonly ok: boolean;
	readonly hidden: boolean;
	readonly message: string;
	readonly at?: Vec3;
	readonly refs?: readonly string[];
};

export type ScenePath = {
	readonly id: string;
	readonly kind:
		| "outline"
		| "cut"
		| "engrave"
		| "copper"
		| "pad"
		| "via"
		| "drill"
		| "part"
		| "extrusion"
		| "travel"
		| "flight"
		| "zone"
		| "area"
		| "footprint";
	readonly layer: string;
	readonly z: number;
	readonly width?: number;
	readonly closed: boolean;
	readonly net?: string;
	readonly order?: number;
	readonly points: readonly Vec2[];
};

export type Scene = {
	readonly units: "mm" | "m";
	readonly size: Vec3;
	readonly stock?: { readonly size: Vec3; readonly material: string };
	readonly paths: readonly ScenePath[];
	readonly probes?: readonly { readonly a: Vec3; readonly b: Vec3; readonly expect: "continuity" | "isolation"; readonly ok: boolean }[];
};

export type Verdict = {
	readonly workflow: "laser-cut" | "pcb" | "print-fdm" | "drone-survey" | "sql" | "data-clean";
	readonly pass: boolean;
	readonly findings: readonly Finding[];
	readonly measured: Readonly<Record<string, number | string>>;
	readonly scene: Scene;
};

export type Camera = {
	readonly sensorWidthMm: number;
	readonly sensorHeightMm: number;
	readonly focalMm: number;
	readonly imageWidthPx: number;
	readonly imageHeightPx: number;
};

/** A no-fly zone: a polygon of geographic points and the height of the volume above the ground, in metres. */
export type Zone = { readonly id: string; readonly heightM: number; readonly polygon: readonly LatLon[] };

/** The published job spec. Public rules are the ones named in `rules`. */
export type Spec = {
	readonly id: string;
	readonly origin: LatLon;
	readonly area: readonly LatLon[];
	readonly zones: readonly Zone[];
	readonly camera: Camera;
	readonly maxAltitudeM: number;
	readonly minAltitudeM: number;
	readonly maxGsdCm: number;
	readonly minFrontOverlap: number;
	readonly minSideOverlap: number;
	readonly cruiseMs: { readonly min: number; readonly max: number };
	readonly enduranceS: number;
	readonly reserveS: number;
	readonly geofenceMarginM: number;
	readonly rules: readonly string[];
};

/** Hidden sample points and wind, in metres from the origin. The verifier runs these checks; the agent never sees the values. */
export type HiddenSample = {
	readonly checkpoints: readonly Vec2[];
	readonly windMs: number;
	readonly cruiseToWindRatio: number;
	readonly minPhotos: number;
};
