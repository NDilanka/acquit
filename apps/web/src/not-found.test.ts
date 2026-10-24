import assert from "node:assert/strict";
import { test } from "node:test";
import { notFoundLink } from "./not-found.ts";

test("a signed-out browser on a missing page is offered Try Acquit", () => {
  assert.deepEqual(notFoundLink(false), { to: "/start", label: "Try Acquit" });
});

test("a signed-in user on a missing page is sent back to their own dashboard", () => {
  assert.deepEqual(notFoundLink(true), { to: "/", label: "Back to your dashboard" });
});
