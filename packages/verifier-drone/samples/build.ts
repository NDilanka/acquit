// Builds the shipped samples: one spec, one honest plan, and one fraud per rule. The files in this folder are
// written from this module, and test/drone-samples.test.ts fails when they drift from it.
// Each fraud changes the honest plan in exactly one way, so it should fail exactly the rule it is named for.

import { toLatLon } from "../src/geo.ts";
import { CMD_RETURN_TO_LAUNCH, CMD_SET_CAM_TRIGGER_DIST, CMD_TAKEOFF, CMD_WAYPOINT } from "../src/plan.ts";

type Wp = { x: number; y: number; alt: number };

export const ORIGIN: [number, number] = [51.5, -0.12];
const ROUND = (value: number): number => Number(value.toFixed(7));

/** Converts local metre points (east, north of the origin) to rounded geographic [latitude, longitude] pairs. */
function geographic(points: readonly (readonly [number, number])[]): [number, number][] {
	return points.map(([x, y]) => {
		const [lat, lon] = toLatLon(ORIGIN, x, y);
		return [ROUND(lat), ROUND(lon)];
	});
}

export const SPEC = {
	id: "orchard-survey",
	origin: ORIGIN,
	area: geographic([
		[0, 0],
		[100, 0],
		[100, 120],
		[0, 120],
	]),
	zones: [
		{
			id: "pump-house",
			heightM: 30,
			polygon: geographic([
				[60, 38],
				[70, 38],
				[70, 42],
				[60, 42],
			]),
		},
	],
	camera: { sensorWidthMm: 13.2, sensorHeightMm: 8.8, focalMm: 8.8, imageWidthPx: 5472, imageHeightPx: 3648 },
	maxAltitudeM: 120,
	minAltitudeM: 20,
	maxGsdCm: 2.5,
	minFrontOverlap: 0.7,
	minSideOverlap: 0.6,
	cruiseMs: { min: 5, max: 20 },
	enduranceS: 1800,
	reserveS: 300,
	geofenceMarginM: 5,
	gridM: 10,
	rules: ["altitude-limits", "ground-resolution", "front-overlap", "side-overlap", "no-fly", "coverage", "cruise-speed"],
};

/**
 * Lines alternate direction: even lines fly west to east, odd lines east to west. Each line runs the full width of the
 * 0 to 100 m survey area, and each is two waypoints, so the turns between lines also stay inside the area.
 */
function lines(ys: readonly number[], alt: number): Wp[] {
	const out: Wp[] = [];
	ys.forEach((y, k) => {
		const forward = k % 2 === 0;
		out.push({ x: forward ? 0 : 100, y, alt }, { x: forward ? 100 : 0, y, alt });
	});
	return out;
}

const HONEST_YS = [30, 50, 70, 90, 110];

/** The height every sample takes off to, in metres above home. */
const TAKEOFF_M = 40;

/** A QGroundControl simple item. doJumpId numbers the items in mission order, as QGroundControl writes them. */
function simple(doJumpId: number, command: number, frame: number, params: readonly number[]): object {
	return { type: "SimpleItem", command, doJumpId, frame, autoContinue: true, params: [...params] };
}

/**
 * A complete mission: camera trigger, takeoff from home, the survey waypoints, then return to launch. Every sample flies
 * this lifecycle, so each fraud breaks only the rule it is named for.
 */
function plan(cruise: number, trigger: number, waypoints: readonly Wp[]): string {
	const items: object[] = [
		simple(1, CMD_SET_CAM_TRIGGER_DIST, 2, [trigger, 0, 0, 0, 0, 0, 0]),
		simple(2, CMD_TAKEOFF, 3, [0, 0, 0, 0, ORIGIN[0], ORIGIN[1], TAKEOFF_M]),
	];
	waypoints.forEach((wp, i) => {
		const [lat, lon] = toLatLon(ORIGIN, wp.x, wp.y);
		items.push(simple(i + 3, CMD_WAYPOINT, 3, [0, 0, 0, 0, ROUND(lat), ROUND(lon), wp.alt]));
	});
	items.push(simple(waypoints.length + 3, CMD_RETURN_TO_LAUNCH, 2, [0, 0, 0, 0, 0, 0, 0]));
	const document = {
		fileType: "Plan",
		version: 1,
		groundStation: "QGroundControl",
		mission: { cruiseSpeed: cruise, hoverSpeed: 5, firmwareType: 12, vehicleType: 2, plannedHomePosition: [ORIGIN[0], ORIGIN[1], 0], items },
	};
	return `${JSON.stringify(document, null, 2)}\n`;
}

const honest = lines(HONEST_YS, 40);

function with_(base: readonly Wp[], edit: (wps: Wp[]) => void): Wp[] {
	const copy = base.map(wp => ({ ...wp }));
	edit(copy);
	return copy;
}

export const HIDDEN_EXAMPLE = {
	checkpoints: [
		[20, 95],
		[80, 20],
		[50, 1],
	],
	windMs: 6,
	cruiseToWindRatio: 1.5,
	minPhotos: 1,
};

/** The fraud table. Each entry names the one rule it is built to break. */
export const FRAUDS: readonly { file: string; rule: string; text: string }[] = [
	{ file: "fraud-garbled.plan", rule: "parse", text: "{ this is not a QGroundControl plan\n" },
	{ file: "fraud-cruise-fast.plan", rule: "cruise-speed", text: plan(25, 10, honest) },
	{ file: "fraud-hidden-wind.plan", rule: "hidden-wind", text: plan(8, 10, honest) },
	{ file: "fraud-trigger.plan", rule: "front-overlap", text: plan(14, 25, honest) },
	{ file: "fraud-side-spacing.plan", rule: "side-overlap", text: plan(14, 10, lines([30, 60, 90, 120], 40)) },
	{ file: "fraud-altitude-gsd.plan", rule: "ground-resolution", text: plan(14, 10, lines(HONEST_YS, 100)) },
	{
		file: "fraud-ceiling.plan",
		rule: "altitude-limits",
		text: plan(
			14,
			10,
			with_(honest, wps => wps.splice(2, 0, { x: 100, y: 40, alt: 130 })),
		),
	},
	{
		file: "fraud-no-fly.plan",
		rule: "no-fly",
		text: plan(
			14,
			10,
			// 25 m: inside the 30 m roof's band (0 to 35 m with the 5 m margin). At 40 m the route clears it.
			with_(honest, wps => wps.splice(2, 0, { x: 65, y: 40, alt: 25 })),
		),
	},
	{
		file: "fraud-coverage.plan",
		rule: "coverage",
		text: plan(
			14,
			10,
			with_(honest, wps => wps.splice(6, 4)),
		),
	},
	{
		file: "fraud-hidden-checkpoint.plan",
		rule: "hidden-checkpoint",
		text: plan(14, 10, lines([32, 50, 70, 90, 110], 40)),
	},
];

/** Every shipped sample file, keyed by its name in samples/. */
export function buildSamples(): Record<string, string> {
	const out: Record<string, string> = {
		"orchard-survey.spec.json": `${JSON.stringify(SPEC, null, 2)}\n`,
		"honest.plan": plan(14, 10, honest),
		"orchard-survey.hidden.example.json": `${JSON.stringify(HIDDEN_EXAMPLE, null, 2)}\n`,
	};
	for (const fraud of FRAUDS) out[fraud.file] = fraud.text;
	return out;
}
