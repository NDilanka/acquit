import assert from "node:assert/strict";
import { test } from "node:test";
import type { Attempt, BidView, PhysicalContract, Receipt } from "./api-types.ts";
import type { TimelineEvent, TimelineJob } from "./job-timeline.ts";
import { isLaserJob, laserDelivery, laserNextLine, laserTimelineEvents, specRows } from "./laser-job.ts";

const SPEC = {
  material: "acrylic",
  thicknessMm: 3,
  bedMm: [300, 200],
  partMm: [120, 80],
  kerfMm: 0.2,
  toleranceMm: 0.1,
  minWebMm: 3,
  holes: [{ id: "mount-a" }, { id: "mount-b" }, { id: "mount-c" }, { id: "mount-d" }],
  slots: [{ id: "window" }],
};

const PHYSICAL: PhysicalContract = {
  workflow: "laser-cut",
  deliveryPath: "delivery/part.svg",
  publicSpec: SPEC,
  specDigest: "9f2c4a7be1d3",
};

const CONTRACT = {
  repository: "NDilanka/acquit-demo",
  issue: 7,
  frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4",
  frozenTestPath: "",
  frozenTests: 0,
  hiddenTests: 0,
  hiddenManifest: "9f2c4a7be1d3",
  protectedPaths: [],
  physical: PHYSICAL,
};

function bid(over: Partial<BidView>): BidView {
  return {
    id: "bid_devon",
    operator: "op_devon",
    handle: "devon",
    label: "INDEPENDENT",
    price: 36000,
    eta: 48,
    agent: "laser-agent",
    runner: "codex",
    pitch: "One clean cut.",
    paidReceipts: 4,
    houseLine: null,
    status: "PENDING",
    ...over,
  };
}

const BASE: TimelineJob = {
  id: "job_laser_0001",
  title: "Cut the enclosure panel to spec",
  vertical: "laser-cut",
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

/** A laser job in flight with devon locked in and the spec frozen. */
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

const VERIFIED_ATTEMPT: Attempt = {
  ordinal: 1,
  sourceCommit: "e4f5a6b",
  at: "2026-10-12T10:00:00.000Z",
  result: "VERIFIED",
  frozen: { expected: 13, passed: 13 },
  hidden: { expected: 6, passed: 6 },
  pullRequest: null,
};

const REJECTED_ATTEMPT: Attempt = {
  ordinal: 1,
  sourceCommit: "a1b2c3d",
  at: "2026-10-12T10:00:00.000Z",
  result: "REJECTED",
  reasons: ["The delivery file delivery/part.svg is not on the submitted commit"],
  reasonsTruncated: 0,
  frozen: null,
  hidden: null,
};

const RECEIPT: Receipt = {
  id: "rcpt_laser_0001",
  jobId: "job_laser_0001",
  operator: "devon",
  agent: "laser-agent",
  pullRequest: null,
  mergeCommit: "abcdef1234567",
  frozen: { expected: 13, passed: 13 },
  hidden: { expected: 6, passed: 6 },
  attemptsUsed: 1,
  paid: 34200,
  releasedAt: "2026-10-15T10:00:00.000Z",
  source: "JOB",
};

/** A laser job the client approved through the API after a verified delivery. */
function paidLaser(): TimelineJob {
  return locked({
    status: "PAID",
    phase: "PAID",
    escrow: "RELEASED",
    releaseAuthority: "CLIENT_APPROVAL",
    merge: { phase: "MERGED", at: "2026-10-15T10:00:00.000Z", sha: null },
    mergeCommit: "abcdef1234567",
    release: { payoutItemId: "PAYOUT-ITEM-1", captureId: "CAPTURE-1", paid: 34200, at: "2026-10-15T10:00:00.000Z" },
    receipt: RECEIPT,
    ledger: [
      { kind: "HELD", cents: 37800, at: "2026-10-11T08:00:00.000Z" },
      { kind: "RELEASED", cents: 34200, at: "2026-10-15T10:00:00.000Z" },
      { kind: "FEE", cents: 3600, processor: 1100, acquit: 2500, at: "2026-10-15T10:00:00.000Z" },
    ],
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [VERIFIED_ATTEMPT], pending: null, failure: null },
  });
}

function allText(events: readonly TimelineEvent[]): string {
  return events
    .map((e) => [e.title, e.detail, ...e.reasons, ...e.ids.map((id) => id.label ?? "")].join(" | "))
    .join("\n");
}

test("isLaserJob reads only the laser-cut vertical", () => {
  assert.equal(isLaserJob({ vertical: "laser-cut" }), true);
  assert.equal(isLaserJob({ vertical: "code" }), false);
  assert.equal(isLaserJob({}), false);
});

test("specRows reads the spec's fields in order", () => {
  assert.deepEqual(specRows(SPEC), [
    { label: "Material", value: "acrylic" },
    { label: "Thickness", value: "3 mm" },
    { label: "Bed", value: "300 × 200 mm" },
    { label: "Part", value: "120 × 80 mm" },
    { label: "Kerf", value: "0.2 mm" },
    { label: "Tolerance", value: "0.1 mm" },
    { label: "Minimum web", value: "3 mm" },
    { label: "Holes", value: "4 holes" },
    { label: "Slots", value: "1 slot" },
  ]);
});

test("specRows leaves out what the spec does not shape as expected", () => {
  assert.deepEqual(specRows(null), []);
  assert.deepEqual(specRows("acrylic"), []);
  assert.deepEqual(specRows([1, 2]), []);
  assert.deepEqual(specRows({ thicknessMm: "3", bedMm: [300], partMm: "120 × 80" }), []);
  assert.deepEqual(specRows({ holes: [{ id: "one" }] }), [{ label: "Holes", value: "1 hole" }]);
  assert.deepEqual(specRows({ slots: [] }), [{ label: "Slots", value: "0 slots" }]);
});

test("laserDelivery names the workflow and carries the file, digest and spec rows", () => {
  assert.equal(laserDelivery(undefined), null);
  const delivery = laserDelivery(PHYSICAL);
  assert.ok(delivery);
  assert.equal(delivery.workflow, "Laser cut");
  assert.equal(delivery.path, "delivery/part.svg");
  assert.equal(delivery.specDigest, "9f2c4a7be1d3");
  assert.equal(delivery.rows.length, 9);
  assert.equal(laserDelivery({ ...PHYSICAL, workflow: "other-cut" })?.workflow, "other-cut");
});

test("the laser timeline spells no test suite, pull request or approval control and links nowhere", () => {
  const events = laserTimelineEvents(paidLaser());
  const text = allText(events);
  assert.doesNotMatch(text, /visible|hidden tests|pull request|approve or dispute|merged|\bPR\b/i);
  for (const event of events) assert.equal(event.href, null, `${event.kind} links nowhere`);
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ["CONTRACT", "BID", "HELD", "ATTEMPT", "PAYOUT", "RECEIPT"]);
});

test("the spec event names the frozen commit and the spec digest", () => {
  const spec = laserTimelineEvents(locked({})).find((e) => e.kind === "CONTRACT");
  assert.ok(spec);
  assert.equal(spec.title, "Spec frozen");
  assert.deepEqual(
    spec.ids.map((id) => id.label),
    ["Frozen commit", "Spec digest"],
  );
});

test("a verified attempt counts public rules and sealed checks", () => {
  const job = locked({
    status: "VERIFIED",
    phase: "AWAITING_CLIENT",
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [VERIFIED_ATTEMPT], pending: null, failure: null },
  });
  const attempt = laserTimelineEvents(job).find((e) => e.kind === "ATTEMPT");
  assert.ok(attempt);
  assert.equal(attempt.title, "Attempt 1 of 3 verified");
  assert.equal(attempt.tone, "ok");
  assert.match(attempt.detail, /Passed all 13 public rules\./);
  assert.match(attempt.detail, /Passed all 6 sealed checks\./);
});

test("a rejected attempt speaks its reason and keeps escrow in view while the job is open", () => {
  const job = locked({
    attempts: { used: 1, left: 2, last: "REJECTED", reasons: [], history: [REJECTED_ATTEMPT], pending: null, failure: null },
  });
  const attempt = laserTimelineEvents(job).find((e) => e.kind === "ATTEMPT");
  assert.ok(attempt);
  assert.equal(attempt.title, "Attempt 1 of 3 rejected");
  assert.equal(attempt.tone, "alert");
  assert.equal(attempt.detail, "The delivery file delivery/part.svg is not on the submitted commit. Escrow still held.");
  assert.deepEqual(attempt.reasons, []);
});

test("a rejected attempt with counts lists its reasons in their own block", () => {
  const judged: Attempt = {
    ...REJECTED_ATTEMPT,
    reasons: ["The delivery breaks spec rules: holes"],
    reasonsTruncated: 1,
    frozen: { expected: 13, passed: 11 },
    hidden: { expected: 6, passed: 6 },
  };
  const job = locked({
    attempts: { used: 1, left: 2, last: "REJECTED", reasons: [], history: [judged], pending: null, failure: null },
  });
  const attempt = laserTimelineEvents(job).find((e) => e.kind === "ATTEMPT");
  assert.ok(attempt);
  assert.match(attempt.detail, /Passed 11 of 13 public rules\./);
  assert.match(attempt.detail, /Passed all 6 sealed checks\./);
  assert.deepEqual(attempt.reasons, ["The delivery breaks spec rules: holes.", "1 more reason not listed."]);
});

test("the receipt counts the laser verdict and names the delivered commit", () => {
  const receipt = laserTimelineEvents(paidLaser()).find((e) => e.kind === "RECEIPT");
  assert.ok(receipt);
  assert.equal(receipt.title, "Receipt");
  assert.match(receipt.detail, /Passed all 13 public rules\./);
  assert.match(receipt.detail, /Attempts used 1 of 3\./);
  assert.deepEqual(receipt.ids.map((id) => id.label), [undefined, "Delivered commit"]);
});

test("nothing is paid out before the client approves", () => {
  const job = locked({
    status: "VERIFIED",
    phase: "AWAITING_CLIENT",
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [VERIFIED_ATTEMPT], pending: null, failure: null },
  });
  const kinds = laserTimelineEvents(job).map((e) => e.kind);
  assert.equal(kinds.includes("PAYOUT"), false);
  assert.equal(kinds.includes("RECEIPT"), false);
});

test("the next line names the client's approval through the API when a laser job is verified", () => {
  const job = locked({
    status: "VERIFIED",
    phase: "AWAITING_CLIENT",
    attempts: { used: 1, left: 2, last: "VERIFIED", reasons: [], history: [VERIFIED_ATTEMPT], pending: null, failure: null },
  });
  assert.equal(laserNextLine(job), "Verified. Waiting for the client to approve through the API.");
});

test("the next line follows the laser job's state", () => {
  assert.equal(laserNextLine(BASE), "Open for bids. Operators bid through the API.");
  assert.equal(laserNextLine(locked({})), "Waiting for the delivery. 3 of 3 attempts left.");
  assert.equal(
    laserNextLine(locked({ attempts: { used: 1, left: 2, last: "REJECTED", reasons: [], history: [REJECTED_ATTEMPT], pending: null, failure: null } })),
    "The last delivery was rejected. 2 of 3 attempts left.",
  );
  assert.equal(laserNextLine(paidLaser()), "Paid.");
  assert.equal(laserNextLine(locked({ status: "VERIFIED", phase: "RELEASE_PENDING" })), null);
});
