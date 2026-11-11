// The sealed checks are parsed fail-closed: a file that is missing, unreadable, or not exactly the shape is no checks at all.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Vertical } from "../src/outcome.ts";
import { independentChecksOf, parseSealedChecks, sealedChecksIn, sealedFileName } from "../src/physical.ts";

const laser = "laser-cut" as Vertical;

test("a sealed file names its vertical, and parses only the exact shape", () => {
	assert.equal(sealedFileName(laser), "laser-cut.sealed.json");
	assert.deepEqual(parseSealedChecks({ keepMaterialMm: [[1, 2]], voidMm: [[3, 4]], clearanceMm: 0.2 }),
		{ keepMaterialMm: [[1, 2]], voidMm: [[3, 4]], clearanceMm: 0.2 });
	// Void points are optional; a file with only kept points is a valid set.
	assert.deepEqual(parseSealedChecks({ keepMaterialMm: [[1, 2]] }), { keepMaterialMm: [[1, 2]], voidMm: [] });
});

test("anything that is not a complete sealed set parses to null", () => {
	const bad: unknown[] = [
		null, [], "laser", 7,
		{},
		{ keepMaterialMm: [] },
		{ keepMaterialMm: [[1]] },
		{ keepMaterialMm: [[1, 2, 3]] },
		{ keepMaterialMm: [["1", 2]] },
		{ keepMaterialMm: [[Infinity, 2]] },
		{ keepMaterialMm: [[1, 2]], voidMm: "none" },
		{ keepMaterialMm: [[1, 2]], clearanceMm: -1 },
		{ keepMaterialMm: [[1, 2]], clearanceMm: "0.2" },
		{ keepMaterialMm: Array.from({ length: 257 }, (_, index) => [index, index]) },
	];
	for (const value of bad) assert.equal(parseSealedChecks(value), null, JSON.stringify(value));
});

test("the checks run one per point, kept points first, and the clearance travels with the kept ones", () => {
	const checks = independentChecksOf({ keepMaterialMm: [[1, 1], [2, 2]], voidMm: [[9, 9]], clearanceMm: 0.25 });
	assert.deepEqual(checks, [
		{ keepMaterialMm: [[1, 1]], clearanceMm: 0.25 },
		{ keepMaterialMm: [[2, 2]], clearanceMm: 0.25 },
		{ keepMaterialMm: [], voidMm: [[9, 9]] },
	]);
});

test("a vertical's sealed file is read from its directory, and a missing or broken one is null", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-sealed-"));
	try {
		assert.equal(sealedChecksIn("", laser), null, "no directory configured");
		assert.equal(sealedChecksIn(dir, laser), null, "no file yet");
		await writeFile(join(dir, sealedFileName(laser)), "{ not json");
		assert.equal(sealedChecksIn(dir, laser), null, "a file that is not JSON");
		await writeFile(join(dir, sealedFileName(laser)), JSON.stringify({ keepMaterialMm: [[1, 2]] }));
		assert.deepEqual(sealedChecksIn(dir, laser), { keepMaterialMm: [[1, 2]], voidMm: [] });
		await writeFile(join(dir, sealedFileName(laser)), JSON.stringify({ voidMm: [[1, 2]] }));
		assert.equal(sealedChecksIn(dir, laser), null, "a file with no kept points");
	} finally { await rm(dir, { recursive: true, force: true }); }
});
