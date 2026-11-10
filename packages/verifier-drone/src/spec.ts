// Reads the published job spec and the hidden sample. Each returns the parsed value, or a sentence saying why it is
// not usable. Never throws. Geographic points are [latitude, longitude] in degrees; hidden points are local metres.

import { toLocal, withinLocal } from "./geo.ts";
import type { Camera, HiddenSample, LatLon, Spec, Vec2, Zone } from "./types.ts";

/** Rules a spec must list, each exactly once. "parse" always runs and is not listed. */
export const PUBLIC_RULES = ["altitude-limits", "ground-resolution", "front-overlap", "side-overlap", "no-fly", "coverage", "cruise-speed"] as const;
/** Rules that need the hidden sample. They always run; without the sample they fail. */
export const HIDDEN_RULES = ["hidden-checkpoint", "hidden-wind"] as const;

/** Limits that keep verification bounded. Inputs above them are refused by the parsers. */
export const LIMITS = {
	missionItems: 2000,
	areaPoints: 500,
	zones: 50,
	zonePoints: 200,
	checkpoints: 1000,
	pixels: 100000,
	minPhotos: 1000,
	localExtentM: 20000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
	return finite(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
	return finite(value) && value >= 0;
}

function unitInterval(value: unknown): value is number {
	return finite(value) && value >= 0 && value <= 1;
}

function wholeBetween(value: unknown, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

function latLon(value: unknown): value is LatLon {
	return Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]) && Math.abs(value[0]) <= 90 && Math.abs(value[1]) <= 180;
}

function vec2(value: unknown): value is Vec2 {
	return Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]);
}

function withinExtent(origin: LatLon, point: LatLon): boolean {
	return withinLocal(toLocal(origin, point[0], point[1]), LIMITS.localExtentM);
}

/** A list of geographic points: at least three, at most `max`, all in range and near the origin. */
function polygon(value: unknown, origin: LatLon, max: number): LatLon[] | null {
	if (!Array.isArray(value) || value.length < 3 || value.length > max) return null;
	const out: LatLon[] = [];
	for (const point of value) {
		if (!latLon(point) || !withinExtent(origin, point)) return null;
		out.push([point[0], point[1]]);
	}
	return out;
}

function camera(value: unknown): Camera | string {
	if (!isRecord(value)) return "The spec camera needs sensorWidthMm, sensorHeightMm, focalMm, imageWidthPx and imageHeightPx.";
	const sensorWidthMm = value.sensorWidthMm;
	const sensorHeightMm = value.sensorHeightMm;
	const focalMm = value.focalMm;
	const imageWidthPx = value.imageWidthPx;
	const imageHeightPx = value.imageHeightPx;
	if (!positive(sensorWidthMm) || !positive(sensorHeightMm) || !positive(focalMm)) return "The camera needs positive sensorWidthMm, sensorHeightMm and focalMm.";
	if (!wholeBetween(imageWidthPx, LIMITS.pixels) || !wholeBetween(imageHeightPx, LIMITS.pixels)) return "The camera imageWidthPx and imageHeightPx must be whole pixel counts.";
	return { sensorWidthMm, sensorHeightMm, focalMm, imageWidthPx, imageHeightPx };
}

function zones(value: unknown, origin: LatLon): Zone[] | string {
	if (!Array.isArray(value) || value.length > LIMITS.zones) return "zones must be a list of no-fly zones.";
	const out: Zone[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) return "Each no-fly zone needs a non-empty id.";
		const heightM = item.heightM;
		if (!positive(heightM)) return `No-fly zone ${item.id} needs a positive heightM in metres.`;
		const points = polygon(item.polygon, origin, LIMITS.zonePoints);
		if (points === null) return `No-fly zone ${item.id} needs at least three geographic [latitude, longitude] points in range.`;
		out.push({ id: item.id, heightM, polygon: points });
	}
	return out;
}

/** Parses and checks the spec. The result is a Spec, or the reason it was refused. */
export function parseSpec(value: unknown): Spec | string {
	if (!isRecord(value)) return "The spec is not a JSON object.";
	if (typeof value.id !== "string" || value.id.length === 0) return "The spec needs a non-empty id.";
	if (!latLon(value.origin)) return "The spec origin needs a latitude in [-90, 90] and a longitude in [-180, 180].";
	const origin: LatLon = [value.origin[0], value.origin[1]];
	const cam = camera(value.camera);
	if (typeof cam === "string") return cam;
	const area = polygon(value.area, origin, LIMITS.areaPoints);
	if (area === null) return "The survey area needs at least three geographic [latitude, longitude] points in range, within 20 km of the origin.";
	const zoneList = zones(value.zones, origin);
	if (typeof zoneList === "string") return zoneList;

	const maxAltitudeM = value.maxAltitudeM;
	const minAltitudeM = value.minAltitudeM;
	if (!positive(maxAltitudeM)) return "maxAltitudeM must be a positive number of metres.";
	if (!positive(minAltitudeM) || minAltitudeM >= maxAltitudeM) return "minAltitudeM must be positive and below maxAltitudeM.";
	const maxGsdCm = value.maxGsdCm;
	if (!positive(maxGsdCm)) return "maxGsdCm must be a positive number of centimetres.";
	const gridM = value.gridM;
	if (!positive(gridM)) return "gridM must be a positive number of metres.";
	const minFrontOverlap = value.minFrontOverlap;
	const minSideOverlap = value.minSideOverlap;
	if (!unitInterval(minFrontOverlap) || !unitInterval(minSideOverlap)) return "minFrontOverlap and minSideOverlap must be fractions from 0 to 1.";
	const cruise = value.cruiseMs;
	if (!isRecord(cruise)) return "cruiseMs needs a positive min not above max.";
	const cruiseMin = cruise.min;
	const cruiseMax = cruise.max;
	if (!positive(cruiseMin) || !positive(cruiseMax) || cruiseMin > cruiseMax) return "cruiseMs needs a positive min not above max.";
	const enduranceS = value.enduranceS;
	const reserveS = value.reserveS;
	if (!positive(enduranceS)) return "enduranceS must be a positive number of seconds.";
	if (!nonNegative(reserveS) || reserveS >= enduranceS) return "reserveS must be non-negative and below enduranceS.";
	const geofenceMarginM = value.geofenceMarginM;
	if (!nonNegative(geofenceMarginM)) return "geofenceMarginM must be a non-negative number of metres.";

	const rules = value.rules;
	const ruleList: string[] = Array.isArray(rules) && rules.every(rule => typeof rule === "string") ? (rules as string[]) : [];
	const exact = ruleList.length === PUBLIC_RULES.length && new Set(ruleList).size === PUBLIC_RULES.length && PUBLIC_RULES.every(rule => ruleList.includes(rule));
	if (!exact) return `rules must list each of ${PUBLIC_RULES.join(", ")} exactly once.`;

	return {
		id: value.id,
		origin,
		area,
		zones: zoneList,
		camera: cam,
		maxAltitudeM,
		minAltitudeM,
		maxGsdCm,
		minFrontOverlap,
		minSideOverlap,
		cruiseMs: { min: cruiseMin, max: cruiseMax },
		enduranceS,
		reserveS,
		geofenceMarginM,
		gridM,
		rules: ruleList,
	};
}

/** Parses the hidden sample. Checkpoints are local metres from the origin; minPhotos is the photograph count per checkpoint. */
export function parseHiddenSample(value: unknown): HiddenSample | string {
	if (!isRecord(value)) return "The hidden sample is not a JSON object.";
	const list = value.checkpoints;
	if (!Array.isArray(list) || list.length > LIMITS.checkpoints) return "The hidden checkpoints must be a list of at most 1000 [x, y] points in metres.";
	const checkpoints: Vec2[] = [];
	for (const point of list) {
		if (!vec2(point) || Math.abs(point[0]) > LIMITS.localExtentM || Math.abs(point[1]) > LIMITS.localExtentM) return "Each hidden checkpoint must be a finite [x, y] point in metres within 20 km.";
		checkpoints.push([point[0], point[1]]);
	}
	const windMs = value.windMs;
	if (!nonNegative(windMs)) return "windMs must be a non-negative number of metres per second.";
	const cruiseToWindRatio = value.cruiseToWindRatio;
	if (!positive(cruiseToWindRatio)) return "cruiseToWindRatio must be a positive number.";
	const minPhotos = value.minPhotos;
	if (!wholeBetween(minPhotos, LIMITS.minPhotos)) return "minPhotos must be a whole number of photographs from 1 to 1000.";
	return { checkpoints, windMs, cruiseToWindRatio, minPhotos };
}
