import assert from "node:assert/strict";
import test from "node:test";
import { validateSpec } from "../src/spec.ts";
import { SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";

// A malformed recognised record (missing, non-finite, out-of-range, or non-positive mandatory field) must fail the
// parse. It must never be skipped silently or coalesced to zero.

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

/** Applies one textual mutation to the honest board, asserting the mutation actually changed the text. */
const mutate = (from: string | RegExp, to: string): string => {
	const text = SAMPLE_HONEST_PCB.replace(from, to);
	assert.notEqual(text, SAMPLE_HONEST_PCB, `mutation did not apply: ${String(from)}`);
	return text;
};

const parseFailed = (text: string): boolean =>
	verify(spec, text).findings.some(f => !f.ok && f.rule === "parse");

test("a track with no width is a parse failure, not a silently dropped track", () => {
	assert.equal(parseFailed(mutate("(width 0.25)", "")), true);
});

test("a NaN, Infinity, or overflowing coordinate is a parse failure", () => {
	for (const bad of ["NaN", "Infinity", "1e309"]) {
		assert.equal(parseFailed(mutate(/\(segment \(start [-\d.]+ /, `(segment (start ${bad} `)), true, bad);
	}
});

test("a coordinate beyond one million millimetres is a parse failure", () => {
	assert.equal(parseFailed(mutate(/\(segment \(start [-\d.]+ /, "(segment (start 2000000 ")), true);
});

test("a footprint with a non-finite position is a parse failure", () => {
	assert.equal(parseFailed(mutate('(layer "F.Cu") (at 102 106)', '(layer "F.Cu") (at NaN 106)')), true);
});

test("a non-finite footprint rotation is a parse failure, not a rotation of zero", () => {
	assert.equal(parseFailed(mutate('(layer "F.Cu") (at 102 106)', '(layer "F.Cu") (at 102 106 1e309)')), true);
});

test("zero or negative track width is a parse failure", () => {
	assert.equal(parseFailed(mutate("(width 0.25)", "(width 0)")), true);
	assert.equal(parseFailed(mutate("(width 0.25)", "(width -0.25)")), true);
});

test("zero via size or drill is a parse failure", () => {
	assert.equal(parseFailed(mutate("(size 0.6)", "(size 0)")), true);
	assert.equal(parseFailed(mutate("(drill 0.3)", "(drill 0)")), true);
});

test("a zero pad dimension is a parse failure", () => {
	assert.equal(parseFailed(mutate("(size 1.7 1.7)", "(size 0 1.7)")), true);
});

test("a through-hole pad with no drill is a parse failure", () => {
	assert.equal(parseFailed(mutate("(drill 1)", "")), true);
});

test("an SMD pad that carries a drill is a parse failure", () => {
	assert.equal(parseFailed(mutate("(size 0.6 0.7)", "(size 0.6 0.7) (drill 0.5)")), true);
});
