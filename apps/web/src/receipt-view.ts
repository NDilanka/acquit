// The public receipt page's view model: plain words and money strings, computed from the body the API
// serves. Pure, so the page's copy and its digest verdict are tested without a browser.

import type { PublicAttempt, PublicReceiptResponse, TestTally } from "./api-types.ts";
import { authorityNote, usd, utc } from "./format.ts";

export type PublicReceipt = PublicReceiptResponse["receipt"];
export type HiddenCases = NonNullable<PublicReceipt["hiddenCases"]>;

/** The page a seller links to. The receipt id is the capability, so the job id never appears in the link. */
export function receiptPageHref(receiptId: string): string {
  return `/receipts/${encodeURIComponent(receiptId)}`;
}

/** The browser's recomputation, as the page holds it: not started, unavailable (no secure context), or the digest it computed. */
export type DigestCheck = { readonly kind: "PENDING" } | { readonly kind: "UNAVAILABLE" } | { readonly kind: "COMPUTED"; readonly digest: string };

export type DigestVerdict = "NOT_SEALED" | "NOT_REVEALED" | "PENDING" | "UNAVAILABLE" | "MATCH" | "NO_MATCH";

/**
 * Match only when the browser's digest of the revealed cases equals the digest the job committed before
 * its work started. The server's own revealed digest is never the comparison: the browser recomputes it.
 */
export function digestVerdict(hidden: PublicReceipt["hiddenCases"], check: DigestCheck): DigestVerdict {
  if (hidden === null) return "NOT_SEALED";
  if (hidden.revealed === null) return "NOT_REVEALED";
  if (check.kind === "PENDING") return "PENDING";
  if (check.kind === "UNAVAILABLE") return "UNAVAILABLE";
  return check.digest === hidden.committedDigest ? "MATCH" : "NO_MATCH";
}

/** The closed reason codes, in the words a seller reads. An unknown code shows as itself, never as nothing. */
const REASON_WORDS: Record<string, string> = {
  "TESTS_FAILED:frozen": "Visible tests failed",
  "TESTS_FAILED:hidden": "Hidden tests failed",
  "TESTS_MISSING:frozen": "Visible tests did not complete",
  "TESTS_MISSING:hidden": "Hidden tests did not complete",
  PROTECTED_PATH_MODIFIED: "A protected test file was changed",
  TEST_FRAMEWORK_IN_SOURCE: "Test framework code was added to source",
  SUBJECT_FAULT: "The judge's run faulted",
  SUBJECT_REPLY_MALFORMED: "The judge's reply was malformed",
  TREE_SYMLINK: "A symlink points outside the tree",
  TREE_GITLINK: "A submodule was added",
  DIFF_TOO_LARGE: "The change touches too many paths",
  SOURCE_PATHS_OVER_READ_BOUND: "The change touches too many source paths",
};

export function reasonWords(code: string): string {
  return REASON_WORDS[code] ?? code;
}

/**
 * The count sentences for a run that reached its tests. Null when either tally is missing, so the
 * reasons speak instead. Shared by the receipt line and the job timeline.
 */
export function tallyWords(frozen: TestTally | null, hidden: TestTally | null): string | null {
  if (frozen === null || hidden === null) return null;
  const visible = frozen.passed === frozen.expected
    ? `Passed all ${frozen.expected} visible tests.`
    : `Passed ${frozen.passed} of ${frozen.expected} visible tests.`;
  const hiddenPart = hidden.passed === hidden.expected
    ? `Passed all ${hidden.expected} hidden tests.`
    : `Failed ${hidden.expected - hidden.passed} of ${hidden.expected} hidden tests.`;
  return `${visible} ${hiddenPart}`;
}

/** One attempt, in the order it was judged: the verdict, the tallies it passed or the reasons it failed. */
export function attemptLine(attempt: PublicAttempt, total: number): string {
  const head = `Attempt ${attempt.ordinal} of ${total}`;
  if (attempt.result === "VERIFIED") {
    const frozen = attempt.frozen ? `Visible tests ${attempt.frozen.passed} of ${attempt.frozen.expected}` : null;
    const hidden = attempt.hidden ? `hidden tests ${attempt.hidden.passed} of ${attempt.hidden.expected}` : null;
    return `${head}: verified. ${[frozen, hidden].filter((part): part is string => part !== null).join(", ")}.`;
  }
  const counts = tallyWords(attempt.frozen, attempt.hidden);
  if (counts !== null) return `${head}: rejected. ${counts}`;
  const reasons = attempt.reasons.map(reasonWords);
  return `${head}: rejected. ${reasons.length > 0 ? reasons.join("; ") : "No reason recorded"}.`;
}

/** The headline a seller reads first: the outcome, the amount, the operator, and when it settled. */
export function outcomeLine(receipt: PublicReceipt): string {
  const operator = receipt.operator.handle ?? "the operator";
  const authority = receipt.releaseAuthority === null ? "" : ` ${authorityNote(receipt.releaseAuthority)}.`;
  return `Verified and paid. ${usd(receipt.money.paidCents)} released to ${operator} on ${utc(receipt.releasedAt)}.${authority}`;
}

export type MoneyLine = { readonly label: string; readonly value: string };

/** The money the receipt holds: the gross the capture held, the payout, and the two parts of the fee. */
export function moneyLines(money: PublicReceipt["money"]): readonly MoneyLine[] {
  const cents = (value: number | null) => (value === null ? "Not recorded" : usd(value));
  return [
    { label: "Held in escrow (gross)", value: cents(money.heldCents) },
    { label: "Paid to the operator", value: usd(money.paidCents) },
    { label: "Processing fee (PayPal)", value: cents(money.processorFeeCents) },
    { label: "Platform fee (Acquit)", value: cents(money.acquitFeeCents) },
  ];
}

export type PayPalLine = { readonly label: string; readonly id: string | null; readonly note: string };

/** The three PayPal ids a settled job carries. A fee has no id of its own unless a reimbursement payout settled it. */
export function paypalLines(paypal: PublicReceipt["paypal"]): readonly PayPalLine[] {
  return [
    { label: "Capture", id: paypal.captureId, note: "The buyer's payment, held in escrow until the release." },
    { label: "Payout", id: paypal.payoutItemId, note: "The referenced PayPal payout that paid the operator." },
    {
      label: "Fee",
      id: paypal.feeBatchId,
      note: paypal.feeBatchId === null
        ? "No separate fee payout: PayPal took its processing fee out of the capture."
        : "The payout batch that settled the fee reimbursement.",
    },
  ];
}

/** The judge's card, as the CI run last verified it, in one sentence and the known gaps. */
export function scoreCardLines(card: PublicReceipt["scoreCard"]): readonly string[] {
  return [
    `Caught ${card.cheatsCaught} of ${card.cheatsTotal} known cheats. Passed ${card.honestPassed} of ${card.honestTotal} honest submissions.`,
    card.gaps.length === 0 ? "No known gaps." : `Known gaps: ${card.gaps.join(", ")}.`,
  ];
}

export function operatorLine(operator: PublicReceipt["operator"]): string {
  const who = operator.handle ?? "The operator";
  const kind = operator.label === "HOUSE" ? "House operator" : operator.label === "INDEPENDENT" ? "Independent operator" : "Operator";
  return `${who}, ${kind}.`;
}

/** The sandbox line every receipt carries, so no PayPal figure reads as real money. */
export const SANDBOX_NOTE = "PayPal sandbox. No real money moves.";

/** The line a judge-scenario receipt carries: its agent was a script, and the verifier run that judged it was real. */
export const SCRIPTED_NOTE = "Scripted agent (Simulated) did this work in a judge scenario. The verifier run that judged it was real.";
