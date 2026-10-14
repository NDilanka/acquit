import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScopingCase, ScopingResponse } from "./api-types";
import { ApiError } from "./api.ts";
import { approvalStep, countsLine, leaveOut, readPanel, shortDigest, type ScopingPanel } from "./scoping-review.ts";

const usd250: ScopingCase = {
  id: "h-usd-250",
  target: { module: "src/money.ts", export: "formatMinor" },
  args: [250, "USD"],
  expected: "2.50",
  citation: "250 cents in USD should print as 2.50",
};
const jpy500: ScopingCase = {
  id: "h-jpy-500",
  target: { module: "src/money.ts", export: "formatMinor" },
  args: [500, "JPY"],
  expected: "500",
  citation: "JPY has no minor unit",
};
const eur199: ScopingCase = {
  id: "h-eur-199",
  target: { module: "src/money.ts", export: "formatMinor" },
  args: [199, "EUR"],
  expected: "1.99",
  citation: "199 cents in EUR is 1.99",
};

const digest = "4b7e1d09c2a6f3e8d5b1c7a9e0f2d4b6c8a1e3f54b7e1d09c2a6f3e8d5b1c7a9";

function draft(over: Partial<ScopingResponse> = {}): ScopingResponse {
  return {
    jobId: "job_7",
    status: "AWAITING_APPROVAL",
    reason: null,
    counts: { candidates: 5, f1: 4, f2: 4, f3: 3, f4: 3, deduped: 3 },
    issueBody: "Totals print wrong for 2-decimal and 0-decimal currencies.",
    approvedAt: null,
    contract: "formatMinor prints minor units in the currency's own decimals.",
    frozenAt: "9f2c41e7d0b3a5c6e8f1d2b4a6c8e0f1a3b5c7d9",
    cases: [usd250, jpy500, eur199],
    ...over,
  };
}

test("the cleared checkboxes are what the approval leaves out, in the draft's order", () => {
  const cases = [usd250, jpy500, eur199];
  assert.deepEqual(leaveOut(cases, new Set(["h-usd-250", "h-jpy-500", "h-eur-199"])), []);
  assert.deepEqual(leaveOut(cases, new Set(["h-jpy-500"])), ["h-usd-250", "h-eur-199"]);
  assert.deepEqual(leaveOut(cases, new Set()), ["h-usd-250", "h-jpy-500", "h-eur-199"]);
});

test("the counts line reads each filter's survivors in order", () => {
  assert.equal(
    countsLine({ candidates: 5, f1: 4, f2: 4, f3: 3, f4: 3, deduped: 2 }),
    "5 drafted, 4 ran clean on the frozen commit, 4 discriminated, 3 passed the trusted fix, 3 justified, 2 kept after dedupe",
  );
});

test("a read maps to its panel: a draft in progress, a failure by name, a review, a frozen set, or no panel", () => {
  assert.deepEqual(readPanel({ ok: true, body: draft({ status: "DRAFTING", contract: null, cases: [] }) }, null), { kind: "DRAFTING" });
  assert.deepEqual(readPanel({ ok: true, body: draft({ status: "FAILED", reason: "DRAFT_BUDGET", cases: [] }) }, null), {
    kind: "FAILED",
    reason: "DRAFT_BUDGET",
  });
  const review = readPanel({ ok: true, body: draft() }, null);
  assert.equal(review.kind, "REVIEW");
  assert.deepEqual(review.kind === "REVIEW" && review.draft.cases.map((c) => c.id), ["h-usd-250", "h-jpy-500", "h-eur-199"]);
  assert.deepEqual(
    readPanel({ ok: true, body: draft({ status: "APPROVED", approvedAt: "2026-11-03T15:22:00.000Z", cases: [usd250] }) }, digest),
    {
      kind: "FROZEN",
      approvedIds: ["h-usd-250"],
      approvedAt: "2026-11-03T15:22:00.000Z",
      digest,
      draft: draft({ status: "APPROVED", approvedAt: "2026-11-03T15:22:00.000Z", cases: [usd250] }),
    },
  );
  assert.deepEqual(readPanel({ ok: false, error: new ApiError(403, "NOT_OWNER") }, null), { kind: "HIDDEN" });
  assert.deepEqual(readPanel({ ok: false, error: new ApiError(404, "NO_DRAFT") }, null), { kind: "HIDDEN" });
  assert.deepEqual(readPanel({ ok: false, error: new ApiError(500, "INTERNAL") }, null), {
    kind: "UNREADABLE",
    message: "The request was refused. (INTERNAL)",
  });
});

test("a 200 approval freezes the panel on the approved ids and the digest, then re-reads for the approval time", () => {
  const review = readPanel({ ok: true, body: draft() }, null) as Extract<ScopingPanel, { kind: "REVIEW" }>;
  const step = approvalStep(review, { ok: true, body: { jobId: "job_7", digest, approvedIds: ["h-usd-250", "h-eur-199"] } });
  assert.equal(step.reread, true);
  assert.equal(step.error, null);
  assert.equal(step.digest, digest);
  assert.equal(step.panel.kind, "FROZEN");
  assert.deepEqual(step.panel.kind === "FROZEN" && step.panel.approvedIds, ["h-usd-250", "h-eur-199"]);
  assert.deepEqual(step.panel.kind === "FROZEN" && step.panel.draft.cases.map((c) => c.id), ["h-usd-250", "h-eur-199"]);
  assert.equal(step.panel.kind === "FROZEN" && step.panel.approvedAt, null);
  assert.equal(shortDigest(digest), "4b7e1d09c2a6");
});

test("a coverage refusal keeps the review open and names the families the kept cases lost", () => {
  const review = readPanel({ ok: true, body: draft() }, null) as Extract<ScopingPanel, { kind: "REVIEW" }>;
  const step = approvalStep(review, {
    ok: false,
    error: new ApiError(422, "COVERAGE_GATE", undefined, { error: "COVERAGE_GATE", missing: ["zero-decimal", "three-decimal"] }),
  });
  assert.deepEqual(step, {
    panel: review,
    error: "The kept cases no longer cover: zero-decimal, three-decimal. Keep a case for each, then approve again.",
    reread: false,
    digest: null,
  });
});

test("leaving every case out keeps the review open and says at least one case must stay", () => {
  const review = readPanel({ ok: true, body: draft() }, null) as Extract<ScopingPanel, { kind: "REVIEW" }>;
  const step = approvalStep(review, { ok: false, error: new ApiError(422, "NOTHING_APPROVED") });
  assert.deepEqual(step, { panel: review, error: "Every case is left out. Keep at least one case to approve.", reread: false, digest: null });
});

test("an approval that finds the draft already frozen re-reads to show the frozen set, with no error", () => {
  const review = readPanel({ ok: true, body: draft() }, null) as Extract<ScopingPanel, { kind: "REVIEW" }>;
  const step = approvalStep(review, { ok: false, error: new ApiError(409, "ALREADY_FROZEN") });
  assert.deepEqual(step, { panel: review, error: null, reread: true, digest: null });
});

test("an unreachable API keeps the review open and says a retry is safe", () => {
  const review = readPanel({ ok: true, body: draft() }, null) as Extract<ScopingPanel, { kind: "REVIEW" }>;
  const step = approvalStep(review, { ok: false, error: new TypeError("Failed to fetch") });
  assert.deepEqual(step, {
    panel: review,
    error: "Cannot reach the API: TypeError: Failed to fetch. Retry is safe.",
    reread: false,
    digest: null,
  });
});
