import { Component, createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { AgPageLayoutState, AgWidgetsConfig } from "ag-studio";
import { createWidgets } from "ag-studio-react";
import type { PayoutRow, PlatformJobLedger, PlatformReconcileReason, PlatformReconcileRow, PlatformReconciliation, ReceiptRow } from "../api-types";
import { dollars, utc } from "../format";
import { COLUMNS, NATIVE_WIDGETS, WIDGET_ROWS, type AcquitRegistry, type AcquitWidgetId, type DashboardId, type DashboardState } from "../dashboard-widgets";
import { conserves, earnings, escrowTotals, newestReceipt, placeRows, verifierStats } from "../studio-data";

export type { AcquitRegistry, AcquitWidgetId, DashboardId, DashboardState };
export { stacked } from "../studio-data";

export type EarningsData = { readonly receipts: readonly ReceiptRow[]; readonly payouts: readonly PayoutRow[]; readonly handle: string };

export const EscrowContext = createContext<readonly PlatformJobLedger[] | null>(null);
export const EarningsContext = createContext<EarningsData | null>(null);
/** The PayPal card's own read: READING until the first answer, UNAVAILABLE when PayPal's read failed. */
export type ReconcileView = PlatformReconciliation | "READING" | "UNAVAILABLE";
export const ReconcileContext = createContext<ReconcileView>("READING");

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
        Over released jobs, payout + fee = paid: {dollars(payout)} + {dollars(fee)} {holds ? "=" : "≠"} {dollars(paid)}. Updates as the ledger changes.
      </small>
    </>
  );
}

const KIND_WORDS: Record<PlatformReconcileRow["kind"], string> = { HELD: "Hold", RELEASED: "Release", FEE: "PayPal processing fee on the capture", REFUND: "Refund" };

const money = (cents: number | null) => (cents === null ? "not recorded" : dollars(cents));

/** Each ledger line checked against the PayPal object it names, read live: the counts, the lines PayPal disagrees with, and other activity. */
function ReconciliationCard() {
  const recon = useContext(ReconcileContext);
  if (recon === "READING") return <p className="muted">Reading PayPal…</p>;
  if (recon === "UNAVAILABLE") {
    return <p className="muted">PayPal could not be read just now. The ledger above still loads, and this card reads again within a few minutes.</p>;
  }
  const { counts, other } = recon;
  const mismatched = recon.rows.filter((row) => row.status === "MISMATCHED");
  const refundsOnCapture = recon.rows.filter((row) => row.status === "MATCHED" && row.note !== null).length;
  const payouts = recon.rows.filter((row) => row.status === "MATCHED" && row.payoutTransactionId !== null);
  const uncheckedFor = (reason: PlatformReconcileReason) => recon.rows.filter((row) => row.status === "NOT_CHECKED" && row.reason === reason).length;
  const noPayPalId = uncheckedFor("NO_PAYPAL_ID");
  const unreadable = uncheckedFor("PAYPAL_UNREADABLE");
  const pastBudget = uncheckedFor("NOT_READ_YET");
  const otherUnchecked = counts.notChecked - noPayPalId - unreadable - pastBudget;
  const pill = counts.mismatched > 0 ? "break" : counts.notChecked > 0 ? "new" : "ok";
  const headline = counts.mismatched > 0 ? `${counts.mismatched} mismatched`
    : counts.notChecked > 0 ? `No mismatches, ${counts.notChecked} not checked yet` : "No mismatches";
  return (
    <>
      <span className={`pill ${pill}`}>
        <span className="dot" />
        {headline}
      </span>
      <div className="rows">
        <div>
          <span>Matched</span>
          <b className="num">{counts.matched}</b>
        </div>
        <div>
          <span>Pending at PayPal</span>
          <b className="num">{counts.pending}</b>
        </div>
        <div>
          <span>Mismatched</span>
          <b className="num">{counts.mismatched}</b>
        </div>
        <div className="total">
          <span>Not checked yet</span>
          <b className="num">{counts.notChecked}</b>
        </div>
      </div>
      {mismatched.slice(0, 5).map((row) => (
        <small key={row.entryId} className="muted">
          {KIND_WORDS[row.kind]} for <span className="mono">{row.jobId}</span>: ledger {money(row.expectedCents)}, PayPal{" "}
          {row.observedCents === null ? "shows no amount" : money(row.observedCents)}. {row.note}
        </small>
      ))}
      {mismatched.length > 5 && <small className="muted">and {mismatched.length - 5} more mismatched lines.</small>}
      {payouts.slice(0, 5).map((row) => (
        <small key={`${row.entryId}-payout`} className="muted">
          Release for <span className="mono">{row.jobId}</span> moved money under PayPal payout transaction{" "}
          <span className="mono">{row.payoutTransactionId}</span>.
        </small>
      ))}
      {payouts.length > 5 && <small className="muted">and {payouts.length - 5} more releases with a PayPal payout transaction.</small>}
      {counts.notChecked > 0 && (
        <small className="muted">
          Not checked yet: {noPayPalId} with no PayPal id recorded on the line, {unreadable} that PayPal could not be read, and {pastBudget} past
          this refresh's read budget{otherUnchecked > 0 ? `, and ${otherUnchecked} with an incomplete PayPal answer` : ""}. None of these is a mismatch.
        </small>
      )}
      {refundsOnCapture > 0 && (
        <small className="muted">
          {refundsOnCapture} {refundsOnCapture === 1 ? "refund line matched" : "refund lines matched"} on the capture it refunded, because PayPal's refund id
          was not recorded for {refundsOnCapture === 1 ? "it" : "them"}.
        </small>
      )}
      <small className="muted">
        Each line is checked against the PayPal object it names: the capture for a hold or fee, the refund for a refund, the payout item for a release.
        A fee line checks PayPal's processor fee on the capture only, not the fee's total or Acquit's share. Pending at PayPal means PayPal itself
        reports that object as pending. Not checked yet means this read did not reach that object (PayPal refused or failed it, or the read budget
        ran out); it is never counted as a mismatch.
      </small>
      <small className="muted">
        {other.state === "READ"
          ? `Other activity on the platform PayPal account, not Acquit escrow: ${other.count} rows from ${utc(other.from)} to ${utc(other.to)}.${other.truncated ? " Only the first few Transaction Search pages are read per refresh, so this count may be partial." : ""} Escrow captures, refunds, and releases sit on each operator's merchant account, so they are checked above. Treasury refund-fee reimbursements are not ledger lines, so they are counted here.`
          : other.reason === "SPAN_TOO_LONG"
            ? "Other activity on the platform PayPal account is not read: the ledger spans more than about two years."
            : "Other activity on the platform PayPal account could not be read just now."}
      </small>
      <small className="muted">
        Read {utc(recon.checkedAt)}. This card reads PayPal again every few minutes while it is on screen.
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
  "acquit-reconciliation": ReconciliationCard,
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
