import assert from "node:assert/strict";
import { test } from "node:test";
import { JUDGE_TOUR, START_DEMO_ACTION } from "./judge-tour.ts";

test("the judge entry tour shows exactly three steps in order", () => {
  assert.equal(JUDGE_TOUR.length, 3);
  for (const [index, step] of JUDGE_TOUR.entries()) {
    assert.equal(typeof step.title, "string", `step ${index + 1} has a title`);
    assert.notEqual(step.title.trim(), "", `step ${index + 1} title is not blank`);
    assert.equal(typeof step.body, "string", `step ${index + 1} has a body`);
    assert.notEqual(step.body.trim(), "", `step ${index + 1} body is not blank`);
  }
});

test("the tour's final action leads into Start my demo", () => {
  assert.equal(START_DEMO_ACTION, "Start my demo");
});
