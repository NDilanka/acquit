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
const hidden = JSON.parse(sample("enclosure-panel.hidden.json")) as HiddenSample;

/** Replaces one fragment of the honest panel. Throws when the fragment is missing, so an edit cannot silently do nothing. */
function edit(text: string, from: string, to: string): string {
	if (!text.includes(from)) throw new Error(`fixture fragment not found: ${from}`);
	return text.replace(from, to);
}

const failed = (verdict: Verdict): string[] => verdict.findings.filter(finding => !finding.ok).map(finding => finding.rule);

const OUTLINE = `<path id="outline" d="M10 10 H130.2 V90.2 H10 Z" stroke="#ff0000" fill="none"/>`;
const WINDOW = `<rect id="window" x="55.2" y="44.2" width="29.8" height="11.8" stroke="#ff0000" fill="none"/>`;
const MOUNT_A = `<circle id="mount-a" cx="16.1" cy="84.1" r="1.5" stroke="#ff0000" fill="none"/>`;

test("the corrected honest panel passes with the shapes checked", () => {
	const verdict = verify(specWith(), honest, hidden);
	assert.deepEqual(failed(verdict), []);
});

test("a chamfered outer corner fails outer-size and nothing else", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 H130.2 V85.2 L125.2 90.2 H10 Z" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["outer-size"]);
});

test("a triangle with the right bounding box fails outer-size", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 L130.2 50.2 L10 90.2 Z" stroke="#ff0000" fill="none"/>`);
	assert.ok(failed(verify(specWith(), text)).includes("outer-size"));
});

test("a zero-area outline fails outer-size", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 H130.2 H10 Z" stroke="#ff0000" fill="none"/>`);
	assert.ok(failed(verify(specWith(), text)).includes("outer-size"));
});

test("an open outline fails closed-paths and outer-size", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 H130.2 V90.2 H10" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["closed-paths", "outer-size"]);
});

test("a rounded outline passes when the spec declares its corner radius, and fails when the spec says square", () => {
	const rounded = edit(honest, OUTLINE, `<rect id="outline" x="10" y="10" width="120.2" height="80.2" rx="1.1" ry="1.1" stroke="#ff0000" fill="none"/>`);
	const declared = verify(specWith({ cornerRadiusMm: 1 }), rounded);
	assert.deepEqual(failed(declared), []);
	const square = verify(specWith({ cornerRadiusMm: 0 }), rounded);
	assert.deepEqual(failed(square), ["outer-size"]);
});

test("a hidden corner removed by a chamfer fails hidden-material", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 H130.2 V85.2 L125.2 90.2 H10 Z" stroke="#ff0000" fill="none"/>`);
	const probe: HiddenSample = { keepMaterialMm: [[119.2, 1]] };
	assert.deepEqual(failed(verify(specWith(), text, probe)), ["outer-size", "hidden-material"]);
});

test("a square where the round hole belongs fails holes", () => {
	const text = edit(honest, MOUNT_A, `<rect id="mount-a" x="14.6" y="82.6" width="3" height="3" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["holes"]);
});

test("a zero-area hole where the round hole belongs fails holes", () => {
	const text = edit(honest, MOUNT_A, `<path id="mount-a" d="M14.6 84.1 H17.6 Z" stroke="#ff0000" fill="none"/>`);
	assert.ok(failed(verify(specWith(), text)).includes("holes"));
});

test("a blue circle where the required hole belongs fails holes and engrave-inside", () => {
	// The engraved circle is both a missing cut and an engraving outside the label region.
	const text = edit(honest, MOUNT_A, `<circle id="mount-a" cx="16.1" cy="84.1" r="1.5" stroke="#0000ff" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["holes", "engrave-inside"]);
});

test("an extra round cut at a new position fails holes", () => {
	for (const cx of [50.1, 52.1]) {
		const extra = `<circle id="extra" cx="${cx}" cy="84.1" r="1.5" stroke="#ff0000" fill="none"/>`;
		// Drawn before the outer cut, so cut-order stays clean and only the hole rule can fail.
		const text = edit(honest, OUTLINE, `${extra}\n${OUTLINE}`);
		assert.deepEqual(failed(verify(specWith(), text)), ["holes"], `cx ${cx}`);
	}
});

test("a hole moved 1 mm fails holes", () => {
	const text = edit(honest, MOUNT_A, `<circle id="mount-a" cx="17.1" cy="84.1" r="1.5" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["holes"]);
});

test("a hole with the wrong diameter fails holes", () => {
	const text = edit(honest, MOUNT_A, `<circle id="mount-a" cx="16.1" cy="84.1" r="2" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["holes"]);
});

test("a diamond where the window belongs fails cutouts", () => {
	const text = edit(honest, WINDOW, `<path id="window" d="M70.1 44.2 L85 50.1 L70.1 56 L55.2 50.1 Z" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["cutouts"]);
});

test("a window outside the part fails cutouts", () => {
	const text = edit(honest, WINDOW, `<rect id="window" x="170" y="44.2" width="29.8" height="11.8" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["cutouts"]);
});

test("an open window fails closed-paths and cutouts", () => {
	const text = edit(honest, WINDOW, `<path id="window" d="M55.2 44.2 H85 V56 H55.2" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["closed-paths", "cutouts"]);
});

test("a rectangle inside the window fails cutouts", () => {
	// Inside the window with every web at least 3.6 mm, and drawn before the window, so only the cutout rule can fail.
	const stray = `<rect id="stray" x="62" y="48" width="10" height="4" stroke="#ff0000" fill="none"/>`;
	const text = edit(honest, WINDOW, `${stray}\n${WINDOW}`);
	assert.deepEqual(failed(verify(specWith(), text)), ["cutouts"]);
});

/** The honest panel with its four mount circles removed, so a spec can name its own holes. */
const withoutMounts = (): string => honest.replace(/<circle[^>]*\/>/g, "");

test("a required hole cut inside the window's waste fails holes and cutouts, even drawn before the window", () => {
	// The window's waste falls out, so a circle inside it is not the hole the spec asks for.
	const central = `<circle id="central" cx="70.1" cy="50.1" r="1.5" stroke="#ff0000" fill="none"/>`;
	const spec = specWith({ holes: [{ id: "central-hole", centreMm: [60, 40], diameterMm: 3.2 }] });
	assert.deepEqual(failed(verify(spec, edit(withoutMounts(), WINDOW, `${central}\n${WINDOW}`))), ["holes", "cutouts"]);
	// Drawn after the window, the same circle also fails cut-order, which is the control.
	assert.ok(failed(verify(spec, edit(withoutMounts(), WINDOW, `${WINDOW}\n${central}`))).includes("cut-order"));
});

test("a required window cut inside a larger required window fails cutouts, drawn before the larger window", () => {
	// Two slots with no holes: the small slot sits inside the large one's waste, so it is not matched to any cutout.
	const small = `<rect id="small" x="60.1" y="48.1" width="19.8" height="3.8" stroke="#ff0000" fill="none"/>`;
	const spec = specWith({ holes: [], slots: [{ id: "window", sizeMm: [30, 12] }, { id: "small", sizeMm: [20, 4] }] });
	assert.deepEqual(failed(verify(spec, edit(withoutMounts(), WINDOW, `${small}\n${WINDOW}`))), ["cutouts"]);
	assert.ok(failed(verify(spec, edit(withoutMounts(), WINDOW, `${WINDOW}\n${small}`))).includes("cut-order"), "outer-first is the control");
});
