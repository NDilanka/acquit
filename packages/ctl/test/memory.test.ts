import assert from "node:assert/strict";
import { test } from "node:test";

test("lane waves reserve 1024 MB and floor the remaining physical memory", async () => {
	const { memoryCap } = await import(new URL("../../../.factory/skills/verify-acquit/scripts/lanes.mjs", import.meta.url).href);
	assert.equal(memoryCap(904, 500), 0);
	assert.equal(memoryCap(1024, 500), 0);
	assert.equal(memoryCap(1523, 500), 0);
	assert.equal(memoryCap(1524, 500), 1);
	assert.equal(memoryCap(2024, 500), 2);
	assert.equal(memoryCap(6024, 500), 10);
	assert.throws(() => memoryCap(2000, 0));
	assert.throws(() => memoryCap(NaN, 500));
});
