// The scene is the additive shared shape: every shared member and union value stays assignable, and a no-fly zone
// carries its height explicitly for the 3D inspector.

import assert from "node:assert/strict";
import test from "node:test";
import { SPEC } from "../samples/build.ts";
import type { Scene, ScenePath, Verdict } from "../src/types.ts";
import { fresh, run } from "./fixtures.ts";

test("scene preserves zone height", () => {
	// A 100 m no-fly tower in the pump-house footprint: the route at 40 m keeps its 8 m horizontal clearance, so
	// the mission stays valid and the scene must carry the 100 m height, not z = 0.
	const zones = [{ id: "tower", heightM: 100, polygon: SPEC.zones[0]!.polygon }];
	const verdict = run(fresh(), { ...SPEC, zones });
	assert.equal(verdict.pass, true);
	const path = verdict.scene.paths.find(item => item.id === "zone-tower");
	assert.ok(path);
	assert.equal(path.z, 100);
	assert.equal(path.width, 100);
	assert.ok(verdict.scene.size[2] >= 100);
});

test("the honest scene carries the pump-house height and the flight altitude", () => {
	const verdict = run(fresh());
	const path = verdict.scene.paths.find(item => item.id === "zone-pump-house");
	assert.ok(path);
	assert.equal(path.z, 30);
	assert.equal(path.width, 30);
	assert.equal(verdict.scene.size[2], 40);
});

test("shared scene shape remains an additive superset", () => {
	// Type-level: the shared members and union values remain assignable through the drone package's types. The
	// parent runs tsc over this; at runtime the assertions are trivially true.
	const sharedPath: ScenePath = { id: "p", kind: "cut", layer: "outline", z: 0.2, width: 0.4, net: "GND", closed: true, points: [[0, 0]] };
	const dronePath: ScenePath = { id: "d", kind: "footprint", layer: "photo", z: 0, closed: true, order: 3, points: [[0, 0]] };
	const sharedScene: Scene = {
		units: "mm",
		size: [10, 10, 1],
		stock: { size: [10, 10, 1], material: "ply" },
		probes: [{ a: [0, 0, 0], b: [1, 1, 1], expect: "continuity", ok: true }],
		paths: [sharedPath, dronePath],
	};
	const workflows: Verdict["workflow"][] = ["laser-cut", "pcb", "print-fdm", "drone-survey", "sql", "data-clean"];
	assert.equal(sharedScene.paths.length, 2);
	assert.equal(workflows.length, 6);
	// Paired runtime gate: a valid drone mission still verifies true.
	assert.equal(run(fresh()).pass, true);
});
