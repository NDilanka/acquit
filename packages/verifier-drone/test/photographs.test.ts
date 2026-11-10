// Photographs as the camera takes them: each exposure is a footprint, and a hidden checkpoint counts the photographs
// that hold it. Regressions reuse the historical probes from test/fixtures.ts, so the original bypasses stay reproducible.

import assert from "node:assert/strict";
import test from "node:test";
import { FRAUDS, HIDDEN_EXAMPLE, ORIGIN, SPEC } from "../samples/build.ts";
import { toLatLon } from "../src/geo.ts";
import type { Verdict } from "../src/types.ts";
import { commands, failed, fresh, planDoc, rtl, run, takeoff, trigger, wp } from "./fixtures.ts";
import type { Doc } from "./fixtures.ts";

/** The finding for one rule. Fails the test when the verdict has none. */
function finding(verdict: Verdict, rule: string) {
	const found = verdict.findings.find(item => item.rule === rule);
	assert.ok(found, `no ${rule} finding`);
	return found;
}

test("late trigger setting cannot repair earlier front-overlap fraud", () => {
	const fraud = FRAUDS.find(item => item.rule === "front-overlap");
	assert.ok(fraud);
	const p = JSON.parse(fraud.text) as Doc;
	p.mission.items.push({ ...commands(p, 206)[0]!, params: [10, 0, 0, 0, 0, 0, 0] });
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "front-overlap").ok, false);
});

test("late trigger setting cannot repair an initial 1000 metre trigger", () => {
	const p = fresh();
	commands(p, 206)[0]!.params = [1000, 0, 0, 0, 0, 0, 0];
	p.mission.items.push(trigger(10));
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "front-overlap").ok, false);
});

test("hidden checkpoints require the requested number of real photographs", () => {
	const verdict = run(fresh(), SPEC, { ...HIDDEN_EXAMPLE, minPhotos: 1000 });
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "hidden-checkpoint").ok, false);
});

test("hidden findings redact checkpoint positions", () => {
	const verdict = run(fresh(), SPEC, { ...HIDDEN_EXAMPLE, minPhotos: 1000 });
	const hidden = verdict.findings.filter(item => item.hidden);
	assert.ok(hidden.some(item => item.rule === "hidden-checkpoint" && !item.ok));
	for (const item of hidden) {
		assert.equal(item.at, undefined, item.rule);
		assert.equal(item.refs, undefined, item.rule);
		assert.doesNotMatch(item.message, /\[|\(|lat|lon/i, item.rule);
	}
});

test("a gap between photographs is not covered", () => {
	// One line at y = 1 m, flown 357 m with a 45 m trigger. Each photograph covers 40 m along track, so 5 m gaps open.
	const area = [[0, 0], [400, 0], [400, 2], [0, 2]].map(([x, y]) => toLatLon(ORIGIN, x!, y!));
	const plan = planDoc([trigger(45), takeoff(), wp(20, 1), wp(377, 1), rtl()]);
	const verdict = run(plan, { ...SPEC, zones: [], gridM: 2, area }, { checkpoints: [], windMs: 0, cruiseToWindRatio: 1, minPhotos: 1 });
	assert.equal(finding(verdict, "coverage").ok, false);
	assert.ok(Number(verdict.measured.uncoveredSamples) > 0);
});

test("scene footprints are actual photographs, one per exposure", () => {
	const verdict = run(fresh());
	const footprints = verdict.scene.paths.filter(path => path.kind === "footprint");
	assert.equal(footprints.length, verdict.measured.photographs);
	for (const path of footprints) {
		// A photograph covers 40 m along track and 60 m across it at 40 m altitude with the original camera.
		const [p0, p1, p2] = [path.points[0]!, path.points[1]!, path.points[2]!];
		const sides = [Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), Math.hypot(p2[0] - p1[0], p2[1] - p1[1])].sort((a, b) => a - b);
		assert.ok(Math.abs(sides[0]! - 40) < 0.01 && Math.abs(sides[1]! - 60) < 0.01, path.id);
	}
});

test("scene footprint sampling is capped at two hundred", () => {
	const p = fresh();
	commands(p, 206)[0]!.params = [1, 0, 0, 0, 0, 0, 0];
	const verdict = run(p);
	assert.ok(Number(verdict.measured.photographs) > 200);
	assert.equal(verdict.scene.paths.filter(path => path.kind === "footprint").length, 200);
});

test("a mission that would take more photographs than the bound is refused as a parse failure", () => {
	const p = fresh();
	commands(p, 206)[0]!.params = [0.01, 0, 0, 0, 0, 0, 0];
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.deepEqual(failed(verdict), ["parse"]);
});
