import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Attempt, BidView, FiledAnswer, Receipt } from "./api-types.ts";
import { agentLine, lockedBid } from "./bids.ts";
import { canDeliver, moneyRows, nextStep, timelineEvents, verifierIndex, verifierLine, type TimelineJob, type Viewer } from "./job-timeline.ts";

const CLIENT: Viewer = { role: "CLIENT", handle: "ada" };
const OTHER_CLIENT: Viewer = { role: "CLIENT", handle: "grace" };
const DEVON: Viewer = { role: "OPERATOR", handle: "devon" };
const NOA: Viewer = { role: "OPERATOR", handle: "noa" };

const CONTRACT = {
  repository: "NDilanka/acquit-demo",
  issue: 7,
  frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4",
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
  providerDispute: null,
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
  starter: false,
  fundingReturned: false,
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
  frozen: null,
  hidden: null,
};

const twoReasons: Attempt = {
  ...rejected,
  reasons: ["Frozen tests failed: test_a", "Hidden tests did not complete: t9"],
  reasonsTruncated: 2,
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

/** A paid job whose release the client approved. */
function paidJob(over: Partial<TimelineJob> = {}): TimelineJob {
  return {
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
    ...over,
  };
}

/** A refund the attempts ran out for: three rejected or judged deliveries, then the money went back. */
function attemptsExhausted(): TimelineJob {
  return {
    ...BASE,
    status: "REFUNDED",
    phase: "REFUNDED",
    escrow: "REFUNDED",
    refundReason: "ATTEMPTS_EXHAUSTED",
    bids: { operators: [bid({ status: "ACCEPTED" })], house: null },
    lockedTo: "op_devon",
    attempts: { used: 3, left: 0, last: "REJECTED", reasons: ["Frozen tests failed: test_a", "Hidden tests did not complete: t9"], history: [twoReasons], pending: null, failure: null },
    ledger: [
      { kind: "HELD", cents: 37800, at: "2026-10-11T08:00:00.000Z" },
      { kind: "REFUND", cents: 37800, at: "2026-10-14T08:00:00.000Z" },
    ],
  };
}

function withBid(): TimelineJob {
  return { ...BASE, bids: { operators: [bid({})], house: null } };
}

test("open for bids: the client accepts a bid, and an operator who has not bid is asked to place one", () => {
  const open = withBid();
  assert.equal(nextStep(open, CLIENT), "Accept one bid to pay it into escrow.");
  assert.equal(nextStep(open, NOA), "Place a bid. The client accepts one bid to fund escrow.");
  assert.equal(nextStep(open, DEVON), "Your bid is in. The client accepts one bid to fund escrow.");
  assert.equal(nextStep(BASE, CLIENT), "Waiting for the first bid. Accept one to pay it into escrow.");
});

test("open for bids: the timeline shows the frozen contract with no time, then each bid with no time served", () => {
  const events = timelineEvents({ ...withBid(), contract: CONTRACT });
  assert.deepEqual(events, [
    {
      at: null,
      kind: "CONTRACT",
      title: "Acceptance contract frozen",
      detail: "48 visible and 6 hidden tests. Hidden cases sealed.",
      tone: "open",
      ids: [
        { value: "a3b6ead29f4e367d1871e753b516cc9e832871e4", label: "Frozen commit" },
        { value: "9f2c4a7be1d3", label: "Hidden cases sealed" },
      ],
      href: null,
      reasons: [],
    },
    {
      at: null,
      kind: "BID",
      title: "devon bid 360.00 USD",
      detail: "2 days. 4 verified receipts. Pending.",
      tone: "open",
      ids: [{ value: "bid_devon" }],
      href: null,
      reasons: [],
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
    ids: [{ value: "a1b2c3d" }],
    href: null,
    reasons: [],
  });
});

test("rejected attempt: every reason the server sent stays in the line, and only unlisted reasons are counted", () => {
  const both = locked({
    attempts: { used: 1, left: 2, last: "REJECTED", reasons: twoReasons.reasons, history: [{ ...twoReasons, reasonsTruncated: 0 }], pending: null, failure: null },
  });
  assert.equal(timelineEvents(both).at(-1)?.detail, "Frozen tests failed: test_a. Hidden tests did not complete: t9. Escrow still held.");
  const cut = locked({
    attempts: { used: 1, left: 2, last: "REJECTED", reasons: ["Frozen tests failed: test_a", "Hidden tests did not complete: t9"], history: [twoReasons], pending: null, failure: null },
  });
  assert.equal(
    timelineEvents(cut).at(-1)?.detail,
    "Frozen tests failed: test_a. Hidden tests did not complete: t9. 2 more reasons not listed. Escrow still held.",
  );
});

test("rejected attempt with tallies: the job page states the counts first, then the reasons beneath them", () => {
  const counted: Attempt = { ordinal: 1, sourceCommit: "a1b2c3d", at: "2026-10-12T10:00:00.000Z", result: "REJECTED",
    reasons: ["Hidden tests failed: hidden:6"], reasonsTruncated: 0, frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 5 } };
  const job = locked({ attempts: { used: 1, left: 2, last: "REJECTED", reasons: counted.reasons, history: [counted], pending: null, failure: null } });
  const event = timelineEvents(job).at(-1);
  assert.equal(event?.detail, "Passed all 48 visible tests. Failed 1 of 6 hidden tests. Escrow still held.");
  assert.deepEqual(event?.reasons, ["Hidden tests failed: hidden:6."]);
  const partial: Attempt = { ...counted, reasons: ["Frozen tests failed: test_a"], frozen: { expected: 48, passed: 40 }, hidden: { expected: 6, passed: 6 } };
  const partialJob = locked({ attempts: { used: 1, left: 2, last: "REJECTED", reasons: partial.reasons, history: [partial], pending: null, failure: null } });
  const partialEvent = timelineEvents(partialJob).at(-1);
  assert.equal(partialEvent?.detail, "Passed 40 of 48 visible tests. Passed all 6 hidden tests. Escrow still held.");
  assert.deepEqual(partialEvent?.reasons, ["Frozen tests failed: test_a."]);
  const truncated: Attempt = { ...counted, reasonsTruncated: 2 };
  const truncatedJob = locked({ attempts: { used: 1, left: 2, last: "REJECTED", reasons: counted.reasons, history: [truncated], pending: null, failure: null } });
  assert.deepEqual(timelineEvents(truncatedJob).at(-1)?.reasons, ["Hidden tests failed: hidden:6.", "2 more reasons not listed."]);
});

test("rejected attempt with tallies: the reason lines render as their own paragraphs after the detail", () => {
  // The suite has no DOM, so the renderer's wiring is checked in its source, as layout-wrap.test.ts does.
  const source = readFileSync(new URL("./pages/job/Timeline.tsx", import.meta.url), "utf8");
  assert.match(source, /tl-detail">\{event\.detail\}<\/p>\s*\{event\.reasons\.map\(/);
});

test("rejected attempt: a refunded job does not claim escrow is held", () => {
  const events = timelineEvents(attemptsExhausted());
  assert.equal(events.at(-2)?.detail, "Frozen tests failed: test_a. Hidden tests did not complete: t9. 2 more reasons not listed.");
  assert.equal(events.at(-1)?.title, "Refunded to the client");
  assert.equal(events.at(-1)?.detail, "378.00 USD refunded. Refunded after all 3 delivery attempts were used.");
  assert.equal(nextStep(attemptsExhausted(), CLIENT), "Refunded to the client. No money is held.");
});

test("rework: the arbiter's note sits after the verified attempt, and the operator is still asked to deliver", () => {
  const job = locked({
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [verified], pending: null, failure: null },
    arbiterNote: "Fix rounding for returned invoices.",
  });
  assert.deepEqual(timelineEvents(job).slice(-2), [
    {
      at: "2026-10-12T10:00:00.000Z",
      kind: "ATTEMPT",
      title: "Attempt 1 of 3 verified",
      detail: "48 of 48 visible and 6 of 6 hidden tests passed. Pull request #12.",
      tone: "ok",
      ids: [{ value: "e4f5a6b" }],
      href: "https://github.com/NDilanka/acquit-demo/pull/12",
      reasons: [],
    },
    {
      at: null,
      kind: "ARBITER",
      title: "Arbiter sent the work back",
      detail: "Arbiter's note: Fix rounding for returned invoices.",
      tone: "alert",
      ids: [],
      href: null,
      reasons: [],
    },
  ]);
  assert.equal(canDeliver(job, DEVON), true);
});

test("rework followed by a rejected attempt: the arbiter's note stays between the two attempts", () => {
  const second: Attempt = { ...rejected, ordinal: 2, at: "2026-10-13T10:00:00.000Z", sourceCommit: "d7e8f9a" };
  const job = locked({
    attempts: { used: 2, left: 1, last: "REJECTED", reasons: rejected.reasons, history: [verified, second], pending: null, failure: null },
    arbiterNote: "Fix rounding for returned invoices.",
  });
  const events = timelineEvents(job);
  assert.deepEqual(
    events.slice(-3).map((e) => [e.kind, e.title]),
    [
      ["ATTEMPT", "Attempt 1 of 3 verified"],
      ["ARBITER", "Arbiter sent the work back"],
      ["ATTEMPT", "Attempt 2 of 3 rejected"],
    ],
  );
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
      ids: [{ value: "e4f5a6b" }],
      href: "https://github.com/NDilanka/acquit-demo/pull/12",
      reasons: [],
    },
    {
      at: "2026-10-12T10:00:00.000Z",
      kind: "REVIEW",
      title: "Waiting for client review",
      detail: "Approve or dispute by 2026-10-22 12:00 UTC. If the client does nothing, Acquit releases the payment then.",
      tone: "held",
      ids: [],
      href: null,
      reasons: [],
    },
  ]);
});

test("verified awaiting review under a PayPal hold: the review row says the timeout records the release and the payout waits", () => {
  const review = (providerDispute: TimelineJob["providerDispute"]) => timelineEvents(locked({
    status: "VERIFIED",
    phase: "AWAITING_CLIENT",
    viewerCanApprove: true,
    viewerCanDispute: true,
    reviewEndsAt: "2026-10-20T12:00:00.000Z",
    mergeCommit: "e4f5a6b",
    pullRequest: 12,
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [verified], pending: null, failure: null },
    providerDispute,
  })).filter(event => event.kind === "REVIEW");
  // A dispute still open, and one PayPal resolved for the buyer, both hold the payout.
  const holds: TimelineJob["providerDispute"][] = [LIVE_DISPUTE, { ...LIVE_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR" }];
  for (const providerDispute of holds) {
    assert.deepEqual(review(providerDispute), [{
      at: "2026-10-12T10:00:00.000Z",
      kind: "REVIEW",
      title: "Waiting for client review",
      detail: "Approve or dispute by 2026-10-20 12:00 UTC. If the client does nothing, Acquit records the release then, and the payout waits until PayPal decides the dispute.",
      tone: "held",
      ids: [],
      href: null,
      reasons: [],
    }]);
  }
});

test("verified awaiting review with no hold: a dispute PayPal resolved for the seller keeps the review row's wording", () => {
  const job = locked({
    status: "VERIFIED",
    phase: "AWAITING_CLIENT",
    reviewEndsAt: "2026-10-20T12:00:00.000Z",
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [verified], pending: null, failure: null },
    providerDispute: { ...LIVE_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" },
  });
  assert.equal(
    timelineEvents(job).find(event => event.kind === "REVIEW")?.detail,
    "Approve or dispute by 2026-10-20 12:00 UTC. If the client does nothing, Acquit releases the payment then.",
  );
});

test("the arbiter's selected release or refund shows its note before the settlement", () => {
  const note = "Fix rounding for returned invoices.";
  const upheld = locked({
    status: "VERIFIED",
    phase: "RELEASE_PENDING",
    releaseAuthority: "ARBITER_UPHELD",
    arbiterNote: note,
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [verified], pending: null, failure: null },
  });
  assert.equal(nextStep(upheld, CLIENT), "The payment is being released to devon.");
  assert.deepEqual(timelineEvents(upheld).at(-1), {
    at: null,
    kind: "ARBITER",
    title: "Arbiter upheld the work",
    detail: "Arbiter's note: Fix rounding for returned invoices.",
    tone: "ok",
    ids: [],
    href: null,
    reasons: [],
  });

  const refund = locked({
    status: "VERIFIED",
    phase: "REFUND_PENDING",
    refundReason: "ARBITER_REFUND",
    arbiterNote: note,
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [verified], pending: null, failure: null },
  });
  assert.equal(nextStep(refund, CLIENT), "The arbiter's refund is in flight. Nothing to do.");
  assert.deepEqual(timelineEvents(refund).at(-1), {
    at: null,
    kind: "ARBITER",
    title: "Arbiter refunded the client",
    detail: "Arbiter's note: Fix rounding for returned invoices.",
    tone: "new",
    ids: [],
    href: null,
    reasons: [],
  });
});

test("paid: the payout names the approval and the merge, and the receipt is the proof", () => {
  const job = paidJob();
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
      ids: [{ value: "PAYOUT-ITEM-1" }, { value: "CAPTURE-1" }],
      href: null,
      reasons: [],
    },
    {
      at: "2026-10-15T10:00:00.000Z",
      kind: "RECEIPT",
      title: "Receipt",
      detail: "342.00 USD paid. Frozen tests 48 of 48, hidden tests 6 of 6, attempts 1 of 3.",
      tone: "ok",
      ids: [{ value: "rcpt_0001" }, { value: "abcdef1234567" }],
      href: "https://github.com/NDilanka/acquit-demo/pull/12",
      reasons: [],
    },
  ]);
  assert.equal(events.at(-1)?.title, "Receipt");
  assert.equal(timelineEvents({ ...job, receipt: { ...RECEIPT, source: "SEED" } }).at(-1)?.title, "Receipt (Seeded)");
});

test("paid after the arbiter upheld the work: the note sits before the payout, and the payout does not repeat it", () => {
  const job = paidJob({ releaseAuthority: "ARBITER_UPHELD", arbiterNote: "Fix rounding for returned invoices." });
  const events = timelineEvents(job);
  assert.deepEqual(events.slice(-3)[0], {
    at: null,
    kind: "ARBITER",
    title: "Arbiter upheld the work",
    detail: "Arbiter's note: Fix rounding for returned invoices.",
    tone: "ok",
    ids: [],
    href: null,
    reasons: [],
  });
  assert.equal(
    events.slice(-2)[0]?.detail,
    "342.00 USD released to devon. Released by the arbiter. Merged 2026-10-15 10:00 UTC: pull request #12, merge commit c0ffee1, approved abcdef1.",
  );
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

test("the verifier line keeps the held warning only while escrow is held", () => {
  assert.equal(verifierLine(locked({})), "0 of 3 attempts used. A rejection keeps escrow held.");
  assert.equal(verifierLine(attemptsExhausted()), "3 of 3 attempts used. Escrow was refunded to the client.");
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
      ids: [{ value: "bid_house" }],
      href: null,
      reasons: [],
      house: "agent",
    },
  ]);
});

test("another client reads as an observer, not the owning client", () => {
  const open = withBid();
  assert.equal(nextStep(open, OTHER_CLIENT), "The client accepts one bid to fund escrow.");
  assert.equal(nextStep(BASE, OTHER_CLIENT), "The client accepts one bid to fund escrow.");
  // The projection serves client null to a viewer who does not own the job.
  assert.equal(nextStep({ ...open, client: null }, CLIENT), "The client accepts one bid to fund escrow.");

  const funding: TimelineJob = {
    ...open,
    bids: { operators: [bid({ status: "ACCEPTED" })], house: null },
    status: "OPEN",
    phase: "FUNDING",
    checkoutPhase: "AWAITING_APPROVAL",
  };
  assert.equal(nextStep(funding, CLIENT), "Approve the payment on PayPal to hold it in escrow.");
  assert.equal(
    nextStep(funding, OTHER_CLIENT),
    "The client is approving the payment on PayPal. Escrow holds the money once it does.",
  );
});

test("disputed and closed read their own next step", () => {
  const disputed = locked({
    status: "VERIFIED",
    phase: "DISPUTED",
    dispute: { reason: "The fix breaks EUR rounding.", openedAt: "2026-10-16T08:00:00.000Z", resolveBy: "2026-10-18T08:00:00.000Z" },
  });
  assert.equal(nextStep(disputed, CLIENT), "The payment is paused. An arbiter decides by 2026-10-18 08:00 UTC, or the payout releases to the operator.");
  assert.equal(nextStep({ ...BASE, status: "CLOSED", phase: "CLOSED" }, CLIENT), "Closed. Nothing else happens on this job.");
});

const BUYER_DISPUTE: NonNullable<TimelineJob["providerDispute"]> = {
  id: "PAYPAL-DISPUTE-1",
  status: "OPEN",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  amount: 37800,
  openedAt: "2026-10-16T09:00:00.000Z",
  outcome: null,
  answer: null,
  answerState: null,
  stage: null,
  requestedEvidence: null,
  evidenceType: null,
  answerRound: null,
  answerStage: null,
  answerNote: null,
  answerHistory: [],
  unconfirmed: false,
  simulated: false,
};

/** The live record of job_9d04e3b8: its payment held while PayPal reviews a chargeback, PayPal asking for refund proof or other evidence. */
const LIVE_DISPUTE: NonNullable<TimelineJob["providerDispute"]> = {
  ...BUYER_DISPUTE,
  id: "PP-R-PPB-10194003",
  status: "UNDER_REVIEW",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  amount: 2100,
  answer: "EVIDENCE",
  answerState: { state: "FILED" },
  stage: "CHARGEBACK",
  requestedEvidence: ["PROOF_OF_REFUND", "OTHER"],
  evidenceType: "OTHER",
};

/** An approved job whose release a PayPal buyer dispute holds, or has resolved. */
function approvedWithDispute(providerDispute: TimelineJob["providerDispute"]): TimelineJob {
  return locked({
    status: "VERIFIED",
    phase: "RELEASE_PENDING",
    releaseAuthority: "CLIENT_APPROVAL",
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [verified], pending: null, failure: null },
    providerDispute,
  });
}

test("a buyer's PayPal dispute on an approved job says the buyer opened it, and that the payout is held", () => {
  const job = approvedWithDispute(BUYER_DISPUTE);
  assert.equal(nextStep(job, CLIENT), "The payout is held because of a buyer's PayPal dispute. Nothing to do.");
  assert.equal(nextStep(job, DEVON), "The payout is held because of a buyer's PayPal dispute. Nothing to do.");
  assert.deepEqual(timelineEvents(job).slice(-2), [
    {
      at: "2026-10-16T09:00:00.000Z",
      kind: "DISPUTE",
      title: "Buyer opened a PayPal dispute (merchandise or service not received)",
      detail: "378.00 USD disputed with PayPal.",
      tone: "alert",
      ids: [{ value: "PAYPAL-DISPUTE-1", label: "PayPal dispute" }],
      href: null,
      reasons: [],
    },
    {
      at: null,
      kind: "DISPUTE",
      title: "Payment held while PayPal reviews the buyer's dispute",
      detail: "PayPal has the dispute open. The approval is recorded. The payout waits until PayPal decides the dispute for the seller.",
      tone: "held",
      ids: [],
      href: null,
      reasons: [],
    },
  ]);
});

test("PayPal deciding a buyer's dispute for the seller lifts the hold, and the timeline says so before the payout", () => {
  const job = approvedWithDispute({ ...BUYER_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" });
  assert.equal(nextStep(job, CLIENT), "The payment is being released to devon.");
  assert.deepEqual(timelineEvents(job).at(-1), {
    at: null,
    kind: "DISPUTE",
    title: "PayPal resolved the dispute for the seller",
    detail: "Nothing holds the payout for this dispute now.",
    tone: "ok",
    ids: [],
    href: null,
    reasons: [],
  });
});

test("PayPal deciding a buyer's dispute for the buyer keeps the payout held, and the timeline says the money is undecided", () => {
  const job = approvedWithDispute({ ...BUYER_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR" });
  assert.equal(nextStep(job, CLIENT), "The payout is held because of a buyer's PayPal dispute. Nothing to do.");
  assert.deepEqual(timelineEvents(job).at(-1), {
    at: null,
    kind: "DISPUTE",
    title: "PayPal resolved the dispute for the buyer",
    detail: "The payout stays held. Acquit has not decided what becomes of the money.",
    tone: "alert",
    ids: [],
    href: null,
    reasons: [],
  });
});

test("a paid job keeps the buyer's dispute in order before the payout, and no hold line", () => {
  const job = paidJob({ providerDispute: { ...BUYER_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" } });
  const titles = timelineEvents(job).map(event => event.title);
  assert.ok(titles.indexOf("Buyer opened a PayPal dispute (merchandise or service not received)") < titles.indexOf("PayPal resolved the dispute for the seller"));
  assert.ok(titles.indexOf("PayPal resolved the dispute for the seller") < titles.indexOf("Paid out"));
  assert.equal(titles.includes("Payment held while PayPal reviews the buyer's dispute"), false);
  assert.equal(nextStep(job, CLIENT), "Paid to devon. The receipt below is the proof.");
});

test("the dispute timeline says what Acquit filed with PayPal, and marks a scripted answer as Simulated", () => {
  const titles = (job: TimelineJob) => timelineEvents(job).filter(event => event.kind === "DISPUTE").map(event => event.title);
  const opened = "Buyer opened a PayPal dispute (merchandise or service not received)";
  const held = "Payment held while PayPal reviews the buyer's dispute";
  const filed = { state: "FILED" } as const;
  assert.deepEqual(titles(approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: filed })),
    [opened, "Acquit filed its verified attempt as evidence with PayPal", held]);
  assert.deepEqual(titles(approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: filed, simulated: true })),
    [opened, "Acquit filed its verified attempt as evidence with PayPal (Simulated)", held]);
  assert.deepEqual(titles(approvedWithDispute({ ...BUYER_DISPUTE, answer: "ACCEPT", answerState: filed })), [opened, "Acquit accepted the buyer's claim", held]);
  assert.deepEqual(titles(approvedWithDispute({ ...BUYER_DISPUTE, answer: "NOT_ANSWERABLE" })),
    [opened, "Acquit could not answer this dispute on its own", held]);
  assert.deepEqual(titles(paidJob({ providerDispute: { ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: filed } })),
    [opened, "Acquit filed the receipt as evidence with PayPal"]);
});

test("an answer PayPal has not confirmed yet is said to be queued, not filed", () => {
  const job = approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: { state: "QUEUED" } });
  assert.deepEqual(timelineEvents(job).find(event => event.title.startsWith("Acquit is sending")), {
    at: null,
    kind: "DISPUTE",
    title: "Acquit is sending its verified attempt as evidence to PayPal",
    detail: "PayPal has not confirmed the evidence yet.",
    tone: "held",
    ids: [{ value: "PAYPAL-DISPUTE-1", label: "PayPal dispute" }],
    href: null,
    reasons: [],
  });
  assert.equal(timelineEvents(job).some(event => event.title.startsWith("Acquit filed")), false);
});

test("an answer PayPal refused says so with the plain reason, says the payment stays held, and never says filed", () => {
  const refused = { state: "REFUSED", reason: "PayPal has not given Acquit dispute access for this merchant" } as const;
  const job = approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: refused });
  assert.deepEqual(timelineEvents(job).find(event => event.title.startsWith("PayPal refused")), {
    at: null,
    kind: "DISPUTE",
    title: "PayPal refused Acquit's answer: PayPal has not given Acquit dispute access for this merchant. The payment stays held.",
    detail: "Acquit's answer did not reach PayPal. An alert went to a person.",
    tone: "alert",
    ids: [{ value: "PAYPAL-DISPUTE-1", label: "PayPal dispute" }],
    href: null,
    reasons: [],
  });
  const titles = timelineEvents(job).map(event => event.title);
  assert.equal(titles.some(title => title.includes("filed") || title.includes("accepted") || title.includes("sending")), false);
  assert.equal(nextStep(job, CLIENT), "The payout is held because of a buyer's PayPal dispute. Nothing to do.");
});

test("an evidence type PayPal refused, and a generic 400, read in plain words, and no PayPal code reaches the timeline", () => {
  const refusedType = { state: "REFUSED", reason: "PAYPAL_400_EVIDENCE_TYPE_IS_NOT_ALLOWED", evidenceType: "PROOF_OF_FULFILLMENT" } as const;
  const typeTitle = timelineEvents(approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: refusedType }))
    .find(event => event.title.startsWith("PayPal refused"))?.title;
  assert.equal(typeTitle, "PayPal refused Acquit's answer: PayPal refused the evidence type. The payment stays held.");
  const generic = { state: "REFUSED", reason: "PAYPAL_HTTP_400" } as const;
  const genericTitle = timelineEvents(approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: generic }))
    .find(event => event.title.startsWith("PayPal refused"))?.title;
  assert.equal(genericTitle, "PayPal refused Acquit's answer: PayPal refused the answer as invalid. The payment stays held.");
  const noHonest = { state: "REFUSED", reason: "PayPal asked only for evidence Acquit cannot give" } as const;
  const noHonestTitle = timelineEvents(approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: noHonest }))
    .find(event => event.title.startsWith("PayPal refused"))?.title;
  assert.equal(noHonestTitle, "PayPal refused Acquit's answer: PayPal asked only for evidence Acquit cannot give. The payment stays held.");
  assert.equal([typeTitle, genericTitle].some(title => title?.includes("PAYPAL_")), false);
});

test("a buyer dispute known only from PayPal's signed notice says the read was refused, and holds the payout whatever its outcome", () => {
  const job = approvedWithDispute({ ...BUYER_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR", unconfirmed: true });
  assert.equal(nextStep(job, CLIENT), "The payout is held because of a buyer's PayPal dispute. Nothing to do.");
  const titles = timelineEvents(job).map(event => event.title);
  assert.equal(titles.at(-1), "PayPal refused the dispute read; release or refund not confirmed");
  assert.equal(titles.includes("PayPal resolved the dispute for the seller"), false);
});

test("a dispute known only from PayPal's signed notice while it is open says the read was refused and the payment stays held", () => {
  const job = approvedWithDispute({ ...BUYER_DISPUTE, unconfirmed: true });
  assert.equal(nextStep(job, CLIENT), "The payout is held because of a buyer's PayPal dispute. Nothing to do.");
  const titles = timelineEvents(job).map(event => event.title);
  assert.equal(titles.at(-1), "PayPal refused the dispute read; the dispute is open and the payment stays held");
  assert.equal(titles.some(title => title.includes("release or refund not confirmed")), false);
});

test("a receipt PayPal took as a message says so on the dispute, queued or filed, and marks a scripted one as Simulated", () => {
  const message = (job: TimelineJob) => timelineEvents(job).find(event => event.kind === "DISPUTE" && event.title.includes("message"));
  const queued = approvedWithDispute({ ...BUYER_DISPUTE, answer: "MESSAGE", answerState: { state: "QUEUED" } });
  assert.deepEqual(message(queued), {
    at: null,
    kind: "DISPUTE",
    title: "Acquit is sending its verified attempt as a message to PayPal on dispute PAYPAL-DISPUTE-1",
    detail: "PayPal has not confirmed the message yet.",
    tone: "held",
    ids: [{ value: "PAYPAL-DISPUTE-1", label: "PayPal dispute" }],
    href: null,
    reasons: [],
  });
  const filed = { state: "FILED" } as const;
  assert.equal(message(approvedWithDispute({ ...BUYER_DISPUTE, answer: "MESSAGE", answerState: filed }))?.title,
    "Acquit sent PayPal its verified attempt as a message on dispute PAYPAL-DISPUTE-1");
  assert.equal(message(approvedWithDispute({ ...BUYER_DISPUTE, answer: "MESSAGE", answerState: filed, simulated: true }))?.title,
    "Acquit sent PayPal its verified attempt as a message on dispute PAYPAL-DISPUTE-1 (Simulated)");
  assert.equal(message(paidJob({ providerDispute: { ...BUYER_DISPUTE, answer: "MESSAGE", answerState: filed } }))?.title,
    "Acquit sent PayPal the receipt as a message on dispute PAYPAL-DISPUTE-1");
  assert.equal(message(approvedWithDispute({ ...BUYER_DISPUTE, answer: "MESSAGE", answerState: filed }))?.detail,
    "The message names the frozen and hidden test counts, the pull request, and the judged commit.");
});

/** The answers PayPal took on the live record: an inquiry message, then the chargeback evidence that escalated it. */
const FILED_HISTORY: readonly FiledAnswer[] = [
  { answer: "MESSAGE", round: "inquiry-round", stage: "INQUIRY", filedAt: "2026-10-16T10:00:00.000Z" },
  { answer: "EVIDENCE", round: "chargeback-round", stage: "CHARGEBACK", evidenceType: "OTHER", filedAt: "2026-10-17T10:00:00.000Z" },
];

test("the timeline shows each answer PayPal took once, oldest first, with the stage it went under, and the current answer once", () => {
  const job = approvedWithDispute({ ...LIVE_DISPUTE, answerRound: "chargeback-round", answerHistory: FILED_HISTORY });
  const disputes = timelineEvents(job).filter(event => event.kind === "DISPUTE");
  assert.deepEqual(disputes.map(event => event.title), [
    "Buyer opened a PayPal dispute (merchandise or service not received)",
    "Acquit sent PayPal its verified attempt as a message on dispute PP-R-PPB-10194003 (inquiry)",
    "Acquit filed its verified attempt as Other evidence with PayPal (chargeback)",
    "Payment held while PayPal reviews the buyer's dispute",
  ]);
  assert.deepEqual(disputes[1], {
    at: "2026-10-16T10:00:00.000Z",
    kind: "DISPUTE",
    title: "Acquit sent PayPal its verified attempt as a message on dispute PP-R-PPB-10194003 (inquiry)",
    detail: "The message names the frozen and hidden test counts, the pull request, and the judged commit.",
    tone: "held",
    ids: [{ value: "PP-R-PPB-10194003", label: "PayPal dispute" }],
    href: null,
    reasons: [],
  });
  assert.equal(disputes[2]?.at, "2026-10-17T10:00:00.000Z");
});

test("a queued answer after a filed one shows both, each once, and a refused one shows its refusal after the history", () => {
  const queued = approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: { state: "QUEUED" }, answerRound: "chargeback-round", answerHistory: [FILED_HISTORY[0]!] });
  assert.deepEqual(timelineEvents(queued).filter(event => event.kind === "DISPUTE").map(event => event.title), [
    "Buyer opened a PayPal dispute (merchandise or service not received)",
    "Acquit sent PayPal its verified attempt as a message on dispute PAYPAL-DISPUTE-1 (inquiry)",
    "Acquit is sending its verified attempt as evidence to PayPal",
    "Payment held while PayPal reviews the buyer's dispute",
  ]);
  const refused = { state: "REFUSED", reason: "PAYPAL_400_EVIDENCE_TYPE_IS_NOT_ALLOWED", evidenceType: "PROOF_OF_FULFILLMENT" } as const;
  const refusal = approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: refused, answerRound: "chargeback-round", answerHistory: [FILED_HISTORY[0]!] });
  assert.deepEqual(timelineEvents(refusal).filter(event => event.kind === "DISPUTE").map(event => event.title), [
    "Buyer opened a PayPal dispute (merchandise or service not received)",
    "Acquit sent PayPal its verified attempt as a message on dispute PAYPAL-DISPUTE-1 (inquiry)",
    "PayPal refused Acquit's answer: PayPal refused the evidence type. The payment stays held.",
    "Payment held while PayPal reviews the buyer's dispute",
  ]);
});

test("a record stored before the history was kept shows its current answer as it did, and an accepted or paid history entry reads in its own words", () => {
  const legacy = approvedWithDispute({ ...BUYER_DISPUTE, answer: "MESSAGE", answerState: { state: "FILED" }, answerRound: "inquiry-round", answerHistory: [] });
  assert.deepEqual(timelineEvents(legacy).filter(event => event.kind === "DISPUTE").map(event => event.title), [
    "Buyer opened a PayPal dispute (merchandise or service not received)",
    "Acquit sent PayPal its verified attempt as a message on dispute PAYPAL-DISPUTE-1",
    "Payment held while PayPal reviews the buyer's dispute",
  ]);
  const accepted: FiledAnswer[] = [{ answer: "ACCEPT", round: "chargeback-round", stage: "CHARGEBACK", filedAt: "2026-10-17T10:00:00.000Z" }];
  const titles = (job: TimelineJob) => timelineEvents(job).filter(event => event.kind === "DISPUTE").map(event => event.title);
  assert.equal(titles(approvedWithDispute({ ...BUYER_DISPUTE, answerHistory: accepted, simulated: true }))[1],
    "Acquit accepted the buyer's claim (chargeback) (Simulated)");
  const paid: FiledAnswer[] = [{ answer: "EVIDENCE", round: "chargeback-round", evidenceType: "PROOF_OF_FULFILLMENT", filedAt: "2026-10-17T10:00:00.000Z" }];
  assert.equal(titles(paidJob({ providerDispute: { ...BUYER_DISPUTE, answerHistory: paid } }))[1],
    "Acquit filed the receipt as Proof of fulfilment with PayPal");
});

test("the current answer names the stage it was filed under, queued, filed, or refused, and names none where the record has none", () => {
  const titles = (fields: Partial<NonNullable<TimelineJob["providerDispute"]>>) =>
    timelineEvents(approvedWithDispute({ ...BUYER_DISPUTE, answerRound: "chargeback-round", ...fields }))
      .filter(event => event.kind === "DISPUTE").map(event => event.title);
  const refused = { state: "REFUSED", reason: "PAYPAL_400_EVIDENCE_TYPE_IS_NOT_ALLOWED", evidenceType: "PROOF_OF_FULFILLMENT" } as const;
  assert.equal(titles({ answer: "EVIDENCE", answerState: { state: "QUEUED" }, answerStage: "CHARGEBACK" })[1],
    "Acquit is sending its verified attempt as evidence to PayPal (chargeback)");
  assert.equal(titles({ answer: "EVIDENCE", answerState: { state: "FILED" }, evidenceType: "OTHER", answerStage: "CHARGEBACK", simulated: true })[1],
    "Acquit filed its verified attempt as Other evidence with PayPal (chargeback) (Simulated)");
  assert.equal(titles({ answer: "MESSAGE", answerState: { state: "QUEUED" }, answerStage: "INQUIRY" })[1],
    "Acquit is sending its verified attempt as a message to PayPal on dispute PAYPAL-DISPUTE-1 (inquiry)");
  assert.equal(titles({ answer: "EVIDENCE", answerState: refused, answerStage: "CHARGEBACK" })[1],
    "PayPal refused Acquit's answer (chargeback): PayPal refused the evidence type. The payment stays held.");
  assert.equal(titles({ answer: "ACCEPT", answerState: { state: "QUEUED" }, answerStage: "ARBITRATION" })[1],
    "Acquit is sending its acceptance of the buyer's claim to PayPal (arbitration)");
  assert.equal(titles({ answer: "EVIDENCE", answerState: { state: "QUEUED" }, answerStage: null })[1],
    "Acquit is sending its verified attempt as evidence to PayPal");
});

test("an answer PayPal did not take reads as not taken, names why, and is never called filed or sent", () => {
  const notTaken = (fields: Partial<NonNullable<TimelineJob["providerDispute"]>>) =>
    timelineEvents(approvedWithDispute({ ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: { state: "FILED" }, answerRound: "chargeback-round",
      answerStage: "CHARGEBACK", answerNote: "PAYPAL_422_DISPUTE_NOT_IN_OPEN_STATE", ...fields }))
      .filter(event => event.kind === "DISPUTE");
  // The answer before it was taken stays in the history, and the answer PayPal did not take is named after it.
  const settled = notTaken({ answerHistory: [FILED_HISTORY[0]!] });
  assert.deepEqual(settled.map(event => event.title), [
    "Buyer opened a PayPal dispute (merchandise or service not received)",
    "Acquit sent PayPal its verified attempt as a message on dispute PAYPAL-DISPUTE-1 (inquiry)",
    "PayPal did not take Acquit's answer (chargeback): the dispute was no longer open to it.",
    "Payment held while PayPal reviews the buyer's dispute",
  ]);
  assert.deepEqual(settled[2], {
    at: null,
    kind: "DISPUTE",
    title: "PayPal did not take Acquit's answer (chargeback): the dispute was no longer open to it.",
    detail: "PayPal took nothing from the answer, so the answer history keeps no entry for it. No alert went to a person.",
    tone: "alert",
    ids: [{ value: "PAYPAL-DISPUTE-1", label: "PayPal dispute" }],
    href: null,
    reasons: [],
  });
  // An ALREADY note says PayPal held an answer to the dispute already, and a message that PayPal did not take reads the same way.
  assert.equal(notTaken({ answer: "MESSAGE", answerStage: "INQUIRY", answerRound: "inquiry-round", answerNote: "PAYPAL_422_ANSWER_ALREADY_SUBMITTED" })[1]?.title,
    "PayPal did not take Acquit's answer (inquiry): PayPal already held an answer to the dispute.");
  // The same plain title on a paid job, where the answer is the receipt: the words name no receipt and no filing.
  assert.equal(timelineEvents(paidJob({ providerDispute: { ...BUYER_DISPUTE, answer: "EVIDENCE", answerState: { state: "FILED" }, answerRound: "chargeback-round",
    answerNote: "PAYPAL_422_DISPUTE_NOT_IN_OPEN_STATE" } })).find(event => event.kind === "DISPUTE" && event.title.startsWith("PayPal did not"))?.title,
    "PayPal did not take Acquit's answer: the dispute was no longer open to it.");
});

test("the arbiter deadline names the hold while PayPal holds the payout, on the dispute row and the next step, and not after PayPal decides for the seller", () => {
  const disputed = (providerDispute: TimelineJob["providerDispute"]) => locked({
    status: "VERIFIED",
    phase: "DISPUTED",
    providerDispute,
    dispute: { reason: "The fix breaks EUR rounding.", openedAt: "2026-10-16T08:00:00.000Z", resolveBy: "2026-10-18T08:00:00.000Z" },
  });
  const detail = (job: TimelineJob) => timelineEvents(job).find(event => event.title === "Disputed by the client")?.detail;
  const held = disputed(BUYER_DISPUTE);
  assert.equal(nextStep(held, CLIENT), "The payment is paused. An arbiter decides by 2026-10-18 08:00 UTC, or Acquit records the release for the operator, and the payout waits until PayPal decides the dispute.");
  assert.equal(detail(held), "The fix breaks EUR rounding. The arbiter decides by 2026-10-18 08:00 UTC, or Acquit records the release for the operator, and the payout waits until PayPal decides the dispute. The review clock is paused.");
  const seller = disputed({ ...BUYER_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" });
  assert.equal(nextStep(seller, CLIENT), "The payment is paused. An arbiter decides by 2026-10-18 08:00 UTC, or the payout releases to the operator.");
  assert.equal(detail(seller), "The fix breaks EUR rounding. The arbiter decides by 2026-10-18 08:00 UTC, or the payout releases to the operator. The review clock is paused.");
});

test("the dispute form says what the deadline does with the payout, and the hold changes it", () => {
  // The suite has no DOM, so the wiring is checked in the page's source, as the tests above do.
  const source = readFileSync(new URL("./pages/JobPage.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ deadlineOutcome, escrowFee, eta, refundNote, usd, utc \} from "\.\.\/format";/);
  assert.match(source, /If no decision comes by then, \{deadlineOutcome\(disputeHolds\)\}<\/small>/);
  assert.match(source, /const disputeHolds = payoutHeldBy\(job\.providerDispute\);/);
});

test("a buyer dispute whose amount could not be read says so instead of a number", () => {
  const job = approvedWithDispute({ ...BUYER_DISPUTE, amount: null });
  assert.equal(timelineEvents(job).find(event => event.title.startsWith("Buyer opened"))?.detail, "Disputed with PayPal. The amount could not be read.");
});

test("a buyer's win settled as a refund says the escrow was returned to the buyer, and holds no payout", () => {
  const job: TimelineJob = { ...attemptsExhausted(), refundReason: "PROVIDER_DISPUTE",
    providerDispute: { ...BUYER_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR", answer: "EVIDENCE" } };
  assert.deepEqual(timelineEvents(job).find(event => event.title.startsWith("PayPal resolved the dispute for the buyer")), {
    at: null,
    kind: "DISPUTE",
    title: "PayPal resolved the dispute for the buyer. The escrow was returned to the buyer.",
    detail: "Acquit settled the job as refunded. No refund call went to PayPal, because PayPal had already reversed the funds.",
    tone: "alert",
    ids: [],
    href: null,
    reasons: [],
  });
  const titles = timelineEvents(job).map(event => event.title);
  assert.equal(titles.includes("Payment held while PayPal reviews the buyer's dispute"), false);
});

test("a buyer's win on a paid job says the payout had already left, and holds nothing", () => {
  const job = paidJob({ providerDispute: { ...BUYER_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR", answer: "EVIDENCE" } });
  assert.deepEqual(timelineEvents(job).find(event => event.title.startsWith("PayPal resolved the dispute for the buyer")), {
    at: null,
    kind: "DISPUTE",
    title: "PayPal resolved the dispute for the buyer after the payout left",
    detail: "The payout had already left. Acquit has not decided what becomes of the money.",
    tone: "alert",
    ids: [],
    href: null,
    reasons: [],
  });
});

test("a live dispute on a job awaiting review holds the payment in plain words, and names what PayPal asked and what Acquit filed", () => {
  const job = locked({
    status: "VERIFIED",
    phase: "AWAITING_CLIENT",
    reviewEndsAt: "2026-10-20T12:00:00.000Z",
    viewerCanApprove: true,
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [verified], pending: null, failure: null },
    providerDispute: LIVE_DISPUTE,
  });
  assert.equal(nextStep(job, CLIENT), "Approve to record the release, or dispute by 2026-10-20 12:00 UTC. PayPal holds the payout while it reviews the buyer's dispute, so nothing pays out yet.");
  assert.equal(nextStep(job, DEVON), "The client reviews until 2026-10-20 12:00 UTC. PayPal holds the payout while it reviews the buyer's dispute, so nothing pays out yet.");
  const disputes = timelineEvents(job).filter(event => event.kind === "DISPUTE");
  assert.deepEqual(disputes.map(event => event.title), [
    "Buyer opened a PayPal dispute (merchandise or service not received)",
    "Acquit filed its verified attempt as Other evidence with PayPal",
    "Payment held while PayPal reviews the buyer's dispute",
  ]);
  assert.equal(disputes[1]?.detail, "PayPal asked for refund proof or other evidence. Acquit made no refund, so it cannot send refund proof. The evidence names the frozen and hidden test counts, the pull request, and the judged commit.");
  assert.deepEqual(disputes[2], {
    at: null,
    kind: "DISPUTE",
    title: "Payment held while PayPal reviews the buyer's dispute",
    detail: "PayPal is reviewing the chargeback. Approving records the release, but the payout waits until PayPal decides the dispute for the seller.",
    tone: "held",
    ids: [],
    href: null,
    reasons: [],
  });
});

test("PayPal's waiting stages say who PayPal waits for, and the payment stays held", () => {
  const job = approvedWithDispute({ ...BUYER_DISPUTE, status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY" });
  assert.deepEqual(timelineEvents(job).find(event => event.kind === "DISPUTE" && event.title.startsWith("Payment held")), {
    at: null,
    kind: "DISPUTE",
    title: "Payment held while PayPal reviews the buyer's dispute",
    detail: "PayPal is waiting for the seller's answer. The approval is recorded. The payout waits until PayPal decides the dispute for the seller.",
    tone: "held",
    ids: [],
    href: null,
    reasons: [],
  });
  const buyer = approvedWithDispute({ ...BUYER_DISPUTE, status: "WAITING_FOR_BUYER_RESPONSE", stage: "INQUIRY" });
  assert.equal(timelineEvents(buyer).find(event => event.kind === "DISPUTE" && event.title.startsWith("Payment held"))?.detail,
    "PayPal is waiting for the buyer. The approval is recorded. The payout waits until PayPal decides the dispute for the seller.");
});

test("a dispute PayPal resolved for the seller gives no hold row, in review or after approval", () => {
  const resolved = { ...LIVE_DISPUTE, status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" };
  const review = locked({ status: "VERIFIED", phase: "AWAITING_CLIENT", reviewEndsAt: "2026-10-20T12:00:00.000Z", providerDispute: resolved });
  for (const job of [review, approvedWithDispute(resolved)]) {
    assert.equal(timelineEvents(job).some(event => event.kind === "DISPUTE" && event.title.startsWith("Payment held")), false);
  }
  assert.equal(timelineEvents(review).at(-1)?.title, "PayPal resolved the dispute for the seller");
});

test("the job page gives the platform no action: it is named read-only, and no bid, approval, or dispute is offered to it", () => {
  // The suite has no DOM, so the wiring is checked in the page's source, as the tests above do.
  const source = readFileSync(new URL("./pages/JobPage.tsx", import.meta.url), "utf8");
  assert.match(source, /\{platform && <p className="muted">Viewing as the platform\. Read only\.<\/p>\}/);
  assert.match(source, /const mergeCommit = !platform && job\.viewerCanApprove/);
  assert.match(source, /const disputeCommit = !platform && job\.viewerCanDispute/);
  assert.match(source, /\{!isClient && !platform && bidding/);
});

test("the agent line names the declared agent and the operator or House that named it", () => {
  assert.equal(agentLine(bid({ handle: "devon-ops", agent: "nemotron-3-ultra-free" })), "Agent nemotron-3-ultra-free, named by devon-ops.");
  assert.equal(
    agentLine(bid({ id: "bid_house", operator: "op_house", handle: "house-ledger", label: "HOUSE", agent: "nemotron-3-ultra-free" })),
    "Agent nemotron-3-ultra-free, named by House: ledger.",
  );
});

test("the job page names the locked agent above the attempts, and only when a bid is locked", () => {
  // The suite has no DOM, so the wiring is checked in the page's source, as the Timeline test above does.
  const source = readFileSync(new URL("./pages/JobPage.tsx", import.meta.url), "utf8");
  assert.match(source, /\{locked && <p className="pad verifier-agent">\{agentLine\(locked\)\}<\/p>\}/);
  assert.ok(source.indexOf("{agentLine(locked)}") < source.indexOf("{failure && !readOnly && ("));
  assert.match(source, /<Verifier job=\{timeline\} diff=\{diff\} locked=\{locked\} readOnly=\{settledStatuses\.includes\(job\.status\)\} \/>/);
});

test("a PAID job keeps its verifier card with the agent line, read-only: PAID stays in the status list and the card asks for nothing", () => {
  const source = readFileSync(new URL("./pages/JobPage.tsx", import.meta.url), "utf8");
  // The status list decides which jobs show the card. Removing "PAID" from it fails this line.
  assert.match(source, /const judgedStatuses: readonly JobView\["status"\]\[\] = \[[^\]]*"PAID"[^\]]*\];/);
  assert.match(source, /const settledStatuses: readonly JobView\["status"\]\[\] = \["PAID", "CLOSED"\];/);
  assert.match(source, /verifier=\{showsVerifier\(job\) \? <Verifier/);
  // The fixture is a paid job whose locked bid names devon's agent, so the card's agent line has its text.
  assert.equal(agentLine(lockedBid(paidJob())!), "Agent ts-bugfixer, named by devon.");
  for (const prompt of ["{failure && !readOnly && (", "{pending && !readOnly && (", "{idle && !readOnly && ("]) {
    assert.ok(source.includes(prompt), `${prompt} keeps the prompt off a settled job`);
  }
});

test("a starter job's next step names the House client's timing, and its House parties carry the badge", () => {
  const starter: TimelineJob = { ...BASE, starter: true };
  assert.equal(nextStep(starter, NOA), "Place a bid. The House client accepts the best bid in about 30 seconds.");
  assert.equal(nextStep({ ...starter, bids: { operators: [bid({})], house: null } }, DEVON),
    "Your bid is in. The House client accepts the best bid in about 30 seconds.");
  assert.equal(nextStep({ ...starter, fundingReturned: true, bids: { operators: [bid({})], house: null } }, DEVON),
    "The House client's payment did not go through. The job is open for bids again.");
  const review = { ...locked({}), starter: true, status: "VERIFIED" as const, phase: "AWAITING_CLIENT" as const, reviewEndsAt: "2026-10-27T09:00:00.000Z" };
  // The silence sentence stays: it is true whether or not the House client has approved by then.
  assert.equal(nextStep(review, DEVON), "Verified. The House client approves in about a minute. If it does not, Acquit releases the payment then.");
  assert.deepEqual(timelineEvents(review).filter((event) => event.house).map((event) => [event.kind, event.house]),
    [["HELD", "client"], ["REVIEW", "client"]]);
  // The paid line "Released on the client's approval" carries the badge too, so the payout names the House client.
  const paid = { ...paidJob({}), starter: true };
  assert.equal(timelineEvents(paid).find((event) => event.kind === "PAYOUT")?.detail,
    "342.00 USD released to devon. Released on the client's approval. Merged 2026-10-15 10:00 UTC: pull request #12, merge commit c0ffee1, approved abcdef1.");
  assert.deepEqual(timelineEvents(paid).filter((event) => event.house).map((event) => [event.kind, event.house]),
    [["HELD", "client"], ["PAYOUT", "client"]]);
  assert.equal(timelineEvents({ ...review, starter: false }).some((event) => event.house), false);
  assert.equal(timelineEvents({ ...paid, starter: false }).some((event) => event.house), false);
});
