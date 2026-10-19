import assert from "node:assert/strict";
import { test } from "node:test";
import { match } from "./route.ts";

test("/demo opens the judge demo, with or without a trailing slash", () => {
  assert.deepEqual(match("/demo"), { name: "demo" });
  assert.deepEqual(match("/demo/"), { name: "demo" });
});

test("/ stays the home route", () => {
  assert.deepEqual(match("/"), { name: "home" });
});
