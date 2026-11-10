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

test("each specialist step has its own path, and a bare step leaves the agent to the page", () => {
  assert.deepEqual(match("/specialists"), { name: "specialists" });
  assert.deepEqual(match("/specialists/"), { name: "specialists" });
  assert.deepEqual(match("/specialists/exam"), { name: "specialistExam" });
  assert.deepEqual(match("/specialists/orders"), { name: "specialistOrders" });
  assert.deepEqual(match("/specialists/night"), { name: "specialistNight" });
  assert.deepEqual(match("/specialists/morning"), { name: "specialistMorning" });
  assert.deepEqual(match("/specialists/floor/"), { name: "specialistFloor" });
});

test("a specialist step may name its agent in the path", () => {
  assert.deepEqual(match("/specialists/exam/agent_42"), { name: "specialistExam", agentId: "agent_42" });
  assert.deepEqual(match("/specialists/orders/agent%20x/"), { name: "specialistOrders", agentId: "agent x" });
  assert.deepEqual(match("/specialists/night/agent_42"), { name: "specialistNight", agentId: "agent_42" });
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
    "/specialists/night",
    "/specialists/morning",
    "/specialists/floor",
  ]) {
    assert.equal(signedOutPage(match(path)), "signIn", path);
  }
});
