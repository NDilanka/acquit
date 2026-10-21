import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlatformJobLedger } from "./api-types.ts";
import { conserves, escrowTotals, verifierStats } from "./studio-data.ts";

// The custom ledger widgets read the book directly. studio-engine.test.ts runs Studio's engine over
// the same book and checks the native widgets against these functions.
const OPENED = "2026-10-13T12:00:00.000Z";
const RELEASED = "2026-10-13T15:00:00.000Z";

function ledgerJob(job: Pick<PlatformJobLedger, "jobId" | "title" | "tenant" | "client" | "status" | "escrow" | "lines" | "attempts">): PlatformJobLedger {
  return {
    ...job,
    operator: { id: "devon-ops", handle: "devon-ops" },
    paidCents: null,
    capture: null,
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
    attempts: [{ ordinal: 2, result: "VERIFIED", at: RELEASED, tamper: false, reasons: [], frozen: null, hidden: null }] }),
  ledgerJob({ jobId: "job_ledger_held", title: "held job", tenant: "v_b", client: "splitter-client", status: "IN_PROGRESS", escrow: "HELD",
    lines: [{ kind: "HELD", cents: 37800, at: OPENED }],
    attempts: [{ ordinal: 1, result: "REJECTED", at: OPENED, tamper: true, reasons: ["PROTECTED_PATH_MODIFIED"], frozen: null, hidden: null }] }),
  ledgerJob({ jobId: "job_ledger_refunded", title: "refunded job", tenant: null, client: "maya-client", status: "REFUNDED", escrow: "REFUNDED",
    lines: [{ kind: "HELD", cents: 42000, at: OPENED }, { kind: "REFUND", cents: 42000, at: RELEASED }],
    attempts: [] }),
];

test("the custom ledger totals the seeded book in cents", () => {
  assert.deepEqual(escrowTotals(book), { held: 37800, released: 36000, refunded: 42000, fees: 6000 });
  assert.deepEqual(verifierStats(book), { passRate: 0.5, rejectRate: 0.5, tamperAttempts: 1, attempts: 2 });
});

test("the custom ledger conserves over the released jobs", () => {
  assert.deepEqual(conserves(book), { payout: 36000, fee: 6000, paid: 42000, holds: true });
});
