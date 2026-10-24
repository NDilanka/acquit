import assert from "node:assert/strict";
import { test } from "node:test";
import { notFoundLink } from "./not-found.ts";

test("a signed-out visitor on a missing page is offered the demo", () => {
  assert.deepEqual(notFoundLink(false), { to: "/demo", label: "Start the demo" });
});

test("a signed-in visitor on a missing page is sent back to their own dashboard", () => {
  assert.deepEqual(notFoundLink(true), { to: "/", label: "Back to your dashboard" });
});
