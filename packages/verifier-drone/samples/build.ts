// Builds the shipped samples: one spec, one honest plan, and one fraud per rule. The files in this folder are
// written from this module, and test/drone-samples.test.ts fails when they drift from it.
// Each fraud changes the honest plan in exactly one way, so it should fail exactly the rule it is named for.

import { toLatLon } from "../src/geo.ts";
import { CMD_SET_CAM_TRIGGER_DIST, CMD_WAYPOINT } from "../src/plan.ts";

type Wp = { x: number; y: number; alt: number };

export const ORIGIN: [number, number] = [51.5, -0.12];

export const SPEC = {
	id: "orchard-survey",
	origin: ORIGIN,
	area: [
		[0, 0],
		[100, 0],
		[100, 120],
		[0, 120],
	],
	zones: [
		{
			id: "pump-house",
			polygon: [
				[60, 38],
				[70, 38],
				[70, 42],
				[60, 42],
			],
		},
	],
	camera: { sensorWidthMm: 13.2, sensorHeightMm: 8.8, focalMm: 8.8, imageWidthPx: 5472 },
	maxAltitudeM: 120,
	maxGsdCm: 2.5,
	minFrontOverlap: 0.7,
	minSideOverlap: 0.6,
	cruiseMs: { min: 5, max: 20 },
	gridM: 10,
	rules: ["altitude-ceiling", "gsd", "front-overlap", "side-overlap", "no-fly", "coverage", "cruise-speed"],
};

/** Lines alternate direction: even lines fly west to east, odd lines east to west. Each line is two waypoints. */
function lines(ys: readonly number[], alt: number): Wp[] {
	const out: Wp[] = [];
	ys.forEach((y, k) => {
		const forward = k % 2 === 0;
		out.push({ x: forward ? -20 : 120, y, alt }, { x: forward ? 120 : -20, y, alt });
	});
	return out;
}

const HONEST_YS = [30, 50, 70, 90, 110];
const ROUND = (value: number): number => Number(value.toFixed(7));

function plan(cruise: number, trigger: number, waypoints: readonly Wp[]): string {
	const items: object[] = [{ type: "SimpleItem", command: CMD_SET_CAM_TRIGGER_DIST, doJumpId: 1, frame: 2, autoContinue: true, params: [trigger, 0, 0, 0, 0, 0, 0] }];
	waypoints.forEach((wp, i) => {
		const [lat, lon] = toLatLon(ORIGIN, wp.x, wp.y);
		items.push({ type: "SimpleItem", command: CMD_WAYPOINT, doJumpId: i + 2, frame: 3, autoContinue: true, params: [0, 0, 0, 0, ROUND(lat), ROUND(lon), wp.alt] });
	});
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
};

/** The fraud table. Each entry names the one rule it is built to break. */
export const FRAUDS: readonly { file: string; rule: string; text: string }[] = [
	{ file: "fraud-garbled.plan", rule: "parse", text: "{ this is not a QGroundControl plan\n" },
	{ file: "fraud-cruise-fast.plan", rule: "cruise-speed", text: plan(25, 10, honest) },
	{ file: "fraud-hidden-wind.plan", rule: "hidden-wind", text: plan(8, 10, honest) },
	{ file: "fraud-trigger.plan", rule: "front-overlap", text: plan(14, 25, honest) },
	{ file: "fraud-side-spacing.plan", rule: "side-overlap", text: plan(14, 10, lines([30, 60, 90, 120], 40)) },
	{ file: "fraud-altitude-gsd.plan", rule: "gsd", text: plan(14, 10, lines(HONEST_YS, 100)) },
	{
		file: "fraud-ceiling.plan",
		rule: "altitude-ceiling",
		text: plan(
			14,
			10,
			with_(honest, wps => wps.splice(2, 0, { x: 120, y: 40, alt: 130 })),
		),
	},
	{
		file: "fraud-no-fly.plan",
		rule: "no-fly",
		text: plan(
			14,
			10,
			with_(honest, wps => wps.splice(2, 0, { x: 65, y: 40, alt: 40 })),
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
