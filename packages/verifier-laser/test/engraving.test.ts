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

test("a label whose ends are clear but whose middle crosses a cut fails engrave-inside", () => {
	// A round cut across the label line. Both label ends are clear of it, so only the whole segment shows the crossing.
	const crossing = `<circle id="crossing" cx="40" cy="80.2" r="1" stroke="#ff0000" fill="none"/>`;
	const text = edit(honest, LABEL, `${LABEL}\n  ${crossing}`);
	assert.ok(failed(verify(specWith(), text)).includes("engrave-inside"));
});
