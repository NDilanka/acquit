import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../src/spec.ts";
import type { Spec, Verdict } from "../src/types.ts";
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

const LABEL = `<path id="label" d="M20 80.2 H60" stroke="#0000ff" fill="none"/>`;

test("a panel with no engraving fails engrave-inside", () => {
	assert.deepEqual(failed(verify(specWith(), edit(honest, LABEL, ""))), ["engrave-inside"]);
});

test("a label outside the part fails engrave-inside", () => {
	const text = edit(honest, LABEL, `<path d="M200 180 H240" stroke="#0000ff"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["engrave-inside"]);
});

test("a label inside the window void fails engrave-inside", () => {
	const text = edit(honest, LABEL, `<path d="M60 50 H80" stroke="#0000ff"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["engrave-inside"]);
});

test("a label in material but outside the label region fails engrave-inside", () => {
	const text = edit(honest, LABEL, `<path id="label" d="M20 30 H60" stroke="#0000ff" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["engrave-inside"]);
});

test("a label curve that rises 0.005 mm above the label region fails engrave-inside", () => {
	// The quadratic peaks at drawn y 76.095, 0.005 mm above the region's top edge at 76.1. Flattening reduces it to a
	// chord on that edge, which lies inside the region, so the flattened chord cannot show the rise.
	const text = edit(honest, 'd="M20 80.2 H60"', 'd="M20 76.1 Q40 76.09 60 76.1"');
	assert.deepEqual(failed(verify(specWith(), text)), ["engrave-inside"]);
});

test("a label whose ends are clear but whose middle crosses a cut fails engrave-inside", () => {
	// A round cut across the label line. Both label ends are clear of it, so only the whole segment shows the crossing.
	const crossing = `<circle id="crossing" cx="40" cy="80.2" r="1" stroke="#ff0000" fill="none"/>`;
	const text = edit(honest, LABEL, `${LABEL}\n  ${crossing}`);
	assert.ok(failed(verify(specWith(), text)).includes("engrave-inside"));
});

test("a zero-length label path fails engrave-inside", () => {
	const text = edit(honest, LABEL, `<path id="label" d="M20 80.2 L20 80.2" stroke="#0000ff" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["engrave-inside"]);
});

test("a zero-length label line fails engrave-inside", () => {
	const text = edit(honest, LABEL, `<line id="label" x1="20" y1="80.2" x2="20" y2="80.2" stroke="#0000ff"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["engrave-inside"]);
});

test("a label scaled to a point fails engrave-inside", () => {
	// Every point of the path lands on (20, 80.2) after the scale, so the drawn length is zero.
	const text = edit(honest, LABEL, `<path id="label" transform="translate(20 80.2) scale(0)" d="M0 0 H40" stroke="#0000ff" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["engrave-inside"]);
});

test("a label shorter than the minimum engraved length fails engrave-inside", () => {
	// A 2 mm mark sits inside the label region, but the spec asks for at least 20 mm of engraving.
	const text = edit(honest, LABEL, `<path id="label" d="M20 80.2 H22" stroke="#0000ff" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["engrave-inside"]);
});

test("the minimum engraved length comes from the spec, so the honest 40 mm label fails a 50 mm minimum", () => {
	assert.deepEqual(failed(verify(specWith(), honest)), []);
	assert.deepEqual(failed(verify(specWith({ minEngraveLengthMm: 50 }), honest)), ["engrave-inside"]);
});

test("strokes that each fall short of the minimum pass when together they reach it", () => {
	// 10 mm and 15 mm: each is under 20 mm, but the engraved length in total is 25 mm.
	const text = edit(honest, LABEL, `<path d="M20 80.2 H30" stroke="#0000ff" fill="none"/>\n  <path d="M30 80.2 H45" stroke="#0000ff" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), []);
});
