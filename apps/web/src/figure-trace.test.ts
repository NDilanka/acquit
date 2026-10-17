import assert from "node:assert/strict";
import { test } from "node:test";
import type { FigureTrace, FigureTraceLine } from "./api-types";
import { checkedPart, figureCheck, isFigureTrace, paypalWords } from "./figure-trace.ts";

const line = (cents: number, paypal: FigureTraceLine["paypal"] = { id: "CAP-1", status: "MATCHED", checkedCents: cents, observedCents: cents, note: null }): FigureTraceLine => ({
  entryId: `job_1#${cents}`,
  jobId: "job_1",
  kind: "HELD",
  cents,
  at: "2026-05-01T10:00:00.000Z",
  receiptId: null,
  paypal,
});

const held = (lines: FigureTraceLine[], totalCents: number): FigureTrace => ({ figure: "held", label: "Held escrow", totalCents, lines });

test("a figure holds when its lines sum to its total, and does not when they differ", () => {
  assert.deepEqual(figureCheck(held([line(10000), line(2550)], 12550)), { linesCents: 12550, holds: true });
  assert.deepEqual(figureCheck(held([line(10000), line(2550)], 12500)), { linesCents: 12550, holds: false });
  assert.deepEqual(figureCheck(held([], 0)), { linesCents: 0, holds: true });
});

test("only a result with a trace's shape is drawn as a figure", () => {
  assert.equal(isFigureTrace(held([line(100)], 100)), true);
  assert.equal(isFigureTrace({ figure: "held", label: "Held escrow", totalCents: 100 }), false, "the lines are required");
  assert.equal(isFigureTrace({ ...held([], 0), figure: "profit" }), false, "an unknown figure is not a trace");
  assert.equal(isFigureTrace(null), false);
  assert.equal(isFigureTrace("held"), false);
});

test("PayPal's status is worded as PayPal answered, and a line PayPal did not answer for is never a match", () => {
  assert.deepEqual(paypalWords("MATCHED"), { text: "Matches PayPal", tone: "ok" });
  assert.deepEqual(paypalWords("PENDING_AT_PAYPAL"), { text: "Pending at PayPal", tone: "new" });
  assert.deepEqual(paypalWords("MISMATCHED"), { text: "Does not match PayPal", tone: "break" });
  assert.deepEqual(paypalWords("NOT_CHECKED"), { text: "Not checked yet", tone: "" });
});

test("a fee line says PayPal checked only its processing fee, and a fully checked line says nothing extra", () => {
  const fee: FigureTraceLine = { ...line(6000, { id: "CAP-1", status: "MATCHED", checkedCents: 1515, observedCents: 1515, note: null }), kind: "FEE" };
  assert.equal(checkedPart(fee), "PayPal checked only the $15.15 processing fee on the capture, not the whole fee or Acquit's share.");
  assert.equal(checkedPart(line(42000)), null);
  assert.equal(checkedPart(line(42000, { id: null, status: "NOT_CHECKED", checkedCents: null, observedCents: null, note: "not read" })), null);
});