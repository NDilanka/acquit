import assert from "node:assert/strict";
import { test } from "node:test";
import { authorityNote, creditLine, denied, disputeNote, ledgerNote, mergeNote, releaseNote, usd } from "./format.ts";

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

test("the merge reads as pending, merged with its merge commit and approved tree, or parked for a person", () => {
  const commit = "9f2c41e7d0b3a5c6e8f1d2b4a6c8e0f1a3b5c7d9";
  const merged = "4b7e1d09c2a6f3e8d5b1c7a9e0f2d4b6c8a1e3f5";
  assert.equal(mergeNote({ phase: "PENDING" }, 7, commit), "Merge pending");
  assert.equal(
    mergeNote({ phase: "MERGED", at, sha: merged }, 7, commit),
    "Merged 2026-11-03 15:22 UTC: pull request #7, merge commit 4b7e1d0, approved 9f2c41e",
  );
  assert.equal(
    mergeNote({ phase: "MERGED", at, sha: null }, 7, commit),
    "Merged 2026-11-03 15:22 UTC: pull request #7, approved 9f2c41e",
  );
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

test("each release authority reads in plain words", () => {
  assert.equal(authorityNote("CLIENT_APPROVAL"), "Released on the client's approval");
  assert.equal(authorityNote("REVIEW_SILENCE"), "Released after review silence: the client did not respond within 72 hours");
  assert.equal(authorityNote("ARBITER_UPHELD"), "Released by the arbiter");
  assert.equal(authorityNote("ARBITER_SLA_MISSED"), "Released after the arbiter missed its deadline");
  assert.equal(authorityNote("CAPTURE_CUTOFF"), "Released at the PayPal capture cutoff, 21 days after payment");
});

test("an open dispute names its reason and the arbiter's deadline", () => {
  assert.equal(
    disputeNote({ reason: "The fix breaks EUR rounding.", openedAt: at, resolveBy: "2026-11-05T15:22:00.000Z" }),
    "Disputed 2026-11-03 15:22 UTC: The fix breaks EUR rounding. The arbiter decides by 2026-11-05 15:22 UTC.",
  );
});

test("the weekly credit line names the balance, the allowance, and the next grant", () => {
  assert.equal(
    creditLine({ available: 20, weeklyAllowance: 30, nextGrantAt: "2026-11-09T00:00:00.000Z" }),
    "20 of 30 credits left this week. Next grant 2026-11-09 00:00 UTC.",
  );
});

test("a bid refused for credits says when credits return", () => {
  const credits = { available: 0, weeklyAllowance: 30, nextGrantAt: "2026-11-09T00:00:00.000Z" };
  assert.equal(
    denied("INSUFFICIENT_CREDITS", credits),
    "Not enough bid credits: you have 0 and a bid costs 10. Your weekly allowance of 30 returns 2026-11-09 00:00 UTC. (INSUFFICIENT_CREDITS)",
  );
  assert.equal(denied("INSUFFICIENT_CREDITS"), "Not enough bid credits. Each bid costs 10. (INSUFFICIENT_CREDITS)");
  assert.equal(denied("NOT_OWNER", credits), "You do not own this job. (NOT_OWNER)");
});
