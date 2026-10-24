import assert from "node:assert/strict";
import { test } from "node:test";
import { SCENARIO_CARDS, SCRIPTED_LABEL } from "./judge-tour.ts";

test("the six scenarios keep their names and titles", () => {
  assert.deepEqual(SCENARIO_CARDS.map(card => card.name), ["verified-and-paid", "hidden-test-fail", "test-tamper", "dispute-arbiter", "buyer-dispute", "deadline-refund"]);
  assert.deepEqual(SCENARIO_CARDS.map(card => card.title), ["Verified and paid", "Hidden test fail", "Test tamper", "Dispute to arbiter", "Buyer disputes", "Deadline refund"]);
});

test("the buyer disputes card states its one sentence, and names its dispute as simulated", () => {
  const card = SCENARIO_CARDS.find(candidate => candidate.name === "buyer-dispute");
  assert.equal(card?.promise, "A verified job's buyer opens a PayPal dispute, the approval is held, the dispute resolves for the seller, and the job is paid.");
  assert.ok(card?.scripted.includes("Simulated PayPal dispute"));
});

test("every scenario card names its scripted agent as simulated", () => {
  assert.equal(SCRIPTED_LABEL, "Scripted agent (Simulated)");
  for (const card of SCENARIO_CARDS) {
    assert.ok(card.scripted.startsWith("Scripted agent (Simulated) "), `${card.name} names its scripted agent as simulated`);
  }
});
