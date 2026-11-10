import assert from "node:assert/strict";
import test from "node:test";
import { readBoard } from "../src/board.ts";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Spec, Verdict } from "../src/types.ts";

// The board outline must be exactly one simple closed loop. A second loop (a cutout or an island), a branch, a folded
// or self-crossing boundary, or a degenerate edge fails the parse by name. A single simple outline of lines or arcs
// passes, and an outline that does not close fails the outline rule. Nothing is cut down to a largest loop.

const spec: Spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const hidden: HiddenSample = (() => {
	const r = validateHidden(JSON.parse(SAMPLE_HIDDEN_JSON), spec);
	if (!r.ok) throw new Error(r.error);
	return r.hidden;
})();

const STROKE = "(stroke (width 0.05) (type default))";
const HONEST_CORNERS: readonly (readonly [number, number])[] = [
	[100, 100],
	[140, 100],
	[140, 125],
	[100, 125],
];

/** One Edge.Cuts line per consecutive pair of corners, closing back to the first. */
function polyline(corners: readonly (readonly [number, number])[]): string[] {
	return corners.map((a, i) => {
		const b = corners[(i + 1) % corners.length] as readonly [number, number];
		return `(gr_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) ${STROKE} (layer "Edge.Cuts"))`;
	});
}

/**
 * The honest board with its outline replaced by the given Edge.Cuts items, and any extra items added before the
 * closing paren. Asserts that exactly the four honest outline lines were removed, so a variant never passes because
 * it changed nothing.
 */
function boardWith(outline: readonly string[], extra: readonly string[] = []): string {
	const lines = SAMPLE_HONEST_PCB.split("\n");
	const kept = lines.filter(line => !(line.includes("(gr_line") && line.includes('(layer "Edge.Cuts")')));
	assert.equal(lines.length - kept.length, 4, "the honest outline must be exactly four Edge.Cuts lines");
	let close = -1;
	for (let i = kept.length - 1; i >= 0; i--) {
		if ((kept[i] ?? "").trim() === ")") {
			close = i;
			break;
		}
	}
	assert.ok(close > 0, "the honest board must end with its closing paren");
	kept.splice(close, 0, ...outline.map(l => `\t${l}`), ...extra.map(l => `\t${l}`));
	return kept.join("\n");
}

const verdictFor = (text: string): Verdict => verify(spec, text, hidden);
const parseFailed = (v: Verdict): boolean => v.findings.some(f => !f.ok && f.rule === "parse");
const outlineFailed = (v: Verdict): boolean => v.findings.some(f => !f.ok && f.rule === "outline");

test("honest board: the four-line rectangle outline passes", () => {
	assert.equal(verdictFor(SAMPLE_HONEST_PCB).pass, true);
	assert.equal(verdictFor(boardWith(polyline(HONEST_CORNERS))).pass, true);
});

test("cutout-and-island: a second closed Edge.Cuts loop fails the parse", () => {
	const cutout = '(gr_rect (start 123 102.5) (end 125 103.5) (fill none) ' + STROKE + ' (layer "Edge.Cuts"))';
	const island = '(gr_rect (start 150 100) (end 151 101) (fill none) ' + STROKE + ' (layer "Edge.Cuts"))';
	const base = polyline(HONEST_CORNERS);
	for (const [label, extra] of [
		["internal cutout across LED_A", cutout],
		["disjoint island outside the board", island],
	] as const) {
		const v = verdictFor(boardWith(base, [extra]));
		assert.equal(v.pass, false, `${label} must fail the board`);
		assert.equal(parseFailed(v), true, `${label} must fail the parse by name`);
	}
});

test("self-intersecting-outline: a crossing or folded boundary fails the parse", () => {
	const crossing: (readonly [number, number])[] = [
		[100, 100],
		[115, 100],
		[116, 101],
		[115, 101],
		[116, 100],
		[140, 100],
		[140, 125],
		[100, 125],
	];
	const folded: (readonly [number, number])[] = [
		[100, 100],
		[120, 100],
		[110, 100],
		[140, 100],
		[140, 125],
		[100, 125],
	];
	for (const [label, corners] of [
		["crossing top edge", crossing],
		["folded top edge", folded],
	] as const) {
		const v = verdictFor(boardWith(polyline(corners)));
		assert.equal(v.pass, false, `${label} must fail the board`);
		assert.equal(parseFailed(v), true, `${label} must fail the parse by name`);
	}
});

test("branching-outline: an edge that meets the outline at a third end fails the parse", () => {
	const dangling = `(gr_line (start 120 100) (end 120 90) ${STROKE} (layer "Edge.Cuts"))`;
	const midTop: (readonly [number, number])[] = [
		[100, 100],
		[120, 100],
		[140, 100],
		[140, 125],
		[100, 125],
	];
	const v = verdictFor(boardWith(polyline(midTop), [dangling]));
	assert.equal(v.pass, false, "a branch must fail the board");
	assert.equal(parseFailed(v), true, "a branch must fail the parse by name");
});

test("simple-curved-outline: a closed rounded outline is accepted; a gap in it fails the outline rule", () => {
	// A 40 by 25 mm rectangle with 2 mm corner arcs, drawn as lines and gr_arc pieces that share their end points.
	const arc = (s: string, m: string, e: string): string => `(gr_arc (start ${s}) (mid ${m}) (end ${e}) ${STROKE} (layer "Edge.Cuts"))`;
	const k = 1.414214;
	const rounded = [
		`(gr_line (start 102 100) (end 138 100) ${STROKE} (layer "Edge.Cuts"))`,
		arc("138 100", `${138 + k} ${102 - k}`, "140 102"),
		`(gr_line (start 140 102) (end 140 123) ${STROKE} (layer "Edge.Cuts"))`,
		arc("140 123", `${138 + k} ${123 + k}`, "138 125"),
		`(gr_line (start 138 125) (end 102 125) ${STROKE} (layer "Edge.Cuts"))`,
		arc("102 125", `${102 - k} ${123 + k}`, "100 123"),
		`(gr_line (start 100 123) (end 100 102) ${STROKE} (layer "Edge.Cuts"))`,
		arc("100 102", `${102 - k} ${102 - k}`, "102 100"),
	];
	const text = boardWith(rounded);
	const parsed = readBoard(text);
	assert.equal(parsed.error, undefined, "a single closed curved outline must parse");
	assert.equal(parsed.outlineLoops.length, 1);
	assert.equal(parsed.outlineOpen, false);
	const v = verdictFor(text);
	assert.equal(parseFailed(v), false, "a single closed curved outline must not fail the parse");
	assert.equal(outlineFailed(v), false, "a single closed curved outline must pass the outline rule");

	const gap = boardWith(rounded.slice(0, -1));
	const g = verdictFor(gap);
	assert.equal(outlineFailed(g), true, "a rounded outline with a missing corner must fail the outline rule");
	assert.equal(g.pass, false);
});

test("simple-curved-outline: a single circle on Edge.Cuts is one loop", () => {
	const circle = `(gr_circle (center 120 112.5) (end 130 112.5) ${STROKE} (fill none) (layer "Edge.Cuts"))`;
	const parsed = readBoard(boardWith([circle]));
	assert.equal(parsed.error, undefined, "a single circular outline must parse");
	assert.equal(parsed.outlineLoops.length, 1);
	assert.equal(parsed.outlineOpen, false);
});
