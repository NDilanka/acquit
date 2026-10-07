import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerNote, usd } from "./format.ts";

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
