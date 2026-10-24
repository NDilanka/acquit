import assert from "node:assert/strict";
import { test } from "node:test";
import { match, showsTryCta, signedOutPage } from "./route.ts";

test("/demo, /start, and /welcome-back match with or without a trailing slash", () => {
  assert.deepEqual(match("/demo"), { name: "demo" });
  assert.deepEqual(match("/demo/"), { name: "demo" });
  assert.deepEqual(match("/start"), { name: "start" });
  assert.deepEqual(match("/start/"), { name: "start" });
  assert.deepEqual(match("/welcome-back"), { name: "welcomeBack" });
  assert.deepEqual(match("/welcome-back/"), { name: "welcomeBack" });
});

test("/ stays the home route", () => {
  assert.deepEqual(match("/"), { name: "home" });
});

test("signed out, / is the landing page, /demo moves to /start, and every other route asks for sign-in", () => {
  assert.equal(signedOutPage(match("/")), "landing");
  assert.equal(signedOutPage(match("/demo")), "toStart");
  assert.equal(signedOutPage(match("/start")), "signIn");
  assert.equal(signedOutPage(match("/welcome-back")), "welcomeBack");
  assert.equal(signedOutPage(match("/cli")), "signIn");
  assert.equal(signedOutPage(match("/jobs/abc")), "signIn");
  assert.equal(signedOutPage(match("/nope")), "notFound");
});

test("the Try Acquit button shows only signed out, and not on a page that has its own", () => {
  assert.equal(showsTryCta(match("/"), false), true);
  assert.equal(showsTryCta(match("/verifiers"), false), true);
  assert.equal(showsTryCta(match("/demo"), false), false);
  assert.equal(showsTryCta(match("/start"), false), false);
  assert.equal(showsTryCta(match("/welcome-back"), false), false);
  assert.equal(showsTryCta(match("/"), true), false);
  assert.equal(showsTryCta(match("/"), undefined), false);
});
