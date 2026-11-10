import assert from "node:assert/strict";
import test from "node:test";
import { validateSpec } from "../src/spec.ts";
import { SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { Verdict } from "../src/types.ts";

// Acceptance tests: a board that carries copper, zones, or structures outside the supported subset must not be
// accepted. Anything the checker does not model must fail closed as a parse finding (or a named rule for zones).

const spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const STROKE = "(stroke (width 0.2) (type default))";

const verdictOf = (text: string): Verdict => verify(spec, text);
const failedRules = (text: string): string[] => verdictOf(text).findings.filter(f => !f.ok).map(f => f.rule);
const parseFailed = (text: string): boolean => verdictOf(text).findings.some(f => !f.ok && f.rule === "parse");

/** Inserts one item as the first child of the board root. */
const onRoot = (item: string): string => SAMPLE_HONEST_PCB.replace("(kicad_pcb ", `(kicad_pcb ${item} `);
/** Inserts one item as the first child of the first footprint (J1). */
const onFootprint = (item: string): string => SAMPLE_HONEST_PCB.replace(/\(footprint "[^"]*"/, m => `${m} ${item}`);

const ZONE = '(zone (net 2) (net_name "GND") (layer "F.Cu") (polygon (pts (xy 100 100) (xy 110 100) (xy 110 110))))';

test("the honest board still passes before any acceptance rule is tested", () => {
	assert.equal(verdictOf(SAMPLE_HONEST_PCB).pass, true);
});

test("copper graphics on any copper or inner layer are rejected, not ignored", () => {
	for (const layer of ["F.Cu", "B.Cu", "In1.Cu", "F.Mask"]) {
		const item = `(gr_line (start 120 110) (end 125 110) ${STROKE} (layer "${layer}"))`;
		assert.equal(parseFailed(onRoot(item)), true, `gr_line on ${layer} must be a parse failure`);
		assert.equal(verdictOf(onRoot(item)).pass, false);
	}
});

test("copper graphics inside a footprint are rejected", () => {
	const item = `(fp_line (start 0 0) (end 1 0) ${STROKE} (layer "F.Cu"))`;
	assert.equal(parseFailed(onFootprint(item)), true);
	assert.equal(verdictOf(onFootprint(item)).pass, false);
});

test("a footprint outline on Edge.Cuts is rejected", () => {
	const item = `(fp_rect (start 0 0) (end 2 2) ${STROKE} (layer "Edge.Cuts"))`;
	assert.equal(parseFailed(onFootprint(item)), true);
	assert.equal(verdictOf(onFootprint(item)).pass, false);
});

test("a zone at the root, in a footprint, or in a pad fails the no-zones rule", () => {
	assert.ok(failedRules(onRoot(ZONE)).includes("no-zones"));
	assert.ok(failedRules(onFootprint(ZONE)).includes("no-zones"));
	const inPad = SAMPLE_HONEST_PCB.replace(
		'(pad "1" smd rect (at -1 -0.95)',
		`(pad "1" smd rect (at -1 -0.95) ${ZONE}`,
	);
	assert.notEqual(inPad, SAMPLE_HONEST_PCB);
	assert.ok(failedRules(inPad).includes("no-zones"));
});

test("a zone inside an unknown container fails the verdict", () => {
	assert.equal(verdictOf(onRoot(`(group (name "g") ${ZONE})`)).pass, false);
});

test("custom pad primitives are rejected", () => {
	const custom =
		'(pad "9" smd custom (at 0 0) (size 1 1) (layers "F.Cu") (primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0) (fill yes))) (net 1 "VIN"))';
	const text = SAMPLE_HONEST_PCB.replace(/\(footprint "Package_TO_SOT_SMD:SOT-23"[^\n]*/, m => `${m} ${custom}`);
	assert.notEqual(text, SAMPLE_HONEST_PCB);
	assert.equal(parseFailed(text), true);
});

test("tracks on an inner layer are rejected", () => {
	const seg = '(segment (start 110 110) (end 115 110) (width 0.2) (layer "In1.Cu") (net 1 "VIN"))';
	assert.equal(parseFailed(onRoot(seg)), true);
});

test("a segment nested in an unknown container is rejected", () => {
	const seg = '(segment (start 110 110) (end 115 110) (width 0.2) (layer "F.Cu") (net 1 "VIN"))';
	assert.equal(parseFailed(onRoot(`(group (name "g") ${seg})`)), true);
});

test("a footprint placed on the back layer is rejected until back-side mirroring is supported", () => {
	const text = SAMPLE_HONEST_PCB.replace('(footprint "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" (layer "F.Cu")', '(footprint "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" (layer "B.Cu")');
	assert.notEqual(text, SAMPLE_HONEST_PCB);
	assert.equal(parseFailed(text), true);
});

test("harmless silkscreen graphics are still accepted", () => {
	const note = '(gr_text "BUILD 1" (at 110 98) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))';
	assert.equal(verdictOf(onRoot(note)).pass, true);
});
