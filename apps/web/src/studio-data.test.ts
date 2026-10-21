import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerLine, PlatformJobLedger, ReceiptRow } from "./api-types";
import { conserves, earnings, escrowTotals, newestReceipt, placeRows, stackLayout, verifierStats } from "./studio-data.ts";

const at = "2026-11-03T15:22:00.000Z";

function job(jobId: string, escrow: PlatformJobLedger["escrow"], lines: LedgerLine[], attempts: PlatformJobLedger["attempts"] = []): PlatformJobLedger {
  return {
    jobId,
    title: `Fix ${jobId}`,
    tenant: null,
    client: "ana-client",
    status: escrow === "RELEASED" ? "PAID" : escrow === "REFUNDED" ? "REFUNDED" : escrow === "HELD" ? "IN_PROGRESS" : "OPEN",
    escrow,
    operator: escrow === "NONE" ? null : { id: "op_1", handle: "devon-ops" },
    lines,
    paidCents: null,
    capture: null,
    fee: null,
    payout: null,
    receipt: null,
    attempts,
  };
}

const verified = { ordinal: 1, result: "VERIFIED", at, tamper: false, reasons: [], frozen: null, hidden: null } as const;
const tampered = { ordinal: 1, result: "REJECTED", at, tamper: true, reasons: ["PROTECTED_PATH_MODIFIED"], frozen: null, hidden: null } as const;
const rejected = { ordinal: 1, result: "REJECTED", at, tamper: false, reasons: ["TESTS_FAILED:hidden"], frozen: null, hidden: null } as const;

const book: PlatformJobLedger[] = [
  job(
    "job_paid",
    "RELEASED",
    [
      { kind: "HELD", cents: 42000, at },
      { kind: "RELEASED", cents: 36000, at },
      { kind: "FEE", cents: 6000, processor: 1515, acquit: 4485, at },
    ],
    [tampered, { ...verified, ordinal: 2 }],
  ),
  job("job_held", "HELD", [{ kind: "HELD", cents: 21000, at }], [rejected]),
  job("job_refunded", "REFUNDED", [
    { kind: "HELD", cents: 10500, at },
    { kind: "REFUND", cents: 10500, at },
  ]),
  job("job_open", "NONE", []),
  job(
    "job_paid_small",
    "RELEASED",
    [
      { kind: "HELD", cents: 10500, at },
      { kind: "RELEASED", cents: 9000, at },
      { kind: "FEE", cents: 1500, processor: 400, acquit: 1100, at },
    ],
    [verified],
  ),
];

test("escrow totals count holds only on jobs still in escrow, and every release, refund, and fee", () => {
  assert.deepEqual(escrowTotals(book), { held: 21000, released: 45000, refunded: 10500, fees: 7500 });
});

test("verifier rates are fractions of all attempts, and a tamper is a rejected attempt flagged as one", () => {
  assert.deepEqual(verifierStats(book), { passRate: 0.5, rejectRate: 0.5, tamperAttempts: 1, attempts: 4 });
});

test("a book with no attempts reads as zero rates, not NaN", () => {
  assert.deepEqual(verifierStats([job("job_open", "NONE", [])]), { passRate: 0, rejectRate: 0, tamperAttempts: 0, attempts: 0 });
});

test("released jobs conserve: payout plus fee equals what the client paid", () => {
  assert.deepEqual(conserves(book), { payout: 45000, fee: 7500, paid: 52500, holds: true });
});

test("a released book whose fee is short reports the break", () => {
  const broken = job("job_broken", "RELEASED", [
    { kind: "HELD", cents: 42000, at },
    { kind: "RELEASED", cents: 36000, at },
    { kind: "FEE", cents: 5000, processor: 1515, acquit: 3485, at },
  ]);
  assert.deepEqual(conserves([broken, book[1]!]), { payout: 36000, fee: 5000, paid: 42000, holds: false });
});

function jobRow(id: string, paid: number, fee: number | null, releasedAt: string, source: "JOB" | "SEED" = "JOB"): ReceiptRow {
  return {
    id,
    jobId: `job_${id}`,
    operator: "op_1",
    agent: "house-fixer",
    pullRequest: 7,
    mergeCommit: "abc1234",
    frozen: { expected: 3, passed: 3 },
    hidden: { expected: 2, passed: 2 },
    attemptsUsed: 1,
    paid,
    releasedAt,
    repository: "acme/widgets",
    source,
    passedVerifiedCi: true,
    grossPaid: fee === null ? null : paid + fee,
    fee,
    feeSplit: fee === null ? null : { processor: 1515, acquit: fee - 1515 },
    result: "VERIFIED",
  };
}

const seeded: ReceiptRow = {
  id: "rc_seed",
  jobId: null,
  operator: "op_1",
  agent: null,
  pullRequest: null,
  mergeCommit: null,
  frozen: null,
  hidden: null,
  attemptsUsed: null,
  paid: null,
  releasedAt: "2026-12-01T00:00:00.000Z",
  repository: null,
  source: "SEED",
  passedVerifiedCi: true,
  grossPaid: null,
  fee: null,
  feeSplit: null,
  result: null,
};

const receipts: ReceiptRow[] = [
  jobRow("rc_old", 36000, 6000, "2026-11-03T15:22:00.000Z"),
  seeded,
  jobRow("rc_new", 9000, null, "2026-11-05T09:00:00.000Z"),
  jobRow("rc_seeded_job", 50000, 1000, "2026-12-02T00:00:00.000Z", "SEED"),
];

test("earnings sum the operator's job-backed receipts however they are seeded, with a missing fee counted as zero", () => {
  assert.deepEqual(earnings(receipts), { paidOut: 95000, feesWithheld: 7000, jobsPaid: 3 });
});

test("the newest receipt is the latest job-backed receipt, job-less display seeds aside", () => {
  assert.equal(newestReceipt(receipts)?.id, "rc_seeded_job");
  assert.equal(newestReceipt([seeded]), null);
});

test("a fresh dashboard places each row left to right, the next row below the tallest widget", () => {
  assert.deepEqual(
    placeRows([
      [
        { id: "held", xSpan: 3, ySpan: 2 },
        { id: "fees", xSpan: 3, ySpan: 3 },
      ],
      [{ id: "conserves", xSpan: 12, ySpan: 3 }],
    ]),
    {
      held: { xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 },
      fees: { xTrack: 3, yTrack: 0, xSpan: 3, ySpan: 3 },
      conserves: { xTrack: 0, yTrack: 3, xSpan: 12, ySpan: 3 },
    },
  );
});

test("a narrow screen stacks every widget full width in reading order", () => {
  assert.deepEqual(
    stackLayout(
      {
        fees: { xTrack: 3, yTrack: 0, xSpan: 3, ySpan: 2 },
        conserves: { xTrack: 0, yTrack: 2, xSpan: 6, ySpan: 3 },
        held: { xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 },
      },
      12,
    ),
    {
      held: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 2 },
      fees: { xTrack: 0, yTrack: 2, xSpan: 12, ySpan: 2 },
      conserves: { xTrack: 0, yTrack: 4, xSpan: 12, ySpan: 3 },
    },
  );
});
