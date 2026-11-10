import assert from "node:assert/strict";
import test from "node:test";
import { validateSpec } from "../src/spec.ts";
import { SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { parseSexprs } from "../src/sexpr.ts";
import { verify } from "../src/verify.ts";

// Budget tests: input size, nesting, element count, copper count, flattened vertices, arc pieces, and the geometric
// work budget. Each oversized input must come back as a failed parse that names the limit. It must never hang,
// exhaust memory, or return a verdict that quietly skipped part of the board.

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

/** Inserts one item as the first child of the board root. */
const onRoot = (item: string): string => SAMPLE_HONEST_PCB.replace("(kicad_pcb ", `(kicad_pcb ${item} `);
const SEG = (x1: number, y1: number, x2: number, y2: number): string =>
	`(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width 0.2) (layer "F.Cu") (net 4))`;
const ARC = (sx: number, sy: number, mx: number, my: number, ex: number, ey: number): string =>
	`(arc (start ${sx} ${sy}) (mid ${mx} ${my}) (end ${ex} ${ey}) (width 0.2) (layer "F.Cu"))`;

/** The parse finding's message, or the empty string when the board parsed. */
function parseMessage(text: string): string {
	const v = verify(spec, text);
	return v.findings.find(f => f.rule === "parse" && !f.ok)?.message ?? "";
}

test("huge-arc-budget: an arc with a 1e16 radius is rejected as an out-of-range coordinate", () => {
	assert.notEqual(parseMessage(onRoot(ARC(1e16, 0, 0, 1e16, -1e16, 0))), "");
});

test("huge-arc-budget: a nearly straight arc inside the coordinate bounds is rejected before it is flattened", () => {
	// Radius about 5e17 mm: the chord error step rounds to zero, so the piece count would be infinite.
	assert.match(parseMessage(onRoot(ARC(-1e6, 0, 0, 1e-6, 1e6, 0))), /straight pieces/);
});

test("huge-arc-budget: a semicircle of radius 1,000,000 mm needs more than the per-arc piece limit", () => {
	assert.match(parseMessage(onRoot(ARC(-1e6, 0, 0, 1e6, 1e6, 0))), /straight pieces/);
});

test("a modest arc inside the budget still parses", () => {
	assert.equal(parseMessage(onRoot(ARC(120, 110, 122, 112, 124, 110))), "");
});

test("primitive-budget: more than 1,000 copper items fail the parse", () => {
	const items = Array.from({ length: 1001 }, (_, i) => SEG(200 + i * 0.1, 150, 200 + i * 0.1 + 0.05, 150));
	assert.match(parseMessage(onRoot(items.join(" "))), /too many copper items/);
});

test("primitive-budget: 100,000 segments fail at admission, before any geometry is built", () => {
	const items = Array.from({ length: 100_000 }, (_, i) => SEG(105, 116, 106 + (i % 3) * 0.001, 116));
	assert.notEqual(parseMessage(onRoot(items.join(" "))), "");
});

test("primitive-budget: an input over 5 MiB is rejected before it is read", () => {
	const big = `${SAMPLE_HONEST_PCB}${" ".repeat(5_242_881)}`;
	assert.match(parseMessage(big), /5242880 characters/);
});

test("primitive-budget: nesting deeper than 256 levels is rejected, and 256 is still allowed", () => {
	assert.equal(parseSexprs("(".repeat(256) + ")".repeat(256)).ok, true);
	const deep = parseSexprs("(".repeat(257) + ")".repeat(257));
	assert.equal(deep.ok, false);
	assert.match(deep.ok ? "" : deep.error, /nesting/);
	assert.notEqual(parseMessage("(".repeat(300) + ")".repeat(300)), "");
});

test("primitive-budget: more than 100,000 elements are rejected, and exactly 100,000 is still allowed", () => {
	assert.equal(parseSexprs(`(${"a ".repeat(99_999)})`).ok, true);
	assert.equal(parseSexprs(`(${"a ".repeat(100_000)})`).ok, false);
});

test("primitive-budget: flattened vertices over 16,384 are rejected", () => {
	// Each semicircle of radius 10,000 mm flattens to about 785 pieces, so 40 of them exceed the vertex budget.
	const arcs = Array.from({ length: 40 }, () => ARC(-10000, 0, 0, 10000, 10000, 0)).join(" ");
	assert.match(parseMessage(onRoot(arcs)), /too many flattened vertices/);
});

test("primitive-budget: overlapping copper exhausts the geometric work budget and fails the parse", () => {
	// 900 identical overlapping segments give about 400,000 pairs, well over the 100,000 segment-pair tests allowed.
	const items = Array.from({ length: 900 }, () => SEG(105, 116, 106, 116)).join(" ");
	assert.match(parseMessage(onRoot(items)), /segment-pair tests/);
});
