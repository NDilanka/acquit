import type { AgReportState, AgWidgetDataFormat } from "ag-studio";
import type { AgRegistry, AgWidgetDefinition } from "ag-studio-react";

export type DashboardId = "escrow" | "earnings";

export const COLUMNS = 12;

export type WidgetSpecData = {
  readonly id: string;
  readonly label: string;
  readonly kind: "stat" | "card";
  readonly xSpan: number;
  readonly ySpan: number;
};

/** Each dashboard's widgets, one inner array per row of a fresh layout. */
export const WIDGET_ROWS = {
  escrow: [
    [
      { id: "acquit-held", label: "Held escrow", kind: "stat", xSpan: 3, ySpan: 2 },
      { id: "acquit-released", label: "Released", kind: "stat", xSpan: 3, ySpan: 2 },
      { id: "acquit-refunded", label: "Refunded", kind: "stat", xSpan: 3, ySpan: 2 },
      { id: "acquit-fees", label: "Fees", kind: "stat", xSpan: 3, ySpan: 2 },
    ],
    [
      { id: "acquit-pass-rate", label: "Verifier pass rate", kind: "stat", xSpan: 4, ySpan: 2 },
      { id: "acquit-reject-rate", label: "Verifier reject rate", kind: "stat", xSpan: 4, ySpan: 2 },
      { id: "acquit-tamper-caught", label: "Tamper attempts caught", kind: "stat", xSpan: 4, ySpan: 2 },
    ],
    [{ id: "acquit-conserves", label: "Ledger conserves", kind: "card", xSpan: 12, ySpan: 4 }],
  ],
  earnings: [
    [
      { id: "acquit-paid-out", label: "Total paid out", kind: "stat", xSpan: 4, ySpan: 2 },
      { id: "acquit-fees-withheld", label: "Fees withheld", kind: "stat", xSpan: 4, ySpan: 2 },
      { id: "acquit-jobs-paid", label: "Jobs paid", kind: "stat", xSpan: 4, ySpan: 2 },
    ],
    [{ id: "acquit-receipt-card", label: "Receipt card", kind: "card", xSpan: 12, ySpan: 5 }],
  ],
} as const satisfies Record<DashboardId, readonly (readonly WidgetSpecData[])[]>;

export type AcquitWidgetId = (typeof WIDGET_ROWS)[DashboardId][number][number]["id"];

export type AcquitWidget = { type: AcquitWidgetId; dataMapping: Record<string, never>; format?: AgWidgetDataFormat<unknown> };

export interface AcquitRegistry extends AgRegistry {
  widgets: readonly AgWidgetDefinition<AcquitWidgetId, AcquitWidget>[];
}

export type DashboardState = AgReportState<AcquitRegistry>;
