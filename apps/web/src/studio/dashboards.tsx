import { createContext, useContext, type ComponentType } from "react";
import type { AgPageLayoutState, AgReportState, AgWidgetDataFormat } from "ag-studio";
import { createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import type { PayoutRow, PlatformJobLedger, ReceiptRow } from "../api-types";
import { dollars, utc } from "../format";
import { conserves, earnings, escrowTotals, newestReceipt, placeRows, stackLayout, verifierStats } from "../studio-data";

export type DashboardId = "escrow" | "earnings";

export type EarningsData = { readonly receipts: readonly ReceiptRow[]; readonly payouts: readonly PayoutRow[]; readonly handle: string };

export const EscrowContext = createContext<readonly PlatformJobLedger[] | null>(null);
export const EarningsContext = createContext<EarningsData | null>(null);

function useEscrow() {
  const jobs = useContext(EscrowContext);
  if (!jobs) throw new Error("escrow widget outside EscrowContext");
  return jobs;
}

function useEarnings() {
  const data = useContext(EarningsContext);
  if (!data) throw new Error("earnings widget outside EarningsContext");
  return data;
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

function stat<D>(useData: () => D, read: (data: D) => { value: string; note: string }): ComponentType {
  return function StatWidget() {
    const { value, note } = read(useData());
    return (
      <>
        <b className="studio-value num">{value}</b>
        <small className="muted">{note}</small>
      </>
    );
  };
}

function LedgerConserves() {
  const { payout, fee, paid, holds } = conserves(useEscrow());
  return (
    <>
      <span className={`pill ${holds ? "ok" : "break"}`}>
        <span className="dot" />
        {holds ? "Ledger conserves" : "LEDGER BREAK"}
      </span>
      <div className="rows">
        <div>
          <span>Payout to operators</span>
          <b className="num">{dollars(payout)}</b>
        </div>
        <div>
          <span>Fees</span>
          <b className="num">{dollars(fee)}</b>
        </div>
        <div className="total">
          <span>Paid by clients</span>
          <b className="num">{dollars(paid)}</b>
        </div>
      </div>
      <small className="muted">
        Over released jobs, payout + fee = paid: {dollars(payout)} + {dollars(fee)} {holds ? "=" : "≠"} {dollars(paid)}. Refreshes every 30 seconds.
      </small>
    </>
  );
}

function ReceiptCard() {
  const { receipts, payouts, handle } = useEarnings();
  const receipt = newestReceipt(receipts);
  if (!receipt) {
    return <p className="muted">No job receipt yet. Your newest paid job's receipt appears here once a release settles.</p>;
  }
  const payout = payouts.find((p) => p.jobId === receipt.jobId);
  return (
    <>
      <span className="pill ok">
        <span className="dot" />
        {receipt.result}
      </span>
      <div className="rows">
        <div>
          <span>Job</span>
          <b className="mono">{receipt.jobId}</b>
        </div>
        <div>
          <span>Operator</span>
          <b className="mono">{handle}</b>
        </div>
        <div>
          <span>Paid</span>
          <b className="num">{receipt.grossPaid === null ? "Not recorded" : dollars(receipt.grossPaid)}</b>
        </div>
        <div>
          <span>Fee</span>
          <b className="num">{receipt.fee === null ? "Not recorded" : dollars(receipt.fee)}</b>
        </div>
        <div className="total">
          <span>Payout</span>
          <b className="num">{dollars(receipt.paid)}</b>
        </div>
      </div>
      <small className="muted">
        Released {utc(receipt.releasedAt)}
        {payout && <> through payout item <span className="mono">{payout.payoutItemId}</span></>}.
      </small>
    </>
  );
}

type WidgetSpec = {
  readonly id: string;
  readonly label: string;
  readonly comp: ComponentType;
  readonly kind: "stat" | "card";
  readonly xSpan: number;
  readonly ySpan: number;
};

const escrowTotal = (key: keyof ReturnType<typeof escrowTotals>, note: string) =>
  stat(useEscrow, (jobs) => ({ value: dollars(escrowTotals(jobs)[key]), note }));

/** Each dashboard's widgets, one inner array per row of a fresh layout. */
const DASHBOARDS = {
  escrow: [
    [
      { id: "acquit-held", label: "Held escrow", kind: "stat", xSpan: 3, ySpan: 2, comp: escrowTotal("held", "In escrow on jobs not yet settled") },
      { id: "acquit-released", label: "Released", kind: "stat", xSpan: 3, ySpan: 2, comp: escrowTotal("released", "Paid out to operators") },
      { id: "acquit-refunded", label: "Refunded", kind: "stat", xSpan: 3, ySpan: 2, comp: escrowTotal("refunded", "Returned to clients") },
      { id: "acquit-fees", label: "Fees", kind: "stat", xSpan: 3, ySpan: 2, comp: escrowTotal("fees", "PayPal processing and Acquit") },
    ],
    [
      {
        id: "acquit-pass-rate",
        label: "Verifier pass rate",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        comp: stat(useEscrow, (jobs) => {
          const s = verifierStats(jobs);
          return { value: percent(s.passRate), note: `Of ${s.attempts} attempts verified` };
        }),
      },
      {
        id: "acquit-reject-rate",
        label: "Verifier reject rate",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        comp: stat(useEscrow, (jobs) => {
          const s = verifierStats(jobs);
          return { value: percent(s.rejectRate), note: `Of ${s.attempts} attempts rejected` };
        }),
      },
      {
        id: "acquit-tamper-caught",
        label: "Tamper attempts caught",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        comp: stat(useEscrow, (jobs) => ({ value: String(verifierStats(jobs).tamperAttempts), note: "Rejected for editing the frozen tests" })),
      },
    ],
    [{ id: "acquit-conserves", label: "Ledger conserves", kind: "card", xSpan: 12, ySpan: 4, comp: LedgerConserves }],
  ],
  earnings: [
    [
      {
        id: "acquit-paid-out",
        label: "Total paid out",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        comp: stat(useEarnings, (d) => ({ value: dollars(earnings(d.receipts).paidOut), note: "Payouts on your job receipts" })),
      },
      {
        id: "acquit-fees-withheld",
        label: "Fees withheld",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        comp: stat(useEarnings, (d) => ({ value: dollars(earnings(d.receipts).feesWithheld), note: "PayPal processing and Acquit" })),
      },
      {
        id: "acquit-jobs-paid",
        label: "Jobs paid",
        kind: "stat",
        xSpan: 4,
        ySpan: 2,
        comp: stat(useEarnings, (d) => ({ value: String(earnings(d.receipts).jobsPaid), note: "Verified, released, and paid" })),
      },
    ],
    [{ id: "acquit-receipt-card", label: "Receipt card", kind: "card", xSpan: 12, ySpan: 5, comp: ReceiptCard }],
  ],
} as const satisfies Record<DashboardId, readonly (readonly WidgetSpec[])[]>;

type Spec = (typeof DASHBOARDS)[DashboardId][number][number];
export type AcquitWidgetId = Spec["id"];

type AcquitWidget = { type: AcquitWidgetId; dataMapping: Record<string, never>; format?: AgWidgetDataFormat<unknown> };

export interface AcquitRegistry extends AgRegistry {
  widgets: readonly AgWidgetDefinition<AcquitWidgetId, AcquitWidget>[];
}

export type DashboardState = AgReportState<AcquitRegistry>;

const COLUMNS = 12;

/**
 * Studio converts a widget's pixel minimum into columns against the page's minimum width, so these
 * minimums stay small enough for a three-column stat on a 300px canvas.
 */
export const PAGE_LAYOUT: Partial<AgPageLayoutState> = { columns: COLUMNS, rowHeight: 60, minWidth: 300 };

const SIZES = {
  stat: { defaultSize: { width: 280, height: 120 }, minSize: { width: 75, height: 110 } },
  card: { defaultSize: { width: 560, height: 240 }, minSize: { width: 150, height: 200 } },
} as const;

function labelled({ comp: Body, label }: Spec): ComponentType {
  return function AcquitWidget() {
    return (
      <section className="studio-widget" aria-label={label}>
        <span className="eyebrow">{label}</span>
        <Body />
      </section>
    );
  };
}

const ALL: readonly Spec[] = Object.values(DASHBOARDS).flat(2);

export const WIDGETS = createWidgets<AcquitRegistry>({
  additionalTypes: ALL.map((spec) => ({
    id: spec.id,
    label: spec.label,
    form: () => [],
    comp: labelled(spec),
    ...SIZES[spec.kind],
  })),
  menu: [{ label: "Acquit", widgetIds: ALL.map((s) => s.id) }],
  defaultType: "acquit-held",
});

export function freshState(id: DashboardId): DashboardState {
  const rows = DASHBOARDS[id];
  return {
    selectedPageId: "main",
    pages: [
      {
        id: "main",
        layout: PAGE_LAYOUT,
        widgets: Object.fromEntries(rows.flat().map((w) => [w.id, { type: w.id, dataMapping: {} }])),
        widgetLayout: placeRows(rows),
      },
    ],
  };
}

/** A saved layout from the server, or null when it is missing or no longer reads as Studio state. */
export function parseSaved(json: string | null): DashboardState | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { pages?: unknown }).pages)) return null;
    return parsed as DashboardState;
  } catch {
    return null;
  }
}

export function stacked(state: DashboardState): DashboardState {
  return {
    ...state,
    pages: state.pages.map((page) => ({ ...page, widgetLayout: stackLayout(page.widgetLayout ?? {}, page.layout?.columns ?? COLUMNS) })),
  };
}
