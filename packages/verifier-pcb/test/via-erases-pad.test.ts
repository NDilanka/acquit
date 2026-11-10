import assert from "node:assert/strict";
import test from "node:test";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Verdict } from "../src/types.ts";

// A plated bore, a via's drill or a plated pad's drill, removes the copper inside it. No other item may reach into it,
// whatever its net. A track may end at a bore's centre only as the wiring of that via or pad. Each board here is the
// honest board with one change.

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

const LED_RUN = '(segment (start 122.95 103) (end 127.95 103) (width 0.25) (layer "F.Cu") (net 4))';

/** Replaces one honest item, asserting the item is present so a test never passes on an unchanged board. */
const edit = (from: string, to: string): string => {
	assert.ok(SAMPLE_HONEST_PCB.includes(from), `the honest board lacks: ${from}`);
	return SAMPLE_HONEST_PCB.replace(from, to);
};

const verdictFor = (text: string): Verdict => verify(spec, text, hidden);
const parseMessage = (v: Verdict): string | undefined => v.findings.find(f => !f.ok && f.rule === "parse")?.message;

const viaText = (at: readonly [number, number], size: number, drill: number, net: number): string =>
	`(via (at ${at[0]} ${at[1]}) (size ${size}) (drill ${drill}) (layers "F.Cu" "B.Cu") (net ${net}))`;

// The delivered board: a 2 mm via whose 1.7 mm bore removes the 0.6 by 0.7 mm 3V3 pad U1.3 at (113, 106).
test("a via drill that removes the U1.3 pad fails the parse and names the pad", () => {
	const v = verdictFor(edit(LED_RUN, `${LED_RUN} ${viaText([113, 106], 2, 1.7, 3)}`));
	assert.equal(v.pass, false);
	const message = parseMessage(v);
	assert.ok(message !== undefined, "the board must fail the parse");
	assert.match(message, /U1\.3/);
});

// Each other pad the bore may remove, at its own centre. A bore covering the pad fails whatever the pad's net is.
type Case = {
	readonly pad: string;
	readonly at: readonly [number, number];
	readonly size: number;
	readonly drill: number;
	readonly net: number;
};
const cases: readonly Case[] = [
	{ pad: "U1.1", at: [111, 105.05], size: 1.3, drill: 1, net: 1 },
	{ pad: "U1.2", at: [111, 106.95], size: 1.3, drill: 1, net: 2 },
	{ pad: "C1.1", at: [107.05, 112], size: 2, drill: 1.7, net: 1 },
];

for (const c of cases) {
	test(`a via drill that removes the ${c.pad} pad fails the parse`, () => {
		const v = verdictFor(edit(LED_RUN, `${LED_RUN} ${viaText(c.at, c.size, c.drill, c.net)}`));
		assert.equal(v.pass, false);
		const message = parseMessage(v);
		assert.ok(message !== undefined, `the board with a via over ${c.pad} must fail the parse`);
		assert.ok(message.includes(c.pad), `the parse failure must name ${c.pad}: ${message}`);
	});
}

test("a track that runs through a via's drill, rather than ending in it, fails the parse", () => {
	// The LED track runs along y = 103. A via centred on it at x = 125 has its bore across the track's middle.
	const v = verdictFor(edit(LED_RUN, `${LED_RUN} ${viaText([125, 103], 0.6, 0.3, 4)}`));
	assert.equal(v.pass, false);
	assert.ok(parseMessage(v) !== undefined, "a track cut by a via drill must fail the parse");
});

test("a via on the end of its own track is wired through its bore and passes the parse", () => {
	const v = verdictFor(edit(LED_RUN, `${LED_RUN} ${viaText([127.95, 103], 0.6, 0.3, 4)}`));
	assert.equal(parseMessage(v), undefined);
});

test("a through-hole pad's own drill passes when its own track ends at the pad's centre", () => {
	// J1.1 is a 1 mm drilled pad at (102, 106) on VIN (net 1). The track runs from its centre out past the bore.
	const track = "(segment (start 102 106) (end 104 106) (width 0.25) (layer \"F.Cu\") (net 1))";
	const v = verdictFor(edit(LED_RUN, `${LED_RUN} ${track}`));
	assert.equal(parseMessage(v), undefined);
});
