// Step 3: geometry primitives. Longitude wraps across the antimeridian, projections stay finite, survey legs follow
// their heading, altitude compares within a tolerance, and a polygon boundary counts as inside.

import assert from "node:assert/strict";
import test from "node:test";
import { HIDDEN_EXAMPLE, ORIGIN, SPEC } from "../samples/build.ts";
import { pointInPolygon, toLatLon, toLocal } from "../src/geo.ts";
import { parseSpec } from "../src/spec.ts";
import type { Vec2 } from "../src/types.ts";
import { verify } from "../src/verify.ts";
import { base, commands, failed, fresh, h, run, type Doc, type Item } from "./fixtures.ts";

/** The public and hidden findings that depend on the survey geometry. */
const SURVEY_RULES = ["ground-resolution", "front-overlap", "side-overlap", "coverage", "hidden-checkpoint"] as const;

/** The named rules whose finding is missing or failed. An empty result means every named rule passes. */
function notOk(verdict: { findings: readonly { rule: string; ok: boolean }[] }, rules: readonly string[]): string[] {
	return rules.filter(rule => verdict.findings.find(item => item.rule === rule)?.ok !== true);
}

/** Rotates a geographic point about the origin by a quarter turn anticlockwise: (x, y) becomes (-y, x). */
function quarterTurn(point: readonly [number, number]): [number, number] {
	const [x, y] = toLocal(ORIGIN, point[0], point[1]);
	return toLatLon(ORIGIN, -y, x);
}

function rotateDoc(doc: Doc): Doc {
	for (const item of commands(doc, 16)) {
		const params = item.params as number[];
		const [lat, lon] = quarterTurn([params[4]!, params[5]!]);
		params[4] = lat;
		params[5] = lon;
	}
	return doc;
}

function rotateSpec(): unknown {
	return {
		...SPEC,
		area: SPEC.area.map(point => quarterTurn(point as [number, number])),
		zones: SPEC.zones.map(zone => ({ ...zone, polygon: zone.polygon.map(point => quarterTurn(point as [number, number])) })),
	};
}

function rotateHidden(): unknown {
	return { ...HIDDEN_EXAMPLE, checkpoints: HIDDEN_EXAMPLE.checkpoints.map(([x, y]) => [-y!, x!]) };
}

test("rotating a complete valid survey ninety degrees preserves its verdict", () => {
	const before = run(base);
	const rotated = run(rotateDoc(fresh()), rotateSpec(), rotateHidden());
	assert.deepEqual(notOk(rotated, SURVEY_RULES), [], JSON.stringify(rotated.findings.filter(item => !item.ok)));
	assert.equal(rotated.measured.surveyLines, 5, "the turns must not be counted as survey lines");
	assert.deepEqual(failed(rotated), failed(before));
});

test("submicrometre altitude noise does not erase survey legs", () => {
	const p = fresh();
	p.mission.items.forEach((item, i) => {
		const entry = item as Item;
		if (entry.command !== 16) return;
		const params = entry.params as number[];
		params[6] = params[6]! + i * 1e-8;
	});
	const verdict = run(p);
	assert.deepEqual(notOk(verdict, SURVEY_RULES), [], JSON.stringify(verdict.findings.filter(item => !item.ok)));
	assert.equal(verdict.measured.surveyLines, 5);
});

test("local projection retains cardinal signs", () => {
	const [lat, lon] = ORIGIN;
	const [east, eastY] = toLocal(ORIGIN, lat, lon + 0.001);
	const [west] = toLocal(ORIGIN, lat, lon - 0.001);
	const [, north] = toLocal(ORIGIN, lat + 0.001, lon);
	const [, south] = toLocal(ORIGIN, lat - 0.001, lon);
	assert.ok(east > 0 && Math.abs(eastY) < 1e-9, "east is positive x");
	assert.ok(west < 0, "west is negative x");
	assert.ok(north > 0, "north is positive y");
	assert.ok(south < 0, "south is negative y");
});

test("antimeridian projection uses the short local displacement", () => {
	const [x, y] = toLocal([0, 179.999], 0, -179.999);
	assert.ok(Math.abs(x - 222.39016) < 0.01, `x was ${x}`);
	assert.ok(Math.abs(y) < 1e-9, `y was ${y}`);
	const [lat, lon] = toLatLon([0, 179.999], x, y);
	assert.ok(Math.abs(lat) < 1e-12, `lat was ${lat}`);
	assert.ok(Math.abs(lon - -179.999) < 1e-9, `lon was ${lon}`);
});

test("a survey crossing the antimeridian passes the geometry findings", () => {
	const origin: [number, number] = [0, 179.999];
	const at = (points: readonly Vec2[]) => points.map(([x, y]) => toLatLon(origin, x, y));
	const spec = {
		...SPEC,
		origin,
		area: at([[0, 0], [100, 0], [100, 120], [0, 120]]),
		zones: [{ ...SPEC.zones[0]!, polygon: at([[60, 38], [70, 38], [70, 42], [60, 42]]) }],
	};
	const items: unknown[] = [{ type: "SimpleItem", command: 206, frame: 2, autoContinue: true, params: [10, 0, 0, 0, 0, 0, 0] }];
	[30, 50, 70, 90, 110].forEach((y, k) => {
		const row: number[] = k % 2 === 0 ? [-20, 120] : [120, -20];
		for (const x of row) {
			const [lat, lon] = toLatLon(origin, x, y);
			items.push({ type: "SimpleItem", command: 16, frame: 3, autoContinue: true, params: [0, 0, 0, 0, lat, lon, 40] });
		}
	});
	const doc = { fileType: "Plan", mission: { cruiseSpeed: 14, plannedHomePosition: [origin[0], origin[1], 0], items } };
	const verdict = verify(spec, JSON.stringify(doc), h);
	assert.deepEqual(notOk(verdict, SURVEY_RULES), [], JSON.stringify(verdict.findings.filter(item => !item.ok)));
	assert.equal(verdict.measured.surveyLines, 5);
});

test("huge finite geographic input cannot produce a passing nonfinite scene", () => {
	const p = fresh();
	p.mission.items.push({ type: "SimpleItem", command: 16, frame: 3, autoContinue: true, params: [0, 0, 0, 0, 1e308, -1e308, 40] });
	let verdict: ReturnType<typeof run> | undefined;
	assert.doesNotThrow(() => {
		verdict = run(p);
	});
	assert.equal(verdict?.pass, false);
	assert.ok(failed(verdict!).includes("parse"), JSON.stringify(failed(verdict!)));
	for (const path of verdict!.scene.paths) for (const [x, y] of path.points) assert.ok(Number.isFinite(x) && Number.isFinite(y), `${path.id} has a nonfinite point`);
	assert.ok(verdict!.scene.size.every(value => Number.isFinite(value)));
});

test("invalid spec origin is rejected before projection", () => {
	const bad = { ...SPEC, origin: [400, 1000] };
	assert.equal(typeof parseSpec(bad), "string");
	let verdict: ReturnType<typeof run> | undefined;
	assert.doesNotThrow(() => {
		verdict = run(fresh(), bad);
	});
	assert.equal(verdict?.pass, false);
	assert.deepEqual(failed(verdict!), ["parse"]);
});

test("polygon boundary classification is explicit and consistent", () => {
	const square: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
	const reversed = [...square].reverse();
	const boundary: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10], [5, 0], [10, 5], [5, 10], [0, 5]];
	const outside: Vec2[] = [[-0.01, 5], [10.01, 5], [5, -0.01], [5, 10.01], [-1, -1]];
	for (const polygon of [square, reversed]) {
		for (const p of boundary) assert.equal(pointInPolygon(p, polygon), true, `boundary point ${p} should be inside`);
		assert.equal(pointInPolygon([5, 5], polygon), true);
		for (const p of outside) assert.equal(pointInPolygon(p, polygon), false, `point ${p} should be outside`);
	}
});

test("refuses a plan whose survey items are empty of commands rather than crashing", () => {
	// Guard against a regression in the geometry helpers: an empty item list must still return a verdict.
	const verdict = run({ fileType: "Plan", mission: { cruiseSpeed: 14, plannedHomePosition: [ORIGIN[0], ORIGIN[1], 0], items: [] } });
	assert.equal(verdict.pass, false);
	assert.deepEqual(failed(verdict), ["parse"]);
});
