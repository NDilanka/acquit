import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlatformJobLedger, ReceiptRow } from "./api-types";
import type { DashboardState } from "./dashboard-widgets.ts";
import { EMPTY_STORY_TEXT, RECEIPT_WIDGET_ID, escrowStoryShown, receiptWidgetShown, studioPanels, withWidgetsFrom, withoutWidgets } from "./studio-story.ts";

const at = "2026-12-01T00:00:00.000Z";

function job(jobId: string): PlatformJobLedger {
  return {
    jobId,
    title: `Fix ${jobId}`,
    tenant: null,
    client: "ana-client",
    status: "OPEN",
    escrow: "NONE",
    operator: null,
    lines: [],
    paidCents: null,
    fee: null,
    payout: null,
    receipt: null,
    attempts: [],
  };
}

const seeded: ReceiptRow = {
  id: "rc_seed",
  jobId: null,
  operator: "op_1",
  agent: null,
  pullRequest: null,
  mergeCommit: null,
  frozen: null,
  hidden: null,
  attemptsUsed: null,
  paid: null,
  releasedAt: at,
  repository: null,
  source: "SEED",
  passedVerifiedCi: true,
  grossPaid: null,
  fee: null,
  feeSplit: null,
  result: null,
};

const paidReceipt: ReceiptRow = {
  id: "rc_1",
  jobId: "job_1",
  operator: "op_1",
  agent: "house-fixer",
  pullRequest: 7,
  mergeCommit: "abc1234",
  frozen: { expected: 3, passed: 3 },
  hidden: { expected: 2, passed: 2 },
  attemptsUsed: 1,
  paid: 4000,
  releasedAt: at,
  repository: "acme/widgets",
  source: "JOB",
  passedVerifiedCi: true,
  grossPaid: 4500,
  fee: 500,
  feeSplit: { processor: 150, acquit: 350 },
  result: "VERIFIED",
};

// A page as Studio keeps it: the receipt card sits beside a stat tile, and its record and placement are both kept.
const fullPage = (): DashboardState =>
  JSON.parse(
    JSON.stringify({
      selectedPageId: "main",
      pages: [
        {
          id: "main",
          layout: { columns: 12, rowHeight: 60 },
          widgets: {
            "acquit-paid-out": { type: "acquit-paid-out", dataMapping: {} },
            [RECEIPT_WIDGET_ID]: { type: RECEIPT_WIDGET_ID, dataMapping: {} },
          },
          widgetLayout: {
            "acquit-paid-out": { xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 2 },
            [RECEIPT_WIDGET_ID]: { xTrack: 0, yTrack: 2, xSpan: 12, ySpan: 5 },
          },
        },
      ],
    }),
  ) as DashboardState;

test("an escrow book with no jobs gets the story, with its exact text", () => {
  assert.equal(EMPTY_STORY_TEXT, "Run a scenario to see money move");
  assert.equal(escrowStoryShown([]), true);
});

test("an escrow book with a job on it gets no story", () => {
  assert.equal(escrowStoryShown([job("job_1")]), false);
});

test("earnings with no receipts hides the receipt widget", () => {
  assert.equal(receiptWidgetShown([]), false);
  assert.equal(receiptWidgetShown([seeded]), false, "a seeded row with no job behind it is not a receipt to show");
});

test("earnings with a job receipt keeps the receipt widget", () => {
  assert.equal(receiptWidgetShown([paidReceipt]), true);
  assert.equal(receiptWidgetShown([seeded, paidReceipt]), true);
});

test("hiding the receipt widget takes its record and placement off the page, and putting it back restores them exactly", () => {
  const full = fullPage();
  const shown = withoutWidgets(full, [RECEIPT_WIDGET_ID]);
  const page = shown.pages[0];
  assert.deepEqual(Object.keys(page?.widgets ?? {}), ["acquit-paid-out"]);
  assert.deepEqual(Object.keys(page?.widgetLayout ?? {}), ["acquit-paid-out"]);
  assert.deepEqual(withWidgetsFrom(shown, full, [RECEIPT_WIDGET_ID]), full);
});

test("a state Studio returns without the hidden widget gets it back from the last full state when it is saved", () => {
  const full = fullPage();
  const studioState = withoutWidgets(full, [RECEIPT_WIDGET_ID]);
  const saved = withWidgetsFrom(studioState, full, [RECEIPT_WIDGET_ID]);
  assert.deepEqual(saved.pages[0]?.widgetLayout?.[RECEIPT_WIDGET_ID], { xTrack: 0, yTrack: 2, xSpan: 12, ySpan: 5 });
  assert.equal(saved.pages[0]?.widgets?.[RECEIPT_WIDGET_ID]?.type, RECEIPT_WIDGET_ID);
});

const NO_PANELS = { view: { left: [], right: [] } };
const AI_PANEL = { view: { left: [], right: ["ai"] }, edit: { right: ["ai"] } };

test("the Ask the ledger panel shows only on a wide screen of a dashboard with an agent", () => {
  assert.deepEqual(studioPanels(true, false), AI_PANEL);
  assert.deepEqual(studioPanels(true, true), NO_PANELS);
  assert.deepEqual(studioPanels(false, false), NO_PANELS);
  assert.deepEqual(studioPanels(false, true), NO_PANELS);
});

test("the same panel choice is the same object, so Studio sees no change between renders", () => {
  assert.equal(studioPanels(true, false), studioPanels(true, false));
  assert.equal(studioPanels(true, true), studioPanels(true, true));
});
