import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  ]) {
    assert.equal(signedOutPage(match(path)), "signIn", path);
  }
});

test("leaderboard and agent record web pages are public signed out", () => {
  assert.equal(signedOutPage(match("/leaderboard")), "public");
  assert.deepEqual(match("/agents/code%20fixer/record/"), { name: "agentRecord", agentId: "code fixer" });
  assert.equal(isOwnerRoute("/agents/a/record"), true);
  assert.equal(signedOutPage(match("/agents/a/record")), "public");
});

test("a paid job's public receipt is reachable signed out, and so are its addresses", () => {
  assert.deepEqual(match("/receipts/rcpt_42"), { name: "receipt", id: "rcpt_42" });
  assert.deepEqual(match("/receipts/rcpt%2042/"), { name: "receipt", id: "rcpt 42" });
  assert.equal(signedOutPage(match("/receipts/rcpt_42")), "public");
  assert.equal(isOwnerRoute("/receipts/rcpt_42"), false);
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

test("the checker demonstration uses the public owner shell for every visitor", () => {
  for (const path of ["/inspect","/inspect/"]) {
    assert.equal(isOwnerRoute(path),true);
    assert.deepEqual(match(path),{name:"inspect"});
    assert.equal(signedOutPage(match(path)),"public");
  }
  assert.equal(isOwnerRoute("/inspect-private"),false);
});

const landing = readFileSync(new URL("./landing/landing.html", import.meta.url), "utf8");

for (const className of ["pill-btn", "h-go", "hf-demo"]) {
  test(`signed-out landing ${className} enters Plug in directly and keeps operator intent at sign-up`, () => {
    const target = landing.match(new RegExp(`<a class="[^"]*\\b${className}\\b[^"]*" href="([^"]+)"`))?.[1];
    assert.equal(target, "/specialists");
    assert.deepEqual(match(target!), { name: "specialists" });
    assert.equal(signedOutPage(match(target!)), "signIn");
    assert.equal(isOwnerRoute(target!), true);
    assert.equal(signUpPath(target!, "CLIENT"), "/specialists");
    assert.equal(signUpPath(target!, "OPERATOR"), "/specialists");
  });
}

test("the landing client button retains the client entry and client home after sign-up", () => {
  const target = landing.match(/<a [^>]*href="([^"]+)"[^>]*>Post a job<\/a>/)?.[1];
  assert.equal(target, "/start");
  assert.equal(signedOutPage(match(target!)), "signIn");
  assert.equal(isOwnerRoute(target!), false);
  assert.equal(signUpPath(target!, "CLIENT"), "/");
});

test("owner sign-up names Plug in Step 1 and switches to operator without a role chooser", () => {
  const source = readFileSync(new URL("./pages/SignIn.tsx", import.meta.url), "utf8");
  assert.match(source, /ownerEntry && <p className="start-step">Step 1 of 5 · Plug in<\/p>/);
  assert.match(source, /<Heading>\{ownerEntry \? "Plug in your agent\." : "Try Acquit"\}<\/Heading>/);
  assert.match(source, /isOwnerRoute\(location\.path\) && made\.user\.role !== "OPERATOR"\s*\? await api\.switchRole\("OPERATOR"\) : account/);
  assert.match(source, /navigate\(signUpPath\(location\.path, next\.user\.role\)\)/);
});
