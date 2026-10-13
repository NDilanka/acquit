import type { AgReportState, AgWidgetDataFormat } from "ag-studio";
import type { AgRegistry, AgWidgetDefinition } from "ag-studio-react";

export type DashboardId = "escrow" | "earnings";

export const COLUMNS = 12;

/** What Studio's widget catalogue tells the agents about a widget type. */
export type WidgetAi = { readonly description: string; readonly usage: string; readonly configuration: string };

export type WidgetSpecData = {
  readonly id: string;
  readonly label: string;
  readonly kind: "stat" | "card";
  readonly xSpan: number;
  readonly ySpan: number;
  readonly ai: WidgetAi;
};

const STAT_CONFIGURATION =
  "Takes no data mapping, filters, or format; it computes its figure from Acquit's own data. A tile 3 or 4 columns wide and 2 rows tall fits.";

const stat = (description: string, usage: string): WidgetAi => ({ description, usage, configuration: STAT_CONFIGURATION });

/** Each dashboard's widgets, one inner array per row of a fresh layout. */
export const WIDGET_ROWS = {
  escrow: [
    [
      {
        id: "acquit-held",
        label: "Held escrow",
        kind: "stat",
        xSpan: 3,
        ySpan: 2,
        ai: stat(
          "One big dollar figure: the escrow held on jobs not yet released or refunded, from the platform ledger.",
          "Use when the reader wants to see how much money is in escrow right now.",
        ),
      },
      {
        id: "acquit-released",
        label: "Released",
        kind: "stat",
        xSpan: 3,
        ySpan: 2,
        ai: stat(
          "One big dollar figure: the total escrow released to operators, from the platform ledger.",
          "Use when the reader wants to see how much has been paid out to operators.",
        ),
      },
      {
        id: "acquit-refunded",
        label: "Refunded",
        kind: "stat",
        xSpan: 3,
        ySpan: 2,
        ai: stat(
          "One big dollar figure: the total escrow refunded to clients, from the platform ledger.",
          "Use when the reader wants to see how much has gone back to clients.",
        ),
      },
      {
        id: "acquit-fees",
        label: "Fees",
        kind: "stat",
        xSpan: 3,
        ySpan: 2,
        ai: stat(
          "One big dollar figure: the total fees taken, PayPal processing and Acquit's, from the platform ledger.",
          "Use when the reader wants to see what fees have cost across all jobs.",
        ),
      },
    ],
    [
      {
        id: "acquit-pass-rate",
        label: "Verifier pass rate",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        ai: stat(
          "One big percentage: the share of verifier attempts that passed, with the attempt count beneath.",
          "Use when the reader asks how often submitted work passes verification.",
        ),
      },
      {
        id: "acquit-reject-rate",
        label: "Verifier reject rate",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        ai: stat(
          "One big percentage: the share of verifier attempts that were rejected, with the attempt count beneath.",
          "Use when the reader asks how often submitted work fails verification.",
        ),
      },
      {
        id: "acquit-tamper-caught",
        label: "Tamper attempts caught",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        ai: stat(
          "One big count: the verifier attempts rejected for editing the job's frozen tests.",
          "Use when the reader asks whether anyone tried to cheat the verifier.",
        ),
      },
    ],
    [
      {
        id: "acquit-conserves",
        label: "Ledger conserves",
        kind: "card",
        xSpan: 12,
        ySpan: 4,
        ai: {
          description:
            "A check card over released jobs: payout to operators, fees, and paid by clients, with a pill saying whether payout plus fee equals what clients paid.",
          usage: "Use when the reader wants proof the ledger balances, or to spot a ledger break.",
          configuration:
            "Takes no data mapping, filters, or format; it reads the platform ledger itself. Give it the full 12 columns and at least 4 rows.",
        },
      },
    ],
  ],
  earnings: [
    [
      {
        id: "acquit-paid-out",
        label: "Total paid out",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        ai: stat(
          "One big dollar figure: the total paid out to the signed-in operator across their job receipts.",
          "Use when the operator wants to see what they have earned in total.",
        ),
      },
      {
        id: "acquit-fees-withheld",
        label: "Fees withheld",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        ai: stat(
          "One big dollar figure: the fees withheld from the signed-in operator's payouts, PayPal processing and Acquit's.",
          "Use when the operator wants to see what fees took from their earnings.",
        ),
      },
      {
        id: "acquit-jobs-paid",
        label: "Jobs paid",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        ai: stat(
          "One big count: the signed-in operator's jobs that were verified, released, and paid.",
          "Use when the operator wants to see how many jobs they have been paid for.",
        ),
      },
    ],
    [
      {
        id: "acquit-receipt-card",
        label: "Receipt card",
        kind: "card",
        xSpan: 12,
        ySpan: 5,
        ai: {
          description:
            "The signed-in operator's newest job receipt: job id, operator, amount paid, fee, payout, and when it was released through which PayPal payout item.",
          usage: "Use when the operator wants to see the details of their latest paid job.",
          configuration:
            "Takes no data mapping, filters, or format; it reads the operator's receipts itself. Give it the full 12 columns and at least 5 rows.",
        },
      },
    ],
  ],
} as const satisfies Record<DashboardId, readonly (readonly WidgetSpecData[])[]>;

export type AcquitWidgetId = (typeof WIDGET_ROWS)[DashboardId][number][number]["id"];

/** Each dashboard's own widget ids, which scope the agent's widget catalogue and its delegated adds. */
export const WIDGET_IDS: Record<DashboardId, readonly AcquitWidgetId[]> = {
  escrow: WIDGET_ROWS.escrow.flat().map((w) => w.id),
  earnings: WIDGET_ROWS.earnings.flat().map((w) => w.id),
};

// The stacked narrow layout keeps each widget's wide-layout height, and a widget scrolls its own
// overflow, so a widget whose content grows when it is narrowed lists a minimum height here; that
// way no stacked widget's last line scrolls out of view. The receipt card needs room for its pill,
// five summary rows and a caption that wraps to two lines at 390 px.
export const STACKED_MIN_YSPAN: Partial<Record<AcquitWidgetId, number>> = {
  "acquit-receipt-card": 7,
};

export type AcquitWidget = { type: AcquitWidgetId; dataMapping: Record<string, never>; format?: AgWidgetDataFormat<unknown> };

export interface AcquitRegistry extends AgRegistry {
  widgets: readonly AgWidgetDefinition<AcquitWidgetId, AcquitWidget>[];
}

export type DashboardState = AgReportState<AcquitRegistry>;
