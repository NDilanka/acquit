// Step 2: the parser reads the mission in execution order. Supported items are checked; malformed items refuse the
// plan; items the checker cannot model are reported as unsupported-item instead of being silently skipped.

import assert from "node:assert/strict";
import test from "node:test";
import { ORIGIN } from "../samples/build.ts";
import { parsePlan } from "../src/plan.ts";
import { LIMITS } from "../src/spec.ts";
import { base, commands, failed, fresh, planDoc, run, trigger, wp } from "./fixtures.ts";

test("rejects ComplexItem survey instead of ignoring it", () => {
	const p = fresh();
	p.mission.items.push({ type: "ComplexItem", complexItemType: "survey", polygon: [[0, 0], [1, 1], [2, 2]] });
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("unsupported-item"), JSON.stringify(failed(verdict)));
});

test("checks takeoff altitude rather than dropping command 22", () => {
	const p = fresh();
	p.mission.items.unshift({ type: "SimpleItem", command: 22, frame: 3, autoContinue: true, params: [0, 0, 0, 0, 51.5, -0.12, 1000] });
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("altitude-limits"), JSON.stringify(failed(verdict)));
});

test("honours command 178 speed changes", () => {
	const p = fresh();
	p.mission.items.splice(1, 0, { type: "SimpleItem", command: 178, frame: 2, autoContinue: true, params: [1, 100, 0, 0, 0, 0, 0] });
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("cruise-speed"), JSON.stringify(failed(verdict)));
	assert.equal(verdict.measured.cruiseMs, 100);
});

test("rejects unsupported manual continuation", () => {
	const p = fresh();
	commands(p, 16)[0]!.autoContinue = false;
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("unsupported-item"), JSON.stringify(failed(verdict)));
});

test("does not ignore a mission home thousands of kilometres away", () => {
	const p = fresh();
	p.mission.plannedHomePosition = [0, 0, 1000];
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("parse"), JSON.stringify(failed(verdict)));
});

test("normalizes absolute waypoint altitude against home altitude", () => {
	const p = fresh();
	p.mission.plannedHomePosition = [ORIGIN[0], ORIGIN[1], 100];
	for (const w of commands(p, 16)) w.frame = 0;
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("altitude-limits"), JSON.stringify(failed(verdict)));
});

test("rejects null mission items", () => {
	const p = fresh();
	p.mission.items.push(null);
	let verdict: ReturnType<typeof run> | undefined;
	assert.doesNotThrow(() => {
		verdict = run(p);
	});
	assert.equal(verdict?.pass, false);
	assert.ok(failed(verdict!).includes("parse"), JSON.stringify(failed(verdict!)));
});

test("rejects malformed SimpleItem parameters", () => {
	const p = fresh();
	p.mission.items.push({ type: "SimpleItem", command: 16, frame: 3, autoContinue: true, params: "not an array" });
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("parse"), JSON.stringify(failed(verdict)));
});

test("refuses a mission longer than the item limit without throwing", () => {
	// The trigger setting stays in place, so the only reason to refuse this mission is its length.
	const p = fresh();
	const setting = structuredClone(base.mission.items[0]);
	p.mission.items = [setting, ...Array.from({ length: LIMITS.missionItems }, () => structuredClone(base.mission.items.at(-1)))];
	let verdict: ReturnType<typeof run> | undefined;
	assert.doesNotThrow(() => {
		verdict = run(p);
	});
	assert.equal(verdict?.pass, false);
	assert.deepEqual(failed(verdict!), ["parse"]);
});

test("refuses a plan without a planned home position", () => {
	const p = fresh();
	delete p.mission.plannedHomePosition;
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("parse"), JSON.stringify(failed(verdict)));
});

test("a waypoint in a frame the checker does not model is unsupported, not read as relative altitude", () => {
	const p = fresh();
	commands(p, 16)[0]!.frame = 10;
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("unsupported-item"), JSON.stringify(failed(verdict)));
});

test("a command the checker does not model is reported as unsupported-item", () => {
	const p = fresh();
	p.mission.items.push({ type: "SimpleItem", command: 115, frame: 2, autoContinue: true, params: [0, 0, 0, 0, 0, 0, 0] });
	const verdict = run(p);
	assert.equal(verdict.pass, false);
	assert.ok(failed(verdict).includes("unsupported-item"), JSON.stringify(failed(verdict)));
});

test("each survey waypoint carries the speed and camera trigger in force when it is reached", () => {
	const text = JSON.stringify(planDoc([trigger(10), wp(-20, 30), wp(120, 30), trigger(25), wp(120, 50), wp(-20, 50)]));
	const plan = parsePlan(text, ORIGIN);
	assert.equal(typeof plan, "object", String(plan));
	if (typeof plan === "string") return;
	assert.deepEqual(
		plan.waypoints.map(w => w.triggerM),
		[10, 10, 25, 25],
	);
	assert.deepEqual(
		plan.waypoints.map(w => w.speedMs),
		[14, 14, 14, 14],
	);
});

test("a camera trigger distance of zero switches triggering off for later waypoints", () => {
	const text = JSON.stringify(planDoc([trigger(10), wp(-20, 30), wp(120, 30), trigger(0), wp(120, 50)]));
	const plan = parsePlan(text, ORIGIN);
	assert.equal(typeof plan, "object", String(plan));
	if (typeof plan === "string") return;
	assert.deepEqual(
		plan.waypoints.map(w => w.triggerM),
		[10, 10, null],
	);
});
