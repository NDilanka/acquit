import assert from "node:assert/strict";
import test from "node:test";
import { child, children, num, parseSexprs } from "../src/sexpr.ts";

test("reads nested lists, atoms and quoted strings", () => {
	const r = parseSexprs('(kicad_pcb (net 1 "VIN") (at 1.5 -2))');
	assert.equal(r.ok, true);
	if (!r.ok) return;
	const root = r.value[0] as readonly unknown[];
	assert.equal(root[0], "kicad_pcb");
	const net = child(root as never, "net");
	assert.deepEqual(net, ["net", "1", "VIN"]);
	assert.equal(num(child(root as never, "at"), 1), 1.5);
	assert.equal(num(child(root as never, "at"), 2), -2);
});

test("quoted strings keep spaces and escaped quotes", () => {
	const r = parseSexprs('(x "a b \\"c\\"")');
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.deepEqual(r.value[0], ["x", 'a b "c"']);
});

test("children returns every list with the head, in file order", () => {
	const r = parseSexprs("(p (pad 1) (pad 2) (other 3))");
	assert.equal(r.ok, true);
	if (!r.ok) return;
	const pads = children(r.value[0] as never, "pad");
	assert.deepEqual(pads, [
		["pad", "1"],
		["pad", "2"],
	]);
});

test("malformed input is an error value, never a throw", () => {
	for (const text of ["(((", ")", '(x "unterminated', ""]) {
		const r = parseSexprs(text);
		if (text === "") assert.equal(r.ok, true);
		else assert.equal(r.ok, false, `expected an error for ${JSON.stringify(text)}`);
	}
});
