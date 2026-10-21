import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckoutPhase, JobPhase, JobStatus } from "./api-types.ts";
import { bidStatusWord, draftFailureWord, escrowWord, ledgerKindWord, runFailureWord, statusLabel, verdictLabel, type StatusInput } from "./job-status.ts";

function job(status: JobStatus, phase: JobPhase, checkoutPhase: CheckoutPhase | null = null, last: "VERIFIED" | "REJECTED" | null = null): StatusInput {
  return { status, phase, checkoutPhase, attempts: { last } };
}

const REACHABLE: readonly [StatusInput, string, string][] = [
  [job("OPEN", "BIDDING"), "Open for bids", "open"],
  [job("OPEN", "FUNDING", "CREATING_ORDER"), "Waiting for payment", "open"],
  [job("OPEN", "FUNDING", "AWAITING_APPROVAL"), "Waiting for payment", "open"],
  [job("OPEN", "FUNDING", "CAPTURING"), "Waiting for payment", "open"],
  [job("OPEN", "FUNDING", "REFUND_PENDING"), "Held in escrow", "held"],
  [job("IN_PROGRESS", "READY"), "Held in escrow", "held"],
  [job("IN_PROGRESS", "READY", null, "VERIFIED"), "Held in escrow", "held"],
  [job("IN_PROGRESS", "READY", null, "REJECTED"), "Rejected (escrow still held)", "alert"],
  [job("IN_PROGRESS", "VERIFYING"), "Being verified", "held"],
  [job("IN_PROGRESS", "VERIFYING", null, "REJECTED"), "Being verified", "held"],
  [job("IN_PROGRESS", "REFUND_PENDING"), "Held in escrow", "held"],
  [job("IN_PROGRESS", "REFUND_PENDING", null, "REJECTED"), "Rejected (escrow still held)", "alert"],
  [job("VERIFIED", "AWAITING_CLIENT"), "Verified (awaiting review)", "held"],
  [job("VERIFIED", "DISPUTED"), "Disputed", "alert"],
  [job("VERIFIED", "RELEASE_PENDING"), "Paying out", "ok"],
  [{ ...job("VERIFIED", "RELEASE_PENDING"), providerDispute: { status: "OPEN", outcome: null } }, "Payout held for a buyer dispute", "alert"],
  [job("VERIFIED", "REFUND_PENDING"), "Disputed", "alert"],
  [job("PAID", "PAID"), "Paid", "ok"],
  [job("REFUNDED", "REFUNDED"), "Refunded", "new"],
  [job("CLOSED", "CLOSED"), "Closed", "new"],
];

test("every reachable status and phase reads its literal label and tone", () => {
  for (const [input, label, tone] of REACHABLE) {
    assert.deepEqual(statusLabel(input), { label, tone }, `${input.status}/${input.phase}`);
  }
});

test("the reachable states use exactly the twelve labels of the plan", () => {
  assert.deepEqual(
    [...new Set(REACHABLE.map(([, label]) => label))].sort(),
    [
      "Being verified",
      "Closed",
      "Disputed",
      "Held in escrow",
      "Open for bids",
      "Paid",
      "Paying out",
      "Payout held for a buyer dispute",
      "Refunded",
      "Rejected (escrow still held)",
      "Verified (awaiting review)",
      "Waiting for payment",
    ],
  );
});

test("a buyer dispute holds an approved payout until PayPal resolves it for the seller, the same rule core applies", () => {
  const approved = (providerDispute: StatusInput["providerDispute"]): StatusInput => ({ ...job("VERIFIED", "RELEASE_PENDING"), providerDispute });
  assert.deepEqual(statusLabel(approved({ status: "OPEN", outcome: null })), { label: "Payout held for a buyer dispute", tone: "alert" });
  assert.deepEqual(statusLabel(approved({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" })), { label: "Paying out", tone: "ok" });
  assert.deepEqual(statusLabel(approved({ status: "RESOLVED", outcome: "CANCELED_BY_BUYER" })), { label: "Paying out", tone: "ok" });
  assert.deepEqual(statusLabel(approved({ status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR" })), { label: "Payout held for a buyer dispute", tone: "alert" });
  assert.deepEqual(statusLabel(approved({ status: "RESOLVED", outcome: null })), { label: "Payout held for a buyer dispute", tone: "alert" });
  assert.deepEqual(statusLabel(approved(null)), { label: "Paying out", tone: "ok" });
});

test("a dispute on a job that is not paying out leaves its label as the phase reads it", () => {
  const open = { status: "OPEN" as const, outcome: null };
  assert.deepEqual(statusLabel({ ...job("VERIFIED", "AWAITING_CLIENT"), providerDispute: open }), { label: "Verified (awaiting review)", tone: "held" });
  assert.deepEqual(statusLabel({ ...job("PAID", "PAID"), providerDispute: open }), { label: "Paid", tone: "ok" });
});

test("a status and phase pair that no state reaches throws rather than reading as another state", () => {
  assert.throws(() => statusLabel(job("OPEN", "READY")), /no status label for OPEN\/READY/);
});

test("escrow, bid, ledger, verdict, and run failure values read in plain words", () => {
  assert.equal(escrowWord("NONE"), "Not funded");
  assert.equal(escrowWord("HELD"), "Held");
  assert.equal(escrowWord("RELEASED"), "Released");
  assert.equal(escrowWord("REFUNDED"), "Refunded");
  assert.equal(bidStatusWord("PENDING"), "Pending");
  assert.equal(bidStatusWord("NOT_SELECTED"), "Not selected");
  assert.equal(ledgerKindWord("FEE"), "Fee");
  assert.equal(ledgerKindWord("REFUND"), "Refunded");
  assert.deepEqual(verdictLabel("VERIFIED"), { label: "Verified", tone: "ok" });
  assert.deepEqual(verdictLabel("REJECTED"), { label: "Rejected", tone: "alert" });
  assert.equal(runFailureWord("RUN_DEADLINE_EXCEEDED"), "the run ran past its deadline");
  assert.equal(runFailureWord("SOMETHING_NEW"), "SOMETHING_NEW");
  assert.equal(draftFailureWord("ISSUE_BODY_UNREADABLE"), "the issue text could not be read");
  assert.equal(draftFailureWord("PIPELINE_ERROR"), "the drafting step hit an internal error");
});
