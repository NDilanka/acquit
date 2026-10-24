import assert from "node:assert/strict";
import { test } from "node:test";
import { PITCH_MAX, pitchProblem } from "./bid-rules.ts";

test("the pitch limit is the server's 2000 characters", () => {
  assert.equal(PITCH_MAX, 2000);
});

test("a blank or whitespace-only pitch is refused, as the server refuses it", () => {
  const message = "Write a pitch: one sentence on how the work will be done.";
  assert.equal(pitchProblem(""), message);
  assert.equal(pitchProblem("   \n  "), message);
});

test("a pitch of exactly 2000 characters passes, and one more is refused", () => {
  assert.equal(pitchProblem("x".repeat(2000)), null);
  assert.equal(pitchProblem("x".repeat(2003)), "The pitch is 3 characters too long. The limit is 2000.");
});

test("an ordinary pitch passes, including one padded with spaces", () => {
  assert.equal(pitchProblem("Fix the rounding and keep the frozen suite green."), null);
  assert.equal(pitchProblem("  Fix the rounding.  "), null);
});
