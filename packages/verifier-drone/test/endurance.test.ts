// Endurance is the route's still-air flight time against the usable battery (endurance minus reserve); the hidden
// headwind case re-prices every move at cruise minus wind. The regressions reuse the historical review probes.

import assert from "node:assert/strict";
import test from "node:test";
import { FRAUDS, HIDDEN_EXAMPLE, ORIGIN, SPEC } from "../samples/build.ts";
import { toLatLon } from "../src/geo.ts";
import type { Verdict } from "../src/types.ts";
import { fresh, planDoc, rtl, run, takeoff, trigger, wp } from "./fixtures.ts";
import type { Doc } from "./fixtures.ts";

/** The finding for one rule. Fails the test when the verdict has none. */
function finding(verdict: Verdict, rule: string) {
	const found = verdict.findings.find(item => item.rule === rule);
	assert.ok(found, `no ${rule} finding`);
	return found;
}

test("one second endurance cannot accept the orchard mission", () => {
	const verdict = run(fresh(), { ...SPEC, enduranceS: 1, reserveS: 0 });
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "endurance").ok, false);
});

test("the honest route fits the usable endurance with its reserve", () => {
	const verdict = run(fresh());
	assert.equal(finding(verdict, "endurance").ok, true);
	// 40 m climb, 30 m transit out, five 100 m lines, four 20 m turns, the return home and the descent, at 14 m/s.
	assert.ok(Math.abs(Number(verdict.measured.flightSeconds) - 59.9) < 0.2, String(verdict.measured.flightSeconds));
});

test("increasing speed to nine does not substitute for hidden endurance", () => {
	const fraud = FRAUDS.find(item => item.rule === "hidden-wind");
	assert.ok(fraud);
	const p = JSON.parse(fraud.text) as Doc;
	p.mission.cruiseSpeed = 9;
	// Still air: 93 seconds, inside the 200 second budget. In the 6 m/s headwind: 280 seconds, outside it. The old
	// 9 >= 1.5 x 6 shortcut passes, so only a duration check fails here.
	const verdict = run(p, { ...SPEC, enduranceS: 200, reserveS: 0 }, { ...HIDDEN_EXAMPLE, windMs: 6 });
	assert.equal(finding(verdict, "endurance").ok, true, "still-air duration must fit, so the failure is the windy one");
	assert.equal(finding(verdict, "hidden-wind").ok, false);
	assert.equal(verdict.pass, false);
});

test("a wind that stops forward progress fails hidden endurance", () => {
	// Cruise 14 in a 14 m/s headwind cannot advance; the ratio condition passes at 14 >= 1 x 14, so the failure is
	// the zero ground speed, not the ratio.
	const verdict = run(fresh(), SPEC, { ...HIDDEN_EXAMPLE, windMs: 14, cruiseToWindRatio: 1 });
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "hidden-wind").ok, false);
	assert.match(finding(verdict, "hidden-wind").message, /forward progress/);
});

test("the return leg counts toward route duration", () => {
	// One 100 m line 9 km from home: 40 m climb, 9 km out, the line, 9.1 km home and the descent make 18280 m, or
	// 1306 seconds at 14 m/s. Without the return it would be 653 seconds, so a 1000 second budget only fails when
	// the return leg is counted, and a 1400 second budget passes.
	const area = [[8990, -10], [9110, -10], [9110, 10], [8990, 10]].map(([x, y]) => toLatLon(ORIGIN, x!, y!));
	const plan = planDoc([trigger(10), takeoff(), wp(9000, 0), wp(9100, 0), rtl()]);
	const hidden = { checkpoints: [], windMs: 0, cruiseToWindRatio: 1, minPhotos: 1 };
	const tight = run(plan, { ...SPEC, area, enduranceS: 1000, reserveS: 0 }, hidden);
	assert.equal(finding(tight, "endurance").ok, false);
	const ample = run(plan, { ...SPEC, area, enduranceS: 1400, reserveS: 0 }, hidden);
	assert.equal(finding(ample, "endurance").ok, true);
});
