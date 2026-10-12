import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobView } from "./api-types";
import { pollInterval } from "./poll.ts";

type PollJob = Pick<JobView, "status" | "phase" | "merge">;

const idle = { awaitingOrder: false } as const;

test("the client waiting inside the PayPal order polls fast", () => {
  assert.equal(pollInterval({ status: "OPEN", phase: "FUNDING", merge: null } satisfies PollJob, { awaitingOrder: true }), 1000);
});

test("a release in flight polls fast", () => {
  assert.equal(pollInterval({ status: "VERIFIED", phase: "RELEASE_PENDING", merge: null } satisfies PollJob, idle), 1000);
});

// Pins the F6 validator finding: an open page on a READY job never showed VERIFIED without a manual reload.
test("the page keeps polling while the House works on an in-progress job with no run submitted yet", () => {
  assert.equal(pollInterval({ status: "IN_PROGRESS", phase: "READY", merge: null } satisfies PollJob, idle), 4000);
});

test("an in-progress job under verification keeps polling", () => {
  assert.equal(pollInterval({ status: "IN_PROGRESS", phase: "VERIFYING", merge: null } satisfies PollJob, idle), 4000);
});

test("a verified job in review keeps polling until it settles", () => {
  assert.equal(pollInterval({ status: "VERIFIED", phase: "AWAITING_CLIENT", merge: null } satisfies PollJob, idle), 4000);
  assert.equal(pollInterval({ status: "VERIFIED", phase: "REFUND_PENDING", merge: null } satisfies PollJob, idle), 4000);
});

test("a paid job keeps polling while its merge is pending and stops once the merge resolves", () => {
  assert.equal(pollInterval({ status: "PAID", phase: "PAID", merge: { phase: "PENDING" } } satisfies PollJob, idle), 4000);
  assert.equal(
    pollInterval({ status: "PAID", phase: "PAID", merge: { phase: "MERGED", at: "2026-11-04T15:22:00.000Z", sha: "abc123" } } satisfies PollJob, idle),
    null,
  );
  assert.equal(pollInterval({ status: "PAID", phase: "PAID", merge: { phase: "NEEDS_HUMAN", reason: "conflict" } } satisfies PollJob, idle), null);
  assert.equal(pollInterval({ status: "PAID", phase: "PAID", merge: null } satisfies PollJob, idle), null);
});

test("a refunded or closed job stops polling", () => {
  assert.equal(pollInterval({ status: "REFUNDED", phase: "REFUNDED", merge: null } satisfies PollJob, idle), null);
  assert.equal(pollInterval({ status: "CLOSED", phase: "CANCELLED", merge: null } satisfies PollJob, idle), null);
});

test("an open job keeps polling through bidding and funding", () => {
  assert.equal(pollInterval({ status: "OPEN", phase: "BIDDING", merge: null } satisfies PollJob, idle), 4000);
  assert.equal(pollInterval({ status: "OPEN", phase: "FUNDING", merge: null } satisfies PollJob, idle), 4000);
});
