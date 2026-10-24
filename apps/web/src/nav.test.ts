import assert from "node:assert/strict";
import { test } from "node:test";
import { isNavActive, navFor, pageHeading, signedOutNav, type NavItem } from "./nav.ts";

const pairs = (items: readonly NavItem[]) => items.map((item) => [item.label, item.to]);

test("a client's navigation is My jobs and Post a job, then the three pages every role gets", () => {
  assert.deepEqual(pairs(navFor("CLIENT")), [
    ["My jobs", "/"],
    ["Post a job", "/jobs/new"],
    ["Verifiers", "/verifiers"],
    ["Print demo", "/print"],
    ["CLI sign-in", "/cli"],
  ]);
});

test("an operator's navigation is Find work and Dashboards, then the three pages every role gets", () => {
  assert.deepEqual(pairs(navFor("OPERATOR")), [
    ["Find work", "/operator"],
    ["Dashboards", "/studio"],
    ["Verifiers", "/verifiers"],
    ["Print demo", "/print"],
    ["CLI sign-in", "/cli"],
  ]);
});

test("a platform user's navigation is Dashboards, then the three pages every role gets", () => {
  assert.deepEqual(pairs(navFor("PLATFORM")), [
    ["Dashboards", "/studio"],
    ["Verifiers", "/verifiers"],
    ["Print demo", "/print"],
    ["CLI sign-in", "/cli"],
  ]);
});

test("signed out, the sidebar lists only Verifiers and Print demo", () => {
  assert.deepEqual(pairs(signedOutNav()), [
    ["Verifiers", "/verifiers"],
    ["Print demo", "/print"],
  ]);
});

test("a role's first page is lit on /, so an operator on / sees Find work lit and Dashboards dark", () => {
  const [findWork, dashboards] = navFor("OPERATOR");
  assert.ok(findWork && dashboards);
  assert.equal(isNavActive(findWork, "/", "OPERATOR"), true);
  assert.equal(isNavActive(dashboards, "/", "OPERATOR"), false);
  assert.equal(isNavActive(dashboards, "/studio", "OPERATOR"), true);
});

test("a client's My jobs stays lit on a job page, and Post a job is lit only on its own page", () => {
  const [myJobs, postJob] = navFor("CLIENT");
  assert.ok(myJobs && postJob);
  assert.equal(isNavActive(myJobs, "/jobs/abc123", "CLIENT"), true);
  assert.equal(isNavActive(postJob, "/jobs/abc123", "CLIENT"), false);
  assert.equal(isNavActive(postJob, "/jobs/new", "CLIENT"), true);
  assert.equal(isNavActive(myJobs, "/jobs/new", "CLIENT"), false);
});

test("each route has one heading, and the eyebrow names the role", () => {
  assert.deepEqual(pageHeading({ name: "home" }, "CLIENT"), { eyebrow: "Client", title: "My jobs" });
  assert.deepEqual(pageHeading({ name: "home" }, "OPERATOR"), { eyebrow: "Operator", title: "Find work" });
  assert.deepEqual(pageHeading({ name: "studio" }, "PLATFORM"), { eyebrow: "Platform", title: "Dashboards" });
  assert.deepEqual(pageHeading({ name: "verifiers" }, null), { eyebrow: "Public", title: "Verifiers" });
  assert.deepEqual(pageHeading({ name: "notFound" }, null), { eyebrow: "Acquit", title: "Page not found" });
});
