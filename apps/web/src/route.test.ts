import assert from "node:assert/strict";
import { test } from "node:test";
import { match, signedOutPage } from "./route.ts";

test("each operator page has its own path, and /operator/ reads the same as /operator", () => {
  assert.deepEqual(match("/operator"), { name: "operator" });
  assert.deepEqual(match("/operator/"), { name: "operator" });
  assert.deepEqual(match("/operator/bids"), { name: "operatorBids" });
  assert.deepEqual(match("/operator/work"), { name: "operatorWork" });
  assert.deepEqual(match("/operator/earnings"), { name: "operatorEarnings" });
});

test("a path under /operator that names no page is not found", () => {
  assert.deepEqual(match("/operator/agents"), { name: "notFound" });
});

test("signed out, every operator page asks for a sign-in", () => {
  for (const path of ["/operator", "/operator/bids", "/operator/work", "/operator/earnings"]) {
    assert.equal(signedOutPage(match(path)), "signIn", path);
  }
});
