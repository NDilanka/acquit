// leg-order: a survey line flown over an earlier one is a retrace. Retraces fail the mission, and their
// photographs earn no coverage or hidden-checkpoint credit, so padding a survey with repeats buys nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { SPEC } from "../samples/build.ts";
import type { Verdict } from "../src/types.ts";
import { fresh, planDoc, rtl, run, takeoff, trigger, wp } from "./fixtures.ts";

/** The finding for one rule. Fails the test when the verdict has none. */
function finding(verdict: Verdict, rule: string) {
	const found = verdict.findings.find(item => item.rule === rule);
	assert.ok(found, `no ${rule} finding`);
	return found;
}

test("fifty repeated surveys fail leg order", () => {
	// The historical bypass: the whole route after the trigger item, repeated 49 more times, passes without a
	// leg-order rule. With it, every line after the first pass is a retrace.
	const p = fresh();
	const route = p.mission.items.slice(1);
	for (let k = 0; k < 49; k++) p.mission.items.push(...structuredClone(route));
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "leg-order").ok, false);
	assert.ok(verdict.scene.paths.filter(path => path.kind === "footprint").length <= 200);
});

test("a reversed retrace of a survey line fails leg order", () => {
	// Flying the y = 30 line back again retraces the first leg exactly, direction notwithstanding.
	const plan = planDoc([trigger(10), takeoff(), wp(0, 30), wp(100, 30), wp(0, 30), rtl()]);
	const verdict = run(plan);
	assert.equal(verdict.pass, false);
	assert.equal(finding(verdict, "leg-order").ok, false);
});

test("repeated survey lines earn no hidden photograph credit", () => {
	// Five passes over the y = 30 line put 25 photographs on the checkpoint at [50, 30], but only the first pass
	// counts: five photographs against a six photograph requirement must fail.
	const items = [trigger(10), takeoff()];
	for (let k = 0; k < 5; k++) items.push(wp(0, 30), wp(100, 30));
	items.push(rtl());
	const verdict = run(planDoc(items), SPEC, { checkpoints: [[50, 30]], windMs: 0, cruiseToWindRatio: 1, minPhotos: 6 });
	assert.equal(finding(verdict, "leg-order").ok, false);
	assert.equal(finding(verdict, "hidden-checkpoint").ok, false);
});

test("the honest survey flies no repeated line", () => {
	assert.equal(finding(run(fresh()), "leg-order").ok, true);
});
