import { Component, createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { AgPageLayoutState, AgWidgetsConfig } from "ag-studio";
import { createWidgets } from "ag-studio-react";
import type { PayoutRow, PlatformJobLedger, ReceiptRow } from "../api-types";
import { dollars, utc } from "../format";
import { COLUMNS, NATIVE_WIDGETS, WIDGET_ROWS, type AcquitRegistry, type AcquitWidgetId, type DashboardId, type DashboardState } from "../dashboard-widgets";
import { conserves, earnings, escrowTotals, newestReceipt, placeRows, verifierStats } from "../studio-data";

export type { AcquitRegistry, AcquitWidgetId, DashboardId, DashboardState };
export { stacked } from "../studio-data";

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
      {receipt.source === "SEED" && <span className="pill new">Seeded</span>}
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

const escrowTotal = (key: keyof ReturnType<typeof escrowTotals>, note: string) =>
  stat(useEscrow, (jobs) => ({ value: dollars(escrowTotals(jobs)[key]), note }));

const COMP = {
  "acquit-held": escrowTotal("held", "In escrow on jobs not yet settled"),
  "acquit-released": escrowTotal("released", "Paid out to operators"),
  "acquit-refunded": escrowTotal("refunded", "Returned to clients"),
  "acquit-fees": escrowTotal("fees", "PayPal processing and Acquit"),
  "acquit-pass-rate": stat(useEscrow, (jobs) => {
    const s = verifierStats(jobs);
    return { value: percent(s.passRate), note: `Of ${s.attempts} attempts verified` };
  }),
  "acquit-reject-rate": stat(useEscrow, (jobs) => {
    const s = verifierStats(jobs);
    return { value: percent(s.rejectRate), note: `Of ${s.attempts} attempts rejected` };
  }),
  "acquit-tamper-caught": stat(useEscrow, (jobs) => ({ value: String(verifierStats(jobs).tamperAttempts), note: "Rejected for editing the frozen tests" })),
  "acquit-conserves": LedgerConserves,
  "acquit-paid-out": stat(useEarnings, (d) => ({ value: dollars(earnings(d.receipts).paidOut), note: "Payouts on your job receipts" })),
  "acquit-fees-withheld": stat(useEarnings, (d) => ({ value: dollars(earnings(d.receipts).feesWithheld), note: "PayPal processing and Acquit" })),
  "acquit-jobs-paid": stat(useEarnings, (d) => ({ value: String(earnings(d.receipts).jobsPaid), note: "Verified, released, and paid" })),
  "acquit-receipt-card": ReceiptCard,
} satisfies Record<AcquitWidgetId, ComponentType>;

type SpecData = (typeof WIDGET_ROWS)[DashboardId][number][number];
type Spec = SpecData & { readonly comp: ComponentType };

const withComp = (rows: readonly (readonly SpecData[])[]): readonly (readonly Spec[])[] =>
  rows.map((row) => row.map((spec) => ({ ...spec, comp: COMP[spec.id] })));

const DASHBOARDS: Record<DashboardId, readonly (readonly Spec[])[]> = {
  escrow: withComp(WIDGET_ROWS.escrow),
  earnings: withComp(WIDGET_ROWS.earnings),
};

/**
 * Studio converts a widget's pixel minimum into columns against the page's minimum width, so these
 * minimums stay small enough for a three-column stat on a 300px canvas.
 */
export const PAGE_LAYOUT: Partial<AgPageLayoutState> = { columns: COLUMNS, rowHeight: 60, minWidth: 300 };

const SIZES = {
  stat: { defaultSize: { width: 280, height: 120 }, minSize: { width: 75, height: 110 } },
  card: { defaultSize: { width: 560, height: 240 }, minSize: { width: 150, height: 200 } },
} as const;

/** One widget that throws shows a fallback in its own tile instead of taking the page down. */
class WidgetBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <p className="muted">This widget could not be shown.</p> : this.props.children;
  }
}

function labelled({ id, comp: Body, label }: Spec): ComponentType {
  return function AcquitWidget() {
    return (
      <section className="studio-widget" aria-label={label} data-widget-type={id}>
        <span className="eyebrow">{label}</span>
        <WidgetBoundary>
          <Body />
        </WidgetBoundary>
      </section>
    );
  };
}

function buildRegistry(id: DashboardId): AgWidgetsConfig<AcquitRegistry> {
  const specs = DASHBOARDS[id].flat();
  return createWidgets<AcquitRegistry>({
    additionalTypes: specs.map((spec) => ({
      id: spec.id,
      label: spec.label,
      form: () => [],
      comp: labelled(spec),
      ai: spec.ai,
      ...SIZES[spec.kind],
    })),
    menu: [{ label: "Acquit", widgetIds: specs.map((s) => s.id) }],
    defaultType: WIDGET_ROWS[id][0][0].id,
  });
}

export const WIDGETS: Record<DashboardId, AgWidgetsConfig<AcquitRegistry>> = {
  escrow: buildRegistry("escrow"),
  earnings: buildRegistry("earnings"),
};

/** A native widget's title and cross filter: a click on one widget filters the others on the page. */
const nativeFormat = (title: string) => ({ title: { text: title, enabled: true }, crossFilter: "filter" as const });

export function freshState(id: DashboardId): DashboardState {
  const rows = DASHBOARDS[id];
  const native = NATIVE_WIDGETS[id];
  return {
    selectedPageId: "main",
    pages: [
      {
        id: "main",
        layout: PAGE_LAYOUT,
        widgets: {
          ...Object.fromEntries(rows.flat().map((w) => [w.id, { type: w.id, dataMapping: {} }])),
          ...Object.fromEntries(native.flat().map((w) => [w.id, { type: w.type, dataMapping: w.dataMapping, format: nativeFormat(w.title) }])),
        },
        widgetLayout: placeRows([...rows, ...native]),
      },
    ],
  };
}
