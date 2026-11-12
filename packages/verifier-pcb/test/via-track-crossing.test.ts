import assert from "node:assert/strict";
import test from "node:test";
import { boardText, part, smdPad, specOf, thruPad, type Fixture } from "./synthetic-board.ts";
import { verify } from "../src/verify.ts";
import type { Verdict } from "../src/types.ts";

// A track of a via's own net may run straight across the via's drill, with both ends outside the drill: the drill
// cuts it in two, and each half still meets the via's copper round the bore. Every other crossing still fails the
// parse: another net's track, a net 0 track, a track inside the drill, a track across a pad's own drill, and a via
// over a pad. Each board is synthetic: the copper is raw KiCad text, so the net numbers are the ones written. Net 1 is
// the first name the fixture lists, which is the pad net "A".

const A = 1;

const base: Fixture = {
	parts: [part("J1", [110, 110], smdPad("1", "A"), smdPad("2", "A", [1, 1], [10, 0]))],
};

/** The fixture's board with raw copper lines added before its closing parenthesis. */
function withCopper(f: Fixture, lines: readonly string[]): string {
	const text = boardText(f);
	return text.slice(0, text.lastIndexOf(")")) + lines.map(l => `\t${l}\n`).join("") + ")";
}

const verdict = (f: Fixture, lines: readonly string[]): Verdict => verify(specOf(f), withCopper(f, lines));
const parseMessage = (v: Verdict): string | undefined => v.findings.find(x => !x.ok && x.rule === "parse")?.message;

const seg = (x1: number, y1: number, x2: number, y2: number, net: number, width = 0.25): string =>
	`(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width ${width}) (layer "F.Cu") (net ${net}))`;
const via = (x: number, y: number, net: number, size = 0.6, drill = 0.3): string =>
	`(via (at ${x} ${y}) (size ${size}) (drill ${drill}) (layers "F.Cu" "B.Cu") (net ${net}))`;

test("a same-net track that runs straight through a via's drill passes the board", () => {
	const v = verdict(base, [seg(110, 110, 120, 110, A), via(115, 110, A)]);
	assert.equal(parseMessage(v), undefined);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("the same track split at the via's centre passes the board", () => {
	const v = verdict(base, [seg(110, 110, 115, 110, A), seg(115, 110, 120, 110, A), via(115, 110, A)]);
	assert.equal(parseMessage(v), undefined);
	assert.equal(v.pass, true, JSON.stringify(v.findings.filter(f => !f.ok)));
});

test("a same-net track that crosses the drill off-centre passes the parse", () => {
	const v = verdict(base, [seg(110, 109.9, 120, 109.9, A), via(115, 110, A)]);
	assert.equal(parseMessage(v), undefined);
});

test("a same-net track whose rounded tip reaches the drill's edge fails the parse", () => {
	// The tip's round end, 0.125 mm past the endpoint, reaches x = 114.85, the drill's edge: a touch the checker refuses.
	const v = verdict(base, [seg(110, 110, 114.725, 110, A), via(115, 110, A)]);
	assert.equal(v.pass, false);
	assert.match(parseMessage(v) ?? "", /the via at \(115\.00, 110\.00\) cuts into a track/);
});

test("the same rounded tip moved 0.001 mm outward passes the parse", () => {
	const v = verdict(base, [seg(110, 110, 114.724, 110, A), via(115, 110, A)]);
	assert.equal(parseMessage(v), undefined);
});

test("a track of another net that runs through the via's drill fails the parse", () => {
	const v = verdict(base, [seg(110, 110, 120, 110, A), via(115, 110, 2)]);
	assert.equal(v.pass, false);
	assert.match(parseMessage(v) ?? "", /the via at \(115\.00, 110\.00\) cuts into a track/);
});

test("a net 0 track through a net 0 via's drill fails the parse, because net 0 is no net", () => {
	const v = verdict(base, [seg(110, 110, 120, 110, 0), via(115, 110, 0)]);
	assert.equal(v.pass, false);
	assert.ok(parseMessage(v) !== undefined, "net 0 must not count as the via's own net");
});

test("a same-net stub that lies inside the drill fails the parse, since nothing outside it reaches the copper", () => {
	const v = verdict(base, [seg(114.9, 110, 115.05, 110, A), via(115, 110, A)]);
	assert.equal(v.pass, false);
	assert.ok(parseMessage(v) !== undefined, "a stub wholly inside the drill must fail the parse");
});

test("a same-net track that runs across a through-hole pad's own drill still fails the parse", () => {
	// Only a via's copper is a whole ring round its drill, so a pad's own drill may not be crossed by a track.
	const withPad: Fixture = {
		parts: [...base.parts, part("J2", [125, 110], thruPad("1", "A", [1.7, 1.7], 1))],
	};
	const v = verdict(withPad, [seg(121, 110, 129, 110, A)]);
	assert.equal(v.pass, false);
	assert.match(parseMessage(v) ?? "", /the drill of pad J2\.1 cuts into a track/);
});

test("a same-net via over a same-net SMD land still fails the parse, since via-in-pad is refused", () => {
	const v = verdict(base, [via(110, 110, A)]);
	assert.equal(v.pass, false);
	assert.match(parseMessage(v) ?? "", /the via at \(110\.00, 110\.00\) cuts into pad J1\.1/);
});

test("two same-net vias 0.46 mm apart pass the parse; 0.4 mm apart fail", () => {
	assert.equal(parseMessage(verdict(base, [via(130, 114, A), via(130.46, 114, A)])), undefined);
	const close = parseMessage(verdict(base, [via(130, 114, A), via(130.4, 114, A)]));
	assert.match(close ?? "", /cuts into the via at \(130\.40, 114\.00\)/);
});
