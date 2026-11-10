// Safety rules that always run (starts-with-takeoff, ends-safely, inside-area), the minimum altitude, and the
// height-aware no-fly rule. Mission items are written out in full so each probe changes one thing. Geometry edge
// cases call the pure helpers in src/geo.ts directly.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ORIGIN, SPEC } from "../samples/build.ts";
import { segmentDistanceToPolygon, segmentHitsPolygon, segmentInsidePolygon, toLatLon } from "../src/geo.ts";
import { failed, fresh, land, planDoc, rtl, run, takeoff, trigger, wp } from "./fixtures.ts";
import type { Item } from "./fixtures.ts";
import type { Finding, Verdict, Vec2 } from "../src/types.ts";

/** The containment tolerance the verifier uses, in metres. */
const TOL = 0.05;
const CONCAVE: Vec2[] = [
	[0, 0],
	[100, 0],
	[100, 100],
	[60, 100],
	[60, 40],
	[40, 40],
	[40, 100],
	[0, 100],
];
const SQUARE: Vec2[] = [
	[0, 0],
	[10, 0],
	[10, 10],
	[0, 10],
];
const PUMP_HOUSE: Vec2[] = [
	[60, 38],
	[70, 38],
	[70, 42],
	[60, 42],
];

/** Converts local metre points to geographic [latitude, longitude] pairs, as the spec stores them. */
function local(points: readonly Vec2[]): [number, number][] {
	return points.map(([x, y]) => toLatLon(ORIGIN, x, y));
}

/** The alternating legacy survey: every line runs from x = -20 to x = 120, outside the 0 to 100 area. */
function legacyLines(ys: readonly number[], alt: number): Item[] {
	return ys.flatMap((y, k) => {
		const forward = k % 2 === 0;
		return [wp(forward ? -20 : 120, y, alt), wp(forward ? 120 : -20, y, alt)];
	});
}

function finding(verdict: Verdict, rule: string): Finding | undefined {
	return verdict.findings.find(item => item.rule === rule);
}

function withSpec(overrides: Record<string, unknown>): Record<string, unknown> {
	return { ...SPEC, ...overrides };
}

test("requires takeoff before the legacy survey", () => {
	const doc = fresh();
	doc.mission.items = doc.mission.items.filter(item => (item as Item).command !== 22);
	const verdict = run(doc);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "starts-with-takeoff")?.ok, false);
});

test("requires RTL or land at the end of the legacy survey", () => {
	const doc = fresh();
	doc.mission.items = doc.mission.items.filter(item => (item as Item).command !== 20);
	const verdict = run(doc);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "ends-safely")?.ok, false);
	assert.deepEqual(failed(verdict).includes("starts-with-takeoff"), false);
});

test("checks takeoff altitude rather than dropping command 22", () => {
	const doc = fresh();
	doc.mission.items.unshift(takeoff(1000));
	const verdict = run(doc);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "altitude-limits")?.ok, false);
});

test("does not photograph waypoints after an intermediate landing as a continuous survey", () => {
	const doc = fresh();
	// Items: trigger, takeoff, waypoint 0, waypoint 1. Land after the first survey line, with no second takeoff.
	doc.mission.items.splice(4, 0, land());
	const verdict = run(doc);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "starts-with-takeoff")?.ok, false);
	assert.ok(Number(verdict.measured.photographs) < Number(run(fresh()).measured.photographs));
});

test("minimum altitude fifty rejects forty metre survey legs", () => {
	const verdict = run(fresh(), withSpec({ minAltitudeM: 50 }));
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "altitude-limits")?.ok, false);
});

test("legacy overshoot and outside turns fail containment", () => {
	const doc = planDoc([trigger(10), takeoff(40), ...legacyLines([30, 50, 70, 90, 110], 40), rtl()]);
	const verdict = run(doc);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "inside-area")?.ok, false);
});

test("concave containment checks the whole segment", () => {
	assert.equal(segmentInsidePolygon([20, 80], [80, 80], CONCAVE, TOL), false);
	assert.equal(segmentInsidePolygon([10, 80], [30, 80], CONCAVE, TOL), true);
	const doc = planDoc([trigger(10), takeoff(40), wp(20, 80), wp(80, 80), rtl()]);
	const verdict = run(doc, withSpec({ area: local(CONCAVE) }));
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "inside-area")?.ok, false);
});

test("no fly clearance catches a route five metres from the volume", () => {
	const zones = [{ id: "zone", heightM: 100, polygon: local([[50, 35], [70, 35], [70, 36], [50, 36]]) }];
	const verdict = run(fresh(), withSpec({ zones, geofenceMarginM: 10 }));
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "no-fly")?.ok, false);
});

test("flight above a ten metre roof is not rejected as a two dimensional crossing", () => {
	const zones = [{ id: "low-roof", heightM: 10, polygon: local([[50, 29], [70, 29], [70, 31], [50, 31]]) }];
	const verdict = run(fresh(), withSpec({ zones, geofenceMarginM: 0 }));
	assert.equal(finding(verdict, "no-fly")?.ok, true);
	assert.equal(verdict.pass, true);
});

test("segment crossing a zone is detected with both ends outside", () => {
	const doc = planDoc([trigger(10), takeoff(25), wp(50, 40, 25), wp(80, 40, 25), rtl()]);
	const verdict = run(doc);
	assert.equal(finding(verdict, "no-fly")?.ok, false);
});

test("segment ending inside a zone is detected", () => {
	const doc = planDoc([trigger(10), takeoff(25), wp(120, 30, 25), wp(65, 40, 25), rtl()]);
	const verdict = run(doc);
	assert.equal(finding(verdict, "no-fly")?.ok, false);
});

test("takeoff climb through a zone at home is a no-fly crossing", () => {
	const zones = [{ id: "home-pad", heightM: 30, polygon: local([[-2, -2], [2, -2], [2, 2], [-2, 2]]) }];
	const verdict = run(fresh(), withSpec({ zones }));
	assert.equal(finding(verdict, "no-fly")?.ok, false);
});

test("return to launch across a zone is a no-fly crossing", () => {
	// The honest survey ends at (100, 110) and returns along the diagonal at 40 m, which passes (50, 55).
	const zones = [{ id: "diagonal", heightM: 100, polygon: local([[49, 54], [51, 54], [51, 56], [49, 56]]) }];
	const verdict = run(fresh(), withSpec({ zones }));
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "no-fly")?.ok, false);
});

test("exact zone corner graze counts as contact", () => {
	assert.equal(segmentHitsPolygon([-1, 1], [1, -1], SQUARE), true);
	assert.equal(segmentDistanceToPolygon([-1, 1], [1, -1], SQUARE), 0);
});

test("collinear zone edge contact counts as contact", () => {
	assert.equal(segmentDistanceToPolygon([-1, 0], [11, 0], SQUARE), 0);
});

test("segment just outside a zero-margin zone stays outside", () => {
	const distance = segmentDistanceToPolygon([-1, -0.01], [11, -0.01], SQUARE);
	assert.ok(distance > 0);
	assert.ok(Math.abs(distance - 0.01) < 1e-9);
});

test("safe transit outside a zone is not a crossing", () => {
	const distance = segmentDistanceToPolygon([120, 30], [120, 50], PUMP_HOUSE);
	assert.ok(distance > SPEC.geofenceMarginM);
});
