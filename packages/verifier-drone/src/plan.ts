// Reads a QGroundControl .plan mission in execution order. Supported items: waypoint (16), takeoff (22), land (21),
// return to launch (20), change speed (178, ground speed only) and camera trigger distance (206). Items the checker
// does not model are collected as unsupported; malformed items refuse the whole plan. Never throws.

import { toLocal, withinLocal } from "./geo.ts";
import { LIMITS } from "./spec.ts";

export const CMD_TAKEOFF = 22;
export const CMD_WAYPOINT = 16;
export const CMD_LAND = 21;
export const CMD_RETURN_TO_LAUNCH = 20;
export const CMD_CHANGE_SPEED = 178;
export const CMD_SET_CAM_TRIGGER_DIST = 206;

/** MAV_FRAME_GLOBAL: altitude above mean sea level. Converted to height above home. */
const FRAME_ABSOLUTE = 0;
/** MAV_FRAME_GLOBAL_RELATIVE_ALT: altitude above home. */
const FRAME_RELATIVE = 3;
/** DO_CHANGE_SPEED speed type for ground speed. Airspeed and climb rates are not modelled. */
const SPEED_GROUND = 1;
/** DO_CHANGE_SPEED value meaning "keep the current speed". */
const SPEED_NO_CHANGE = -1;

/**
 * A survey position in local metres, with the speed and camera trigger in force when it is reached.
 * triggerM is null while triggering is off, so that stretch of flight takes no photographs.
 */
export type Waypoint = {
	readonly x: number;
	readonly y: number;
	/** Metres above home. */
	readonly alt: number;
	readonly speedMs: number;
	readonly triggerM: number | null;
};

/** An ordered lifecycle event. A waypoint event names an index into Plan.waypoints. */
export type MissionEvent =
	| { readonly kind: "takeoff"; readonly alt: number }
	| { readonly kind: "waypoint"; readonly index: number }
	| { readonly kind: "land" }
	| { readonly kind: "rtl" };

export type Plan = {
	/** The highest speed in force at any waypoint, in m/s. */
	readonly cruiseMs: number;
	/** The lowest speed in force at any waypoint, in m/s. */
	readonly minSpeedMs: number;
	/** The trigger distance in force at the last waypoint, or null when triggering is off there. */
	readonly triggerM: number | null;
	readonly waypoints: readonly Waypoint[];
	readonly events: readonly MissionEvent[];
	/** One sentence per item the checker does not model. The verdict fails while this is not empty. */
	readonly unsupported: readonly string[];
};

const HOME_MESSAGE = "The mission needs plannedHomePosition as [latitude, longitude, altitude].";

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

function wholeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

function isLatitude(value: unknown): value is number {
	return finite(value) && Math.abs(value) <= 90;
}

function isLongitude(value: unknown): value is number {
	return finite(value) && Math.abs(value) <= 180;
}

/** A MAVLink parameter: a number, or null where QGroundControl left it unset. */
function isParam(value: unknown): boolean {
	return value === null || finite(value);
}

/** The home altitude in metres, after checking the home position lies near the job origin. Returns a reason if not. */
function homeAltitude(value: unknown, origin: readonly [number, number]): number | string {
	if (!Array.isArray(value) || value.length !== 3) return HOME_MESSAGE;
	const home: unknown[] = value;
	const lat = home[0];
	const lon = home[1];
	const alt = home[2];
	if (!isLatitude(lat) || !isLongitude(lon) || !finite(alt)) return HOME_MESSAGE;
	if (!withinLocal(toLocal(origin, lat, lon), LIMITS.localExtentM)) return "The planned home position is more than 20 km from the job origin.";
	return alt;
}

/** Height above home. Frame 0 is above sea level, so home's altitude is taken away; frame 3 is already above home. */
function aboveHome(alt: number, frame: number, homeAltM: number): number {
	return frame === FRAME_ABSOLUTE ? alt - homeAltM : alt;
}

/** Parses the plan text against the spec origin. Returns the plan, or the reason it was refused. Never throws. */
export function parsePlan(text: string, origin: readonly [number, number]): Plan | string {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return "The file is not valid JSON, so it is not a QGroundControl plan.";
	}
	if (!isRecord(json) || json.fileType !== "Plan" || !isRecord(json.mission)) return "The file is not a QGroundControl Plan with a mission.";
	const mission = json.mission;
	const cruiseSpeed = mission.cruiseSpeed;
	if (!positive(cruiseSpeed)) return "The mission has no positive cruiseSpeed.";
	const homeAltM = homeAltitude(mission.plannedHomePosition, origin);
	if (typeof homeAltM === "string") return homeAltM;
	const rawItems = mission.items;
	if (!Array.isArray(rawItems)) return "The mission has no items list.";
	const items: unknown[] = rawItems;
	if (items.length > LIMITS.missionItems) return `The mission has ${items.length} items; the checker accepts at most ${LIMITS.missionItems}.`;

	let speedMs = cruiseSpeed;
	let triggerM: number | null = null;
	let triggerSeen = false;
	const waypoints: Waypoint[] = [];
	const events: MissionEvent[] = [];
	const unsupported: string[] = [];

	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const where = `Mission item ${index}`;
		if (!isRecord(item)) return `${where} is not an object.`;
		if (item.type === "ComplexItem") {
			unsupported.push(`${where} is a complex item (survey or pattern); the checker reads simple items only.`);
			continue;
		}
		if (typeof item.type !== "string") return `${where} has no type.`;
		if (item.type !== "SimpleItem") {
			unsupported.push(`${where} has an item type the checker does not model.`);
			continue;
		}
		const command = item.command;
		const frame = item.frame;
		const autoContinue = item.autoContinue;
		if (!wholeNumber(command) || !wholeNumber(frame)) return `${where} needs an integer command and frame.`;
		if (typeof autoContinue !== "boolean") return `${where} needs autoContinue set to true or false.`;
		const rawParams = item.params;
		if (!Array.isArray(rawParams) || rawParams.length !== 7) return `${where} needs seven params.`;
		const params: unknown[] = rawParams;
		if (!params.every(isParam)) return `${where} has a param that is neither a number nor unset.`;
		if (autoContinue === false) {
			unsupported.push(`${where} does not continue automatically; the checker does not model manual continuation.`);
			continue;
		}

		if (command === CMD_SET_CAM_TRIGGER_DIST) {
			const distance = params[0];
			if (!nonNegative(distance)) return `${where} sets a camera trigger distance that is not zero or a positive number of metres.`;
			triggerM = distance === 0 ? null : distance;
			triggerSeen = true;
		} else if (command === CMD_CHANGE_SPEED) {
			const speedType = params[0];
			const value = params[1];
			if (speedType !== SPEED_GROUND) {
				unsupported.push(`${where} changes airspeed or climb rate; the checker models ground speed only.`);
				continue;
			}
			if (value === SPEED_NO_CHANGE) continue;
			if (!positive(value)) return `${where} sets a speed that is not a positive number of metres per second.`;
			speedMs = value;
		} else if (command === CMD_WAYPOINT) {
			if (frame !== FRAME_ABSOLUTE && frame !== FRAME_RELATIVE) {
				unsupported.push(`${where} is a waypoint in coordinate frame ${frame}; the checker models frames 0 and 3.`);
				continue;
			}
			const lat = params[4];
			const lon = params[5];
			const alt = params[6];
			if (!isLatitude(lat) || !isLongitude(lon) || !finite(alt)) return `${where} needs a latitude, longitude and altitude.`;
			const local = toLocal(origin, lat, lon);
			if (!withinLocal(local, LIMITS.localExtentM)) return `${where} is more than 20 km from the job origin.`;
			waypoints.push({ x: local[0], y: local[1], alt: aboveHome(alt, frame, homeAltM), speedMs, triggerM });
			events.push({ kind: "waypoint", index: waypoints.length - 1 });
		} else if (command === CMD_TAKEOFF) {
			if (frame !== FRAME_ABSOLUTE && frame !== FRAME_RELATIVE) {
				unsupported.push(`${where} is a takeoff in coordinate frame ${frame}; the checker models frames 0 and 3.`);
				continue;
			}
			const alt = params[6];
			if (!finite(alt)) return `${where} needs a finite takeoff altitude.`;
			events.push({ kind: "takeoff", alt: aboveHome(alt, frame, homeAltM) });
		} else if (command === CMD_LAND) {
			events.push({ kind: "land" });
		} else if (command === CMD_RETURN_TO_LAUNCH) {
			events.push({ kind: "rtl" });
		} else {
			unsupported.push(`${where} is command ${command}, which the checker does not model.`);
		}
	}

	if (!triggerSeen) return "The plan sets no camera trigger distance (MAV_CMD 206), so photo overlap cannot be checked.";
	if (waypoints.length < 2) return "The plan has fewer than two waypoints.";
	let cruiseMs = waypoints[0]!.speedMs;
	let minSpeedMs = cruiseMs;
	for (const waypoint of waypoints) {
		cruiseMs = Math.max(cruiseMs, waypoint.speedMs);
		minSpeedMs = Math.min(minSpeedMs, waypoint.speedMs);
	}
	return { cruiseMs, minSpeedMs, triggerM: waypoints[waypoints.length - 1]!.triggerM, waypoints, events, unsupported };
}
