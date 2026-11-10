import assert from "node:assert/strict";
import test from "node:test";
import { arc, okOf, part, run, segment, smdPad } from "./synthetic-board.ts";
import type { Fixture, Vec } from "./synthetic-board.ts";

// track-width applies one minimum to every track, arcs included. power-width applies each listed power net's own
// minimum to the tracks routed for that net. A thin branch of a power net must fail power-width even though it meets
// the general 0.20 mm minimum, and a thin arc must fail track-width even though it is curved, not straight. Each
// fraud below has a control that differs only in the width, so the failure can only come from that width.

const padAt = (ref: string, net: string, at: Vec, size: Vec = [1, 1]) => part(ref, at, smdPad("A", net, size));

// A 3V3 net of three pads in a row. The first two are joined by a 0.50 mm track; the third hangs off the second by a
// branch whose width is the variable.
const powerNet = (branch: number, powerNets: Record<string, number> = { "3V3": 0.5 }): Fixture => ({
	parts: [padAt("U1", "3V3", [110, 110]), padAt("U2", "3V3", [120, 110]), padAt("U3", "3V3", [130, 110])],
	copper: [
		segment([110, 110], [120, 110], 0.5, "F.Cu", "3V3"),
		segment([120, 110], [130, 110], branch, "F.Cu", "3V3"),
	],
	powerNets,
});

// Two pads of one net joined by a single arc over the top. The arc's width is the variable.
const arcBetween = (width: number, powerNets?: Record<string, number>): Fixture => ({
	parts: [padAt("U1", "SIG1", [110, 110]), padAt("U2", "SIG1", [120, 110])],
	copper: [arc([110, 110], [115, 115], [120, 110], width, "F.Cu", "SIG1")],
	...(powerNets === undefined ? {} : { powerNets }),
});

test("a 0.30 mm branch of a 0.50 mm power net fails power-width, though it meets the general minimum", () => {
	const v = run(powerNet(0.3));
	assert.equal(okOf(v, "power-width"), false);
	assert.equal(okOf(v, "track-width"), true, "0.30 mm is at least the 0.20 mm general minimum");
	const message = v.findings.find(f => f.rule === "power-width")?.message ?? "";
	assert.match(message, /The 3V3 power net has a 0\.30 mm track; it needs at least 0\.50 mm\./);
});

test("the same 0.30 mm branch on a net that is not a power net passes power-width", () => {
	const v = run(powerNet(0.3, {}));
	assert.equal(okOf(v, "power-width"), true);
	assert.equal(okOf(v, "track-width"), true);
});

test("a power net routed entirely at its own minimum is a clean control that passes", () => {
	const v = run(powerNet(0.5));
	assert.equal(okOf(v, "power-width"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("a 0.15 mm arc between two pads fails track-width, although the arc is curved, not straight", () => {
	const v = run(arcBetween(0.15));
	assert.equal(okOf(v, "track-width"), false);
	const message = v.findings.find(f => f.rule === "track-width")?.message ?? "";
	assert.match(message, /A track is 0\.15 mm wide; the minimum is 0\.20 mm\./);
});

test("a 0.25 mm arc of the same shape is a clean control that passes", () => {
	const v = run(arcBetween(0.25));
	assert.equal(okOf(v, "track-width"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("a 0.30 mm arc on a 0.50 mm power net fails power-width, so arcs count toward the power minimum", () => {
	const v = run(arcBetween(0.3, { SIG1: 0.5 }));
	assert.equal(okOf(v, "track-width"), true, "0.30 mm is at least the 0.20 mm general minimum");
	assert.equal(okOf(v, "power-width"), false);
});
