import assert from "node:assert/strict";
import { test } from "node:test";
import type { Attempt, BidView, Receipt } from "./api-types.ts";
import { canDeliver, moneyRows, nextStep, timelineEvents, verifierIndex, type TimelineJob, type Viewer } from "./job-timeline.ts";

const CLIENT: Viewer = { role: "CLIENT", handle: "ada" };
const DEVON: Viewer = { role: "OPERATOR", handle: "devon" };
const NOA: Viewer = { role: "OPERATOR", handle: "noa" };

const CONTRACT = {
  repository: "NDilanka/acquit-demo",
  issue: 7,
  frozenAt: "2026-10-10T09:00:00.000Z",
  frozenTestPath: "tests/frozen.test.ts",
  frozenTests: 48,
  hiddenTests: 6,
  hiddenManifest: "9f2c4a7be1d3",
  protectedPaths: ["tests/**"],
};

function bid(over: Partial<BidView>): BidView {
  return {
    id: "bid_devon",
    operator: "op_devon",
    handle: "devon",
    label: "INDEPENDENT",
    price: 36000,
    eta: 48,
    agent: "ts-bugfixer",
    runner: "codex",
    pitch: "One fix and a test.",
    paidReceipts: 4,
    houseLine: null,
    status: "PENDING",
    ...over,
  };
}

const BASE: TimelineJob = {
  id: "job_0001",
  title: "Fix rounding in EUR invoices",
  status: "OPEN",
  phase: "BIDDING",
  checkoutPhase: null,
  budget: 40000,
  deliveryEndsAt: "2026-10-20T00:00:00.000Z",
  bids: { operators: [], house: null },
  client: "ada",
  lockedTo: null,
  viewerCanApprove: false,
  viewerCanDispute: false,
  dispute: null,
  arbiterNote: null,
  releaseAuthority: null,
  refundReason: null,
  escrow: "NONE",
  approveUrl: null,
  ledger: [],
  attempts: { used: 0, left: 3, last: null, reasons: [], history: [], pending: null, failure: null },
  reviewEndsAt: null,
  pullRequest: null,
  mergeCommit: null,
  merge: null,
  release: null,
  receipt: null,
  contract: null,
  funding: "card",
  clockShiftMs: 0,
};

/** A job in flight with devon locked in and the contract frozen. */
function locked(over: Partial<TimelineJob>): TimelineJob {
  return {
    ...BASE,
    status: "IN_PROGRESS",
    phase: "READY",
    bids: { operators: [bid({ status: "ACCEPTED" })], house: null },
    lockedTo: "op_devon",
    escrow: "HELD",
    ledger: [{ kind: "HELD", cents: 37800, at: "2026-10-11T08:00:00.000Z" }],
    contract: CONTRACT,
    ...over,
  };
}

const rejected: Attempt = {
  ordinal: 1,
  sourceCommit: "a1b2c3d",
  at: "2026-10-12T10:00:00.000Z",
  result: "REJECTED",
  reasons: ["Frozen tests failed: test_a, test_b"],
  reasonsTruncated: 0,
};

const verified: Attempt = {
  ordinal: 1,
  sourceCommit: "e4f5a6b",
  at: "2026-10-12T10:00:00.000Z",
  result: "VERIFIED",
  frozen: { expected: 48, passed: 48 },
  hidden: { expected: 6, passed: 6 },
  pullRequest: 12,
};

const RECEIPT: Receipt = {
  id: "rcpt_0001",
  jobId: "job_0001",
  operator: "devon",
  agent: "ts-bugfixer",
  pullRequest: 12,
  mergeCommit: "abcdef1234567",
  frozen: { expected: 48, passed: 48 },
  hidden: { expected: 6, passed: 6 },
  attemptsUsed: 1,
  paid: 34200,
  releasedAt: "2026-10-15T10:00:00.000Z",
  source: "JOB",
};

test("open for bids: the client accepts a bid, and an operator who has not bid is asked to place one", () => {
  const open = withBid();
  assert.equal(nextStep(open, CLIENT), "Accept one bid to pay it into escrow.");
  assert.equal(nextStep(open, NOA), "Place a bid. The client accepts one bid to fund escrow.");
  assert.equal(nextStep(open, DEVON), "Your bid is in. The client accepts one bid to fund escrow.");
  assert.equal(nextStep(BASE, CLIENT), "Waiting for the first bid. Accept one to pay it into escrow.");
});

test("open for bids: the timeline shows the frozen contract, then each bid with no time served", () => {
  const events = timelineEvents({ ...withBid(), contract: CONTRACT });
  assert.deepEqual(events, [
    {
      at: "2026-10-10T09:00:00.000Z",
      kind: "CONTRACT",
      title: "Acceptance contract frozen",
      detail: "48 visible and 6 hidden tests. Hidden cases sealed.",
      tone: "open",
      ids: ["9f2c4a7be1d3"],
      href: null,
    },
    {
      at: null,
      kind: "BID",
      title: "devon bid 360.00 USD",
      detail: "2 days. 4 verified receipts. Pending.",
      tone: "open",
      ids: ["bid_devon"],
      href: null,
    },
  ]);
});

test("held in escrow: the operator is asked to deliver, and the verifier counts appear in the line", () => {
  const job = locked({});
  assert.equal(nextStep(job, DEVON), "Deliver the commit with the steps below. Every attempt runs 48 visible and 6 hidden tests.");
  assert.equal(nextStep(job, CLIENT), "Waiting for devon to deliver. Escrow holds the payment.");
  assert.equal(canDeliver(job, DEVON), true);
  assert.equal(canDeliver(job, NOA), false);
  assert.equal(canDeliver(job, CLIENT), false);
});

test("held in escrow: a job with no contract still tells the operator to deliver", () => {
  const job = locked({ contract: null });
  assert.equal(nextStep(job, DEVON), "Deliver the commit with the steps below.");
});

test("rejected attempt: the timeline names the reason in red and says escrow is still held", () => {
  const job = locked({
    attempts: { used: 1, left: 2, last: "REJECTED", reasons: rejected.reasons, history: [rejected], pending: null, failure: null },
  });
  assert.equal(
    nextStep(job, DEVON),
    "The last attempt was rejected and escrow is still held. Fix the work and deliver again. 2 of 3 attempts left.",
  );
  assert.equal(nextStep(job, CLIENT), "The last attempt was rejected. Escrow is still held while devon tries again.");
  const events = timelineEvents(job);
  assert.deepEqual(events.at(-1), {
    at: "2026-10-12T10:00:00.000Z",
    kind: "ATTEMPT",
    title: "Attempt 1 of 3 rejected",
    detail: "Frozen tests failed: test_a, test_b. Escrow still held.",
    tone: "alert",
    ids: ["a1b2c3d"],
    href: null,
  });
});

test("rejected attempt: extra reasons are counted in words, and a refunded job does not claim escrow is held", () => {
  const twoReasons: Attempt = { ...rejected, reasons: ["Frozen tests failed: test_a", "Hidden tests did not complete: t9"], reasonsTruncated: 2 };
  const refunded: TimelineJob = {
    ...BASE,
    status: "REFUNDED",
    phase: "REFUNDED",
    escrow: "REFUNDED",
    refundReason: "ATTEMPTS_EXHAUSTED",
    bids: { operators: [bid({ status: "ACCEPTED" })], house: null },
    lockedTo: "op_devon",
    attempts: { used: 3, left: 0, last: "REJECTED", reasons: twoReasons.reasons, history: [twoReasons], pending: null, failure: null },
    ledger: [
      { kind: "HELD", cents: 37800, at: "2026-10-11T08:00:00.000Z" },
      { kind: "REFUND", cents: 37800, at: "2026-10-14T08:00:00.000Z" },
    ],
  };
  const events = timelineEvents(refunded);
  assert.equal(events.at(-2)?.detail, "Frozen tests failed: test_a (and 3 more reasons).");
  assert.equal(events.at(-1)?.title, "Refunded to the client");
  assert.equal(events.at(-1)?.detail, "378.00 USD refunded. Refunded after all 3 delivery attempts were used.");
  assert.equal(nextStep(refunded, CLIENT), "Refunded to the client. No money is held.");
});

test("verified awaiting review: the client is asked to approve or dispute by the review deadline", () => {
  const job = locked({
    status: "VERIFIED",
    phase: "AWAITING_CLIENT",
    viewerCanApprove: true,
    viewerCanDispute: true,
    reviewEndsAt: "2026-10-22T12:00:00.000Z",
    mergeCommit: "e4f5a6b",
    pullRequest: 12,
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [verified], pending: null, failure: null },
  });
  assert.equal(
    nextStep(job, CLIENT),
    "Approve to release the payment, or dispute by 2026-10-22 12:00 UTC. If you do nothing, Acquit releases it then.",
  );
  assert.equal(
    nextStep({ ...job, viewerCanApprove: false }, CLIENT),
    "The client reviews until 2026-10-22 12:00 UTC. If the client does nothing, Acquit releases the payment then.",
  );
  const events = timelineEvents(job);
  assert.deepEqual(events.slice(-2), [
    {
      at: "2026-10-12T10:00:00.000Z",
      kind: "ATTEMPT",
      title: "Attempt 1 of 3 verified",
      detail: "48 of 48 visible and 6 of 6 hidden tests passed. Pull request #12.",
      tone: "ok",
      ids: ["e4f5a6b"],
      href: "https://github.com/NDilanka/acquit-demo/pull/12",
    },
    {
      at: "2026-10-12T10:00:00.000Z",
      kind: "REVIEW",
      title: "Waiting for client review",
      detail: "Approve or dispute by 2026-10-22 12:00 UTC. If the client does nothing, Acquit releases the payment then.",
      tone: "held",
      ids: [],
      href: null,
    },
  ]);
});

test("paid: the payout names the approval and the merge, and the receipt is the proof", () => {
  const job: TimelineJob = {
    ...locked({}),
    status: "PAID",
    phase: "PAID",
    escrow: "RELEASED",
    releaseAuthority: "CLIENT_APPROVAL",
    merge: { phase: "MERGED", at: "2026-10-15T10:00:00.000Z", sha: "c0ffee1234567" },
    pullRequest: 12,
    mergeCommit: "abcdef1234567",
    release: { payoutItemId: "PAYOUT-ITEM-1", captureId: "CAPTURE-1", paid: 34200, at: "2026-10-15T10:00:00.000Z" },
    receipt: RECEIPT,
    ledger: [
      { kind: "HELD", cents: 37800, at: "2026-10-11T08:00:00.000Z" },
      { kind: "RELEASED", cents: 34200, at: "2026-10-15T10:00:00.000Z" },
      { kind: "FEE", cents: 3600, processor: 1100, acquit: 2500, at: "2026-10-15T10:00:00.000Z" },
    ],
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [], pending: null, failure: null },
  };
  assert.equal(nextStep(job, CLIENT), "Paid to devon. The receipt below is the proof.");
  const events = timelineEvents(job);
  assert.deepEqual(events.slice(-2), [
    {
      at: "2026-10-15T10:00:00.000Z",
      kind: "PAYOUT",
      title: "Paid out",
      detail:
        "342.00 USD released to devon. Released on the client's approval. Merged 2026-10-15 10:00 UTC: pull request #12, merge commit c0ffee1, approved abcdef1.",
      tone: "ok",
      ids: ["PAYOUT-ITEM-1", "CAPTURE-1"],
      href: null,
    },
    {
      at: "2026-10-15T10:00:00.000Z",
      kind: "RECEIPT",
      title: "Receipt",
      detail: "342.00 USD paid. Frozen tests 48 of 48, hidden tests 6 of 6, attempts 1 of 3.",
      tone: "ok",
      ids: ["rcpt_0001", "abcdef1234567"],
      href: "https://github.com/NDilanka/acquit-demo/pull/12",
    },
  ]);
  assert.equal(events.at(-1)?.title, "Receipt");
  assert.equal(timelineEvents({ ...job, receipt: { ...RECEIPT, source: "SEED" } }).at(-1)?.title, "Receipt (Seeded)");
});

test("paid: the money card holds the held, released, refunded, and fee rows with the fee split", () => {
  const rows = moneyRows(
    {
      ledger: [
        { kind: "HELD", cents: 37800, at: "2026-10-11T08:00:00.000Z" },
        { kind: "RELEASED", cents: 34200, at: "2026-10-15T10:00:00.000Z" },
        { kind: "FEE", cents: 3600, processor: 1100, acquit: 2500, at: "2026-10-15T10:00:00.000Z" },
      ],
    },
    "devon",
  );
  assert.deepEqual(rows, [
    { key: "HELD", label: "Held", cents: 37800, note: "The client's payment, escrow fee included." },
    { key: "RELEASED", label: "Released", cents: 34200, note: "To devon." },
    { key: "REFUND", label: "Refunded", cents: null, note: null },
    { key: "FEE", label: "Fee", cents: 3600, note: "PayPal 11.00 USD, Acquit 25.00 USD." },
  ]);
});

test("refunded: the money card and the timeline both show the refund", () => {
  const rows = moneyRows({ ledger: [{ kind: "REFUND", cents: 37800, at: "2026-10-14T08:00:00.000Z" }] }, "devon");
  assert.deepEqual(rows[2], { key: "REFUND", label: "Refunded", cents: 37800, note: "To the client." });
});

test("the verifier block sits before the first judged attempt, and after the held payment when none is judged", () => {
  const withAttempt = timelineEvents(
    locked({ attempts: { used: 1, left: 2, last: "REJECTED", reasons: rejected.reasons, history: [rejected], pending: null, failure: null } }),
  );
  assert.equal(verifierIndex(withAttempt), 3);
  const noAttempt = timelineEvents(locked({}));
  assert.equal(verifierIndex(noAttempt), noAttempt.length);
  assert.equal(verifierIndex([]), 0);
});

test("a House bid reads as the House, with its receipts line", () => {
  const house = bid({
    id: "bid_house",
    operator: "op_house",
    handle: "house-ledger",
    label: "HOUSE",
    price: 30000,
    eta: 24,
    houseLine: "41 fixes, 39 passed verified CI",
    paidReceipts: 39,
    status: "PENDING",
  });
  const events = timelineEvents({ ...BASE, bids: { operators: [], house } });
  assert.deepEqual(events, [
    {
      at: null,
      kind: "BID",
      title: "House: ledger bid 300.00 USD",
      detail: "1 day. 41 fixes, 39 passed verified CI. Pending.",
      tone: "open",
      ids: ["bid_house"],
      href: null,
    },
  ]);
});

test("disputed and closed read their own next step", () => {
  const disputed = locked({
    status: "VERIFIED",
    phase: "DISPUTED",
    dispute: { reason: "The fix breaks EUR rounding.", openedAt: "2026-10-16T08:00:00.000Z", resolveBy: "2026-10-18T08:00:00.000Z" },
  });
  assert.equal(nextStep(disputed, CLIENT), "The payment is paused. An arbiter decides by 2026-10-18 08:00 UTC.");
  assert.equal(nextStep({ ...BASE, status: "CLOSED", phase: "CLOSED" }, CLIENT), "Closed. Nothing else happens on this job.");
});

function withBid(): TimelineJob {
  return { ...BASE, bids: { operators: [bid({})], house: null } };
}
