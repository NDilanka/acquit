// The drone survey checker. It reads a QGroundControl plan and the job spec, and returns a Verdict.
// Pure TypeScript: no I/O, no clock, no randomness. Bad input becomes a failed "parse" finding.

import { fromFrame, frameFrom, pointInPolygon, segmentDistanceToPolygon, segmentInsidePolygon, toFrame, toLocal } from "./geo.ts";
import type { Frame } from "./geo.ts";
import { parsePlan } from "./plan.ts";
import type { Move, Plan, Waypoint } from "./plan.ts";
import { photographs } from "./photos.ts";
import type { Flight, Shot } from "./photos.ts";
import { HIDDEN_RULES, LIMITS, PUBLIC_RULES, parseHiddenSample, parseSpec } from "./spec.ts";
import type { Camera, Finding, HiddenSample, Scene, ScenePath, Spec, Vec2, Vec3, Verdict } from "./types.ts";

/** Metres. Positions this close count as equal, so plan rounding does not split a survey line. */
const TOL = 0.05;
/** Metres of altitude. Altitudes this close count as level, so float noise cannot split a survey line. */
const ALT_TOL = 1e-6;
/** Metres. A route this close to a no-fly clearance counts as touching it, so float noise cannot slip a graze past. */
const CONTACT_M = 1e-6;
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
type Geometry = {
	readonly area: readonly Vec2[];
	readonly zones: readonly { readonly id: string; readonly heightM: number; readonly polygon: readonly Vec2[] }[];
};
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
		zones: spec.zones.map(zone => ({ id: zone.id, heightM: zone.heightM, polygon: zone.polygon.map(project) })),
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

/** The coverage cell size: the area is judged at the centre of every 2 m square cell, not on a caller-chosen grid. */
const COVERAGE_CELL_M = 2;
/** The fraction of sampled cell centres that must be photographed for coverage to pass. */
const COVERAGE_MIN = 0.99;

/** The bounding box of the area, found iteratively so a long point list cannot overflow the stack. */
function bounds(area: readonly Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const point of area) {
		if (point[0] < minX) minX = point[0];
		if (point[0] > maxX) maxX = point[0];
		if (point[1] < minY) minY = point[1];
		if (point[1] > maxY) maxY = point[1];
	}
	return { minX, maxX, minY, maxY };
}

/** How many cell centres one axis holds: the first centre is one half-cell above the minimum, strictly below the maximum. */
function axisCells(min: number, max: number): number {
	return Math.max(0, Math.ceil((max - min - COVERAGE_CELL_M / 2) / COVERAGE_CELL_M));
}

/** The 2 m coverage cells an area's bounding box spans; areas above the limit are refused before any sampling. */
function coverageCells(area: readonly Vec2[]): number {
	const box = bounds(area);
	return axisCells(box.minX, box.maxX) * axisCells(box.minY, box.maxY);
}

/** The centre of every 2 m cell whose centre lies inside the survey area, in x-then-y order. */
function sampleGrid(area: readonly Vec2[]): Vec2[] {
	const box = bounds(area);
	const out: Vec2[] = [];
	for (let x = box.minX + COVERAGE_CELL_M / 2; x < box.maxX; x += COVERAGE_CELL_M) {
		for (let y = box.minY + COVERAGE_CELL_M / 2; y < box.maxY; y += COVERAGE_CELL_M) {
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

/** The midpoint of a flight move, in local metres and altitude. */
function moveMid(move: Move): Vec3 {
	return [(move.a.x + move.b.x) / 2, (move.a.y + move.b.y) / 2, (move.a.alt + move.b.alt) / 2];
}

/** The 3D length of a move: a climb or a descent counts as flight, not only ground distance. */
function moveLength(move: Move): number {
	return Math.hypot(move.b.x - move.a.x, move.b.y - move.a.y, move.b.alt - move.a.alt);
}

/** The route's still-air flight time: every move at the speed in force on it, takeoff and return included. */
function flightSeconds(plan: Plan): number {
	let seconds = 0;
	for (const move of plan.moves) seconds += moveLength(move) / move.speedMs;
	return seconds;
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
 * Overlap between each survey line and its genuine neighbour on the upper side. The neighbour is the line across
 * from it that shares the most of its along-track extent, not merely the closest line across: a short or disjoint
 * leg cannot stand in for a neighbour along parts of the survey it does not photograph. Ties on shared extent take
 * the closer line, then the earlier one, so the pairing is deterministic. The lower of the two footprints counts.
 */
function sideOverlaps(legs: readonly Leg[], camera: Camera): { overlap: number; a: Leg; b: Leg }[] {
	const out: { overlap: number; a: Leg; b: Leg }[] = [];
	for (const a of legs) {
		const aLo = Math.min(a.s0, a.s1);
		const aHi = Math.max(a.s0, a.s1);
		let best: Leg | null = null;
		let bestCommon = TOL;
		let bestSpacing = Infinity;
		for (const b of legs) {
			const spacing = b.t - a.t;
			if (spacing <= TOL) continue;
			const common = Math.min(aHi, Math.max(b.s0, b.s1)) - Math.max(aLo, Math.min(b.s0, b.s1));
			if (common > bestCommon + TOL || (common > TOL && common >= bestCommon - TOL && spacing < bestSpacing)) {
				best = b;
				bestCommon = common;
				bestSpacing = spacing;
			}
		}
		if (best === null) continue;
		const width = Math.min(acrossM(a.alt, camera), acrossM(best.alt, camera));
		out.push({ overlap: 1 - bestSpacing / width, a, b: best });
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
	"no-fly": ({ spec, geometry, plan }) => {
		const margin = spec.geofenceMarginM;
		for (const move of plan.moves) {
			// The clearance around a zone is its footprint grown by the margin, up to its height grown by the margin.
			// A move is tested whole: its entire altitude band and its entire horizontal run.
			const low = Math.min(move.a.alt, move.b.alt);
			const high = Math.max(move.a.alt, move.b.alt);
			for (const zone of geometry.zones) {
				if (low > zone.heightM + margin + ALT_TOL) continue;
				const gap = segmentDistanceToPolygon([move.a.x, move.a.y], [move.b.x, move.b.y], zone.polygon);
				if (gap > margin + CONTACT_M) continue;
				return finding(
					"no-fly",
					false,
					false,
					`The route comes within ${margin} m of no-fly zone ${zone.id}, which is ${zone.heightM} m high, at ${low.toFixed(1)} to ${high.toFixed(1)} m.`,
					moveMid(move),
					[`zone-${zone.id}`],
				);
			}
		}
		return finding("no-fly", true, false, "No part of the route comes within the no-fly clearance of any zone.");
	},
	coverage: ({ spec, geometry, shots, frame }) => {
		const samples = sampleGrid(geometry.area);
		if (samples.length === 0) return finding("coverage", false, false, "The survey area holds no 2 m sample cell, so coverage cannot be shown.");
		const missed = samples.filter(p => holding(p, shots, spec.camera, frame) === 0);
		if (missed.length === 0) return finding("coverage", true, false, `All ${samples.length} sample points on the survey area are photographed.`);
		const covered = samples.length - missed.length;
		if (covered / samples.length >= COVERAGE_MIN) {
			return finding("coverage", true, false, `${covered} of ${samples.length} sample points on the survey area are photographed, at least ${percent(COVERAGE_MIN)}.`);
		}
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
	"hidden-wind": ({ spec, plan, hidden }) => {
		if (hidden === undefined) return finding("hidden-wind", false, true, "The hidden wind was not supplied, so this check cannot pass.");
		// Every move is priced against the headwind: ground speed is the speed in force minus the wind. A route that
		// cannot advance against the wind fails, and so does one whose windy duration outlasts the usable battery.
		const usable = spec.enduranceS - spec.reserveS;
		let seconds = 0;
		for (const move of plan.moves) {
			const groundSpeed = move.speedMs - hidden.windMs;
			if (groundSpeed <= 0) return finding("hidden-wind", false, true, "The forecast wind stops forward progress on some of the route.");
			seconds += moveLength(move) / groundSpeed;
		}
		const margin = hidden.cruiseToWindRatio * hidden.windMs;
		if (plan.cruiseMs < margin) return finding("hidden-wind", false, true, `The cruise speed is too low to hold the route in the forecast wind; it needs at least ${margin.toFixed(1)} m/s.`);
		if (seconds > usable) return finding("hidden-wind", false, true, `The route takes ${Math.round(seconds)} seconds in the forecast wind, longer than the ${Math.round(usable)} seconds usable after the reserve.`);
		return finding("hidden-wind", true, true, `The route takes ${Math.round(seconds)} seconds in the forecast wind, within the ${Math.round(usable)} seconds usable after the reserve.`);
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
	const cells = coverageCells(geometry.area);
	if (cells > LIMITS.coverageCells) {
		return refused(
			`The survey area spans about ${cells} 2 m coverage cells, more than the ${LIMITS.coverageCells} the checker samples.`,
			sceneFor(geometry, null, [], [], spec.camera, null),
		);
	}
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
	// Always run, like unsupported-item: they check the lifecycle and the path the aircraft actually flies, which a spec
	// cannot switch off.
	const takeoffFinding =
		parsed.lifecycleProblem === null
			? finding("starts-with-takeoff", true, false, "The aircraft takes off before its survey and stays airborne for every survey waypoint.")
			: finding("starts-with-takeoff", false, false, parsed.lifecycleProblem);
	const endFinding = parsed.endsSafely
		? finding("ends-safely", true, false, "The mission ends with a landing or a return to launch.")
		: finding("ends-safely", false, false, "The mission does not end with a landing (command 21) or a return to launch (command 20).");
	const leaving = parsed.moves.find(move => !segmentInsidePolygon([move.a.x, move.a.y], [move.b.x, move.b.y], geometry.area, TOL));
	const areaFinding =
		leaving === undefined
			? finding("inside-area", true, false, "Every flight segment stays inside the survey area.")
			: finding("inside-area", false, false, "A flight segment leaves the survey area.", moveMid(leaving));
	// Always run, like the other lifecycle findings: the battery is a safety limit the spec's rule list cannot
	// switch off. The usable battery is the endurance with the reserve kept back.
	const routeSeconds = flightSeconds(parsed);
	const usableSeconds = spec.enduranceS - spec.reserveS;
	const enduranceFinding =
		routeSeconds <= usableSeconds
			? finding("endurance", true, false, `The route takes ${Math.round(routeSeconds)} seconds of flight, within the ${usableSeconds} seconds usable after the reserve.`)
			: finding("endurance", false, false, `The route takes ${Math.round(routeSeconds)} seconds of flight, longer than the ${usableSeconds} seconds usable after the reserve.`);
	const findings = [planFinding, unsupportedFinding, takeoffFinding, endFinding, areaFinding, enduranceFinding, ...publicFindings, ...hiddenFindings];

	const gsdWorst = worstGsdLeg(legs, spec.camera);
	const frontWorst = worstFrontLeg(legs, spec.camera);
	const sides = sideOverlaps(legs, spec.camera);
	const samples = sampleGrid(geometry.area);
	const measured: Record<string, number | string> = {
		sceneUnit: "m",
		cruiseMs: parsed.cruiseMs,
		minSpeedMs: parsed.minSpeedMs,
		...(parsed.triggerM === null ? {} : { triggerM: parsed.triggerM }),
		surveyLines: legs.length,
		flightSeconds: routeSeconds,
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
