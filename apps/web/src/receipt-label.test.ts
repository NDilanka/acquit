import assert from "node:assert/strict";
import { test } from "node:test";
import { seededLabel } from "./scoping-review.ts";

test("the receipt panel labels a seeded receipt and leaves a real one unlabelled", () => {
  assert.equal(seededLabel("SEED"), "Seeded");
  assert.equal(seededLabel("JOB"), null);
});
