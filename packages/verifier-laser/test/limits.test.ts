import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseSvg } from "../src/svg.ts";
import { validateSpec } from "../src/spec.ts";
import type { HiddenSample, Spec } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const sample = (name: string): string => readFileSync(fileURLToPath(new URL(`../samples/${name}`, import.meta.url)), "utf8");

function loadSpec(): Spec {
	const result = validateSpec(JSON.parse(sample("enclosure-panel.spec.json")));
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.value;
}

const spec = loadSpec();
const honest = sample("honest.svg");

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200">';
const panel = (body: string): string => `${HEAD}${body}</svg>`;

/** True when every number in the value is finite. Used on the scene and measurements, which must never hold NaN or Infinity. */
function allNumbersFinite(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(allNumbersFinite);
	if (value !== null && typeof value === "object") return Object.values(value).every(allNumbersFinite);
	return true;
}

function rulesOf(text: string): string[] {
	return verify(spec, text).findings.map(finding => finding.rule);
}

test("a tiny cubic that would flatten to billions of chords fails parse", () => {
	assert.deepEqual(rulesOf(panel('<path d="M0 0 C1e300 0 0 0 1 1" stroke="#ff0000" fill="none"/>')), ["parse"]);
});

test("a file of one million segments fails parse by size, without reading it", () => {
	assert.deepEqual(rulesOf(panel(`<path d="M0 0 ${"l0 0 ".repeat(1_000_000)}" stroke="#ff0000" fill="none"/>`)), ["parse"]);
});

test("a path with more points than the point budget fails parse", () => {
	assert.deepEqual(rulesOf(panel(`<path d="M0 0 ${"l0 0 ".repeat(250_000)}" stroke="#ff0000" fill="none"/>`)), ["parse"]);
});

test("groups nested deeper than the depth limit fail parse, including ten thousand levels", () => {
	const leaf = '<path d="M0 0 H1" stroke="#ff0000" fill="none"/>';
	assert.equal(parseSvg(panel("<g>".repeat(100) + leaf + "</g>".repeat(100))).ok, false);
	assert.deepEqual(rulesOf(panel("<g>".repeat(10_000) + leaf + "</g>".repeat(10_000))), ["parse"]);
});

test("a file with more elements than the element limit fails parse", () => {
	const body = Array.from({ length: 10_001 }, () => '<path d="M0 0 H1" stroke="#ff0000"/>').join("");
	assert.deepEqual(rulesOf(panel(body)), ["parse"]);
});

test("a large-radius circle is flattened within the stated tolerance", () => {
	const result = parseSvg(panel('<circle id="big" cx="0" cy="0" r="1000000" stroke="#ff0000" fill="none"/>'));
	assert.equal(result.ok, true);
	if (!result.ok) return;
	const points = result.value.paths[0]!.points;
	let worst = 0;
	for (let i = 0; i < points.length; i++) {
		const [ax, ay] = points[i]!;
		const [bx, by] = points[(i + 1) % points.length]!;
		const mid = Math.hypot((ax + bx) / 2, (ay + by) / 2);
		worst = Math.max(worst, 1_000_000 - mid);
	}
	assert.ok(worst <= 0.05, `chord error ${worst} mm`);
});

test("several large-radius circles together exceed the point budget and fail parse", () => {
	const body = Array.from({ length: 20 }, (_, i) => `<circle id="c${i}" cx="0" cy="0" r="1000000" stroke="#ff0000" fill="none"/>`).join("");
	assert.deepEqual(rulesOf(panel(body)), ["parse"]);
});

test("a drawing with too many cut segments to check in one pass fails parse", () => {
	const body = Array.from({ length: 3000 }, (_, i) => `<path d="M${i} 0 L${i} 1" stroke="#ff0000" fill="none"/>`).join("");
	assert.deepEqual(rulesOf(panel(body)), ["parse"]);
});

test("cut paths whose pairwise checks exceed the work budget fail parse before those checks run", () => {
	const body = Array.from({ length: 16 }, (_, i) => `<circle id="c${i}" cx="${i * 3000}" cy="0" r="1000" stroke="#ff0000" fill="none"/>`).join("");
	assert.deepEqual(rulesOf(panel(body)), ["parse"]);
});

test("hidden samples that are not finite points fail parse", () => {
	const bad: unknown[] = [null, {}, { keepMaterialMm: [[Number.NaN, 1]] }, { keepMaterialMm: "nope" }];
	for (const hidden of bad) {
		assert.deepEqual(verify(spec, honest, hidden as HiddenSample).findings.map(finding => finding.rule), ["parse"], JSON.stringify(hidden));
	}
});

test("non-finite numbers fail parse and never reach the scene", () => {
	const cases = [
		panel('<path d="M1e309 1e309 L1e309 1e309" stroke="#0000ff" fill="none"/>'),
		panel('<circle cx="0" cy="0" r="1e309" stroke="#ff0000" fill="none"/>'),
		panel('<g transform="scale(1e308)"><path d="M1e10 0 H0" stroke="#ff0000" fill="none"/></g>'),
		'<svg xmlns="http://www.w3.org/2000/svg" width="1e309mm" height="200mm" viewBox="0 0 300 200"><path d="M0 0 H1" stroke="#ff0000"/></svg>',
	];
	for (const text of cases) {
		const verdict = verify(spec, text);
		assert.deepEqual(verdict.findings.map(finding => finding.rule), ["parse"], text);
		assert.equal(allNumbersFinite(verdict.scene), true, text);
		assert.equal(allNumbersFinite(verdict.measured), true, text);
	}
});

test("verify never throws on a malformed spec or a missing artefact", () => {
	assert.deepEqual(verify({} as unknown as Spec, honest).findings.map(finding => finding.rule), ["parse"]);
	assert.deepEqual(verify(null as unknown as Spec, honest).findings.map(finding => finding.rule), ["parse"]);
	assert.deepEqual(verify(spec, null as unknown as string).findings.map(finding => finding.rule), ["parse"]);
});
