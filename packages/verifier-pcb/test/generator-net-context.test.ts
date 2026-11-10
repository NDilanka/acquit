import assert from "node:assert/strict";
import test from "node:test";
import { validateHidden, validateSpec } from "../src/spec.ts";
import { SAMPLE_HIDDEN_JSON, SAMPLE_HONEST_PCB, SAMPLE_SPEC_JSON } from "../src/samples.ts";
import { verify } from "../src/verify.ts";
import type { HiddenSample, Spec, Verdict } from "../src/types.ts";

// KiCad 8 writes a track or via net as one numeric code, (net 4). A pad writes its net as a code and a name,
// (net 4 "LED_A"). A track or via that carries a name is not KiCad 8 syntax, so the checker must refuse it with a
// parse finding that names the construct, not read the name and carry on.

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

const verdictFor = (text: string): Verdict => verify(spec, text, hidden);
const parseFindings = (text: string): string[] =>
	verdictFor(text)
		.findings.filter(f => !f.ok && f.rule === "parse")
		.map(f => f.message);

/**
 * The honest board with one textual change on each line that starts with the given prefix and contains `from`.
 * Asserts that at least one line changed, so a variant never passes because it touched nothing.
 */
function onLines(prefix: string, from: string, to: string): string {
	let changed = 0;
	const out = SAMPLE_HONEST_PCB.split("\n").map(line => {
		if (!line.trimStart().startsWith(prefix) || !line.includes(from)) return line;
		changed++;
		return line.replace(from, to);
	});
	assert.ok(changed > 0, `no ${prefix} line contains: ${from}`);
	return out.join("\n");
}

test("generator-net-context: every track and via names its net by one numeric code", () => {
	const lines = SAMPLE_HONEST_PCB.split("\n").filter(line => /^\s*\((segment|via) /.test(line));
	assert.ok(lines.length > 0, "the honest board has tracks and vias");
	for (const line of lines) {
		const net = line.match(/\(net ([^)]*)\)/);
		assert.ok(net, `track or via has no (net ...) form: ${line.trim()}`);
		assert.match(net[1] ?? "", /^\d+$/, `track or via net must be one numeric code: ${line.trim()}`);
	}
});

test("generator-net-context: every pad names its net by a numeric code and a quoted name", () => {
	const pads = SAMPLE_HONEST_PCB.split("\n").filter(line => /^\s*\(pad /.test(line) && line.includes("(net "));
	assert.ok(pads.length > 0, "the honest board has connected pads");
	for (const line of pads) {
		assert.match(line, /\(net \d+ "[^"]*"\)/, `pad net must be a code and a quoted name: ${line.trim()}`);
	}
});

test("generator-net-context: the honest board with numeric track nets passes", () => {
	const v = verdictFor(SAMPLE_HONEST_PCB);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok).map(f => f.message)));
});

test("generator-net-context: a segment with a quoted net name fails the parse and names the segment", () => {
	const text = onLines("(segment ", "(net 4)", '(net 4 "LED_A")');
	const messages = parseFindings(text);
	assert.ok(messages.length > 0, "a segment with a quoted net name must fail the parse");
	assert.ok(messages.some(m => m.includes("(segment)")), `the finding must name the segment: ${messages.join("; ")}`);
});

test("generator-net-context: a via with a quoted net name fails the parse and names the via", () => {
	const text = onLines("(via ", "(net 2)", '(net 2 "GND")');
	const messages = parseFindings(text);
	assert.ok(messages.length > 0, "a via with a quoted net name must fail the parse");
	assert.ok(messages.some(m => m.includes("(via)")), `the finding must name the via: ${messages.join("; ")}`);
});

test("generator-net-context: a pad with a bare net code and no name fails the parse and names the pad", () => {
	const text = onLines("(pad ", '(net 1 "VIN")', "(net 1)");
	const messages = parseFindings(text);
	assert.ok(messages.length > 0, "a pad with no net name must fail the parse");
	assert.ok(messages.some(m => m.includes("pad ")), `the finding must name the pad: ${messages.join("; ")}`);
});
