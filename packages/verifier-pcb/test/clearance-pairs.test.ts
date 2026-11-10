import assert from "node:assert/strict";
import test from "node:test";
import { okOf, part, run, segment, smdPad, via } from "./synthetic-board.ts";
import type { Fixture, Vec } from "./synthetic-board.ts";

// Clearance applies to every pair of copper items that share a layer and belong to different connected parts. Each
// pair below is built twice from the same geometry: with a 0.10 mm gap, which breaks the 0.20 mm minimum, and with a
// 0.30 mm gap, which keeps it. A control board must pass every rule, so a failure can only come from the gap.

const padAt = (ref: string, net: string, at: Vec, size: Vec = [1, 1]) => part(ref, at, smdPad("A", net, size));

type Pair = "track-track" | "track-pad" | "track-via" | "via-pad" | "pad-pad";

const fixtureFor = (pair: Pair, gap: number): Fixture => {
	switch (pair) {
		case "track-track":
			// Two parallel front tracks of different nets. The SIG2 track is floating, so only the gap is in play.
			return {
				parts: [padAt("U1", "SIG1", [105, 110]), padAt("U2", "SIG1", [115, 110])],
				copper: [
					segment([105, 110], [115, 110], 0.25, "F.Cu", "SIG1"),
					segment([107, 110.25 + gap], [113, 110.25 + gap], 0.25, "F.Cu", "SIG2"),
				],
			};
		case "track-pad":
			// A 1 mm front pad of a different net, whose lower edge sits gap above the track's upper edge.
			return {
				parts: [
					padAt("U1", "SIG1", [105, 110]),
					padAt("U2", "SIG1", [115, 110]),
					padAt("U3", "SIG2", [110, 110.625 + gap]),
				],
				copper: [segment([105, 110], [115, 110], 0.25, "F.Cu", "SIG1")],
			};
		case "track-via":
			// A through via of a different net, whose edge sits gap above the track's upper edge.
			return {
				parts: [padAt("U1", "SIG1", [105, 110]), padAt("U2", "SIG1", [115, 110])],
				copper: [segment([105, 110], [115, 110], 0.25, "F.Cu", "SIG1"), via([110, 110.425 + gap], "SIG2")],
			};
		case "via-pad":
			// A through via of one net beside a front pad of another. The via radius is 0.3 mm.
			return {
				parts: [padAt("U1", "SIG1", [110, 114])],
				copper: [via([110, 113.2 - gap], "SIG2")],
			};
		case "pad-pad":
			// Two 1 mm front pads of different nets, side by side.
			return { parts: [padAt("U1", "SIG1", [120, 110]), padAt("U2", "SIG2", [121 + gap, 110])] };
	}
};

const PAIRS: readonly Pair[] = ["track-track", "track-pad", "track-via", "via-pad", "pad-pad"];

for (const pair of PAIRS) {
	test(`${pair}: copper of different nets 0.10 mm apart fails clearance`, () => {
		const v = run(fixtureFor(pair, 0.1));
		assert.equal(okOf(v, "clearance"), false);
		const message = v.findings.find(f => f.rule === "clearance")?.message ?? "";
		assert.match(message, /different nets is 0\.10 mm apart/);
	});

	test(`${pair}: the same copper 0.30 mm apart is a clean control that passes`, () => {
		const v = run(fixtureFor(pair, 0.3));
		assert.equal(okOf(v, "clearance"), true);
		assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
	});
}

test("opposite outer layers: an SMD pad and a copper track on the other side may pass close together", () => {
	// The track lies under the pad in plan view, but on B.Cu while the pad is on F.Cu. The rule compares copper only
	// where the items share a layer, so the overlap in plan view is not a clearance violation.
	const v = run({
		parts: [padAt("U1", "SIG1", [120, 110])],
		copper: [segment([118, 110.3], [122, 110.3], 0.25, "B.Cu", "SIG2")],
	});
	assert.equal(okOf(v, "clearance"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});
