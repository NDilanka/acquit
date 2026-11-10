import assert from "node:assert/strict";
import test from "node:test";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Spec, Verdict } from "../src/types.ts";

// A pad's copper is modelled exactly or refused. A roundrect's corner ratio is not modelled, so a roundrect fails the
// parse. A tall oval is a vertical capsule, so the copper gap to it is measured against that capsule.

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const hidden: HiddenSample = (() => {
	const r = validateHidden(JSON.parse(SAMPLE_HIDDEN_JSON), spec);
	if (!r.ok) throw new Error(r.error);
	return r.hidden;
})();

/** Replaces text inside one footprint, found by its reference, asserting the text is present in that footprint. */
const inFootprint = (ref: string, from: string, to: string): string => {
	const start = SAMPLE_HONEST_PCB.indexOf(`(property "Reference" "${ref}"`);
	assert.ok(start >= 0, `the honest board lacks footprint ${ref}`);
	const end = SAMPLE_HONEST_PCB.indexOf("\n\t)", start);
	const block = SAMPLE_HONEST_PCB.slice(start, end);
	assert.ok(block.includes(from), `footprint ${ref} lacks: ${from}`);
	return SAMPLE_HONEST_PCB.slice(0, start) + block.replace(from, to) + SAMPLE_HONEST_PCB.slice(end);
};

const verdictFor = (text: string): Verdict => verify(spec, text, hidden);
const okOf = (v: Verdict, rule: string): boolean | undefined => v.findings.find(f => f.rule === rule)?.ok;
const parseFailed = (text: string): boolean => verdictFor(text).findings.some(f => !f.ok && f.rule === "parse");

test("roundrect-corner-gap: a roundrect pad on the board fails the parse, since its corner ratio is not modelled", () => {
	const text = inFootprint("R1", '(pad "2" smd rect', '(pad "2" smd roundrect (roundrect_rratio 0.5)');
	assert.equal(parseFailed(text), true);
	assert.equal(verdictFor(text).pass, false);
});

test("roundrect-corner-gap: a roundrect pad in the spec is refused, not approximated as a rectangle", () => {
	const raw = JSON.parse(SAMPLE_SPEC_JSON) as { parts: { ref: string; pads: { name: string; shape: string }[] }[] };
	const r1 = raw.parts.find(p => p.ref === "R1");
	assert.ok(r1, "the spec lacks R1");
	const pad = r1.pads.find(p => p.name === "2");
	assert.ok(pad, "the spec lacks R1.2");
	pad.shape = "roundrect";
	assert.equal(validateSpec(raw).ok, false);
});

/** A one-pad board: a 40 by 25 mm outline, one oval SMD pad X1.1 on net NET at (120, 115), and the given track. */
const ovalBoard = (track: string): string => `(kicad_pcb (version 20240108) (generator "verifier-pcb-test")
	(general (thickness 1.6))
	(paper "A4")
	(layers
		(0 "F.Cu" signal)
		(31 "B.Cu" signal)
		(37 "F.SilkS" user)
		(44 "Edge.Cuts" user)
	)
	(setup (pad_to_mask_clearance 0))
	(net 0 "")
	(net 1 "NET")
	(net 2 "OTHER")
	(gr_line (start 100 100) (end 140 100) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
	(gr_line (start 140 100) (end 140 125) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
	(gr_line (start 140 125) (end 100 125) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
	(gr_line (start 100 125) (end 100 100) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
	(footprint "Test:TallOval" (layer "F.Cu") (at 120 115)
		(property "Reference" "X1" (at 0 -2 0) (layer "F.SilkS"))
		(pad "1" smd oval (at 0 0) (size 1 3) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "NET"))
	)
	${track}
)`;

/** A spec for ovalBoard: the one oval pad is the only pad in its net, and the rules are the public minimums. */
const ovalSpec = (): Spec => {
	const r = validateSpec({
		name: "tall-oval",
		board: { size: [40, 25], tolerance: 0.05 },
		parts: [
			{
				ref: "X1",
				footprint: "Test:TallOval",
				at: [120, 115],
				pads: [{ name: "1", offset: [0, 0], size: [1, 3], shape: "oval", type: "smd" }],
			},
		],
		netlist: { NET: ["X1.1"] },
		rules: { minTrackWidth: 0.2, minClearance: 0.2, minViaDrill: 0.3, minAnnularRing: 0.1, edgeClearance: 0.2, powerNets: {} },
	});
	if (!r.ok) throw new Error(r.error);
	return r.spec;
};

test("tall-oval-clearance: a 0.1 mm gap from a tall oval pad fails clearance", () => {
	// The pad's right edge is at x = 120.5 mm. The track's left edge at x = 120.6 mm leaves a true gap of 0.1 mm.
	const near = verify(ovalSpec(), ovalBoard('(segment (start 120.7 113.9) (end 120.7 114.1) (width 0.2) (layer "F.Cu") (net 2 "OTHER"))'));
	assert.equal(near.findings.some(f => !f.ok && f.rule === "parse"), false, "the fixture must parse");
	assert.equal(okOf(near, "clearance"), false);
	assert.equal(near.pass, false);
});

test("tall-oval-clearance: the same track 0.4 mm from the pad is clear, so the failure above is the gap", () => {
	const far = verify(ovalSpec(), ovalBoard('(segment (start 121 113.9) (end 121 114.1) (width 0.2) (layer "F.Cu") (net 2 "OTHER"))'));
	assert.equal(far.findings.some(f => !f.ok && f.rule === "parse"), false, "the fixture must parse");
	assert.equal(okOf(far, "clearance"), true);
});
