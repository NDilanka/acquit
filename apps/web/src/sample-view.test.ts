import assert from "node:assert/strict";
import { test } from "node:test";
import { WIDGET_IDS, WIDGET_ROWS } from "./dashboard-widgets.ts";
import { seededWidgets } from "./studio-data.ts";

// The sample book's widgets, in the order the page shows them. The live escrow page's PayPal card is not one of them.
const SAMPLE_IDS = [
  "acquit-held",
  "acquit-released",
  "acquit-refunded",
  "acquit-fees",
  "acquit-pass-rate",
  "acquit-reject-rate",
  "acquit-tamper-caught",
  "acquit-conserves",
  "acquit-verdict-grid",
  "acquit-sample-reconciliation",
  "acquit-changes",
];

test("the sample book's widgets are its own set, in the order the page shows them", () => {
  assert.deepEqual(WIDGET_IDS.sample, SAMPLE_IDS);
  assert.equal(WIDGET_IDS.sample.includes("acquit-reconciliation"), false);
});

test("every sample widget is labelled with the literal Sample names", () => {
  assert.deepEqual(
    WIDGET_ROWS.sample.flat().map((spec) => spec.label),
    [
      "Sample: held escrow",
      "Sample: released",
      "Sample: refunded",
      "Sample: fees",
      "Sample: verifier pass rate",
      "Sample: verifier reject rate",
      "Sample: tamper attempts caught",
      "Sample: ledger conserves",
      "Sample: verdict timeline",
      "Sample: reconciliation",
      "Sample: changes",
    ],
  );
});

test("no sample label or agent description uses a word the page must not show", () => {
  for (const spec of WIDGET_ROWS.sample.flat()) {
    assert.doesNotMatch(`${spec.label} ${spec.ai.description} ${spec.ai.usage}`, /demo|guest|visitor|judge/i, spec.id);
  }
});

test("a fresh sample page seeds exactly the sample widgets", () => {
  assert.deepEqual(Object.keys(seededWidgets("sample")).sort(), [...SAMPLE_IDS].sort());
});
