import assert from "node:assert/strict";
import { test } from "node:test";
import { SCENARIO_CARDS, SCRIPTED_LABEL, START_DEMO_ACTION } from "./judge-tour.ts";

test("the sign-in page offers the five judge scenarios under their titles", () => {
  assert.deepEqual(SCENARIO_CARDS.map(card => card.name), ["verified-and-paid", "hidden-test-fail", "test-tamper", "dispute-arbiter", "deadline-refund"]);
  assert.deepEqual(SCENARIO_CARDS.map(card => card.title), ["Verified and paid", "Hidden test fail", "Test tamper", "Dispute to arbiter", "Deadline refund"]);
});

test("every scenario card names its scripted agent as simulated", () => {
  assert.equal(SCRIPTED_LABEL, "Scripted agent (Simulated)");
  for (const card of SCENARIO_CARDS) {
    assert.ok(card.scripted.startsWith("Scripted agent (Simulated) "), `${card.name} names its scripted agent as simulated`);
  }
});

test("the start action keeps its name", () => {
  assert.equal(START_DEMO_ACTION, "Start my demo");
});
