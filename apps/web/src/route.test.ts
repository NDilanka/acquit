import assert from "node:assert/strict";
import { test } from "node:test";
import { isOwnerRoute, match, ownerRouteUrl, signUpPath, signedOutPage } from "./route.ts";

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

test("each specialist step has its own path, and a bare step leaves the agent to the page", () => {
  assert.deepEqual(match("/specialists"), { name: "specialists" });
  assert.deepEqual(match("/specialists/"), { name: "specialists" });
  assert.deepEqual(match("/specialists/exam"), { name: "specialistExam" });
  assert.deepEqual(match("/specialists/orders"), { name: "specialistOrders" });
  assert.deepEqual(match("/specialists/activity"), { name: "specialistActivity" });
  assert.deepEqual(match("/earnings"), { name: "specialistEarnings" });
  assert.deepEqual(match("/leaderboard/"), { name: "specialistLeaderboard" });
});

test("a specialist step may name its agent in the path", () => {
  assert.deepEqual(match("/specialists/exam/agent_42"), { name: "specialistExam", agentId: "agent_42" });
  assert.deepEqual(match("/specialists/orders/agent%20x/"), { name: "specialistOrders", agentId: "agent x" });
  assert.deepEqual(match("/specialists/activity/agent_42"), { name: "specialistActivity", agentId: "agent_42" });
});

test("a path under /specialists that names no page is not found", () => {
  assert.deepEqual(match("/specialists/agents"), { name: "notFound" });
  assert.deepEqual(match("/specialists/exam/a/b"), { name: "notFound" });
});

test("signed out, every specialist page asks for a sign-in", () => {
  for (const path of [
    "/specialists",
    "/specialists/exam/agent_42",
    "/specialists/orders",
    "/specialists/activity",
    "/earnings",
    "/leaderboard",
  ]) {
    assert.equal(signedOutPage(match(path)), "signIn", path);
  }
});

test("old owner addresses redirect without losing ids, query strings or fragments", () => {
  assert.equal(ownerRouteUrl("/specialists/night/agent%20x/?exam=e&agent=a#record"), "/specialists/activity/agent%20x/?exam=e&agent=a#record");
  assert.equal(ownerRouteUrl("/specialists/morning/?agent=a"), "/earnings?agent=a");
  assert.equal(ownerRouteUrl("/specialists/floor?agent=a"), "/leaderboard?agent=a");
  assert.equal(ownerRouteUrl("/specialists/earnings?agent=a"), "/earnings?agent=a");
  assert.equal(ownerRouteUrl("/specialists/leaderboard/"), "/leaderboard");
  assert.equal(ownerRouteUrl("/operator/earnings"), "/operator/earnings");
  assert.deepEqual(match("/specialists/night/a"), { name: "specialistActivity", agentId: "a" });
  assert.deepEqual(match("/specialists/morning"), { name: "specialistEarnings" });
  assert.deepEqual(match("/specialists/floor"), { name: "specialistLeaderboard" });
});

test("owner starts stay in the owner workspace; client starts retain their home", () => {
  for (const path of ["/specialists", "/specialists/exam/a", "/earnings", "/leaderboard/"]) {
    assert.equal(isOwnerRoute(path), true);
    assert.equal(signUpPath(path, "CLIENT"), "/specialists");
  }
  assert.equal(signUpPath("/start", "CLIENT"), "/");
  assert.equal(signUpPath("/start", "OPERATOR"), "/specialists");
  assert.equal(signUpPath("/jobs/new", "CLIENT"), "/");
  assert.equal(isOwnerRoute("/operator/earnings"), false);
  assert.equal(isOwnerRoute("/specialists-wrong"), false);
});
