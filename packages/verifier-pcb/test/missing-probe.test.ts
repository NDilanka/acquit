import assert from "node:assert/strict";
import test from "node:test";
import { validateSpec } from "../src/spec.ts";
import { SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import type { HiddenSample } from "../src/types.ts";
import { verify } from "../src/verify.ts";

// A hidden probe whose endpoint is not on the board cannot be run. It must fail the hidden-probe rule, whichever
// expectation it carries, and its message must not name the pad. An isolation probe must not pass vacuously.

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

function probeFinding(hidden: HiddenSample) {
	const v = verify(spec, SAMPLE_HONEST_PCB, hidden);
	const f = v.findings.find(x => x.rule === "hidden-probe");
	assert.ok(f, "the hidden-probe finding is present");
	return { v, f };
}

test("an isolation probe to a pad that is not on the board fails the hidden-probe rule", () => {
	const { v, f } = probeFinding({ probes: [{ a: "notthere.1", b: "J1.1", expect: "isolation" }] });
	assert.equal(f.ok, false);
	assert.equal(v.pass, false);
});

test("a continuity probe to a pad that is not on the board fails the hidden-probe rule", () => {
	const { f } = probeFinding({ probes: [{ a: "J1.1", b: "notthere.1", expect: "continuity" }] });
	assert.equal(f.ok, false);
});

test("the failure names neither the missing pad nor the probed pad", () => {
	const { f } = probeFinding({ probes: [{ a: "notthere.1", b: "J1.1", expect: "isolation" }] });
	assert.doesNotMatch(f.message, /notthere|J1/);
});

test("a probe whose two pads are both on the board still runs and passes on the honest board", () => {
	const { f } = probeFinding({ probes: [{ a: "J1.1", b: "J1.2", expect: "isolation" }] });
	assert.equal(f.ok, true);
});
