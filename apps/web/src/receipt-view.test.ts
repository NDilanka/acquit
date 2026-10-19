import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicAttempt } from "./api-types.ts";
import {
  attemptLine,
  digestVerdict,
  moneyLines,
  operatorLine,
  outcomeLine,
  paypalLines,
  receiptPageHref,
  reasonWords,
  tallyWords,
  SANDBOX_NOTE,
  SCRIPTED_NOTE,
  scoreCardLines,
  type DigestCheck,
  type PublicReceipt,
} from "./receipt-view.ts";

const DIGEST = "1764db63ab48ebab5142bfc8275d72ba1b09672157ed55433394445c025bf5a7";
const SALT = "5a".repeat(32);
const RELEASED = "2026-10-12T00:00:00Z";

const revealed = {
  salt: SALT,
  cases: [{ id: "per-job-1", target: { module: "src/invoice.ts", export: "totalOf" }, args: [[]], expected: 0 }],
};

function receipt(overrides: Partial<PublicReceipt> = {}): PublicReceipt {
  return {
    id: "rcpt_public",
    title: "Fix the invoice total",
    issue: 42,
    source: "JOB",
    scripted: false,
    releasedAt: RELEASED,
    releaseAuthority: "CLIENT_APPROVAL",
    operator: { handle: "devon-ops", label: "INDEPENDENT" },
    money: { heldCents: 42_000, paidCents: 36_000, feeCents: 6_000, processorFeeCents: 1_515, acquitFeeCents: 4_485 },
    verdict: { attemptsUsed: 2, attemptsAllowed: 3, frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 },
      pullRequest: 7, mergeCommit: "a".repeat(40), history: [] },
    paypal: { captureId: "CAPTURE-7", payoutItemId: "PAYOUT-ITEM-7", feeBatchId: null },
    hiddenCases: { committedDigest: DIGEST, committedAt: "2026-10-11T23:00:00Z", revealed },
    scoreCard: { cheatsCaught: 11, cheatsTotal: 11, honestPassed: 20, honestTotal: 20, gaps: [] },
    ...overrides,
  };
}

const MATCH: DigestCheck = { kind: "COMPUTED", digest: DIGEST };
const TAMPERED: DigestCheck = { kind: "COMPUTED", digest: "54842b81de0e36a4b6cd715776f339b52f76ca88af06637e219d5747b64f0485" };

test("the receipt link is the public page for a receipt id, with the id encoded", () => {
  assert.equal(receiptPageHref("rcpt_abc"), "/receipts/rcpt_abc");
  assert.equal(receiptPageHref("rcpt a/b"), "/receipts/rcpt%20a%2Fb");
});

test("a digest verdict matches only when the browser's digest equals the committed one", () => {
  const hidden = receipt().hiddenCases;
  assert.equal(digestVerdict(hidden, MATCH), "MATCH");
  assert.equal(digestVerdict(hidden, TAMPERED), "NO_MATCH");
  assert.equal(digestVerdict(hidden, { kind: "PENDING" }), "PENDING");
  assert.equal(digestVerdict(hidden, { kind: "UNAVAILABLE" }), "UNAVAILABLE");
});

test("a job with no seal, or cases the server could not reveal, never reads as a match", () => {
  assert.equal(digestVerdict(null, MATCH), "NOT_SEALED");
  const unrevealed = { committedDigest: DIGEST, committedAt: null, revealed: null };
  assert.equal(digestVerdict(unrevealed, MATCH), "NOT_REVEALED");
  assert.equal(digestVerdict(unrevealed, { kind: "PENDING" }), "NOT_REVEALED");
});

test("the reason codes read as the words a seller reads, and an unknown code shows as itself", () => {
  assert.equal(reasonWords("TESTS_FAILED:hidden"), "Hidden tests failed");
  assert.equal(reasonWords("TESTS_MISSING:frozen"), "Visible tests did not complete");
  assert.equal(reasonWords("TREE_GITLINK"), "A submodule was added");
  assert.equal(reasonWords("SOMETHING_NEW"), "SOMETHING_NEW");
});

test("one attempt reads as its verdict and its tallies, or its reasons when it was rejected", () => {
  const verified: PublicAttempt = { ordinal: 2, result: "VERIFIED", at: RELEASED, frozen: { expected: 48, passed: 48 },
    hidden: { expected: 6, passed: 6 }, reasons: [] };
  assert.equal(attemptLine(verified, 3), "Attempt 2 of 3: verified. Visible tests 48 of 48, hidden tests 6 of 6.");
  const rejected: PublicAttempt = { ordinal: 1, result: "REJECTED", at: RELEASED, frozen: null, hidden: null,
    reasons: ["TESTS_FAILED:hidden", "PROTECTED_PATH_MODIFIED"] };
  assert.equal(attemptLine(rejected, 3), "Attempt 1 of 3: rejected. Hidden tests failed; A protected test file was changed.");
  assert.equal(attemptLine({ ...rejected, reasons: [] }, 3), "Attempt 1 of 3: rejected. No reason recorded.");
});

test("a rejected attempt that ran its tests states the counts in place of the reason words", () => {
  const hiddenFailed: PublicAttempt = { ordinal: 1, result: "REJECTED", at: RELEASED, frozen: { expected: 48, passed: 48 },
    hidden: { expected: 6, passed: 5 }, reasons: ["TESTS_FAILED:hidden"] };
  assert.equal(attemptLine(hiddenFailed, 3), "Attempt 1 of 3: rejected. Passed all 48 visible tests. Failed 1 of 6 hidden tests.");
  const bothFailed: PublicAttempt = { ...hiddenFailed, frozen: { expected: 48, passed: 40 }, hidden: { expected: 6, passed: 4 },
    reasons: ["TESTS_FAILED:frozen", "TESTS_FAILED:hidden"] };
  assert.equal(attemptLine(bothFailed, 3), "Attempt 1 of 3: rejected. Passed 40 of 48 visible tests. Failed 2 of 6 hidden tests.");
  assert.equal(tallyWords({ expected: 48, passed: 40 }, { expected: 6, passed: 6 }), "Passed 40 of 48 visible tests. Passed all 6 hidden tests.");
  assert.equal(tallyWords(null, { expected: 6, passed: 6 }), null);
});

test("the headline names the outcome, the amount, the operator, the time, and the release authority", () => {
  assert.equal(outcomeLine(receipt()),
    "Verified and paid. 360.00 USD released to devon-ops on 2026-10-12 00:00 UTC. Released on the client's approval.");
  assert.equal(outcomeLine(receipt({ releaseAuthority: null, operator: { handle: null, label: null } })),
    "Verified and paid. 360.00 USD released to the operator on 2026-10-12 00:00 UTC.");
});

test("the money lines name the gross held, the payout, and the two parts of the fee", () => {
  assert.deepEqual(moneyLines(receipt().money), [
    { label: "Held in escrow (gross)", value: "420.00 USD" },
    { label: "Paid to the operator", value: "360.00 USD" },
    { label: "Processing fee (PayPal)", value: "15.15 USD" },
    { label: "Platform fee (Acquit)", value: "44.85 USD" },
  ]);
  assert.equal(moneyLines({ heldCents: null, paidCents: 36_000, feeCents: null, processorFeeCents: null, acquitFeeCents: null })[0]?.value,
    "Not recorded");
});

test("the three PayPal ids are named, and a fee with no batch says PayPal took it from the capture", () => {
  const [capture, payout, fee] = paypalLines(receipt().paypal);
  assert.equal(capture?.id, "CAPTURE-7");
  assert.equal(payout?.id, "PAYOUT-ITEM-7");
  assert.equal(fee?.id, null);
  assert.equal(fee?.note, "No separate fee payout: PayPal took its processing fee out of the capture.");
  const reimbursed = paypalLines({ captureId: "CAPTURE-7", payoutItemId: "PAYOUT-ITEM-7", feeBatchId: "PAYOUT-BATCH-9" })[2];
  assert.equal(reimbursed?.id, "PAYOUT-BATCH-9");
  assert.equal(reimbursed?.note, "The payout batch that settled the fee reimbursement.");
});

test("the score card reads as the CI-verified counts and its known gaps", () => {
  assert.deepEqual(scoreCardLines({ cheatsCaught: 11, cheatsTotal: 11, honestPassed: 20, honestTotal: 20, gaps: [] }), [
    "Caught 11 of 11 known cheats. Passed 20 of 20 honest submissions.",
    "No known gaps.",
  ]);
  assert.equal(scoreCardLines({ cheatsCaught: 10, cheatsTotal: 11, honestPassed: 20, honestTotal: 20, gaps: ["CASE-3"] })[1],
    "Known gaps: CASE-3.");
});

test("the operator line names the handle and the kind of operator", () => {
  assert.equal(operatorLine({ handle: "devon-ops", label: "INDEPENDENT" }), "devon-ops, Independent operator.");
  assert.equal(operatorLine({ handle: "house-tsfix", label: "HOUSE" }), "house-tsfix, House operator.");
});

test("every receipt carries the sandbox note, so no PayPal figure reads as real money", () => {
  assert.equal(SANDBOX_NOTE, "PayPal sandbox. No real money moves.");
});

test("a scripted receipt names its agent with the same Simulated label the judge tour shows", () => {
  assert.equal(SCRIPTED_NOTE.startsWith("Scripted agent (Simulated)"), true);
});
