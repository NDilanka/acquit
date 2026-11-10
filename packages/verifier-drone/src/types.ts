// Shared contract types for the drone survey checker. Units here are metres, not millimetres: the flight
// plan and the survey area are in metres, so the scene declares units "m" (a contract extension).

/** A 2D point in metres, east (x) and north (y) of the spec origin. */
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

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
	readonly kind: "flight" | "zone" | "area" | "footprint" | "travel";
	readonly layer: string;
	readonly z: number;
	readonly closed: boolean;
	readonly order?: number;
	readonly points: readonly Vec2[];
};

export type Scene = {
	readonly units: "m";
	readonly size: Vec3;
	readonly paths: readonly ScenePath[];
};

export type Verdict = {
	readonly workflow: "drone-survey";
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
};

export type Zone = { readonly id: string; readonly polygon: readonly Vec2[] };

/** The published job spec. Public rules are the ones named in `rules`. */
export type Spec = {
	readonly id: string;
	readonly origin: readonly [number, number];
	readonly area: readonly Vec2[];
	readonly zones: readonly Zone[];
	readonly camera: Camera;
	readonly maxAltitudeM: number;
	readonly maxGsdCm: number;
	readonly minFrontOverlap: number;
	readonly minSideOverlap: number;
	readonly cruiseMs: { readonly min: number; readonly max: number };
	readonly gridM: number;
	readonly rules: readonly string[];
};

/** Hidden sample points and wind. The verifier runs these checks; the agent never sees the values. */
export type HiddenSample = {
	readonly checkpoints: readonly Vec2[];
	readonly windMs: number;
	readonly cruiseToWindRatio: number;
};
