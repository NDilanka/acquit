// Bounded execution: excessive input fails as a parse refusal rather than throwing, however large the text.

import assert from "node:assert/strict";
import test from "node:test";
import type { Verdict } from "../src/types.ts";
import { failed, fresh, run } from "./fixtures.ts";

test("excessive waypoint list returns failure instead of RangeError", () => {
	// The historical RangeError: 135,010 waypoints reached an argument-spread Math.max. The item limit refuses the
	// mission first, and the extrema are iterative now too, so nothing in the path can overflow the stack.
	const p = fresh();
	const last = p.mission.items.at(-1);
	p.mission.items = p.mission.items.concat(Array(135000).fill(structuredClone(last)));
	let verdict: Verdict | undefined;
	assert.doesNotThrow(() => {
		verdict = run(p);
	});
	assert.ok(verdict);
	assert.equal(verdict.pass, false);
	assert.deepEqual(failed(verdict), ["parse"]);
});
