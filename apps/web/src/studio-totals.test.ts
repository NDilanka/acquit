import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlatformJobLedger, PlatformJobRow, PlatformTables, PlatformVerdictRow } from "./api-types.ts";
import { conserves, escrowTotals, verifierStats } from "./studio-data.ts";
import { escrowData } from "./studio-source.ts";

// The seeded book for three jobs: a paid job, a held job whose first attempt tripped the tamper check,
// and a refunded job. The rows are the platform route's output for that book, as
// packages/core/test/platform-ledger.test.ts pins them. The ledger jobs are the same book read the
// way the custom widgets read it.
const OPENED = "2026-10-13T12:00:00.000Z";
const RELEASED = "2026-10-13T15:00:00.000Z";

const jobs: PlatformJobRow[] = [
  { jobId: "job_ledger_paid", title: "paid job", tenant: "v_a", clientId: "maya-client", status: "PAID", escrow: "RELEASED",
    stage: "5 Paid", operatorId: "devon-ops", operatorHandle: "devon-ops", openedAt: OPENED, releasedAt: RELEASED, bidCount: 1,
    attemptCount: 1, grossCents: 42000, heldCents: 0, releasedCents: 36000, feeCents: 6000, refundedCents: 0 },
  { jobId: "job_ledger_held", title: "held job", tenant: "v_b", clientId: "splitter-client", status: "IN_PROGRESS", escrow: "HELD",
    stage: "3 Funded", operatorId: "devon-ops", operatorHandle: "devon-ops", openedAt: OPENED, releasedAt: null, bidCount: 1,
    attemptCount: 1, grossCents: 37800, heldCents: 37800, releasedCents: 0, feeCents: 0, refundedCents: 0 },
  { jobId: "job_ledger_refunded", title: "refunded job", tenant: null, clientId: "maya-client", status: "REFUNDED", escrow: "REFUNDED",
    stage: "6 Refunded", operatorId: "devon-ops", operatorHandle: "devon-ops", openedAt: OPENED, releasedAt: null, bidCount: 0,
    attemptCount: 0, grossCents: 42000, heldCents: 0, releasedCents: 0, feeCents: 0, refundedCents: 42000 },
];

const verdicts: PlatformVerdictRow[] = [
  { verdictId: "job_ledger_paid#2", jobId: "job_ledger_paid", ordinal: 2, result: "VERIFIED", verified: 1, tamper: 0, reasonCount: 0, at: RELEASED },
  { verdictId: "job_ledger_held#1", jobId: "job_ledger_held", ordinal: 1, result: "REJECTED", verified: 0, tamper: 1, reasonCount: 1, at: OPENED },
];

const tables: PlatformTables = { jobs, bids: [], verdicts, ledger_entries: [], paypal_events: [], operators: [], clients: [] };

function ledgerJob(job: Pick<PlatformJobLedger, "jobId" | "title" | "tenant" | "client" | "status" | "escrow" | "lines" | "attempts">): PlatformJobLedger {
  return {
    ...job,
    operator: { id: "devon-ops", handle: "devon-ops" },
    paidCents: null,
    fee: null,
    payout: null,
    receipt: null,
  };
}

const book: PlatformJobLedger[] = [
  ledgerJob({ jobId: "job_ledger_paid", title: "paid job", tenant: "v_a", client: "maya-client", status: "PAID", escrow: "RELEASED",
    lines: [
      { kind: "HELD", cents: 42000, at: OPENED },
      { kind: "RELEASED", cents: 36000, at: RELEASED },
      { kind: "FEE", cents: 6000, processor: 1515, acquit: 4485, at: RELEASED },
    ],
    attempts: [{ ordinal: 2, result: "VERIFIED", at: RELEASED, tamper: false, reasons: [] }] }),
  ledgerJob({ jobId: "job_ledger_held", title: "held job", tenant: "v_b", client: "splitter-client", status: "IN_PROGRESS", escrow: "HELD",
    lines: [{ kind: "HELD", cents: 37800, at: OPENED }],
    attempts: [{ ordinal: 1, result: "REJECTED", at: OPENED, tamper: true, reasons: ["PR modifies frozen test file tests/totals.test.ts"] }] }),
  ledgerJob({ jobId: "job_ledger_refunded", title: "refunded job", tenant: null, client: "maya-client", status: "REFUNDED", escrow: "REFUNDED",
    lines: [{ kind: "HELD", cents: 42000, at: OPENED }, { kind: "REFUND", cents: 42000, at: RELEASED }],
    attempts: [] }),
];

/** The totals each native widget draws, computed from the route's rows the way the engine aggregates them. */
function nativeTotals(rows: readonly PlatformJobRow[], passed: readonly PlatformVerdictRow[]) {
  const sum = (pick: (row: PlatformJobRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const count = <K extends string>(keyOf: (row: PlatformJobRow) => K) => {
    const counts: Partial<Record<K, number>> = {};
    for (const row of rows) counts[keyOf(row)] = (counts[keyOf(row)] ?? 0) + 1;
    return counts;
  };
  const verified = passed.reduce((total, verdict) => total + verdict.verified, 0);
  return {
    funnel: count((row) => row.stage),
    pivot: rows.reduce<Record<string, Record<string, number>>>((byOperator, row) => {
      const statuses = byOperator[row.operatorHandle ?? ""] ?? {};
      statuses[row.status] = (statuses[row.status] ?? 0) + 1;
      byOperator[row.operatorHandle ?? ""] = statuses;
      return byOperator;
    }, {}),
    treemap: { held: sum((row) => row.heldCents) },
    funded: sum((row) => row.grossCents),
    held: sum((row) => row.heldCents),
    released: sum((row) => row.releasedCents),
    refunded: sum((row) => row.refundedCents),
    fees: sum((row) => row.feeCents),
    passRate: verified / passed.length,
  };
}

test("the native widgets total the seeded book the same as the custom widgets", () => {
  const native = nativeTotals(jobs, verdicts);
  const custom = escrowTotals(book);

  assert.deepEqual(native.funnel, { "3 Funded": 1, "5 Paid": 1, "6 Refunded": 1 });
  assert.deepEqual(native.pivot, { "devon-ops": { "IN_PROGRESS": 1, "PAID": 1, "REFUNDED": 1 } });
  assert.deepEqual(native.treemap, { held: 37800 });
  assert.deepEqual(
    { held: native.held, released: native.released, refunded: native.refunded, fees: native.fees },
    custom,
  );
  assert.deepEqual(custom, { held: 37800, released: 36000, refunded: 42000, fees: 6000 });
  assert.equal(native.treemap.held, custom.held, "the treemap's total is the custom held total");

  const stats = verifierStats(book);
  assert.deepEqual(stats, { passRate: 0.5, rejectRate: 0.5, tamperAttempts: 1, attempts: 2 });
  assert.equal(native.passRate, stats.passRate);
});

test("held, released, refunded, and fees add up to the funded gross, natively and in the custom ledger", () => {
  const native = nativeTotals(jobs, verdicts);
  assert.equal(native.funded, 121800);
  assert.equal(native.held + native.released + native.refunded + native.fees, native.funded);
  const released = conserves(book);
  assert.deepEqual(released, { payout: 36000, fee: 6000, paid: 42000, holds: true });
});

test("the engine reads the same rows in dollars, so the treemap sums to the custom held total", () => {
  const [jobsSource] = escrowData(tables).sources;
  assert.ok(jobsSource && "data" in jobsSource, "the jobs table carries its rows");
  const engineHeld = jobsSource.data.reduce<number>((total, row) => total + Number((row as { held: unknown }).held), 0);
  assert.equal(engineHeld * 100, escrowTotals(book).held);
});
