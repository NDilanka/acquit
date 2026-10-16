import assert from "node:assert/strict";
import test from "node:test";
import type { JobId } from "../../core/src/ids.ts";
import { coupon } from "../src/coupon.ts";
import { buildPlate } from "../src/plate.ts";
import { meshStats } from "../src/stl.ts";
import type { Box } from "../src/types.ts";
import { vec3 } from "../src/types.ts";
import { cube, toBinaryStl } from "./stl-fixture.ts";

const JOB = "job_plate01" as JobId;
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 0xff);
const PART = toBinaryStl(cube(20));
const PART_BOX: Box = { min: vec3(0, 0, 0), max: vec3(20, 20, 20) };

test("one part and its coupon: the coupon sits 5 mm past the part, and the plate is one closed solid", async () => {
	const witness = coupon(JOB, SEED);
	const plate = await buildPlate({ partStl: PART, partBox: PART_BOX, coupon: witness, quantity: 1 });
	assert.deepEqual(plate.layout.partOrigins, [[0, 0]]);
	assert.deepEqual(plate.layout.couponOrigin, [25, 0]);
	assert.deepEqual(plate.layout.couponRect, { minX: 25, minY: 0, maxX: 49, maxY: 24 });

	const stats = meshStats(plate.stl);
	assert.ok(stats.ok, "plate is a readable STL");
	if (!stats.ok) return;
	assert.equal(stats.value.watertight, true);
	assert.deepEqual(stats.value.sizeMm, [49, 24, 20]);
	const raised = witness.raisedCells.length;
	const expectedVolume = 8000 + 24 * 24 * 4 + 8 * raised;
	assert.ok(Math.abs(stats.value.volumeMm3 - expectedVolume) < 0.5, `volume ${stats.value.volumeMm3} vs ${expectedVolume}`);
});

test("two parts sit in a row, and the coupon follows them at the same 5 mm gap", async () => {
	const witness = coupon(JOB, SEED);
	const plate = await buildPlate({ partStl: PART, partBox: PART_BOX, coupon: witness, quantity: 2 });
	assert.deepEqual(plate.layout.partOrigins, [[0, 0], [25, 0]]);
	assert.deepEqual(plate.layout.couponOrigin, [50, 0]);
	const stats = meshStats(plate.stl);
	assert.ok(stats.ok && stats.value.watertight);
	if (stats.ok) assert.deepEqual(stats.value.sizeMm, [74, 24, 20]);
});

test("the plate is the same bytes for the same inputs", async () => {
	const first = await buildPlate({ partStl: PART, partBox: PART_BOX, coupon: coupon(JOB, SEED), quantity: 1 });
	const second = await buildPlate({ partStl: PART, partBox: PART_BOX, coupon: coupon(JOB, SEED), quantity: 1 });
	assert.deepEqual(Buffer.from(first.stl), Buffer.from(second.stl));
	const other = await buildPlate({ partStl: PART, partBox: PART_BOX, coupon: coupon("job_other" as JobId, SEED), quantity: 1 });
	assert.notDeepEqual(Buffer.from(first.stl), Buffer.from(other.stl));
});
