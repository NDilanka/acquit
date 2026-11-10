// Reads the QGroundControl .plan mission this checker understands: cruise speed, the camera trigger distance
// (MAV_CMD 206) and the waypoints (MAV_CMD 16). Other items are ignored. Returns a reason on any bad input.

import { toLocal } from "./geo.ts";
import type { Vec2 } from "./types.ts";

export const CMD_WAYPOINT = 16;
export const CMD_SET_CAM_TRIGGER_DIST = 206;

export type Waypoint = { readonly x: number; readonly y: number; readonly alt: number };
export type Plan = { readonly cruiseMs: number; readonly triggerM: number; readonly waypoints: readonly Waypoint[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Parses the plan text against the spec origin. Never throws. */
export function parsePlan(text: string, origin: readonly [number, number]): Plan | string {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return "The file is not valid JSON, so it is not a QGroundControl plan.";
	}
	if (!isRecord(json) || json.fileType !== "Plan" || !isRecord(json.mission)) return "The file is not a QGroundControl Plan with a mission.";
	const mission = json.mission;
	if (!finite(mission.cruiseSpeed) || mission.cruiseSpeed <= 0) return "The mission has no positive cruiseSpeed.";
	if (!Array.isArray(mission.items)) return "The mission has no items list.";

	let triggerM: number | null = null;
	const waypoints: Waypoint[] = [];
	for (const item of mission.items) {
		if (!isRecord(item) || item.type !== "SimpleItem" || !Array.isArray(item.params)) continue;
		const params: unknown[] = item.params;
		if (item.command === CMD_SET_CAM_TRIGGER_DIST) {
			if (!finite(params[0]) || params[0] <= 0) return "The camera trigger distance must be a positive number of metres.";
			triggerM = params[0];
		} else if (item.command === CMD_WAYPOINT) {
			const lat = params[4];
			const lon = params[5];
			const alt = params[6];
			if (!finite(lat) || !finite(lon) || !finite(alt)) return "A waypoint has no latitude, longitude or altitude.";
			const [x, y] = toLocal(origin, lat, lon);
			waypoints.push({ x, y, alt });
		}
	}
	if (triggerM === null) return "The plan sets no camera trigger distance (MAV_CMD 206), so photo overlap cannot be checked.";
	if (waypoints.length < 2) return "The plan has fewer than two waypoints.";
	return { cruiseMs: mission.cruiseSpeed, triggerM, waypoints };
}

/** The ground-level corners of a survey leg's footprint, used for the scene and the coverage check. */
export function rectangle(x0: number, x1: number, y0: number, y1: number): Vec2[] {
	return [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
	];
}
