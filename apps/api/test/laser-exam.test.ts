// The laser exam on a deployment: closed while physical jobs are off, unbuilt without readable sealed checks, and otherwise
// a simulated run whose counts are the public rules and the sealed checks. No sealed coordinate or check name leaves the file.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LASER_PUBLIC_RULES, sealedFileName } from "../../../packages/core/src/physical.ts";
import { LASER_VERTICAL } from "../../../packages/core/src/code-manifest.ts";
import { laserExamFor } from "../src/specialists.ts";

const sealed = { keepMaterialMm: [[12.5, 40], [60, 8.25]], voidMm: [[3, 3]] };

test("the laser exam is closed while physical jobs are off, whatever the directory holds", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-laser-exam-"));
	try {
		await writeFile(join(dir, sealedFileName(LASER_VERTICAL)), JSON.stringify(sealed));
		assert.equal(laserExamFor(false, dir), "CLOSED");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("the laser exam is unbuilt when the sealed checks cannot be read", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-laser-exam-"));
	try {
		assert.equal(laserExamFor(true, dir), "UNBUILT", "no file");
		assert.equal(laserExamFor(true, ""), "UNBUILT", "no directory configured");
		await writeFile(join(dir, sealedFileName(LASER_VERTICAL)), "{ broken");
		assert.equal(laserExamFor(true, dir), "UNBUILT", "a malformed file");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("the laser exam counts the public rules and the sealed checks, and names no check", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-laser-exam-"));
	try {
		await writeFile(join(dir, sealedFileName(LASER_VERTICAL)), JSON.stringify(sealed));
		const exam = laserExamFor(true, dir);
		const publicCount = LASER_PUBLIC_RULES.length;
		const hiddenCount = sealed.keepMaterialMm.length + sealed.voidMm.length;
		assert.deepEqual(exam, { visible: { passed: publicCount, total: publicCount }, hidden: { passed: hiddenCount, total: hiddenCount } });
		// The hidden count is a number of checks, never a check's coordinates or the file's names.
		const text = JSON.stringify(exam);
		assert.equal(text.includes("keepMaterialMm"), false);
		assert.equal(text.includes("12.5"), false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
