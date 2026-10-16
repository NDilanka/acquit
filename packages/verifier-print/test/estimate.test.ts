import assert from "node:assert/strict";
import test from "node:test";
import { estimateTime, trapezoidSeconds } from "../src/estimate.ts";
import { parseGcode } from "../src/gcode.ts";
import { mmPerSecond, mmPerSecondSquared } from "../src/types.ts";
import type { ParsedGcode, PrinterLimits } from "../src/types.ts";

const LIMITS: PrinterLimits = { accelMmPerSec2: mmPerSecondSquared(1000), maxFeedMmPerSec: mmPerSecond(200) };

function parsed(text: string): ParsedGcode {
	const result = parseGcode(text);
	if (!result.ok) throw new Error("fixture G-code is refused");
	return result.value;
}

test("a 2 mm move at 100 mm/s never reaches cruise, so it takes 2 * sqrt(L / a)", () => {
	assert.ok(Math.abs(trapezoidSeconds(2, 100, 1000) - 0.0894427191) < 1e-9);
});

test("a 100 mm move at 100 mm/s accelerates 5 mm, cruises 90 mm, decelerates 5 mm, and takes 1.1 s", () => {
	assert.ok(Math.abs(trapezoidSeconds(100, 100, 1000) - 1.1) < 1e-9);
});

// Three moves, hand-timed at a = 1000 mm/s^2 and a 200 mm/s cap:
//   100 mm at 100 mm/s (F6000): 1.1 s
//   2 mm at 100 mm/s (F6000):   2 * sqrt(2 / 1000) = 0.0894427191 s
//   100 mm at 500 requested, capped to 200 (F30000): 2 * 200 / 1000 + (100 - 40) / 200 = 0.7 s
// Total 1.8894427191 s. The estimate is the at-rest time, so it sits above the cruise-only time of 1.52 s.
test("the estimate matches the hand-timed move list within 1e-6 s", () => {
	const g = parsed(["G21", "G90", "G1 X100 F6000", "G1 Y2 F6000", "G1 X0 Y2 E1 F30000"].join("\n"));
	const estimate = estimateTime(g, LIMITS);
	assert.ok(Math.abs(estimate.totalSeconds - 1.8894427191) < 1e-6, `total was ${estimate.totalSeconds}`);
	assert.ok(Math.abs(estimate.layers[0].seconds - 0.7) < 1e-6, `layer 0 was ${estimate.layers[0].seconds}`);
	assert.equal(estimate.layers.length, 1);
});

test("the estimate never falls below the cruise-only time, distance over the capped feedrate", () => {
	const cruiseOnly = 100 / 100 + 2 / 100 + 100 / 200;
	const estimate = estimateTime(parsed(["G21", "G90", "G1 X100 F6000", "G1 Y2 F6000", "G1 X0 Y2 E1 F30000"].join("\n")), LIMITS);
	assert.ok(estimate.totalSeconds >= cruiseOnly - 1e-9);
});

test("a move with no F word uses the machine's max feedrate", () => {
	const estimate = estimateTime(parsed("G21\nG90\nG1 X100"), LIMITS);
	assert.ok(Math.abs(estimate.totalSeconds - trapezoidSeconds(100, 200, 1000)) < 1e-9);
});
