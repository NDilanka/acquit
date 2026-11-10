import assert from "node:assert/strict";
import test from "node:test";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_FRAUDS, SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Spec, Verdict } from "../src/types.ts";

// Where the camera points. A public failure carries the `at` of what it blames; a hidden finding never does,
// because its position would name the hidden probe or clearance point. The scene never carries probe data either.

const spec: Spec = (() => {
	const r = validateSpec(JSON.parse(SAMPLE_SPEC_JSON));
	if (!r.ok) throw new Error(r.error);
	return r.spec;
})();

const hidden: HiddenSample = (() => {
	const r = validateHidden(JSON.parse(SAMPLE_HIDDEN_JSON), spec);
	if (!r.ok) throw new Error(r.error);
	return r.hidden;
})();

// Each fraud and the public rule it breaks. fraud-10 breaks only a hidden rule, so it is not in this list.
const PUBLIC_FRAUDS: readonly { id: string; rule: string }[] = [
	{ id: "fraud-01-unrouted-net", rule: "connected" },
	{ id: "fraud-02-shorted-nets", rule: "no-shorts" },
	{ id: "fraud-03-power-thin", rule: "power-width" },
	{ id: "fraud-04-clearance-0.1", rule: "clearance" },
	{ id: "fraud-05-via-drill", rule: "via-rules" },
	{ id: "fraud-06-outside-edge", rule: "inside-board" },
	{ id: "fraud-07-pad-moved", rule: "parts-placed" },
	{ id: "fraud-08-track-misses-pad", rule: "connected" },
	{ id: "fraud-09-wrong-pad-net", rule: "pad-nets" },
	{ id: "fraud-11-bore-cut", rule: "clearance" },
];

const verdictOf = (text: string, h?: HiddenSample): Verdict => verify(spec, text, h);

test("no hidden finding ever carries a position, on any sample board", () => {
	const boards = [SAMPLE_HONEST_PCB, ...Object.values(SAMPLE_FRAUDS)];
	for (const text of boards) {
		const v = verdictOf(text, hidden);
		for (const f of v.findings) {
			if (f.hidden) assert.equal(f.at, undefined, `${f.rule} must not carry a position: ${f.message}`);
		}
	}
});

test("the scene carries no probe data, even when a hidden probe fails", () => {
	for (const text of [SAMPLE_HONEST_PCB, SAMPLE_FRAUDS["fraud-01-unrouted-net"] as string]) {
		const v = verdictOf(text, hidden);
		assert.equal("probes" in v.scene, false, "the scene must not have a probes field");
		assert.equal(JSON.stringify(v.scene).includes('"probes"'), false);
		assert.equal(v.scene.paths.some(p => p.id.startsWith("probe")), false);
	}
});

for (const { id, rule } of PUBLIC_FRAUDS) {
	test(`the ${rule} failure on ${id} carries a position`, () => {
		const v = verdictOf(SAMPLE_FRAUDS[id] as string, hidden);
		const f = v.findings.find(x => !x.ok && x.rule === rule);
		assert.ok(f, `${id} must fail ${rule}`);
		assert.ok(f.at !== undefined, `${rule} must say where to point the camera`);
		assert.equal(f.at.length, 3);
	});
}

test("an outline of the wrong size points at the outline's corner", () => {
	const raw = JSON.parse(SAMPLE_SPEC_JSON) as { board: { size: number[] } };
	raw.board.size = [raw.board.size[0] + 5, raw.board.size[1]];
	const r = validateSpec(raw);
	assert.ok(r.ok);
	const f = verify(r.spec, SAMPLE_HONEST_PCB).findings.find(x => !x.ok && x.rule === "outline");
	assert.ok(f, "the wrong size must fail the outline rule");
	assert.ok(f.at !== undefined, "a size mismatch knows the outline's corner");
});

test("a part missing from the board points at the spec's placement", () => {
	const raw = JSON.parse(SAMPLE_SPEC_JSON) as { parts: Record<string, unknown>[] };
	const j1 = raw.parts.find(p => p.ref === "J1");
	assert.ok(j1);
	raw.parts.push({ ref: "J9", footprint: "Test:Missing", at: [110, 100], pads: j1.pads });
	const r = validateSpec(raw);
	assert.ok(r.ok);
	const f = verify(r.spec, SAMPLE_HONEST_PCB).findings.find(x => !x.ok && x.rule === "parts-placed");
	assert.ok(f, "a missing part must fail parts-placed");
	assert.match(f.message, /J9/);
	assert.deepEqual(f.at, [110, 100, 1.6]);
});

test("a board-wide parse failure has no position to point at", () => {
	const f = verdictOf("this is not a board").findings.find(x => !x.ok && x.rule === "parse");
	assert.ok(f, "garbage must fail the parse");
	assert.equal(f.at, undefined);
});

test("a copper zone failure has no single position to point at", () => {
	const zone = '(zone (net 2) (net_name "GND") (layer "F.Cu") (polygon (pts (xy 100 100) (xy 110 100) (xy 110 110))))';
	const f = verdictOf(SAMPLE_HONEST_PCB.replace("(kicad_pcb ", `(kicad_pcb ${zone} `)).findings.find(
		x => !x.ok && x.rule === "no-zones",
	);
	assert.ok(f, "a copper zone must fail no-zones");
	assert.equal(f.at, undefined);
});
