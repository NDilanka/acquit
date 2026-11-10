import assert from "node:assert/strict";
import { test } from "node:test";
import { isNavActive, navFor, pageHeading, signedOutNav, type NavItem } from "./nav.ts";

const pairs = (items: readonly NavItem[]) => items.map((item) => [item.label, item.to]);

test("a client's navigation is My jobs and Post a job, then the two public pages", () => {
  assert.deepEqual(pairs(navFor("CLIENT")), [
    ["My jobs", "/"],
    ["Post a job", "/jobs/new"],
    ["Sample book", "/studio/sample"],
    ["Your agent", "/specialists"],
    ["Leaderboard", "/leaderboard"],
    ["Scenarios", "/tour"],
  ]);
});

test("an operator keeps the work pages and one agent entry plus Leaderboard", () => {
  assert.deepEqual(pairs(navFor("OPERATOR")), [
    ["Find work", "/operator"],
    ["My bids", "/operator/bids"],
    ["My work", "/operator/work"],
    ["Earnings", "/operator/earnings"],
    ["Dashboards", "/studio"],
    ["Sample book", "/studio/sample"],
    ["Your agent", "/specialists"],
    ["Leaderboard", "/leaderboard"],
    ["Scenarios", "/tour"],
  ]);
});

test("Public and Agents are separate groups, without inventing a CLI or Tutorials page", () => {
  const publicPages = navFor("OPERATOR").filter((item) => item.group === "Public").map((item) => item.label);
  assert.deepEqual(publicPages, ["Scenarios"]);
  const labels = navFor("OPERATOR").map((item) => item.label);
  assert.equal(labels.includes("CLI sign-in"), false);
  assert.equal(labels.includes("Tutorials"), false);
  assert.equal(labels.includes("Agents"), false);
  assert.deepEqual(pairs(navFor("OPERATOR").filter((item) => item.group === "Agents")), [
    ["Your agent", "/specialists"], ["Leaderboard", "/leaderboard"],
  ]);
  assert.equal(navFor("CLIENT").filter((item) => item.label === "Your agent").length, 1);
});

test("an agent-specific step and trailing slash light only their own Agents destination", () => {
  for (const path of ["/specialists/exam/agent-one", "/specialists/orders/agent-one/", "/specialists/activity/agent-one", "/earnings/"]) {
    const lit = navFor("OPERATOR").filter((item) => isNavActive(item, path, "OPERATOR"));
    assert.equal(lit.length, 1);
    assert.equal(lit[0]?.to, "/specialists");
  }
});

test("the leaderboard lights only its own destination", () => {
  const lit = navFor("OPERATOR").filter((item) => isNavActive(item, "/leaderboard/", "OPERATOR"));
  assert.deepEqual(pairs(lit), [["Leaderboard", "/leaderboard"]]);
  assert.deepEqual(pageHeading({ name: "specialistActivity" }, "OPERATOR"), { eyebrow: "Specialists", title: "Activity" });
  assert.deepEqual(pageHeading({ name: "specialistEarnings" }, "OPERATOR"), { eyebrow: "Specialists", title: "Earnings" });
  assert.deepEqual(pageHeading({ name: "specialistLeaderboard" }, "OPERATOR"), { eyebrow: "Specialists", title: "Leaderboard" });
});

test("a platform user's navigation is Dashboards and Sample book, then the two public pages", () => {
  assert.deepEqual(pairs(navFor("PLATFORM")), [
    ["Dashboards", "/studio"],
    ["Sample book", "/studio/sample"],
  ]);
});

test("checking is not a sidebar destination", () => {
  assert.deepEqual(pairs(signedOutNav()), []);
  for (const role of ["CLIENT", "OPERATOR", "PLATFORM"] as const) {
    assert.ok(navFor(role).every(item => !["Verifiers", "Print verifier"].includes(item.label)));
  }
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
  assert.deepEqual(pageHeading({ name: "studioSample" }, "CLIENT"), { eyebrow: "Client", title: "Sample book" });
  assert.deepEqual(pageHeading({ name: "verifiers" }, null), { eyebrow: "Public", title: "Verifiers" });
  assert.deepEqual(pageHeading({ name: "print" }, null), { eyebrow: "Public", title: "Print verifier" });
  assert.deepEqual(pageHeading({ name: "tour" }, "OPERATOR"), { eyebrow: "Operator", title: "Scenarios" });
  assert.deepEqual(pageHeading({ name: "notFound" }, null), { eyebrow: "Acquit", title: "Page not found" });
  assert.deepEqual(pageHeading({ name: "start" }, null), { eyebrow: "Welcome", title: "Try Acquit" });
  assert.deepEqual(pageHeading({ name: "demo" }, null), { eyebrow: "Welcome", title: "Try Acquit" });
  assert.deepEqual(pageHeading({ name: "welcomeBack" }, "CLIENT"), { eyebrow: "Welcome", title: "Welcome back" });
});
