import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PublicAttempt } from "./api-types.ts";
import {
  attemptLine,
  digestVerdict,
  isLaserReceipt,
  laserVerdictLine,
  LASER_DELIVERY_PATH,
  LASER_WORDS,
  LASER_WORKFLOW_NAME,
  moneyLines,
  operatorLine,
  outcomeLine,
  paypalLines,
  receiptJsonHref,
  receiptPageHref,
  reasonWords,
  sumCheck,
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

test("public receipt amounts keep the currency with the amount while narrow labels can wrap", () => {
  const page = readFileSync(new URL("./pages/PublicReceipt.tsx",import.meta.url),"utf8");
  const css = readFileSync(new URL("./public-receipt.css",import.meta.url),"utf8");
  assert.match(page,/import "\.\.\/public-receipt\.css"/);
  assert.match(page,/className="rows receipt-money-rows"/);
  assert.match(page,/className="num receipt-money-value">\{line\.value\}/);
  assert.match(css,/\.receipt-money-rows \.receipt-money-value \{[^}]*flex-shrink: 0;[^}]*white-space: nowrap;[^}]*overflow-wrap: normal;/);
  assert.match(css,/\.receipt-money-rows > div > span \{ min-width: 0; overflow-wrap: anywhere;/);
  assert.ok(moneyLines({...receipt().money,paidCents:3638}).some(line => line.value === "36.38 USD"));
});

test("the receipt link is the public page for a receipt id, with the id encoded", () => {
  assert.equal(receiptPageHref("rcpt_abc"), "/receipts/rcpt_abc");
  assert.equal(receiptPageHref("rcpt a/b"), "/receipts/rcpt%20a%2Fb");
});

test("the JSON link is the API's own address for the same receipt, with the id encoded", () => {
  assert.equal(receiptJsonHref("rcpt_abc"), "/api/receipts/rcpt_abc");
  assert.equal(receiptJsonHref("rcpt a/b"), "/api/receipts/rcpt%20a%2Fb");
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

test("the money lines name the gross held, the released amount, and the two parts of the fee", () => {
  assert.deepEqual(moneyLines(receipt().money), [
    { label: "Held in escrow (gross)", value: "420.00 USD" },
    { label: "Released to the operator", value: "360.00 USD" },
    { label: "Processing fee (PayPal)", value: "15.15 USD" },
    { label: "Platform fee (Acquit)", value: "44.85 USD" },
  ]);
});

test("a money figure the API did not serve gets no row, and nothing is invented in its place", () => {
  assert.deepEqual(moneyLines({ heldCents: null, paidCents: 36_000, feeCents: null, processorFeeCents: null, acquitFeeCents: null }),
    [{ label: "Released to the operator", value: "360.00 USD" }]);
  assert.deepEqual(moneyLines({ heldCents: 42_000, paidCents: 36_000, feeCents: 6_000, processorFeeCents: 1_515, acquitFeeCents: null })
    .map(line => line.label), ["Held in escrow (gross)", "Released to the operator", "Processing fee (PayPal)"]);
});

test("the sum check names Held = Released + PayPal fee + Acquit fee with the served amounts, and holds when they add up", () => {
  assert.deepEqual(sumCheck(receipt().money), {
    equation: "Held = Released + PayPal fee + Acquit fee",
    figures: "420.00 USD = 360.00 USD + 15.15 USD + 44.85 USD",
    holds: true,
  });
});

test("the sum check says it does not hold when the served amounts miss by a cent", () => {
  const off = sumCheck({ heldCents: 42_001, paidCents: 36_000, feeCents: 6_000, processorFeeCents: 1_515, acquitFeeCents: 4_485 });
  assert.equal(off?.holds, false);
});

test("the sum check is shown only when the held amount and both fee parts are all served", () => {
  assert.equal(sumCheck({ heldCents: null, paidCents: 36_000, feeCents: null, processorFeeCents: 1_515, acquitFeeCents: 4_485 }), null);
  assert.equal(sumCheck({ heldCents: 42_000, paidCents: 36_000, feeCents: 6_000, processorFeeCents: null, acquitFeeCents: 4_485 }), null);
  assert.equal(sumCheck({ heldCents: 42_000, paidCents: 36_000, feeCents: 6_000, processorFeeCents: 1_515, acquitFeeCents: null }), null);
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

const LASER_VERDICT: PublicReceipt["verdict"] = { attemptsUsed: 1, attemptsAllowed: 3, frozen: { expected: 13, passed: 13 },
  hidden: { expected: 7, passed: 7 }, pullRequest: null, mergeCommit: "b".repeat(40), history: [] };

test("a receipt with no pull request is a laser-cut receipt, and a code job's receipt is not", () => {
  assert.equal(isLaserReceipt(receipt({ verdict: LASER_VERDICT })), true);
  assert.equal(isLaserReceipt(receipt()), false);
});

test("a laser-cut verdict counts public rules and sealed checks, and the attempts used", () => {
  assert.equal(laserVerdictLine(LASER_VERDICT), "Public rules 13 of 13. Sealed checks 7 of 7. Attempts used 1 of 3.");
  assert.equal(laserVerdictLine({ ...LASER_VERDICT, attemptsUsed: 2, frozen: { expected: 13, passed: 11 }, hidden: { expected: 7, passed: 6 } }),
    "Public rules 11 of 13. Sealed checks 6 of 7. Attempts used 2 of 3.");
});

test("a laser-cut attempt names its public rules and sealed checks, never visible or hidden tests", () => {
  const verified: PublicAttempt = { ordinal: 1, result: "VERIFIED", at: RELEASED, frozen: { expected: 13, passed: 13 },
    hidden: { expected: 7, passed: 7 }, reasons: [] };
  assert.equal(attemptLine(verified, 3, LASER_WORDS), "Attempt 1 of 3: verified. Public rules 13 of 13, sealed checks 7 of 7.");
  const rejected: PublicAttempt = { ...verified, result: "REJECTED", frozen: { expected: 13, passed: 12 }, reasons: ["TESTS_FAILED:frozen"] };
  assert.equal(attemptLine(rejected, 3, LASER_WORDS), "Attempt 1 of 3: rejected. Passed 12 of 13 public rules. Passed all 7 sealed checks.");
  assert.equal(tallyWords({ expected: 13, passed: 13 }, { expected: 7, passed: 5 }, LASER_WORDS),
    "Passed all 13 public rules. Failed 2 of 7 sealed checks.");
});

test("the laser-cut receipt names its workflow and delivered file, and drops the code verifier's score card and pull request", () => {
  assert.equal(LASER_WORKFLOW_NAME, "Laser cut");
  assert.equal(LASER_DELIVERY_PATH, "delivery/part.svg");
  const page = readFileSync(new URL("./pages/PublicReceipt.tsx", import.meta.url), "utf8");
  assert.match(page, /const laser = isLaserReceipt\(r\);/);
  assert.match(page, /\{laser \? \(\s*<>\s*<p>\{laserVerdictLine\(r\.verdict\)\}<\/p>/);
  assert.match(page, /Workflow: \{LASER_WORKFLOW_NAME\}\. Delivered file: <span className="mono">\{LASER_DELIVERY_PATH\}<\/span>\./);
  assert.match(page, /Delivered commit <IdChip value=\{r\.verdict\.mergeCommit\} \/>/);
  assert.match(page, /\{!laser && \(\s*<section className="card pad">\s*<h2>Verifier score card<\/h2>/);
  assert.match(page, /<h2>Sealed checks<\/h2>/);
});

test("a code job's receipt keeps its visible and hidden test wording, pull request, hidden cases, and score card", () => {
  const page = readFileSync(new URL("./pages/PublicReceipt.tsx", import.meta.url), "utf8");
  assert.match(page, /Visible tests \{r\.verdict\.frozen\.passed\} of \{r\.verdict\.frozen\.expected\}, hidden tests \{r\.verdict\.hidden\.passed\} of\{" "\}/);
  assert.match(page, /Pull request #\{r\.verdict\.pullRequest\}, checked tree <IdChip value=\{r\.verdict\.mergeCommit\} \/>/);
  assert.match(page, /<h2>Hidden cases<\/h2>/);
  assert.match(page, /<h2>Verifier score card<\/h2>/);
  assert.match(page, /\{attemptLine\(attempt, r\.verdict\.attemptsAllowed\)\}/);
});

test("laser PayPal ID chips keep all-width containment and code rows have a separate scope", () => {
  const page = readFileSync(new URL("./pages/PublicReceipt.tsx",import.meta.url),"utf8");
  const css = readFileSync(new URL("./public-receipt.css",import.meta.url),"utf8");
  const ids = page.slice(page.indexOf("{ids.length > 0"),page.indexOf("{!laser && ("));
  assert.match(ids,/<section className="card pad money">/);
  assert.match(ids,/<div className=\{laser \? "rows laser-receipt-ids" : "rows code-receipt-ids"\}>/);
  assert.match(ids,/\{line\.id !== null && <IdChip value=\{line\.id\} \/>\}/);
  assert.equal((page.match(/laser-receipt-ids/g) ?? []).length,1,"only the laser PayPal rows get the new class");
  assert.match(css,/\.laser-receipt-ids > div \{ flex-wrap: wrap; gap: var\(--space-3\); align-items: flex-start; \}/);
  assert.match(css,/\.laser-receipt-ids \.idchip \{ display: block; min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; \}/);
});

test("code PayPal ID chips wrap only at the narrow breakpoint, leaving desktop code receipt styles alone", () => {
  const page = readFileSync(new URL("./pages/PublicReceipt.tsx",import.meta.url),"utf8");
  const css = readFileSync(new URL("./public-receipt.css",import.meta.url),"utf8");
  const narrow = css.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.equal((page.match(/code-receipt-ids/g) ?? []).length,1,"only the code PayPal rows get the narrow scope");
  assert.match(narrow,/\.code-receipt-ids > div \{ flex-wrap: wrap; gap: var\(--space-3\); align-items: flex-start; \}/);
  assert.match(narrow,/\.code-receipt-ids \.idchip \{ display: block; min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; \}/);
  const outsideNarrow = css.replace(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/g,"");
  assert.doesNotMatch(outsideNarrow,/\.code-receipt-ids\b/,"the 1440px code receipt must not acquire these rules");
});
