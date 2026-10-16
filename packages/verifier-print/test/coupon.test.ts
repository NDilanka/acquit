import assert from "node:assert/strict";
import test from "node:test";
import type { JobId } from "../../core/src/ids.ts";
import { coupon } from "../src/coupon.ts";

const JOB = "job_coupon01" as JobId;
const SEED_A = Uint8Array.from({ length: 32 }, (_, i) => i);
const SEED_B = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

test("the same job and seed give the same coupon", () => {
	assert.deepEqual(coupon(JOB, SEED_A), coupon(JOB, SEED_A));
});

test("two seeds give different markers and different cells", () => {
	const a = coupon(JOB, SEED_A);
	const b = coupon(JOB, SEED_B);
	assert.notEqual(a.markerId, b.markerId);
	assert.notDeepEqual(a.markerCells, b.markerCells);
});

// The derivation is pinned on purpose. Changing it changes every coupon already printed for a job.
// 52151 is 0xCBB7. Its low nibble 0111 gives the first row 1110, and its top nibble 1100 gives the last row 0011.
test("the marker id and first raised cell are pinned for the fixed seed", () => {
	const c = coupon(JOB, SEED_A);
	assert.equal(c.markerId, 52151);
	assert.equal(c.raisedCells.length, 11);
	assert.deepEqual(c.raisedCells[0], { min: [8, 8, 4], max: [10, 10, 6] });
});

test("marker ids stay in 1 to 65535 across many seeds", () => {
	for (let n = 0; n < 50; n++) {
		const seed = Uint8Array.from({ length: 16 }, (_, i) => (n * 31 + i) & 0xff);
		const { markerId } = coupon(JOB, seed);
		assert.ok(markerId >= 1 && markerId <= 65535, `seed ${n} gave ${markerId}`);
	}
});

test("each cell is the bit of the marker id at its position, and raised cells are listed", () => {
	const c = coupon(JOB, SEED_A);
	c.markerCells.forEach((row, r) => row.forEach((raised, col) => {
		assert.equal(raised, ((c.markerId >> (r * 4 + col)) & 1) === 1);
	}));
	const raised = c.markerCells.flat().filter(Boolean).length;
	assert.equal(c.raisedCells.length, raised);
	assert.deepEqual(c.tileMm, [24, 24, 4]);
});

test("each raised cell is 2 by 2 mm and stands 2 mm above the tile top", () => {
	const c = coupon(JOB, SEED_A);
	assert.ok(c.raisedCells.length > 0);
	for (const box of c.raisedCells) {
		assert.equal(box.max[0] - box.min[0], 2);
		assert.equal(box.max[1] - box.min[1], 2);
		assert.equal(box.min[2], 4);
		assert.equal(box.max[2], 6);
	}
});
