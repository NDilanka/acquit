// Coverage is judged on 2 m sample cells: a cell counts as photographed when a real photograph holds its centre. The
// regressions reuse the historical bypass constructions from the review, so each one stays reproducible.

import assert from "node:assert/strict";
import test from "node:test";
import { FRAUDS, ORIGIN, SPEC } from "../samples/build.ts";
import { toLatLon, toLocal } from "../src/geo.ts";
import type { Verdict } from "../src/types.ts";
import { commands, failed, fresh, planDoc, rtl, run, takeoff, trigger, wp } from "./fixtures.ts";
import type { Doc } from "./fixtures.ts";

/** The finding for one rule. Fails the test when the verdict has none. */
function finding(verdict: Verdict, rule: string) {
	const found = verdict.findings.find(item => item.rule === rule);
	assert.ok(found, `no ${rule} finding`);
	return found;
}

/** Moves every west endpoint of the survey (within 1 m of x = 0) to x = 24, leaving a 4 m strip unphotographed. */
function strippedWest(p: Doc): Doc {
	for (const item of commands(p, 16)) {
		const params = item.params as number[];
		const [x, y] = toLocal(ORIGIN, params[4]!, params[5]!);
		if (x < 1) {
			const [lat, lon] = toLatLon(ORIGIN, 24, y);
			params[4] = lat;
			params[5] = lon;
		}
	}
	return p;
}

test("honest survey samples every 2 m cell of its area", () => {
	const verdict = run(fresh());
	assert.equal(Number(verdict.measured.samplePoints), 3000);
	assert.equal(Number(verdict.measured.uncoveredSamples), 0);
	assert.equal(finding(verdict, "coverage").ok, true);
});

test("four metre uncovered edge strip fails the required coverage grid", () => {
	const verdict = run(strippedWest(fresh()));
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "coverage").ok, false);
	// Every line now starts at x = 24, so its first photograph cannot hold the cells at the west edge; the trigger
	// phase drifting across the lines widens the uncovered band on later lines: 170 of 3000 cells, 94.3% covered.
	assert.equal(Number(verdict.measured.samplePoints), 3000);
	assert.equal(Number(verdict.measured.uncoveredSamples), 170);
});

test("coverage does not depend on a caller choosing the coarse legacy grid", () => {
	const p = strippedWest(fresh());
	for (const gridM of [10, 2]) {
		const verdict = run(p, { ...SPEC, gridM });
		assert.equal(finding(verdict, "coverage").ok, false, `gridM ${gridM}`);
	}
});

test("concave narrow arm is not lost between coarse grid columns", () => {
	const area = [[0, 0], [100, 0], [100, 120], [53, 120], [53, 1000], [51, 1000], [51, 120], [0, 120]].map(([x, y]) =>
		toLatLon(ORIGIN, x!, y!),
	);
	const verdict = run(fresh(), { ...SPEC, area, gridM: 10 });
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "coverage").ok, false);
});

test("ninety nine point five percent coverage passes the coverage rule", () => {
	// Two lines 10 m trigger spacing over a 400 by 2 m strip: 200 cells. The trigger-off detour resets the exposure
	// phase, so the second line opens with a photograph at its start (x = 377) and only the cell at x = 399 is missed.
	const area = [[0, 0], [400, 0], [400, 2], [0, 2]].map(([x, y]) => toLatLon(ORIGIN, x!, y!));
	const plan = planDoc([trigger(10), takeoff(), wp(20, -5), wp(377, -5), trigger(0), wp(380, 2), trigger(10), wp(377, 5), wp(20, 5), rtl()]);
	const verdict = run(plan, { ...SPEC, zones: [], area }, { checkpoints: [], windMs: 0, cruiseToWindRatio: 1, minPhotos: 1 });
	assert.equal(Number(verdict.measured.samplePoints), 200);
	assert.equal(Number(verdict.measured.uncoveredSamples), 1);
	assert.equal(finding(verdict, "coverage").ok, true);
});

test("empty coverage grid cannot pass vacuously", () => {
	// No 2 m cell centre lies inside this triangle: its only centre, (1, 1), is beyond the hypotenuse.
	const area = [[0, 0], [1.5, 0], [0, 1.5]].map(([x, y]) => toLatLon(ORIGIN, x!, y!));
	const verdict = run(fresh(), { ...SPEC, area });
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "coverage").ok, false);
});

test("oversized survey area is refused as a parse failure rather than sampled", () => {
	const area = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]].map(([x, y]) => toLatLon(ORIGIN, x!, y!));
	const verdict = run(fresh(), { ...SPEC, area });
	assert.equal(verdict.pass, false);
	assert.deepEqual(failed(verdict), ["parse"]);
});

test("short unrelated stubs do not repair side-spacing fraud", () => {
	// The historical bypass: three 10 cm stub legs at x = 1 sit between the 30 m-spaced fraud lines. They share almost
	// no along-track extent with the real lines, so the real lines must stay paired with each other at 50% overlap.
	const fraud = FRAUDS.find(item => item.rule === "side-overlap");
	assert.ok(fraud);
	const p = JSON.parse(fraud.text) as Doc;
	for (const y of [45, 75, 105]) p.mission.items.push(wp(1, y), wp(1.1, y));
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "side-overlap").ok, false);
});
