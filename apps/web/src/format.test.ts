import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerNote, mergeNote, releaseNote, usd } from "./format.ts";

const at = "2026-11-03T15:22:00.000Z";
const devon = { handle: "devon-ops", price: 40000 };

test("the paid book reads like the tutorial's ledger", () => {
  const rows = [
    { kind: "HELD", cents: 42000, at },
    { kind: "RELEASED", cents: 36000, at },
    { kind: "FEE", cents: 6000, processor: 1515, acquit: 4485, at },
  ] as const;
  assert.deepEqual(
    rows.map((line) => `${line.kind} ${usd(line.cents)}  ${ledgerNote(line, devon)}`),
    [
      "HELD 420.00 USD  client payment (400.00 job + 20.00 escrow fee)",
      "RELEASED 360.00 USD  payout to devon-ops",
      "FEE 60.00 USD  fees (15.15 PayPal processing + 44.85 Acquit)",
    ],
  );
});

test("a refund and an unknown payee still read plainly", () => {
  assert.equal(ledgerNote({ kind: "REFUND", cents: 42000, at }, devon), "refunded to client");
  assert.equal(ledgerNote({ kind: "RELEASED", cents: 36000, at }, null), "payout to operator");
  assert.equal(ledgerNote({ kind: "HELD", cents: 42000, at }, null), "client payment (400.00 job + 20.00 escrow fee)");
});

test("the merge reads as pending, merged with its pull and tree, or parked for a person", () => {
  const commit = "9f2c41e7d0b3a5c6e8f1d2b4a6c8e0f1a3b5c7d9";
  assert.equal(mergeNote({ phase: "PENDING" }, 7, commit), "Merge pending");
  assert.equal(mergeNote({ phase: "MERGED", at }, 7, commit), "Merged 2026-11-03 15:22 UTC: pull request #7, commit 9f2c41e");
  assert.equal(
    mergeNote({ phase: "NEEDS_HUMAN", reason: "GITHUB_MERGE_CONFLICT" }, 7, commit),
    "Needs a person: GitHub refused the merge (GITHUB_MERGE_CONFLICT)",
  );
  assert.equal(mergeNote({ phase: "NEEDS_HUMAN", reason: "SOMETHING_NEW" }, null, null), "Needs a person: SOMETHING_NEW");
});

test("the release evidence names the payout item and the capture", () => {
  assert.equal(
    releaseNote({ payoutItemId: "PI-7XK2", captureId: "CAP-91QZ", paid: 36000, at }),
    "Payout item PI-7XK2, capture CAP-91QZ",
  );
});
