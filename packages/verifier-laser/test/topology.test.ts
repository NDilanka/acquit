import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../src/spec.ts";
import { parseSvg } from "../src/svg.ts";
import type { Spec } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const specResult = validateSpec(JSON.parse(readFileSync(fileURLToPath(new URL("../samples/enclosure-panel.spec.json", import.meta.url)), "utf8")));
if (!specResult.ok) throw new Error(JSON.stringify(specResult.errors));
const spec: Spec = specResult.value;

// Built from fixed markup, not from the samples, so regenerating the samples cannot move these cases.
const RED = 'stroke="#ff0000" fill="none"';
const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200">';
const MOUNTS = [
	`<circle id="mount-a" cx="16.1" cy="84.1" r="1.5" ${RED}/>`,
	`<circle id="mount-b" cx="124.1" cy="84.1" r="1.5" ${RED}/>`,
	`<circle id="mount-c" cx="16.1" cy="16.1" r="1.5" ${RED}/>`,
	`<circle id="mount-d" cx="124.1" cy="16.1" r="1.5" ${RED}/>`,
].join("\n  ");
const WINDOW = `<rect id="window" x="55.2" y="44.2" width="29.8" height="11.8" ${RED}/>`;
const LABEL = '<path id="label" d="M20 80.2 H60" stroke="#0000ff" fill="none"/>';
const OUTLINE = `<path id="outline" d="M10 10 H130.2 V90.2 H10 Z" ${RED}/>`;

const panel = (...parts: string[]): string => [HEAD, ...parts, "</svg>"].join("\n  ");
const cut = (id: string, d: string): string => `<path id="${id}" d="${d}" ${RED}/>`;

const HONEST = panel(MOUNTS, WINDOW, LABEL, OUTLINE);

const failedRules = (drawing: string): string[] => verify(spec, drawing).findings.filter(item => !item.ok).map(item => item.rule);
const findingOf = (drawing: string, rule: string) => verify(spec, drawing).findings.find(item => item.rule === rule);

test("the honest panel fails no topology rule", () => {
	assert.deepEqual(failedRules(HONEST), []);
});

test("a retraced outline, its top edge cut again from x 50 to 90, fails no-duplicates and no-self-intersection", () => {
	const retraced = panel(MOUNTS, WINDOW, LABEL, cut("outline", "M10 10 H90 H50 H130.2 V90.2 H10 Z"));
	assert.deepEqual(failedRules(retraced), ["no-duplicates", "no-self-intersection"]);
});

// Each copy runs over the window's edges, so the copy is a repeat and the window is still the one hole it fills.
const REPEATS: Record<string, string> = {
	"a reversed copy": "M85 44.2 H55.2 V56 H85 Z",
	"a copy with an extra collinear vertex": "M55.2 44.2 H70 H85 V56 H55.2 Z",
	"a copy overlapping the window's right part": "M70 44.2 H100 V56 H70 Z",
	"a copy offset 0.01 mm": "M55.21 44.21 H85.01 V56.01 H55.21 Z",
};

for (const [name, d] of Object.entries(REPEATS)) {
	test(`${name} of the window fails no-duplicates alone`, () => {
		assert.deepEqual(failedRules(panel(MOUNTS, WINDOW, cut("copy", d), LABEL, OUTLINE)), ["no-duplicates"]);
	});
}

test("a circle 3.1 mm from the window fails min-web, with the flattened gap less the kerf and flattening allowance", () => {
	// The 64-sided flattening puts the nearest vertex 3.114 mm off, not 3.1. Less the 0.2 mm kerf and up to
	// 2 x 0.02 mm of flattening on the finished edges, the finished web is 2.874 mm.
	const withCircle = panel(MOUNTS, WINDOW, '<circle id="web" cx="89.1" cy="50.2" r="1" ' + RED + "/>", LABEL, OUTLINE);
	assert.equal(findingOf(withCircle, "min-web")?.ok, false);
	const web = verify(spec, withCircle).measured.minWebMm;
	assert.ok(typeof web === "number" && web > 2.85 && web < 2.9, `finished web ${String(web)}`);
});

test("a circle 3.4 mm from the window leaves at least 3 mm of finished web and passes min-web", () => {
	const withCircle = panel(MOUNTS, WINDOW, '<circle id="web" cx="89.4" cy="50.2" r="1" ' + RED + "/>", LABEL, OUTLINE);
	assert.equal(findingOf(withCircle, "min-web")?.ok, true);
});

const COMPOUND = cut("frame", "M10 10 H130.2 V90.2 H10 Z M55.2 44.2 H85 V56 H55.2 Z");

test("a compound outer cut drawn before its window fails cut-order alone", () => {
	assert.deepEqual(failedRules(panel(MOUNTS, LABEL, COMPOUND)), ["cut-order"]);
});

test("each subpath of a compound path keeps its own order, in drawing order", () => {
	const parsed = parseSvg(panel(MOUNTS, LABEL, COMPOUND));
	if (!parsed.ok) throw new Error(parsed.errors[0]?.message);
	const subpaths = parsed.value.paths.filter(path => path.id.startsWith("frame."));
	assert.equal(subpaths.length, 2);
	assert.ok(subpaths[0]!.order < subpaths[1]!.order);
});

test("a rectangle drawn after the window, inside it, fails cut-order", () => {
	const island = cut("island", "M60 48 H70 V53 H60 Z");
	assert.ok(failedRules(panel(MOUNTS, WINDOW, island, LABEL, OUTLINE)).includes("cut-order"));
});

test("a rectangle drawn before the window, inside it, passes cut-order", () => {
	const island = cut("island", "M60 48 H70 V53 H60 Z");
	assert.equal(findingOf(panel(MOUNTS, island, WINDOW, LABEL, OUTLINE), "cut-order")?.ok, true);
});

test("a rectangle enclosing the window and drawn before it fails cut-order", () => {
	const frame = cut("frame", "M40 30 H100 V70 H40 Z");
	assert.ok(failedRules(panel(MOUNTS, frame, WINDOW, LABEL, OUTLINE)).includes("cut-order"));
});
