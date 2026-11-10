import assert from "node:assert/strict";
import test from "node:test";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import type { HiddenSample } from "../src/types.ts";
import { verify } from "../src/verify.ts";

// A probe must be two distinct conductive pads named by the spec. A same-pad probe, a non-plated hole, or an
// unknown reference is an invalid definition. The sample validator refuses it, and verify never passes it as a test.

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const hiddenOf = (probes: unknown[]): unknown => ({ probes });

function probeOk(hidden: HiddenSample): boolean {
	const f = verify(spec, SAMPLE_HONEST_PCB, hidden).findings.find(x => x.rule === "hidden-probe");
	assert.ok(f, "the hidden-probe finding is present");
	return f.ok;
}

test("the bundled hidden sample is still accepted", () => {
	assert.equal(validateHidden(JSON.parse(SAMPLE_HIDDEN_JSON), spec).ok, true);
});

test("a probe that names the same pad at both ends is refused by validateHidden", () => {
	assert.equal(validateHidden(hiddenOf([{ a: "J1.1", b: "J1.1", expect: "continuity" }]), spec).ok, false);
});

test("a probe to a non-plated hole is refused by validateHidden", () => {
	assert.equal(validateHidden(hiddenOf([{ a: "H4.1", b: "J1.1", expect: "isolation" }]), spec).ok, false);
});

test("a probe naming a reference the spec does not define is refused by validateHidden", () => {
	assert.equal(validateHidden(hiddenOf([{ a: "X9.1", b: "J1.1", expect: "isolation" }]), spec).ok, false);
});

test("verify does not pass a same-pad continuity probe as a test", () => {
	assert.equal(probeOk({ probes: [{ a: "J1.1", b: "J1.1", expect: "continuity" }] }), false);
});

test("verify does not pass an isolation probe to a non-plated hole", () => {
	assert.equal(probeOk({ probes: [{ a: "H4.1", b: "J1.1", expect: "isolation" }] }), false);
});
