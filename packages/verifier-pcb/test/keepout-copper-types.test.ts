import assert from "node:assert/strict";
import test from "node:test";
import { okOf, part, run, segment, smdPad, via } from "./synthetic-board.ts";
import type { Fixture, Vec } from "./synthetic-board.ts";

// The keep-out box spans x 115 to 125 mm and y 110 to 120 mm. Each copper type is tested alone. The intrusion case
// puts one item of that type inside the box, and the control puts the same item outside it, so the only difference
// is where the copper lies.

const KEEPOUT = { name: "no-copper-zone", min: [115, 110] as Vec, max: [125, 120] as Vec };

const padAt = (ref: string, net: string, at: Vec, size: Vec = [1, 1]) => part(ref, at, smdPad("A", net, size));

// A track of SIG1 between two pads of SIG1 at the given height. Height 112 runs through the box; height 104 does not.
const trackAt = (y: number): Fixture => ({
	parts: [padAt("U1", "SIG1", [110, y]), padAt("U2", "SIG1", [130, y])],
	copper: [segment([110, y], [130, y], 0.25, "F.Cu", "SIG1")],
	keepouts: [KEEPOUT],
});

// A through via of SIG2, floating beside a single SIG2 pad well away from the box. The via sits at the given height.
const viaAt = (y: number): Fixture => ({
	parts: [padAt("U1", "SIG2", [110, 104])],
	copper: [via([120, y], "SIG2")],
	keepouts: [KEEPOUT],
});

// A single SIG1 pad at the given position. Position (120, 115) lies in the box; (120, 104) does not.
const padCentre = (at: Vec): Fixture => ({
	parts: [padAt("U1", "SIG1", at)],
	keepouts: [KEEPOUT],
});

test("a track that runs through the keep-out fails keepouts", () => {
	const v = run(trackAt(112));
	assert.equal(okOf(v, "keepouts"), false);
	const message = v.findings.find(f => f.rule === "keepouts")?.message ?? "";
	assert.match(message, /Copper enters the keep-out no-copper-zone\./);
});

test("the same track routed outside the keep-out is a clean control that passes", () => {
	const v = run(trackAt(104));
	assert.equal(okOf(v, "keepouts"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("a track whose centreline stays outside the keep-out but whose width reaches in fails keepouts", () => {
	// The centreline is 0.10 mm below the box's lower edge. Half the 0.25 mm width carries the copper across it.
	const v = run({
		parts: [padAt("U1", "SIG1", [110, 109.9]), padAt("U2", "SIG1", [130, 109.9])],
		copper: [segment([110, 109.9], [130, 109.9], 0.25, "F.Cu", "SIG1")],
		keepouts: [KEEPOUT],
	});
	assert.equal(okOf(v, "keepouts"), false);
});

test("a via inside the keep-out fails keepouts", () => {
	const v = run(viaAt(115));
	assert.equal(okOf(v, "keepouts"), false);
	const message = v.findings.find(f => f.rule === "keepouts")?.message ?? "";
	assert.match(message, /Copper enters the keep-out no-copper-zone\./);
});

test("the same via outside the keep-out is a clean control that passes", () => {
	const v = run(viaAt(104));
	assert.equal(okOf(v, "keepouts"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("a pad inside the keep-out fails keepouts", () => {
	const v = run(padCentre([120, 115]));
	assert.equal(okOf(v, "keepouts"), false);
	const message = v.findings.find(f => f.rule === "keepouts")?.message ?? "";
	assert.match(message, /Copper enters the keep-out no-copper-zone\./);
});

test("the same pad outside the keep-out is a clean control that passes", () => {
	const v = run(padCentre([120, 104]));
	assert.equal(okOf(v, "keepouts"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});
