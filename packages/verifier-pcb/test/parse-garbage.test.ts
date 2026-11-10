import assert from "node:assert/strict";
import test from "node:test";
import { SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { verify } from "../src/verify.ts";

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const garbage = [
	"",
	"not a board at all",
	"(((",
	")))",
	'(kicad_pcb (footprint "x" (pad "1" smd rect (at a b)))',
	"(kicad_pcb (gr_line (start 0 0) (end 1 nope)))",
	"\u0000\u0001\uffff",
];

test("unparseable or hostile files give a failed parse finding and never throw", () => {
	for (const text of garbage) {
		const v = verify(spec, text);
		assert.equal(v.pass, false, `pass must be false for ${JSON.stringify(text)}`);
		assert.ok(v.findings.length > 0, "at least one finding");
		assert.ok(v.findings.every(f => typeof f.rule === "string" && typeof f.message === "string"));
		assert.ok(v.scene.paths.every(p => Array.isArray(p.points)));
	}
});

test("a file that parses but is not a PCB fails the parse rule", () => {
	const v = verify(spec, "(something_else (a 1))");
	assert.equal(v.pass, false);
	assert.ok(v.findings.some(f => f.rule === "parse" && !f.ok));
});

test("a bad spec or hidden sample is reported, not thrown", () => {
	for (const value of [null, 42, "spec", { name: 3 }, { name: "x" }, []]) {
		const r = validateSpec(value);
		assert.equal(r.ok, false);
	}
	for (const value of [null, {}, { probes: "no" }]) {
		const r = validateHidden(value, spec);
		assert.equal(r.ok, false);
	}
});
