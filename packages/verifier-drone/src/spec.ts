// Reads the published job spec. Returns the spec, or a sentence saying why it is not usable. Never throws.

import type { Camera, Spec, Vec2, Zone } from "./types.ts";

/** Rules a spec may list. "parse" always runs and is not listed. */
export const PUBLIC_RULES = ["altitude-ceiling", "gsd", "front-overlap", "side-overlap", "no-fly", "coverage", "cruise-speed"] as const;
/** Rules that need the hidden sample. They always run; without the sample they fail. */
export const HIDDEN_RULES = ["hidden-checkpoint", "hidden-wind"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function vec2(value: unknown): value is Vec2 {
	return Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]);
}

function positive(value: unknown): value is number {
	return finite(value) && value > 0;
}

function camera(value: unknown): Camera | null {
	if (!isRecord(value)) return null;
	const { sensorWidthMm, sensorHeightMm, focalMm, imageWidthPx } = value;
	if (!positive(sensorWidthMm) || !positive(sensorHeightMm) || !positive(focalMm) || !positive(imageWidthPx)) return null;
	return { sensorWidthMm, sensorHeightMm, focalMm, imageWidthPx };
}

function zones(value: unknown): Zone[] | null {
	if (!Array.isArray(value)) return null;
	const out: Zone[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== "string" || !Array.isArray(item.polygon) || item.polygon.length < 3) return null;
		if (!item.polygon.every(vec2)) return null;
		out.push({ id: item.id, polygon: item.polygon as Vec2[] });
	}
	return out;
}

/** Parses and checks the spec. The result is a Spec, or the reason it was refused. */
export function parseSpec(value: unknown): Spec | string {
	if (!isRecord(value)) return "The spec is not a JSON object.";
	const cam = camera(value.camera);
	if (cam === null) return "The spec camera needs positive sensorWidthMm, sensorHeightMm, focalMm and imageWidthPx.";
	const zoneList = zones(value.zones);
	if (zoneList === null) return "Each no-fly zone needs an id and at least three [x, y] points.";
	if (typeof value.id !== "string") return "The spec needs an id.";
	if (!Array.isArray(value.origin) || !finite(value.origin[0]) || !finite(value.origin[1]) || value.origin.length !== 2) return "The spec origin needs a latitude and longitude.";
	if (!Array.isArray(value.area) || value.area.length < 3 || !value.area.every(vec2)) return "The survey area needs at least three [x, y] points in metres.";
	if (!positive(value.maxAltitudeM) || !positive(value.maxGsdCm) || !positive(value.gridM)) return "maxAltitudeM, maxGsdCm and gridM must be positive numbers.";
	if (!finite(value.minFrontOverlap) || !finite(value.minSideOverlap)) return "minFrontOverlap and minSideOverlap must be numbers.";
	const cruise = isRecord(value.cruiseMs) ? value.cruiseMs : null;
	if (cruise === null || !positive(cruise.min) || !positive(cruise.max) || cruise.min > cruise.max) return "cruiseMs needs a positive min not above max.";
	if (!Array.isArray(value.rules) || !value.rules.every(rule => typeof rule === "string" && (PUBLIC_RULES as readonly string[]).includes(rule))) {
		return `rules must be a list of ${PUBLIC_RULES.join(", ")}.`;
	}
	return {
		id: value.id,
		origin: [value.origin[0], value.origin[1]],
		area: value.area as Vec2[],
		zones: zoneList,
		camera: cam,
		maxAltitudeM: value.maxAltitudeM,
		maxGsdCm: value.maxGsdCm,
		minFrontOverlap: value.minFrontOverlap,
		minSideOverlap: value.minSideOverlap,
		cruiseMs: { min: cruise.min, max: cruise.max },
		gridM: value.gridM,
		rules: value.rules as string[],
	};
}
