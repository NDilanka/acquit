import assert from "node:assert/strict";
import test from "node:test";
import { okOf, part, run, segment, smdPad, thruPad, via } from "./synthetic-board.ts";
import type { Fixture } from "./synthetic-board.ts";
import type { Verdict } from "../src/types.ts";

// Copper that joins two nets is a short, however it joins them: a collinear overlap, a track through a foreign pad,
// a via on a foreign pad, or two foreign pads that overlap. Copper that joins one net through a plated through-hole
// on a different layer is a valid bridge and must pass. Track labels play no part in either judgement.

const padAt = (ref: string, net: string, at: readonly [number, number]) => part(ref, at, smdPad("A", net, [1, 1]));

const SHORTS: readonly [string, Fixture][] = [
	[
		"collinear overlap of two nets' tracks",
		{
			parts: [padAt("U1", "SIG1", [105, 110]), padAt("U2", "SIG2", [115, 110])],
			copper: [
				segment([105, 110], [112, 110], 0.25, "F.Cu", "SIG1"),
				segment([110, 110], [115, 110], 0.25, "F.Cu", "SIG2"),
			],
		},
	],
	[
		"a track that runs through a pad of another net",
		{
			parts: [padAt("U1", "SIG1", [105, 110]), padAt("U2", "SIG2", [115, 110])],
			copper: [segment([105, 110], [116, 110], 0.25, "F.Cu", "SIG1")],
		},
	],
	[
		"a via that overlaps a pad of another net, and reaches its own net on the back",
		{
			parts: [padAt("U1", "SIG1", [120, 110]), part("U2", [125, 110], thruPad("A", "SIG2"))],
			copper: [via([120.2, 110], "SIG2"), segment([120.2, 110], [125, 110], 0.25, "B.Cu", "SIG2")],
		},
	],
	[
		"two front pads of different nets that overlap",
		{
			parts: [padAt("U1", "SIG1", [120, 110]), padAt("U2", "SIG2", [120.5, 110])],
		},
	],
];

const BRIDGE: Fixture = {
	parts: [padAt("U1", "SIG1", [105, 110]), part("U2", [115, 110], thruPad("A", "SIG1"))],
	copper: [
		segment([105, 110], [110, 110], 0.25, "F.Cu", "SIG1"),
		via([110, 110], "SIG1"),
		segment([110, 110], [115, 110], 0.25, "B.Cu", "SIG1"),
	],
};

/** The verdict as a list of rule and ok pairs, so two verdicts can be compared rule by rule. */
const okMap = (v: Verdict): string[] => v.findings.map(f => `${f.rule}:${String(f.ok)}`);

const relabel = (f: Fixture, net: string): Fixture => ({
	...f,
	copper: (f.copper ?? []).map(item => ({ ...item, net })),
});

for (const [name, fixture] of SHORTS) {
	test(`a real short fails no-shorts: ${name}`, () => {
		const v = run(fixture);
		assert.equal(okOf(v, "no-shorts"), false);
		assert.equal(v.pass, false);
	});
}

/**
 * A SIG1 track ending in a via at (120, 110), and a SIG2 track to a pad at (125, 110) that starts `gap` mm short of
 * the via's outline. Its cap stops at x = 120.3 + gap, and the via's polygon vertex on the +x axis sits at x = 120.3.
 */
const tangentAt = (gap: number): Fixture => ({
	parts: [padAt("U1", "SIG1", [116, 110]), padAt("U2", "SIG2", [125, 110])],
	copper: [
		segment([116, 110], [120, 110], 0.25, "F.Cu", "SIG1"),
		via([120, 110], "SIG1"),
		segment([120.425 + gap, 110], [125, 110], 0.25, "F.Cu", "SIG2"),
	],
});

test("a track tangent to a via's polygon vertex is a certain contact, so it is a short", () => {
	const v = run(tangentAt(0));
	assert.equal(v.findings.some(f => !f.ok && f.rule === "parse"), false);
	assert.equal(okOf(v, "no-shorts"), false);
});

test("the same track 0.005 mm short of the via is open, and no-shorts passes", () => {
	const v = run(tangentAt(0.005));
	assert.equal(v.findings.some(f => !f.ok && f.rule === "parse"), false);
	assert.equal(okOf(v, "no-shorts"), true);
});

test("a plated layer bridge joins one net through the through-hole and passes connected and no-shorts", () => {
	const v = run(BRIDGE);
	assert.equal(okOf(v, "connected"), true);
	assert.equal(okOf(v, "no-shorts"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("without its back copper the bridge leaves the through-hole pad open", () => {
	// The control for the bridge: the same board minus the B.Cu track must fail connected, so the bridge is what joins.
	const frontOnly = (BRIDGE.copper ?? []).filter(item => item.kind !== "segment" || item.layer !== "B.Cu");
	const v = run({ ...BRIDGE, copper: frontOnly });
	assert.equal(okOf(v, "connected"), false);
});

test("track labels alone cannot change the no-shorts result", () => {
	const [, throughPad] = SHORTS[1] as [string, Fixture];
	const before = run(throughPad);
	// Relabel the SIG1 track as SIG2, the net of the pad it runs through, and then as a net with no pads at all.
	assert.deepEqual(okMap(run(relabel(throughPad, "SIG2"))), okMap(before));
	assert.deepEqual(okMap(run(relabel(throughPad, "GHOST"))), okMap(before));
	assert.equal(okOf(run(relabel(throughPad, "GHOST")), "no-shorts"), false);
});

test("track labels alone cannot change the connected result of a bridge", () => {
	const before = run(BRIDGE);
	assert.deepEqual(okMap(run(relabel(BRIDGE, "GHOST"))), okMap(before));
	assert.equal(okOf(run(relabel(BRIDGE, "GHOST")), "connected"), true);
});
