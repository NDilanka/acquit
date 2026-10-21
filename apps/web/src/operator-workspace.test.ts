import assert from "node:assert/strict";
import { test } from "node:test";
import type { BidView, OperatorEscrowRow, ReceiptRow } from "./api-types.ts";
import { buildOperatorWorkspace, homeCrumbs, receiptMarks, type OperatorSnapshot } from "./operator-workspace.ts";
import type { TimelineJob } from "./job-timeline.ts";

const OPERATOR = { operatorId: "op_devon", handle: "devon" };

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
    price: 40000,
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
  id: "job_open",
  title: "Fix rounding in EUR invoices",
  status: "OPEN",
  phase: "BIDDING",
  checkoutPhase: null,
  budget: 50000,
  deliveryEndsAt: "2026-10-20T00:00:00.000Z",
  bids: { operators: [], house: null },
  client: null,
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
};

const LOCKED: Partial<TimelineJob> = {
  id: "job_work",
  status: "IN_PROGRESS",
  phase: "READY",
  lockedTo: "op_devon",
  bids: { operators: [bid({ status: "CHOSEN" })], house: null },
  escrow: "HELD",
  ledger: [{ kind: "HELD", cents: 42000, at: "2026-10-16T09:00:00.000Z" }],
  contract: CONTRACT,
};

const PAID_RECEIPT: ReceiptRow = {
  id: "rcpt_devon_1",
  jobId: "job_paid",
  operator: "op_devon",
  agent: "ts-bugfixer",
  pullRequest: 12,
  mergeCommit: "b7c1d2e",
  frozen: { expected: 48, passed: 48 },
  hidden: { expected: 6, passed: 6 },
  attemptsUsed: 1,
  paid: 36000,
  releasedAt: "2026-10-18T12:00:00.000Z",
  source: "JOB",
  repository: "NDilanka/acquit-demo",
  passedVerifiedCi: true,
  grossPaid: 42000,
  fee: 6000,
  feeSplit: { processor: 1515, acquit: 4485 },
  result: "VERIFIED",
};

const SEEDED_HISTORY: ReceiptRow = {
  id: "rcpt_seed_1", jobId: null, operator: "op_devon", agent: null, pullRequest: null, mergeCommit: null,
  frozen: null, hidden: null, attemptsUsed: null, paid: null, releasedAt: "2026-09-01T00:00:00.000Z",
  repository: null, source: "SEED", passedVerifiedCi: true, grossPaid: null, fee: null, feeSplit: null, result: null,
};

function snapshot(jobs: TimelineJob[], over: Partial<OperatorSnapshot> = {}): OperatorSnapshot {
  return { ...OPERATOR, jobs, receipts: [], escrow: [], ...over };
}

function job(over: Partial<TimelineJob>): TimelineJob {
  return { ...BASE, ...over };
}

test("an operator with no bids sees only the open jobs", () => {
  const ws = buildOperatorWorkspace(snapshot([job({})]));
  assert.deepEqual(ws.open.map(j => j.id), ["job_open"]);
  assert.deepEqual(ws.mine, []);
  assert.deepEqual(ws.earnings, { heldCents: 0, paidCents: 0, receipts: [] });
});

test("a pending bid keeps its job in the open list and adds no work", () => {
  const ws = buildOperatorWorkspace(snapshot([job({ bids: { operators: [bid({ status: "PENDING" })], house: null } })]));
  assert.deepEqual(ws.open.map(j => j.id), ["job_open"]);
  assert.deepEqual(ws.mine, []);
  assert.equal(ws.earnings.heldCents, 0);
});

test("a locked job in escrow counts at the operator's net and reads Deliver", () => {
  // A 40000 bid is held at 42000 from the client, and the operator's net after the 10% operator fee is 36000.
  const ws = buildOperatorWorkspace(snapshot([job(LOCKED)], { escrow: [{ jobId: "job_work", cents: 36000 }] }));
  assert.deepEqual(ws.open, []);
  assert.equal(ws.mine.length, 1);
  assert.deepEqual(ws.mine[0]?.status, { label: "Held in escrow", tone: "held" });
  assert.equal(ws.mine[0]?.next, "Deliver the commit with the steps below. Every attempt runs 48 visible and 6 hidden tests.");
  assert.deepEqual(ws.earnings, { heldCents: 36000, paidCents: 0, receipts: [] });
});

test("a paid job counts as paid and lists its receipt", () => {
  const paid = job({ id: "job_paid", status: "PAID", phase: "PAID", escrow: "RELEASED", lockedTo: "op_devon",
    bids: { operators: [bid({ status: "ACCEPTED" })], house: null },
    ledger: [{ kind: "HELD", cents: 42000, at: "2026-10-16T09:00:00.000Z" }, { kind: "RELEASED", cents: 36000, at: "2026-10-18T12:00:00.000Z" }] });
  const ws = buildOperatorWorkspace(snapshot([paid], { receipts: [PAID_RECEIPT] }));
  assert.equal(ws.mine[0]?.status.label, "Paid");
  assert.equal(ws.mine[0]?.next, "Paid to devon. The receipt below is the proof.");
  assert.deepEqual(ws.earnings, { heldCents: 0, paidCents: 36000, receipts: [PAID_RECEIPT] });
});

test("a refunded job counts neither held nor paid", () => {
  const refunded = job({ id: "job_refunded", status: "REFUNDED", phase: "REFUNDED", escrow: "REFUNDED", lockedTo: "op_devon",
    bids: { operators: [bid({ status: "CHOSEN" })], house: null }, refundReason: "DELIVERY_DEADLINE",
    ledger: [{ kind: "HELD", cents: 42000, at: "2026-10-16T09:00:00.000Z" }, { kind: "REFUND", cents: 42000, at: "2026-10-20T00:00:00.000Z" }] });
  const ws = buildOperatorWorkspace(snapshot([refunded]));
  assert.equal(ws.mine[0]?.status.label, "Refunded");
  assert.equal(ws.mine[0]?.next, "Refunded to the client. No money is held.");
  assert.deepEqual(ws.earnings, { heldCents: 0, paidCents: 0, receipts: [] });
});

test("settled receipts add up in whole cents and the seeded history row adds nothing", () => {
  const second: ReceiptRow = { ...PAID_RECEIPT, id: "rcpt_devon_2", jobId: "job_paid_two", paid: 22500 };
  const ws = buildOperatorWorkspace(snapshot([], { receipts: [PAID_RECEIPT, second, SEEDED_HISTORY] }));
  assert.equal(ws.earnings.paidCents, 58500);
  assert.equal(ws.earnings.receipts.length, 3);
});

test("a job-backed seed keeps its paid amount in the total", () => {
  const jobBackedSeed: ReceiptRow = { ...PAID_RECEIPT, source: "SEED" };
  const ws = buildOperatorWorkspace(snapshot([], { receipts: [jobBackedSeed] }));
  assert.equal(ws.earnings.paidCents, 36000);
});

test("a job-backed seed shows the Seeded badge and its job link, and a detached seed shows the badge alone", () => {
  assert.deepEqual(receiptMarks({ ...PAID_RECEIPT, source: "SEED" }), { seeded: true, jobHref: "/jobs/job_paid" });
  assert.deepEqual(receiptMarks(SEEDED_HISTORY), { seeded: true, jobHref: null });
  assert.deepEqual(receiptMarks(PAID_RECEIPT), { seeded: false, jobHref: "/jobs/job_paid" });
});

test("a checkout refund still in funding holds nothing for the operator", () => {
  // The projected capture-mismatch shape: the escrow reads HELD, and the server's escrow rows leave the job out.
  const mismatch = job({ id: "job_capture_mismatch", status: "OPEN", phase: "FUNDING", checkoutPhase: "REFUND_PENDING",
    escrow: "HELD", lockedTo: "op_devon", bids: { operators: [bid({ status: "CHOSEN" })], house: null }, refundReason: "CAPTURE_MISMATCH" });
  const ws = buildOperatorWorkspace(snapshot([mismatch], { escrow: [] }));
  assert.equal(ws.earnings.heldCents, 0);
  assert.equal(ws.earnings.paidCents, 0);
});

test("the escrow rows of jobs the operator does not hold add nothing", () => {
  const stranger: OperatorEscrowRow = { jobId: "job_other", cents: 99000 };
  const ws = buildOperatorWorkspace(snapshot([job(LOCKED)], { escrow: [{ jobId: "job_work", cents: 36000 }, stranger] }));
  assert.equal(ws.earnings.heldCents, 36000);
});

test("the operator's page crumbs never include the client's", () => {
  assert.deepEqual(homeCrumbs("OPERATOR"), ["Workspace"]);
  assert.deepEqual(homeCrumbs("CLIENT"), ["Jobs"]);
  assert.equal(homeCrumbs("OPERATOR").includes("Jobs"), false);
  assert.equal(homeCrumbs("OPERATOR").includes("New job"), false);
});
