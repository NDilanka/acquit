// Photograph events: where the camera fires along a flight, carried from one stretch of flight to the next.

import assert from "node:assert/strict";
import test from "node:test";
import { photographs } from "../src/photos.ts";
import type { Flight, SurveyLine } from "../src/photos.ts";

const lineA: SurveyLine = { s0: -20, s1: 120, t: 30, alt: 40 };
const lineB: SurveyLine = { s0: 0, s1: 140, t: 60, alt: 40 };

/** Positions along the survey heading, rounded to a micrometre so float noise does not split them. */
function along(shots: { readonly s: number }[]): number[] {
	return shots.map(shot => Math.round(shot.s * 1e6) / 1e6);
}

test("photographs fall every trigger distance along a survey leg", () => {
	const shots = photographs([{ length: 140, trigger: 10, survey: lineA }], 1000);
	assert.ok(shots !== null);
	assert.deepEqual(along(shots), Array.from({ length: 15 }, (_, k) => -20 + 10 * k));
	assert.ok(shots.every(shot => shot.t === 30 && shot.alt === 40));
});

test("trigger phase carries across a transit and into the next leg", () => {
	const flights: Flight[] = [
		{ length: 140, trigger: 10, survey: lineA },
		{ length: 20, trigger: 10, survey: null },
		{ length: 140, trigger: 10, survey: lineB },
	];
	const shots = photographs(flights, 1000);
	assert.ok(shots !== null);
	// Leg A: 15 photographs. The 20 m transit fires at 10 m and 20 m, which earns nothing, so leg B starts 10 m in.
	assert.equal(shots.length, 15 + 14);
	assert.equal(Math.round(shots[15]!.s * 1e6) / 1e6, 10);
});

test("switching triggering off resets the phase, so the next leg starts with a photograph", () => {
	const flights: Flight[] = [
		{ length: 25, trigger: 10, survey: { s0: 0, s1: 25, t: 30, alt: 40 } },
		{ length: 1, trigger: null, survey: null },
		{ length: 25, trigger: 10, survey: { s0: 0, s1: 25, t: 60, alt: 40 } },
	];
	const shots = photographs(flights, 1000);
	assert.ok(shots !== null);
	assert.equal(shots.length, 6);
	// Without the reset, the 25 m leg would start 4 m in, carried over from the first leg.
	assert.equal(Math.round(shots[3]!.s * 1e6) / 1e6, 0);
});

test("exposures on a transit move the phase but earn no credit", () => {
	const flights: Flight[] = [
		{ length: 15, trigger: 10, survey: null },
		{ length: 20, trigger: 10, survey: { s0: 0, s1: 20, t: 30, alt: 40 } },
	];
	const shots = photographs(flights, 1000);
	assert.ok(shots !== null);
	assert.deepEqual(along(shots), [5, 15]);
});

test("a flight that would take more exposures than the limit is refused without a list", () => {
	const flight: Flight[] = [{ length: 90, trigger: 10, survey: lineA }];
	assert.ok(photographs(flight, 10) !== null);
	assert.equal(photographs(flight, 9), null);
	assert.equal(photographs([{ length: 1000, trigger: 0.5, survey: lineA }], 100), null);
});
