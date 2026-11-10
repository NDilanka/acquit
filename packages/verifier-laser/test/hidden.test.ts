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
const enclosure = JSON.parse(sample("enclosure-panel.hidden.json")) as HiddenSample;

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

const hiddenFinding = (verdict: Verdict): Verdict["findings"][number] | undefined =>
	verdict.findings.find(finding => finding.rule === "hidden-material");

test("a hidden finding does not leak the probe coordinates, the clearance or any count", () => {
	const verdict = verify(specWith(), honest, { keepMaterialMm: [[1.537, 40]], voidMm: [[60, 40]], clearanceMm: 2.345678 });
	assert.deepEqual(failed(verdict), ["hidden-material"]);
	const message = hiddenFinding(verdict)?.message;
	assert.ok(message !== undefined);
	assert.doesNotMatch(message, /\d/);
	assert.equal("hiddenSamples" in verdict.measured, false);
	assert.ok(!JSON.stringify(verdict).includes("1.537"));
	assert.ok(!JSON.stringify(verdict).includes("2.345678"));
});

/** The distinct hidden-material messages over some samples, each of which must pass or fail as the caller says. */
function hiddenMessages(cases: readonly HiddenSample[], ok: boolean): string[] {
	const messages = cases.map(hidden => {
		const finding = hiddenFinding(verify(specWith(), honest, hidden));
		assert.equal(finding?.ok, ok, JSON.stringify(hidden));
		return finding?.message ?? "";
	});
	return [...new Set(messages)];
}

test("hidden messages are the same fixed text whatever the samples, clearance and voids are", () => {
	const passing: HiddenSample[] = [
		{ keepMaterialMm: [[44.95, 40], [75.05, 40]] },
		{ keepMaterialMm: [[1.5, 40]], clearanceMm: 1 },
		{ keepMaterialMm: [[30, 20]], voidMm: [[60, 40]] },
	];
	const failing: HiddenSample[] = [
		{ keepMaterialMm: [[1.537, 40]], clearanceMm: 2.345678 },
		{ keepMaterialMm: [[1.5, 40], [2.25, 40], [1.75, 40]], clearanceMm: 2 },
		{ keepMaterialMm: [[30, 20]], voidMm: [[30, 20]] },
		{ keepMaterialMm: [[60, 40]], voidMm: [[1, 1], [2, 2]], clearanceMm: 0.5 },
	];
	const passText = hiddenMessages(passing, true);
	const failText = hiddenMessages(failing, false);
	assert.equal(passText.length, 1);
	assert.equal(failText.length, 1);
	assert.notEqual(passText[0], failText[0]);
	assert.doesNotMatch(failText[0] ?? "", /\d/);
	assert.doesNotMatch(passText[0] ?? "", /\d/);
});

test("a non-finite expected-void probe or a negative clearance fails parse", () => {
	assert.deepEqual(failed(verify(specWith(), honest, { keepMaterialMm: [], voidMm: [[Infinity, 1]] })), ["parse"]);
	assert.deepEqual(failed(verify(specWith(), honest, { keepMaterialMm: [[60, 40]], clearanceMm: -1 })), ["parse"]);
});

// The first hole drawn at r 1.53 instead of 1.5: its finished radius is 1.63 mm, and it still passes the hole tolerance.
const enlargedFirstHole = (): string => edit(honest, 'r="1.5"', 'r="1.53"');

test("a keep-material probe that the enlarged first hole cuts away fails hidden-material", () => {
	// The probe is 1.625 mm from the first hole's centre at part (6, 6). The honest hole finishes at 1.6 mm, so the
	// probe is material. The enlarged hole finishes at 1.63 mm and cuts the probe away by 0.005 mm. The drawn circle is
	// flattened to an inscribed polygon, so its edges can look further from the probe than the true hole edge.
	const probe: [number, number] = [7.611097899732444, 5.78789493764242];
	const hidden: HiddenSample = { ...enclosure, keepMaterialMm: [...enclosure.keepMaterialMm, probe] };
	assert.deepEqual(failed(verify(specWith(), honest, hidden)), []);
	assert.deepEqual(failed(verify(specWith(), enlargedFirstHole(), hidden)), ["hidden-material"]);
});

test("a clearance probe that the enlarged first hole brings under the clearance fails hidden-material", () => {
	// The probe is 2.62 mm from the first hole's centre. Honest clearance is 1.02 mm, which passes a 1 mm clearance.
	// The enlarged hole leaves 0.99 mm, which must fail.
	const probe: [number, number] = [8.597585536799384, 5.658021376383459];
	const hidden: HiddenSample = { ...enclosure, clearanceMm: 1, keepMaterialMm: [...enclosure.keepMaterialMm, probe] };
	assert.deepEqual(failed(verify(specWith(), honest, hidden)), []);
	assert.deepEqual(failed(verify(specWith(), enlargedFirstHole(), hidden)), ["hidden-material"]);
});
