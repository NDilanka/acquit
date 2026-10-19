import assert from "node:assert/strict";
import { test } from "node:test";
import { match, showsDemoCta, signedOutPage } from "./route.ts";

test("/demo opens the judge demo, with or without a trailing slash", () => {
  assert.deepEqual(match("/demo"), { name: "demo" });
  assert.deepEqual(match("/demo/"), { name: "demo" });
});

test("/ stays the home route", () => {
  assert.deepEqual(match("/"), { name: "home" });
});

test("signed out, / is the landing page and every other route asks for sign-in", () => {
  assert.equal(signedOutPage(match("/")), "landing");
  assert.equal(signedOutPage(match("/demo")), "signIn");
  assert.equal(signedOutPage(match("/cli")), "signIn");
  assert.equal(signedOutPage(match("/jobs/abc")), "signIn");
  assert.equal(signedOutPage(match("/nope")), "notFound");
});

test("the demo call to action shows only to a signed-out visitor who is not on /demo", () => {
  assert.equal(showsDemoCta(match("/"), false), true);
  assert.equal(showsDemoCta(match("/demo"), false), false);
  assert.equal(showsDemoCta(match("/"), true), false);
  assert.equal(showsDemoCta(match("/"), undefined), false);
});
