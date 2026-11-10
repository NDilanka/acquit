import assert from "node:assert/strict";
import test from "node:test";
import { npthPad, okOf, part, run, segment, smdPad, via } from "./synthetic-board.ts";
import type { Fixture } from "./synthetic-board.ts";

// The board spans x 100 to 140 mm and y 100 to 125 mm, and copper must keep 0.30 mm from the outline (inside-board).
// Copper must also keep 0.20 mm from every drilled hole (clearance). Each case is built twice from the same geometry:
// a breaking distance and a clearing distance. An anchor pad of another net keeps each board honest and non-empty.

const anchor = part("U9", [120, 118], smdPad("A", "SIG2"));
const padAt = (ref: string, net: string, at: [number, number]) => part(ref, at, smdPad("A", net));

// A 0.25 mm track along the bottom edge. Its centreline is 0.20 mm (breaking) or 0.50 mm (clearing) from the edge.
const trackNearEdge = (y: number): Fixture => ({
	parts: [anchor],
	copper: [segment([110, y], [130, y], 0.25, "F.Cu", "SIG1")],
});

// A through via of 0.6 mm pad and 0.3 mm drill. Its copper edge is 0.20 mm (breaking) or 0.50 mm (clearing) from the
// outline, with its centre at y 100.5 or 100.8.
const viaNearEdge = (y: number): Fixture => ({
	parts: [anchor],
	copper: [via([120, y], "SIG1")],
});

// A single 1 mm pad whose lower edge is 0.10 mm (breaking) or 0.50 mm (clearing) from the outline.
const padNearEdge = (y: number): Fixture => ({
	parts: [anchor, padAt("U1", "SIG1", [120, y])],
});

// An NPTH bore of 2 mm drill at (120, y). Its lower edge is 0.20 mm (breaking) or 0.50 mm (clearing) from the outline.
const boreNearEdge = (y: number): Fixture => ({
	parts: [anchor, part("H1", [120, y], npthPad(2))],
});

// A 2 mm NPTH bore at (120, 112). A 0.25 mm track runs vertically past its right side at the given x.
const trackPastBore = (x: number): Fixture => ({
	parts: [anchor, part("H1", [120, 112], npthPad(2))],
	copper: [segment([x, 105], [x, 118], 0.25, "F.Cu", "SIG1")],
});

test("a track 0.20 mm from the outline fails inside-board", () => {
	const v = run(trackNearEdge(100.2));
	assert.equal(okOf(v, "inside-board"), false);
	const message = v.findings.find(f => f.rule === "inside-board")?.message ?? "";
	assert.match(message, /A copper item is [\d.]+ mm from the board edge; the minimum is 0\.30 mm\./);
});

test("the same track 0.50 mm from the outline is a clean control that passes", () => {
	const v = run(trackNearEdge(100.5));
	assert.equal(okOf(v, "inside-board"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("a via 0.50 mm from the outline fails inside-board", () => {
	const v = run(viaNearEdge(100.5));
	assert.equal(okOf(v, "inside-board"), false);
});

test("the same via 0.80 mm from the outline is a clean control that passes", () => {
	const v = run(viaNearEdge(100.8));
	assert.equal(okOf(v, "inside-board"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("a pad 0.10 mm from the outline fails inside-board", () => {
	const v = run(padNearEdge(100.6));
	assert.equal(okOf(v, "inside-board"), false);
});

test("the same pad 0.50 mm from the outline is a clean control that passes", () => {
	const v = run(padNearEdge(101));
	assert.equal(okOf(v, "inside-board"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("an NPTH bore 0.20 mm from the outline fails inside-board", () => {
	const v = run(boreNearEdge(101.2));
	assert.equal(okOf(v, "inside-board"), false);
	const message = v.findings.find(f => f.rule === "inside-board")?.message ?? "";
	assert.match(message, /A drilled hole is [\d.]+ mm from the board edge; the minimum is 0\.30 mm\./);
});

test("an NPTH bore 0.50 mm from the outline is a clean control that passes", () => {
	const v = run(boreNearEdge(101.5));
	assert.equal(okOf(v, "inside-board"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("a track 0.10 mm from an NPTH bore fails clearance", () => {
	// The bore's edge is 1.00 mm from its centre. The track centreline is 1.225 mm away, so 0.10 mm remains after half
	// its 0.25 mm width.
	const v = run(trackPastBore(121.225));
	assert.equal(okOf(v, "clearance"), false);
	const message = v.findings.find(f => f.rule === "clearance")?.message ?? "";
	assert.match(message, /Copper is [\d.]+ mm from a drilled hole; the minimum is 0\.20 mm\./);
});

test("the same track 0.30 mm from the NPTH bore is a clean control that passes", () => {
	const v = run(trackPastBore(121.425));
	assert.equal(okOf(v, "clearance"), true);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});
