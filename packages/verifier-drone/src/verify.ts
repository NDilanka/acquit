// The drone survey checker. It reads a QGroundControl plan and the job spec, and returns a Verdict.
// Pure TypeScript: no I/O, no clock, no randomness. Bad input becomes a failed "parse" finding.

import { centroid, fromFrame, frameFrom, pointInPolygon, segmentHitsPolygon, toFrame, toLocal } from "./geo.ts";
import type { Frame } from "./geo.ts";
import { parsePlan } from "./plan.ts";
import type { Plan, Waypoint } from "./plan.ts";
import { photographs } from "./photos.ts";
import type { Flight, Shot } from "./photos.ts";
import { HIDDEN_RULES, LIMITS, PUBLIC_RULES, parseHiddenSample, parseSpec } from "./spec.ts";
import type { Camera, Finding, HiddenSample, Scene, ScenePath, Spec, Vec2, Vec3, Verdict } from "./types.ts";

/** Metres. Positions this close count as equal, so plan rounding does not split a survey line. */
const TOL = 0.05;
/** Metres of altitude. Altitudes this close count as level, so float noise cannot split a survey line. */
const ALT_TOL = 1e-6;
/** The most photograph footprints the scene carries. A longer flight is sampled evenly down to this many. */
const SCENE_FOOTPRINTS = 200;

type Segment = { readonly index: number; readonly a: Waypoint; readonly b: Waypoint };
/**
 * A survey leg: a level run along the survey heading with both ends on one line. s0 and s1 are its ends' positions
 * along the heading, t is the position of the line across it, and triggerM is the photograph spacing, or null when
 * triggering is off for any part of it.
 */
type Leg = {
	readonly index: number;
	readonly a: Vec2;
	readonly b: Vec2;
	readonly s0: number;
	readonly s1: number;
	readonly t: number;
	readonly alt: number;
	readonly triggerM: number | null;
};
/** The spec's survey area and no-fly zones in local metres east and north of the origin. */
type Geometry = { readonly area: readonly Vec2[]; readonly zones: readonly { readonly id: string; readonly polygon: readonly Vec2[] }[] };
type Context = {
	readonly spec: Spec;
	readonly geometry: Geometry;
	readonly plan: Plan;
	readonly segments: readonly Segment[];
	/** The survey heading, or null when the plan has no level segment long enough to define one. */
	readonly frame: Frame | null;
	readonly legs: readonly Leg[];
	/** Every photograph taken on the survey flights, in flight order. */
	readonly shots: readonly Shot[];
	readonly hidden: HiddenSample | undefined;
};

const EMPTY_SCENE: Scene = { units: "m", size: [0, 0, 0], paths: [] };

export function acrossM(alt: number, camera: Camera): number {
	return (alt * camera.sensorWidthMm) / camera.focalMm;
}

export function alongM(alt: number, camera: Camera): number {
	return (alt * camera.sensorHeightMm) / camera.focalMm;
}

/** Ground sample distance in centimetres per pixel, across the sensor width. */
export function gsdCm(alt: number, camera: Camera): number {
	return ((alt * camera.sensorWidthMm) / (camera.focalMm * camera.imageWidthPx)) * 100;
}

function projectGeometry(spec: Spec): Geometry {
	const project = (point: readonly [number, number]): Vec2 => toLocal(spec.origin, point[0], point[1]);
	return {
		area: spec.area.map(project),
		zones: spec.zones.map(zone => ({ id: zone.id, polygon: zone.polygon.map(project) })),
	};
}

function segmentsOf(waypoints: readonly Waypoint[]): Segment[] {
	const out: Segment[] = [];
	for (let i = 0; i + 1 < waypoints.length; i++) out.push({ index: i, a: waypoints[i]!, b: waypoints[i + 1]! });
	return out;
}

/**
 * The trigger distance a leg is flown with. Photographs need triggering on at both ends. Where the two ends differ,
 * the sparser (larger) setting applies, so a setting changed mid-leg cannot earn the tighter spacing.
 */
function legTrigger(a: Waypoint, b: Waypoint): number | null {
	if (a.triggerM === null || b.triggerM === null) return null;
	return Math.max(a.triggerM, b.triggerM);
}

function level(segment: Segment): boolean {
	return Math.abs(segment.a.alt - segment.b.alt) <= ALT_TOL;
}

/**
 * The survey heading: the direction of the longest level segment. A survey is flown along one heading, and its
 * connecting turns are shorter than its lines, so the longest run is a survey line.
 */
function surveyFrame(segments: readonly Segment[]): Frame | null {
	let best: Segment | null = null;
	let bestLength = TOL;
	for (const segment of segments) {
		if (!level(segment)) continue;
		const length = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
		if (length > bestLength) {
			best = segment;
			bestLength = length;
		}
	}
	return best === null ? null : frameFrom([best.a.x, best.a.y], [best.b.x, best.b.y]);
}

/**
 * The survey legs: level segments whose two ends lie on one line along the survey heading, within TOL. Any other
 * segment is a transit. The test is made in the survey frame, so a survey flown at any heading is found the same way.
 */
function legsOf(segments: readonly Segment[], frame: Frame | null): Leg[] {
	if (frame === null) return [];
	const out: Leg[] = [];
	for (const segment of segments) {
		if (!level(segment)) continue;
		const { a, b } = segment;
		const [s0, t0] = toFrame(frame, [a.x, a.y]);
		const [s1, t1] = toFrame(frame, [b.x, b.y]);
		if (Math.abs(s1 - s0) <= TOL || Math.abs(t1 - t0) > TOL) continue;
		out.push({ index: segment.index, a: [a.x, a.y], b: [b.x, b.y], s0, s1, t: (t0 + t1) / 2, alt: a.alt, triggerM: legTrigger(a, b) });
	}
	return out;
}

/**
 * How many survey photographs hold a point. Each photograph covers the camera footprint centred on its exposure:
 * alongM split either side of the exposure along the heading, and acrossM split either side across it.
 */
function holding(p: Vec2, shots: readonly Shot[], camera: Camera, frame: Frame | null): number {
	if (frame === null) return 0;
	const [s, t] = toFrame(frame, p);
	let count = 0;
	for (const shot of shots) {
		const half = acrossM(shot.alt, camera) / 2;
		const reach = alongM(shot.alt, camera) / 2;
		if (Math.abs(t - shot.t) <= half + TOL && Math.abs(s - shot.s) <= reach + TOL) count++;
	}
	return count;
}

/**
 * One stretch of flight per segment, in mission order: its ground length, the trigger distance in force, and the
 * survey line it flies, or null for a transit. The index of each flight is its segment index.
 */
function flightsOf(segments: readonly Segment[], legs: readonly Leg[]): Flight[] {
	const byIndex = new Map<number, Leg>();
	for (const leg of legs) byIndex.set(leg.index, leg);
	return segments.map(segment => {
		const { a, b } = segment;
		const leg = byIndex.get(segment.index);
		return {
			length: Math.hypot(b.x - a.x, b.y - a.y),
			trigger: legTrigger(a, b),
			survey: leg === undefined ? null : { s0: leg.s0, s1: leg.s1, t: leg.t, alt: leg.alt },
		};
	});
}

/** Up to `cap` photographs spread evenly through the flight, each with its index in the full list. */
function sampleShots(shots: readonly Shot[], cap: number): { index: number; shot: Shot }[] {
	if (shots.length <= cap) return shots.map((shot, index) => ({ index, shot }));
	const out: { index: number; shot: Shot }[] = [];
	for (let k = 0; k < cap; k++) {
		const index = Math.floor((k * shots.length) / cap);
		out.push({ index, shot: shots[index]! });
	}
	return out;
}

/** Along-track overlap of a leg's photographs. With triggering off, or no height above the ground, there is none. */
function frontOverlapOf(leg: Leg, camera: Camera): number {
	if (leg.triggerM === null || leg.alt <= 0) return 0;
	return 1 - leg.triggerM / alongM(leg.alt, camera);
}

function sampleGrid(area: readonly Vec2[], gridM: number): Vec2[] {
	const xs = area.map(p => p[0]);
	const ys = area.map(p => p[1]);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const out: Vec2[] = [];
	for (let x = minX + gridM / 2; x < maxX; x += gridM) {
		for (let y = minY + gridM / 2; y < maxY; y += gridM) {
			if (pointInPolygon([x, y], area)) out.push([x, y]);
		}
	}
	return out;
}

/** A finding. Optional `at` and `refs` are left out entirely when absent, so a hidden finding carries no such keys. */
function finding(rule: string, ok: boolean, hidden: boolean, message: string, at?: Vec3, refs?: readonly string[]): Finding {
	return { rule, ok, hidden, message, ...(at === undefined ? {} : { at }), ...(refs === undefined ? {} : { refs }) };
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** The midpoint of a leg, at the leg's altitude. */
function legMid(leg: Leg): Vec3 {
	return [(leg.a[0] + leg.b[0]) / 2, (leg.a[1] + leg.b[1]) / 2, leg.alt];
}

function worstGsdLeg(legs: readonly Leg[], camera: Camera): Leg | null {
	let worst: Leg | null = null;
	for (const leg of legs) if (worst === null || gsdCm(leg.alt, camera) > gsdCm(worst.alt, camera)) worst = leg;
	return worst;
}

function worstFrontLeg(legs: readonly Leg[], camera: Camera): Leg | null {
	let worst: Leg | null = null;
	for (const leg of legs) if (worst === null || frontOverlapOf(leg, camera) < frontOverlapOf(worst, camera)) worst = leg;
	return worst;
}

/**
 * Overlap between each pair of neighbouring survey lines, the lower of the two footprints counted. Lines are ordered
 * across the survey heading, so the check follows the survey at any heading.
 */
function sideOverlaps(legs: readonly Leg[], camera: Camera): { overlap: number; a: Leg; b: Leg }[] {
	const sorted = [...legs].sort((p, q) => p.t - q.t || p.index - q.index);
	const out: { overlap: number; a: Leg; b: Leg }[] = [];
	for (let i = 1; i < sorted.length; i++) {
		const a = sorted[i - 1]!;
		const b = sorted[i]!;
		const spacing = b.t - a.t;
		if (spacing <= TOL) continue;
		const width = Math.min(acrossM(a.alt, camera), acrossM(b.alt, camera));
		out.push({ overlap: 1 - spacing / width, a, b });
	}
	return out;
}

type Check = (ctx: Context) => Finding;

const CHECKS: Record<(typeof PUBLIC_RULES)[number], Check> = {
	"altitude-limits": ({ spec, plan }) => {
		const outside = plan.waypoints.find(w => w.alt > spec.maxAltitudeM || w.alt < spec.minAltitudeM);
		if (outside !== undefined) return finding("altitude-limits", false, false, `A waypoint at ${outside.alt.toFixed(1)} m is outside the ${spec.minAltitudeM} to ${spec.maxAltitudeM} m limit.`, [outside.x, outside.y, outside.alt]);
		const takeoff = plan.events.find(e => e.kind === "takeoff" && (e.alt > spec.maxAltitudeM || e.alt < spec.minAltitudeM));
		if (takeoff !== undefined && takeoff.kind === "takeoff") return finding("altitude-limits", false, false, `The takeoff climbs to ${takeoff.alt.toFixed(1)} m, outside the ${spec.minAltitudeM} to ${spec.maxAltitudeM} m limit.`, [0, 0, takeoff.alt]);
		return finding("altitude-limits", true, false, `Every waypoint and takeoff is between ${spec.minAltitudeM} and ${spec.maxAltitudeM} m.`);
	},
	"ground-resolution": ({ spec, legs }) => {
		const worst = worstGsdLeg(legs, spec.camera);
		if (worst === null) return finding("ground-resolution", false, false, "The plan flies no survey line, so no ground resolution can be given.");
		const value = gsdCm(worst.alt, spec.camera);
		const ok = value <= spec.maxGsdCm;
		return finding("ground-resolution", ok, false, ok ? `Photos resolve ${value.toFixed(2)} cm per pixel or better, within ${spec.maxGsdCm} cm.` : `The survey line at ${worst.alt.toFixed(1)} m resolves ${value.toFixed(2)} cm per pixel, coarser than ${spec.maxGsdCm} cm.`, legMid(worst), [`leg-${worst.index}`]);
	},
	"front-overlap": ({ spec, legs }) => {
		const worst = worstFrontLeg(legs, spec.camera);
		if (worst === null) return finding("front-overlap", false, false, "The plan flies no survey line, so photo overlap along track cannot be checked.");
		const overlap = frontOverlapOf(worst, spec.camera);
		const ok = overlap >= spec.minFrontOverlap;
		return finding("front-overlap", ok, false, ok ? `Photos overlap ${percent(overlap)} along track, at least ${percent(spec.minFrontOverlap)}.` : `Photos overlap only ${percent(overlap)} along track; the minimum is ${percent(spec.minFrontOverlap)}.`, legMid(worst), [`leg-${worst.index}`]);
	},
	"side-overlap": ({ spec, legs }) => {
		const pairs = sideOverlaps(legs, spec.camera);
		if (pairs.length === 0) return finding("side-overlap", false, false, "The survey has no two neighbouring lines, so side overlap cannot be checked.");
		const worst = pairs.reduce((low, pair) => (pair.overlap < low.overlap ? pair : low));
		const ok = worst.overlap >= spec.minSideOverlap;
		const [ma, mb] = [legMid(worst.a), legMid(worst.b)];
		const at: Vec3 = [(ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2, worst.a.alt];
		const refs = [`leg-${worst.a.index}`, `leg-${worst.b.index}`];
		return finding("side-overlap", ok, false, ok ? `Neighbouring lines overlap ${percent(worst.overlap)} sideways, at least ${percent(spec.minSideOverlap)}.` : `Neighbouring lines overlap only ${percent(worst.overlap)} sideways; the minimum is ${percent(spec.minSideOverlap)}.`, at, refs);
	},
	"no-fly": ({ geometry, segments }) => {
		for (const segment of segments) {
			for (const zone of geometry.zones) {
				if (segmentHitsPolygon([segment.a.x, segment.a.y], [segment.b.x, segment.b.y], zone.polygon)) {
					const c = centroid(zone.polygon);
					return finding("no-fly", false, false, `The route crosses no-fly zone ${zone.id}.`, [c[0], c[1], Math.max(segment.a.alt, segment.b.alt)], [`zone-${zone.id}`]);
				}
			}
		}
		return finding("no-fly", true, false, "No part of the route crosses a no-fly zone.");
	},
	coverage: ({ spec, geometry, shots, frame }) => {
		const samples = sampleGrid(geometry.area, spec.gridM);
		const missed = samples.filter(p => holding(p, shots, spec.camera, frame) === 0);
		if (missed.length === 0) return finding("coverage", true, false, `All ${samples.length} sample points on the survey area are photographed.`);
		const first = missed[0]!;
		return finding("coverage", false, false, `${missed.length} of ${samples.length} sample points on the survey area are not photographed.`, [first[0], first[1], 0]);
	},
	"cruise-speed": ({ spec, plan }) => {
		const { min, max } = spec.cruiseMs;
		const ok = plan.minSpeedMs >= min && plan.cruiseMs <= max;
		return finding(
			"cruise-speed",
			ok,
			false,
			ok ? `Every speed in force is within ${min} to ${max} m/s.` : `The mission flies between ${plan.minSpeedMs} and ${plan.cruiseMs} m/s, outside ${min} to ${max} m/s at some point.`,
		);
	},
};

const HIDDEN_CHECKS: Record<(typeof HIDDEN_RULES)[number], Check> = {
	"hidden-checkpoint": ({ spec, shots, frame, hidden }) => {
		if (hidden === undefined) return finding("hidden-checkpoint", false, true, "The hidden checkpoints were not supplied, so this check cannot pass.");
		const short = hidden.checkpoints.filter(p => holding(p, shots, spec.camera, frame) < hidden.minPhotos);
		if (short.length === 0) return finding("hidden-checkpoint", true, true, `Every hidden checkpoint is in at least ${hidden.minPhotos} photographs.`);
		return finding("hidden-checkpoint", false, true, `${short.length} hidden checkpoint${short.length === 1 ? " is" : "s are"} in fewer than ${hidden.minPhotos} photographs.`);
	},
	"hidden-wind": ({ plan, hidden }) => {
		if (hidden === undefined) return finding("hidden-wind", false, true, "The hidden wind was not supplied, so this check cannot pass.");
		const needed = hidden.cruiseToWindRatio * hidden.windMs;
		const ok = plan.cruiseMs >= needed;
		return finding("hidden-wind", ok, true, ok ? "The cruise speed holds the route in the forecast wind." : `The cruise speed is too low to hold the route in the forecast wind; it needs at least ${needed.toFixed(1)} m/s.`);
	},
};

function sceneFor(geometry: Geometry, segments: readonly Segment[] | null, legs: readonly Leg[], shots: readonly Shot[], camera: Camera, frame: Frame | null): Scene {
	const xs = geometry.area.map(p => p[0]);
	const ys = geometry.area.map(p => p[1]);
	const paths: ScenePath[] = [{ id: "area", kind: "area", layer: "survey", z: 0, closed: true, points: geometry.area }];
	for (const zone of geometry.zones) paths.push({ id: `zone-${zone.id}`, kind: "zone", layer: "no-fly", z: 0, closed: true, points: zone.polygon });
	let maxAlt = 0;
	const byIndex = new Map<number, Leg>();
	for (const leg of legs) byIndex.set(leg.index, leg);
	for (const segment of segments ?? []) {
		const z = Math.max(segment.a.alt, segment.b.alt);
		maxAlt = Math.max(maxAlt, z);
		const points: Vec2[] = [[segment.a.x, segment.a.y], [segment.b.x, segment.b.y]];
		const leg = byIndex.get(segment.index);
		if (leg === undefined) {
			paths.push({ id: `transit-${segment.index}`, kind: "travel", layer: "transit", z, closed: false, order: segment.index, points });
		} else {
			paths.push({ id: `leg-${leg.index}`, kind: "flight", layer: "survey", z: leg.alt, closed: false, order: leg.index, points });
		}
	}
	// One footprint per sampled photograph: the camera's ground footprint around the exposure, not a whole strip.
	if (frame !== null) {
		for (const { index, shot } of sampleShots(shots, SCENE_FOOTPRINTS)) {
			const reach = alongM(shot.alt, camera) / 2;
			const half = acrossM(shot.alt, camera) / 2;
			const corners: Vec2[] = [
				fromFrame(frame, shot.s - reach, shot.t - half),
				fromFrame(frame, shot.s + reach, shot.t - half),
				fromFrame(frame, shot.s + reach, shot.t + half),
				fromFrame(frame, shot.s - reach, shot.t + half),
			];
			paths.push({ id: `photo-${index}`, kind: "footprint", layer: "photo", z: 0, closed: true, order: index, points: corners });
		}
	}
	return { units: "m", size: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), maxAlt], paths };
}

function refused(reason: string, scene: Scene): Verdict {
	return { workflow: "drone-survey", pass: false, findings: [finding("parse", false, false, reason)], measured: { sceneUnit: "m" }, scene };
}

/**
 * Checks a plan against the spec. The spec and the hidden sample arrive as unknown values and are parsed here, so
 * a bad value becomes a failed "parse" finding rather than a throw. The hidden sample is optional; without it the
 * hidden rules fail.
 */
export function verify(specInput: unknown, artefact: string, hiddenInput?: unknown): Verdict {
	const spec = parseSpec(specInput);
	if (typeof spec === "string") return refused(spec, EMPTY_SCENE);
	const geometry = projectGeometry(spec);
	const hiddenParsed = hiddenInput === undefined ? undefined : parseHiddenSample(hiddenInput);
	const hiddenError = typeof hiddenParsed === "string" ? hiddenParsed : null;
	const hidden = typeof hiddenParsed === "string" ? undefined : hiddenParsed;
	const parsed = parsePlan(artefact, spec.origin);
	if (typeof parsed === "string") return refused(parsed, sceneFor(geometry, null, [], [], spec.camera, null));

	const segments = segmentsOf(parsed.waypoints);
	const frame = surveyFrame(segments);
	const legs = legsOf(segments, frame);
	const shots = photographs(flightsOf(segments, legs), LIMITS.exposures);
	if (shots === null) {
		return refused(
			`The mission would take more than ${LIMITS.exposures} photographs, which is more than the checker verifies.`,
			sceneFor(geometry, segments, legs, [], spec.camera, frame),
		);
	}
	const ctx: Context = { spec, geometry, plan: parsed, segments, frame, legs, shots, hidden };
	const publicFindings = PUBLIC_RULES.filter(rule => spec.rules.includes(rule)).map(rule => CHECKS[rule](ctx));
	const hiddenFindings = HIDDEN_RULES.map(rule => HIDDEN_CHECKS[rule](ctx));
	const planFinding =
		hiddenError === null
			? finding("parse", true, false, "The plan is a readable QGroundControl mission.")
			: finding("parse", false, false, `The hidden sample is unusable: ${hiddenError}`);
	// Always run: the checker cannot vouch for items it does not model, and the spec cannot switch this off.
	const unsupportedFinding =
		parsed.unsupported.length === 0
			? finding("unsupported-item", true, false, "Every mission item is one the checker models.")
			: finding("unsupported-item", false, false, `${parsed.unsupported.length} mission item${parsed.unsupported.length === 1 ? "" : "s"} the checker does not model. First: ${parsed.unsupported[0]}`);
	const findings = [planFinding, unsupportedFinding, ...publicFindings, ...hiddenFindings];

	const gsdWorst = worstGsdLeg(legs, spec.camera);
	const frontWorst = worstFrontLeg(legs, spec.camera);
	const sides = sideOverlaps(legs, spec.camera);
	const samples = sampleGrid(geometry.area, spec.gridM);
	const measured: Record<string, number | string> = {
		sceneUnit: "m",
		cruiseMs: parsed.cruiseMs,
		minSpeedMs: parsed.minSpeedMs,
		...(parsed.triggerM === null ? {} : { triggerM: parsed.triggerM }),
		surveyLines: legs.length,
		maxAltitudeM: Math.max(...parsed.waypoints.map(w => w.alt)),
		maxGsdCm: gsdWorst === null ? 0 : gsdCm(gsdWorst.alt, spec.camera),
		frontOverlap: frontWorst === null ? 0 : frontOverlapOf(frontWorst, spec.camera),
		sideOverlap: sides.length === 0 ? 1 : Math.min(...sides.map(pair => pair.overlap)),
		samplePoints: samples.length,
		photographs: shots.length,
		uncoveredSamples: samples.filter(p => holding(p, shots, spec.camera, frame) === 0).length,
	};
	return { workflow: "drone-survey", pass: findings.every(item => item.ok), findings, measured, scene: sceneFor(geometry, segments, legs, shots, spec.camera, frame) };
}
