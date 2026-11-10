import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../src/spec.ts";
import type { HiddenSample, Spec, Verdict } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const sample = (name: string): string => readFileSync(fileURLToPath(new URL(`../samples/${name}`, import.meta.url)), "utf8");

/** The enclosure spec with some fields replaced. Fails loudly when the patch is not a valid spec. */
function specWith(patch: Record<string, unknown> = {}): Spec {
	const raw = JSON.parse(sample("enclosure-panel.spec.json")) as Record<string, unknown>;
	const result = validateSpec({ ...raw, ...patch });
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.value;
}

const honest = sample("honest.svg");

/** Replaces one fragment of the honest panel. Throws when the fragment is missing, so an edit cannot silently do nothing. */
function edit(text: string, from: string, to: string): string {
	if (!text.includes(from)) throw new Error(`fixture fragment not found: ${from}`);
	return text.replace(from, to);
}

const failed = (verdict: Verdict): string[] => verdict.findings.filter(finding => !finding.ok).map(finding => finding.rule);

const OUTLINE = `d="M10 10 H130.2 V90.2 H10 Z"`;

test("the honest panel keeps its hidden samples as material", () => {
	const hidden = JSON.parse(sample("enclosure-panel.hidden.json")) as HiddenSample;
	assert.deepEqual(failed(verify(specWith(), honest, hidden)), []);
});

test("keep-material probes in the window's kerf strip fail hidden-material on every side", () => {
	// The window's finished void is its drawn cut grown kerf/2 (0.1 mm) on every side. Each probe sits 0.05 mm inside
	// that growth, so it is in the kerf strip, on the far side of the drawn line.
	const probes: [number, number][] = [
		[45.05, 40],
		[74.95, 40],
		[60, 45.95],
		[60, 34.05],
	];
	for (const probe of probes) {
		assert.deepEqual(failed(verify(specWith(), honest, { keepMaterialMm: [probe] })), ["hidden-material"], `probe ${probe}`);
	}
});

test("keep-material probes on the finished window boundary fail hidden-material on every side", () => {
	const probes: [number, number][] = [
		[45, 40],
		[75, 40],
		[60, 46],
		[60, 34],
	];
	for (const probe of probes) {
		assert.deepEqual(failed(verify(specWith(), honest, { keepMaterialMm: [probe] })), ["hidden-material"], `probe ${probe}`);
	}
});

test("a keep-material probe just outside the finished window passes", () => {
	// 0.05 mm beyond the finished boundary on the left and on the right: material on both sides.
	const hidden: HiddenSample = { keepMaterialMm: [[44.95, 40], [75.05, 40]] };
	assert.deepEqual(failed(verify(specWith(), honest, hidden)), []);
});

test("a keep-material probe in the removed corner fails hidden-material and the outline check", () => {
	// The bottom-right corner is chamfered away. The probe [119.2, 1] sits in the removed corner.
	const notched = edit(honest, OUTLINE, `d="M10 10 H130.2 V88 L128 90.2 H10 Z"`);
	const verdict = verify(specWith(), notched, { keepMaterialMm: [[119.2, 1]] });
	assert.ok(failed(verdict).includes("hidden-material"));
	assert.ok(failed(verdict).includes("outer-size"));
});

test("an expected-void probe inside the window passes", () => {
	// The window centre is in the finished void, so the probe is correct.
	const hidden: HiddenSample = { keepMaterialMm: [[30, 20]], voidMm: [[60, 40]] };
	assert.deepEqual(failed(verify(specWith(), honest, hidden)), []);
});

test("an expected-void probe in material fails hidden-material", () => {
	const hidden: HiddenSample = { keepMaterialMm: [[30, 20]], voidMm: [[30, 20]] };
	assert.deepEqual(failed(verify(specWith(), honest, hidden)), ["hidden-material"]);
});

test("a keep-material probe closer to a finished edge than the clearance fails hidden-material", () => {
	// 1.5 mm from the finished left edge: fails at a 2 mm clearance, passes at 1 mm.
	assert.deepEqual(failed(verify(specWith(), honest, { keepMaterialMm: [[1.5, 40]], clearanceMm: 2 })), ["hidden-material"]);
	assert.deepEqual(failed(verify(specWith(), honest, { keepMaterialMm: [[1.5, 40]], clearanceMm: 1 })), []);
});

test("a hidden clearance failure does not leak the probe coordinates", () => {
	const verdict = verify(specWith(), honest, { keepMaterialMm: [[1.537, 40]], clearanceMm: 2 });
	assert.deepEqual(failed(verdict), ["hidden-material"]);
	assert.ok(!JSON.stringify(verdict.findings).includes("1.537"));
});

test("a non-finite expected-void probe or a negative clearance fails parse", () => {
	assert.deepEqual(failed(verify(specWith(), honest, { keepMaterialMm: [], voidMm: [[Infinity, 1]] })), ["parse"]);
	assert.deepEqual(failed(verify(specWith(), honest, { keepMaterialMm: [[60, 40]], clearanceMm: -1 })), ["parse"]);
});
