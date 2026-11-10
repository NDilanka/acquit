// Reads a QGroundControl .plan mission in execution order. Supported items: waypoint (16), takeoff (22), land (21),
// return to launch (20), change speed (178, ground speed only) and camera trigger distance (206). Items the checker
// does not model are collected as unsupported; malformed items refuse the whole plan. Never throws.

import { toLocal, withinLocal } from "./geo.ts";
import { LIMITS } from "./spec.ts";
import type { Vec2 } from "./types.ts";

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

/** A point in local metres east (x) and north (y) of the origin, at an altitude above home. */
export type Point3 = { readonly x: number; readonly y: number; readonly alt: number };

/**
 * A survey position, with the speed and camera trigger in force when it is reached. triggerM is null while
 * triggering is off, or while the aircraft is on the ground at this position, so the stretch of flight into it takes
 * no photographs.
 */
export type Waypoint = {
	readonly x: number;
	readonly y: number;
	/** Metres above home. */
	readonly alt: number;
	readonly speedMs: number;
	readonly triggerM: number | null;
};

/**
 * A straight move of the aircraft from a to b, flown at speedMs ground speed. A climb or a descent keeps x and y.
 * The speed is the one in force on the move: a speed change (command 178) applies from the item after it executes.
 */
export type Move = { readonly a: Point3; readonly b: Point3; readonly speedMs: number };

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
	/** The home position in local metres. The flight climbs from here at takeoff and returns here at return-to-launch. */
	readonly home: Vec2;
	readonly waypoints: readonly Waypoint[];
	readonly events: readonly MissionEvent[];
	/** The aircraft's straight moves in flight order, from the ground at home. Containment and no-fly use these. */
	readonly moves: readonly Move[];
	/**
	 * The first place the mission is out of step with the aircraft: a waypoint reached on the ground, or a takeoff
	 * while already in the air. Null when the lifecycle is in order.
	 */
	readonly lifecycleProblem: string | null;
	/** True when the last lifecycle event is a landing or a return to launch. */
	readonly endsSafely: boolean;
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

/**
 * The home position in local metres and its altitude, after checking the home position lies near the job origin.
 * Returns a reason if not.
 */
function homeOf(value: unknown, origin: readonly [number, number]): { readonly home: Vec2; readonly alt: number } | string {
	if (!Array.isArray(value) || value.length !== 3) return HOME_MESSAGE;
	const home: unknown[] = value;
	const lat = home[0];
	const lon = home[1];
	const alt = home[2];
	if (!isLatitude(lat) || !isLongitude(lon) || !finite(alt)) return HOME_MESSAGE;
	const local = toLocal(origin, lat, lon);
	if (!withinLocal(local, LIMITS.localExtentM)) return "The planned home position is more than 20 km from the job origin.";
	return { home: local, alt };
}

/** Height above home. Frame 0 is above sea level, so home's altitude is taken away; frame 3 is already above home. */
function aboveHome(alt: number, frame: number, homeAltM: number): number {
	return frame === FRAME_ABSOLUTE ? alt - homeAltM : alt;
}

/**
 * The aircraft's moves in flight order. A takeoff climbs straight up from home. A waypoint is flown to in a straight
 * line from wherever the aircraft is. A landing descends where it stands. A return to launch flies home at its current
 * height, then descends there.
 */
function movesOf(events: readonly MissionEvent[], waypoints: readonly Waypoint[], home: Vec2, eventSpeeds: readonly number[]): Move[] {
	const moves: Move[] = [];
	let at: Point3 = { x: home[0], y: home[1], alt: 0 };
	const fly = (to: Point3, speedMs: number): void => {
		moves.push({ a: at, b: to, speedMs });
		at = to;
	};
	events.forEach((event, index) => {
		const speedMs = eventSpeeds[index]!;
		if (event.kind === "takeoff") {
			fly({ x: home[0], y: home[1], alt: event.alt }, speedMs);
		} else if (event.kind === "waypoint") {
			const waypoint = waypoints[event.index]!;
			fly({ x: waypoint.x, y: waypoint.y, alt: waypoint.alt }, waypoint.speedMs);
		} else if (event.kind === "land") {
			fly({ x: at.x, y: at.y, alt: 0 }, speedMs);
		} else {
			fly({ x: home[0], y: home[1], alt: at.alt }, speedMs);
			fly({ x: home[0], y: home[1], alt: 0 }, speedMs);
		}
	});
	return moves;
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
	const homeAt = homeOf(mission.plannedHomePosition, origin);
	if (typeof homeAt === "string") return homeAt;
	const rawItems = mission.items;
	if (!Array.isArray(rawItems)) return "The mission has no items list.";
	const items: unknown[] = rawItems;
	if (items.length > LIMITS.missionItems) return `The mission has ${items.length} items; the checker accepts at most ${LIMITS.missionItems}.`;

	let speedMs = cruiseSpeed;
	let triggerM: number | null = null;
	let triggerSeen = false;
	let airborne = false;
	let lifecycleProblem: string | null = null;
	let triggerAtLastWaypoint: number | null = null;
	const waypoints: Waypoint[] = [];
	const events: MissionEvent[] = [];
	/** The ground speed in force at each event, in the same order. */
	const eventSpeeds: number[] = [];
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
			if (!airborne && lifecycleProblem === null) {
				lifecycleProblem = `${where} is a waypoint the aircraft reaches on the ground. A takeoff (command 22) must come before the survey, and the aircraft must take off again after any landing.`;
			}
			// A waypoint reached on the ground takes no photographs, whatever the trigger setting.
			waypoints.push({ x: local[0], y: local[1], alt: aboveHome(alt, frame, homeAt.alt), speedMs, triggerM: airborne ? triggerM : null });
			triggerAtLastWaypoint = triggerM;
			events.push({ kind: "waypoint", index: waypoints.length - 1 });
			eventSpeeds.push(speedMs);
		} else if (command === CMD_TAKEOFF) {
			if (frame !== FRAME_ABSOLUTE && frame !== FRAME_RELATIVE) {
				unsupported.push(`${where} is a takeoff in coordinate frame ${frame}; the checker models frames 0 and 3.`);
				continue;
			}
			const alt = params[6];
			if (!finite(alt)) return `${where} needs a finite takeoff altitude.`;
			if (airborne && lifecycleProblem === null) lifecycleProblem = `${where} takes off while the aircraft is already in the air.`;
			airborne = true;
			events.push({ kind: "takeoff", alt: aboveHome(alt, frame, homeAt.alt) });
			eventSpeeds.push(speedMs);
		} else if (command === CMD_LAND) {
			airborne = false;
			events.push({ kind: "land" });
			eventSpeeds.push(speedMs);
		} else if (command === CMD_RETURN_TO_LAUNCH) {
			airborne = false;
			events.push({ kind: "rtl" });
			eventSpeeds.push(speedMs);
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
	const last = events[events.length - 1];
	const endsSafely = last !== undefined && (last.kind === "land" || last.kind === "rtl");
	return {
		cruiseMs,
		minSpeedMs,
		triggerM: triggerAtLastWaypoint,
		home: homeAt.home,
		waypoints,
		events,
		moves: movesOf(events, waypoints, homeAt.home, eventSpeeds),
		lifecycleProblem,
		endsSafely,
		unsupported,
	};
}
