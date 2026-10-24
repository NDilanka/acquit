import assert from "node:assert/strict";
import { test } from "node:test";
import { isNavActive, navFor, pageHeading, signedOutNav, type NavItem } from "./nav.ts";

const pairs = (items: readonly NavItem[]) => items.map((item) => [item.label, item.to]);

test("a client's navigation is My jobs and Post a job, then the two public pages", () => {
  assert.deepEqual(pairs(navFor("CLIENT")), [
    ["My jobs", "/"],
    ["Post a job", "/jobs/new"],
    ["Verifiers", "/verifiers"],
    ["Print verifier", "/print"],
  ]);
});

test("an operator's navigation is Find work, My bids, My work, Earnings, and Dashboards, then the two public pages", () => {
  assert.deepEqual(pairs(navFor("OPERATOR")), [
    ["Find work", "/operator"],
    ["My bids", "/operator/bids"],
    ["My work", "/operator/work"],
    ["Earnings", "/operator/earnings"],
    ["Dashboards", "/studio"],
    ["Verifiers", "/verifiers"],
    ["Print verifier", "/print"],
  ]);
});

test("the public pages sit under the Public label, and CLI sign-in, Tutorials, and Agents are not listed", () => {
  const publicPages = navFor("OPERATOR").filter((item) => item.group === "Public").map((item) => item.label);
  assert.deepEqual(publicPages, ["Verifiers", "Print verifier"]);
  const labels = navFor("OPERATOR").map((item) => item.label);
  assert.equal(labels.includes("CLI sign-in"), false);
  assert.equal(labels.includes("Tutorials"), false);
  assert.equal(labels.includes("Agents"), false);
});

test("a platform user's navigation is Dashboards, then the two public pages", () => {
  assert.deepEqual(pairs(navFor("PLATFORM")), [
    ["Dashboards", "/studio"],
    ["Verifiers", "/verifiers"],
    ["Print verifier", "/print"],
  ]);
});

test("signed out, the sidebar lists Verifiers and Print verifier", () => {
  assert.deepEqual(pairs(signedOutNav()), [
    ["Verifiers", "/verifiers"],
    ["Print verifier", "/print"],
  ]);
});

test("a role's first page is lit on /, so an operator on / sees Find work lit and Dashboards dark", () => {
  const operator = navFor("OPERATOR");
  const findWork = operator.find((item) => item.label === "Find work");
  const dashboards = operator.find((item) => item.label === "Dashboards");
  assert.ok(findWork && dashboards);
  assert.equal(isNavActive(findWork, "/", "OPERATOR"), true);
  assert.equal(isNavActive(dashboards, "/", "OPERATOR"), false);
  assert.equal(isNavActive(dashboards, "/studio", "OPERATOR"), true);
});

test("an operator's page lights only its own item, so My bids is lit on /operator/bids and Find work is not", () => {
  const operator = navFor("OPERATOR");
  const findWork = operator.find((item) => item.label === "Find work");
  const myBids = operator.find((item) => item.label === "My bids");
  assert.ok(findWork && myBids);
  assert.equal(isNavActive(myBids, "/operator/bids", "OPERATOR"), true);
  assert.equal(isNavActive(findWork, "/operator/bids", "OPERATOR"), false);
});

test("a client's My jobs stays lit on a job page, and Post a job is lit only on its own page", () => {
  const [myJobs, postJob] = navFor("CLIENT");
  assert.ok(myJobs && postJob);
  assert.equal(isNavActive(myJobs, "/jobs/abc123", "CLIENT"), true);
  assert.equal(isNavActive(postJob, "/jobs/abc123", "CLIENT"), false);
  assert.equal(isNavActive(postJob, "/jobs/new", "CLIENT"), true);
  assert.equal(isNavActive(myJobs, "/jobs/new", "CLIENT"), false);
});

test("an operator's Find work stays lit on a job page, and no other operator row lights there", () => {
  const lit = navFor("OPERATOR").filter((item) => isNavActive(item, "/jobs/abc123", "OPERATOR")).map((item) => item.label);
  assert.deepEqual(lit, ["Find work"]);
});

test("each route has one heading, and the eyebrow names the role", () => {
  assert.deepEqual(pageHeading({ name: "home" }, "CLIENT"), { eyebrow: "Client", title: "My jobs" });
  assert.deepEqual(pageHeading({ name: "home" }, "OPERATOR"), { eyebrow: "Operator", title: "Find work" });
  assert.deepEqual(pageHeading({ name: "operatorBids" }, "OPERATOR"), { eyebrow: "Operator", title: "My bids" });
  assert.deepEqual(pageHeading({ name: "operatorWork" }, "OPERATOR"), { eyebrow: "Operator", title: "My work" });
  assert.deepEqual(pageHeading({ name: "operatorEarnings" }, "OPERATOR"), { eyebrow: "Operator", title: "Earnings" });
  assert.deepEqual(pageHeading({ name: "studio" }, "PLATFORM"), { eyebrow: "Platform", title: "Dashboards" });
  assert.deepEqual(pageHeading({ name: "verifiers" }, null), { eyebrow: "Public", title: "Verifiers" });
  assert.deepEqual(pageHeading({ name: "print" }, null), { eyebrow: "Public", title: "Print verifier" });
  assert.deepEqual(pageHeading({ name: "notFound" }, null), { eyebrow: "Acquit", title: "Page not found" });
});
