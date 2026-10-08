import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "./api.ts";
import { clockAhead, demoControls, demoEnds, errorText, withJobChangedRetry } from "./demo.ts";
import { denied } from "./format.ts";

const visitor = {
  id: "v_1f2e",
  client: "guest-1f2e-client",
  operator: "guest-1f2e-ops",
  repository: "acquit-forks/demo-v_1f2e",
  expiresAt: "2026-11-04T15:22:00.000Z",
};

const asClient = { user: { handle: visitor.client, role: "CLIENT" as const }, visitor };
const asOperator = { user: { handle: visitor.operator, role: "OPERATOR" as const }, visitor };

test("a visitor's own bidding job offers both the funding choice and the clock", () => {
  assert.deepEqual(demoControls({ client: visitor.client, status: "OPEN", phase: "BIDDING" }, asClient), { funding: true, clock: true });
});

test("the funding choice closes once a bid is accepted, and the clock closes once the job settles", () => {
  assert.deepEqual(demoControls({ client: visitor.client, status: "OPEN", phase: "FUNDING" }, asClient), { funding: false, clock: true });
  assert.deepEqual(demoControls({ client: visitor.client, status: "IN_PROGRESS", phase: "READY" }, asClient), { funding: false, clock: true });
  assert.deepEqual(demoControls({ client: visitor.client, status: "VERIFIED", phase: "AWAITING_CLIENT" }, asClient), { funding: false, clock: true });
  assert.deepEqual(demoControls({ client: visitor.client, status: "PAID", phase: "PAID" }, asClient), { funding: false, clock: false });
  assert.deepEqual(demoControls({ client: visitor.client, status: "CLOSED", phase: "CANCELLED" }, asClient), { funding: false, clock: false });
});

test("another visitor's job, an operator's view, and a seeded session get neither control", () => {
  const none = { funding: false, clock: false };
  assert.deepEqual(demoControls({ client: "guest-9a9a-client", status: "OPEN", phase: "BIDDING" }, asClient), none);
  assert.deepEqual(demoControls({ client: null, status: "OPEN", phase: "BIDDING" }, asOperator), none);
  assert.deepEqual(
    demoControls({ client: "maya-client", status: "OPEN", phase: "BIDDING" }, { user: { handle: "maya-client", role: "CLIENT" }, visitor: null }),
    none,
  );
});

test("the visitor's operator gets neither control, even holding a job view its client was served", () => {
  assert.deepEqual(demoControls({ client: visitor.client, status: "OPEN", phase: "BIDDING" }, asOperator), { funding: false, clock: false });
});

test("the job clock card names the running total this job was moved", () => {
  assert.equal(clockAhead(0), "This job's clock runs on real time.");
  assert.equal(clockAhead(3_600_000), "This job's clock is 1 hour ahead.");
  assert.equal(clockAhead(86_400_000), "This job's clock is 1 day ahead.");
  assert.equal(clockAhead(4 * 86_400_000 + 2 * 3_600_000), "This job's clock is 4 days 2 hours ahead.");
  assert.equal(clockAhead(90_000), "This job's clock is 1 min ahead.");
});

test("a clock shift that lost its race is sent again, and the first answer that lands is returned", async () => {
  let calls = 0;
  const result = await withJobChangedRetry(async () => {
    calls++;
    if (calls < 3) throw new ApiError(409, "JOB_CHANGED");
    return "moved";
  });
  assert.equal(result, "moved");
  assert.equal(calls, 3);
});

test("the clock gives up after three lost races and never retries another refusal", async () => {
  let calls = 0;
  await assert.rejects(
    withJobChangedRetry(async () => {
      calls++;
      throw new ApiError(409, "JOB_CHANGED");
    }),
    { code: "JOB_CHANGED" },
  );
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    withJobChangedRetry(async () => {
      calls++;
      throw new ApiError(403, "NOT_VISITOR_JOB");
    }),
    { code: "NOT_VISITOR_JOB" },
  );
  assert.equal(calls, 1);
});

test("a demo refusal reads as a plain sentence with its code", () => {
  assert.equal(denied("CAP_VISITORS_DAY"), "Today's demos are all taken: the daily limit is reached. Try again tomorrow. (CAP_VISITORS_DAY)");
  assert.equal(denied("SEEDED_LOGIN_DISABLED"), "Seeded sign-in is off on this deployment. Start a demo instead. (SEEDED_LOGIN_DISABLED)");
  assert.equal(denied("FUNDING_BOUND"), "The payment method was fixed when a bid was accepted. (FUNDING_BOUND)");
});

test("a late funding choice and a capped command read from the refusal table, not the API's detail", () => {
  assert.equal(
    errorText(new ApiError(409, "FUNDING_BOUND", "This job's funding was fixed when its client accepted a bid.")),
    "The payment method was fixed when a bid was accepted. (FUNDING_BOUND)",
  );
  assert.equal(errorText(new ApiError(403, "NOT_VISITOR_JOB", "This action reaches only a job your own demo's client owns.")),
    "Only the demo's client can change this job. (NOT_VISITOR_JOB)");
  assert.equal(denied("CAP_VISITOR_JOBS"), "This demo has opened as many jobs as a demo can. (CAP_VISITOR_JOBS)");
  assert.equal(denied("CAP_SPEND_DAY"), "This demo has reached its daily limit for job budgets. (CAP_SPEND_DAY)");
});

test("the demo bar counts down to the visitor's expiry", () => {
  const now = Date.parse("2026-11-03T15:22:00.000Z");
  assert.equal(demoEnds(visitor.expiresAt, now), "Ends in 24 h 0 min");
  assert.equal(demoEnds(visitor.expiresAt, now + 23 * 3_600_000 + 15 * 60_000), "Ends in 0 h 45 min");
  assert.equal(demoEnds(visitor.expiresAt, now + 25 * 3_600_000), "This demo has ended.");
});
