import assert from "node:assert/strict";
import test from "node:test";
import { readBoard } from "../src/board.ts";
import { SAMPLE_HONEST_PCB } from "../src/samples.ts";

// KiCad writes a track or via net as a bare number, and a pad net as a bare number followed by a quoted name. A quoted
// atom in the number position is a string, not a net number, so a track, via, or pad that quotes its number fails the
// parse. A quoted net name is still a name: a pad may name a net "4" while its number stays bare.

const withRecord = (record: string): string => SAMPLE_HONEST_PCB.replace(/\)\s*$/, `${record}\n)`);

const SEG = '(segment (start 122.95 110) (end 127.95 110) (width 0.25) (layer "F.Cu") (net "4"))';
const VIA = '(via (at 145 110) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "5"))';
const FP =
	'(footprint "Test:P" (layer "F.Cu") (at 150 100) (property "Reference" "X1") ' +
	'(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net "1" "VIN")))';

test("a track that quotes its net number fails the parse", () => {
	const board = readBoard(withRecord(SEG));
	assert.equal(board.ok, false, SEG);
	assert.ok(board.error?.includes("(segment) has a quoted net number"), String(board.error));
});

test("a via that quotes its net number fails the parse", () => {
	const board = readBoard(withRecord(VIA));
	assert.equal(board.ok, false, VIA);
	assert.ok(board.error?.includes("(via) has a quoted net number"), String(board.error));
});

test("a pad that quotes its net number fails the parse", () => {
	const board = readBoard(withRecord(FP));
	assert.equal(board.ok, false, FP);
	assert.ok(board.error?.includes("pad 1 on X1 has a quoted net number"), String(board.error));
});

test("a track with a bare net number still parses", () => {
	const board = readBoard(withRecord(SEG.replace('(net "4")', "(net 4)")));
	assert.equal(board.ok, true, String(board.error));
});

test("a pad with a bare net number and a quoted name that looks like a number still parses", () => {
	const board = readBoard(withRecord(FP.replace('(net "1" "VIN")', '(net 4 "4")')));
	assert.equal(board.ok, true, String(board.error));
});
