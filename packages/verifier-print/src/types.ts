// The print vertical's data shapes. Units are branded so a mm value cannot pass as a mm/s value.
// Ids and the registry's Vertical come from core as types only, so this package stays pure.

import type { Branded, Digest, Instant, JobId } from "../../core/src/ids.ts";
import type { Vertical } from "../../core/src/outcome.ts";

export type Mm = Branded<number, "Mm">;
export type Mm3 = Branded<number, "Mm3">;
export type MmPerSecond = Branded<number, "MmPerSecond">;
export type MmPerSecondSquared = Branded<number, "MmPerSecondSquared">;
export type Seconds = Branded<number, "Seconds">;
export type Vec3 = readonly [Mm, Mm, Mm];

export const mm = (value: number): Mm => value as Mm;
export const mm3 = (value: number): Mm3 => value as Mm3;
export const mmPerSecond = (value: number): MmPerSecond => value as MmPerSecond;
export const mmPerSecondSquared = (value: number): MmPerSecondSquared => value as MmPerSecondSquared;
export const seconds = (value: number): Seconds => value as Seconds;
export const vec3 = (x: number, y: number, z: number): Vec3 => [mm(x), mm(y), mm(z)];

export type FieldError = { readonly path: string; readonly message: string };
export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly FieldError[] };

/** Hotend window in degrees C and density in g/cm3, from the design note (section 1.1 and 1.2). */
export const MATERIALS = {
	PLA: { densityGcm3: 1.24, hotendC: [190, 225] },
	PETG: { densityGcm3: 1.27, hotendC: [225, 250] },
	ABS: { densityGcm3: 1.04, hotendC: [235, 260] },
	ASA: { densityGcm3: 1.07, hotendC: [240, 260] },
	TPU95A: { densityGcm3: 1.21, hotendC: [210, 235] },
} as const;
export type Material = keyof typeof MATERIALS;

export type PrintSpec = {
	readonly modelDigest: Digest;
	readonly material: Material;
	readonly color: { readonly name: string; readonly hex: string | null };
	readonly quantity: number;
	readonly toleranceMm: Mm;
	readonly infillPct: number;
	readonly walls: number;
	readonly maxLayerHeightMm: Mm;
	readonly printBy: Instant;
	readonly deliverBy: Instant;
};

export type MeshStats = {
	readonly format: "binary" | "ascii";
	readonly triangles: number;
	readonly bboxMm: { readonly min: Vec3; readonly max: Vec3 };
	readonly sizeMm: Vec3;
	/** Signed: a closed mesh with outward normals is positive. */
	readonly volumeMm3: Mm3;
	/** True when every undirected edge is shared by exactly two triangles. */
	readonly watertight: boolean;
	readonly digest: Digest;
};

export type Box = { readonly min: Vec3; readonly max: Vec3 };

export type Coupon = {
	readonly jobId: JobId;
	/** 1 to 65535. Bit row * 4 + col of this value is the cell at that grid position. */
	readonly markerId: number;
	/** Four rows of four. true means the cell is raised. */
	readonly markerCells: readonly (readonly boolean[])[];
	readonly tileMm: Vec3;
	readonly raisedCells: readonly Box[];
};

/** Lives only in the private store until close. Revealed with the seed after close. */
export type HiddenTerms = {
	/** Layer numbers (1-based) on the contract's layer grid, sorted ascending. */
	readonly sampleLayers: readonly number[];
};

export type PrintPublicTerms = {
	readonly spec: PrintSpec;
	readonly mesh: MeshStats;
	readonly layerHeightMm: Mm;
	readonly layerCount: number;
	readonly markerId: number;
	readonly couponDigest: Digest;
};

export type FrozenPrintContract = {
	readonly vertical: Vertical;
	readonly jobId: JobId;
	readonly publicTerms: PrintPublicTerms;
	readonly hidden: HiddenTerms;
	readonly hiddenDigest: Digest;
	readonly frozenAt: Instant;
};

export type Xy = readonly [Mm, Mm];

export type GcodeMove = {
	readonly line: number;
	/** Index into the layers array. -1 for moves that run before the first layer opens. */
	readonly layer: number;
	/** The XY path from the move's start to its end. Arcs are sampled into chords. */
	readonly path: readonly Xy[];
	readonly xyzMm: Mm;
	/** What the estimator times: xyzMm, or |deltaEMm| for an E-only move. */
	readonly distanceMm: Mm;
	/** Null until the first F word. The estimator then uses the machine's max feedrate. */
	readonly feedMmPerSec: MmPerSecond | null;
	/** Signed filament move. Negative is a retraction. */
	readonly deltaEMm: number;
	/** The last ;TYPE: comment seen, or "". */
	readonly feature: string;
};

export type GcodeLayer = {
	readonly index: number;
	readonly z: Mm;
	/** Filament length of the positive E moves attributed to this layer. */
	readonly extrudedMm: number;
	/** XYZ length of the extruding moves attributed to this layer. */
	readonly pathLengthMm: Mm;
	readonly moveCount: number;
};

export type ParsedGcode = {
	readonly layers: readonly GcodeLayer[];
	readonly moves: readonly GcodeMove[];
	/** Sum of positive E moves. Retractions are not subtracted. */
	readonly extrudedMm: number;
};

export type PrinterLimits = {
	readonly accelMmPerSec2: MmPerSecondSquared;
	readonly maxFeedMmPerSec: MmPerSecond;
};

export type TimeEstimate = {
	readonly totalSeconds: Seconds;
	readonly layers: readonly { readonly index: number; readonly z: Mm; readonly seconds: Seconds }[];
};

/** The print reasons this package can produce. */
export type PrintRejectReason =
	| { readonly kind: "MESH_NOT_MANIFOLD" }
	| { readonly kind: "GCODE_UNPARSEABLE"; readonly line: number }
	| { readonly kind: "INFILL_BELOW_CONTRACT"; readonly layer: number; readonly pct: number; readonly contractPct: number }
	| { readonly kind: "FOOTPRINT_MISMATCH"; readonly layer: number; readonly iou: number }
	| { readonly kind: "OUTSIDE_MATERIAL"; readonly layer: number; readonly pct: number }
	| { readonly kind: "BED_OUT_OF_BOUNDS"; readonly axis: "X" | "Y"; readonly gcodeMm: number; readonly boundMm: number }
	| { readonly kind: "SCALE_OUT_OF_TOLERANCE"; readonly axis: "X" | "Y" | "Z"; readonly gcodeMm: number; readonly meshMm: number }
	| { readonly kind: "UNIT_COUNT_MISMATCH"; readonly expected: number; readonly found: number }
	| { readonly kind: "COUPON_MISSING" }
	| { readonly kind: "COUPON_IOU_LOW"; readonly iou: number }
	| { readonly kind: "COUPON_MARKER_MISMATCH"; readonly expected: number; readonly found: number }
	| { readonly kind: "PHOTO_UNREADABLE"; readonly layer: number }
	| { readonly kind: "PHOTO_MISSING"; readonly layer: number }
	| { readonly kind: "GEOMETRY_MISMATCH"; readonly layer: number; readonly iou: number }
	| { readonly kind: "PHOTO_REUSED"; readonly layer: number; readonly distance: number }
	| { readonly kind: "TELEMETRY_MISSING" }
	| { readonly kind: "TELEMETRY_SIGNATURE_INVALID"; readonly seq: number }
	| { readonly kind: "TELEMETRY_CHAIN_BROKEN"; readonly seq: number }
	| { readonly kind: "FILE_HASH_MISMATCH"; readonly seq: number }
	| { readonly kind: "LAYER_SEQUENCE_MISMATCH"; readonly seq: number }
	| { readonly kind: "FILAMENT_MISMATCH"; readonly gcodeMm: number; readonly telemetryMm: number }
	| { readonly kind: "DURATION_IMPLAUSIBLE"; readonly estimateS: number; readonly telemetryS: number };
