// The Explain panel and the ask chat's card read a traced figure through these helpers. They are pure, so the
// node tests cover the sum check and the PayPal wording without a DOM.

import { isFigureId } from "../../../packages/core/src/explain.ts";
import type { FigureTrace, FigureTraceLine } from "./api-types";

/** The lines summed, and whether that sum is the figure. The check runs on the lines here, not on the server's total alone. */
export function figureCheck(trace: FigureTrace): { readonly linesCents: number; readonly holds: boolean } {
  const linesCents = trace.lines.reduce((sum, line) => sum + line.cents, 0);
  return { linesCents, holds: linesCents === trace.totalCents };
}

/** A tool result is drawn as a trace only when it has the trace's shape. */
export function isFigureTrace(value: unknown): value is FigureTrace {
  if (typeof value !== "object" || value === null) return false;
  const shape = value as { readonly figure?: unknown; readonly label?: unknown; readonly totalCents?: unknown; readonly lines?: unknown };
  return isFigureId(shape.figure) && typeof shape.label === "string" && typeof shape.totalCents === "number" && Array.isArray(shape.lines);
}

/** A line's PayPal status in words and in the pill's tone. A status PayPal did not answer for is never worded as a match. */
export function paypalWords(status: FigureTraceLine["paypal"]["status"]): { readonly text: string; readonly tone: "ok" | "new" | "break" | "" } {
  switch (status) {
    case "MATCHED":
      return { text: "Matches PayPal", tone: "ok" };
    case "PENDING_AT_PAYPAL":
      return { text: "Pending at PayPal", tone: "new" };
    case "MISMATCHED":
      return { text: "Does not match PayPal", tone: "break" };
    case "NOT_CHECKED":
      return { text: "Not checked yet", tone: "" };
  }
}
