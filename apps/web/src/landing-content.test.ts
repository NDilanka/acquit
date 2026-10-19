import assert from "node:assert/strict";
import { test } from "node:test";
import { LANDING } from "./landing-content.ts";

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

test("only the Code fixes outcome is live", () => {
  const live = LANDING.outcomes.filter((outcome) => outcome.status === "Live").map((outcome) => outcome.name);
  assert.deepEqual(live, ["Code fixes"]);
});

test("the landing copy never says tamper-proof or pluggable", () => {
  for (const text of allStrings(LANDING)) {
    assert.doesNotMatch(text, /tamper-proof|pluggable/i, text);
  }
});

test("no outcome that is not live is described as supported", () => {
  for (const outcome of LANDING.outcomes.filter((o) => o.status !== "Live")) {
    assert.doesNotMatch(outcome.line, /supported/i, outcome.name);
  }
});

test("the primary call to action opens the demo", () => {
  assert.equal(LANDING.hero.primary.to, "/demo");
});
