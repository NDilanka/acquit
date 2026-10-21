import { Component, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode, type RefObject } from "react";
import type { AgPageLayoutState, AgWidgetsConfig } from "ag-studio";
import { createWidgets } from "ag-studio-react";
import type { ColDef, ICellRendererParams, RowClickedEvent, RowHeightParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import type { PayoutRow, PlatformJobLedger, PlatformReconcileReason, PlatformReconcileRow, PlatformReconciliation, ReceiptRow } from "../api-types";
import { acquitTheme } from "../grid";
import { escrowWord } from "../job-status";
import { dollars, shortId, utc } from "../format";
import { COLUMNS, WIDGET_ROWS, type AcquitRegistry, type AcquitWidgetId, type DashboardId, type DashboardState } from "../dashboard-widgets";
import { conserves, earnings, escrowTotals, newestReceipt, seededPlacements, seededWidgets, verifierStats } from "../studio-data";
import { listedLinks, type ChangeLog, type ChangeSnapshot } from "../change-chain";
import {
  VERDICT_MIN_WIDTHS,
  attemptWords,
  cardRows,
  groupWords,
  lastVerdictWords,
  payPalIds,
  platformStatusWord,
  sparkCoords,
  sparkPoints,
  toggleExpanded,
  totalsRow,
  verdictRows,
  type AttemptRow,
  type CardRow,
  type GroupRow,
  type JobCard,
  type TotalsRow,
  type VerdictRow,
} from "../verdict-grid";
import { FigureExplain } from "./FigureExplain";

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
          <span>
            Paid by clients <FigureExplain figure="paid-by-clients" />
          </span>
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

/** An escrow KPI tile: its value is the core figure's sum, and its Explain button opens that figure's lines. */
const escrowTotal = (key: keyof ReturnType<typeof escrowTotals>, note: string) => {
  const Value = stat(useEscrow, (jobs) => ({ value: dollars(escrowTotals(jobs)[key]), note }));
  return function EscrowTotal() {
    return (
      <>
        <Value />
        <FigureExplain figure={key} />
      </>
    );
  };
};

/** A grid row's kind is one of the verdict rows, or the pinned totals. Only a job row has cells; the others span the grid. */
type GridRow = VerdictRow | TotalsRow;

const jobOf = (row: GridRow | undefined): PlatformJobLedger | null => (row?.kind === "job" ? row.job : null);

const VERDICT_HEIGHT: Record<GridRow["kind"], number> = { group: 34, job: 46, attempt: 40, totals: 44 };
const SPARK = { width: 96, height: 18 } as const;

/** The tenant on a job's second line, shortened the way a job id is; the deployment's own world has no tenant id. */
const tenantLabel = (tenant: string | null): string => (tenant === null ? "Deployment" : shortId(tenant));

function TitleCell({ data }: ICellRendererParams<GridRow>) {
  const job = jobOf(data);
  if (!job) return null;
  const open = data?.kind === "job" && data.expanded;
  return (
    <span className="verdict-title">
      <span className="verdict-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <span>
        <b>{job.title}</b>
        <small className="muted mono">{shortId(job.jobId)} · {tenantLabel(job.tenant)}</small>
      </span>
    </span>
  );
}

/** The passing-share sparkline: one point per judged attempt, in ordinal order. Shared by the wide cell and the narrow card. */
function Spark({ points }: { readonly points: readonly number[] }) {
  return (
    <svg className="verdict-spark" width={SPARK.width} height={SPARK.height} viewBox={`0 0 ${SPARK.width} ${SPARK.height}`} role="img"
      aria-label={`Passing share of ${points.length} attempts: ${points.map((point) => percent(point)).join(", ")}`}>
      <polyline points={sparkCoords(points, SPARK.width, SPARK.height)} />
    </svg>
  );
}

function SparkCell({ data }: ICellRendererParams<GridRow>) {
  const job = jobOf(data);
  if (!job) return null;
  const points = sparkPoints(job.attempts);
  return points.length === 0 ? <span className="muted">No counts yet</span> : <Spark points={points} />;
}

/** One PayPal id as a chip; the full id sits in the title. */
function IdChip({ label, id }: { readonly label: string; readonly id: string }) {
  return <span className="verdict-chip mono" title={`${label} ${id}`}>{shortId(id)}</span>;
}

function IdsCell({ data }: ICellRendererParams<GridRow>) {
  const job = jobOf(data);
  if (!job) return null;
  const ids = payPalIds(job);
  if (ids.length === 0) return <span className="muted">None yet</span>;
  return <span>{ids.map(({ label, id }) => <IdChip key={label} label={label} id={id} />)}</span>;
}

/** The wide grid's columns. The tenant sits on the Job cell's second line, and the attempts show as the passing sparkline and the expanded rows. */
const VERDICT_COLUMNS: ColDef<GridRow>[] = [
  { colId: "job", headerName: "Job", flex: 3, minWidth: VERDICT_MIN_WIDTHS.job, cellRenderer: TitleCell },
  { colId: "operator", headerName: "Operator", minWidth: VERDICT_MIN_WIDTHS.operator, valueGetter: ({ data }) => jobOf(data)?.operator?.handle ?? "None yet" },
  { colId: "status", headerName: "Status", flex: 2, minWidth: VERDICT_MIN_WIDTHS.status, valueGetter: ({ data }) => { const job = jobOf(data); return job ? platformStatusWord(job.status) : ""; } },
  { colId: "escrow", headerName: "Escrow", minWidth: VERDICT_MIN_WIDTHS.escrow, valueGetter: ({ data }) => { const job = jobOf(data); return job ? escrowWord(job.escrow) : ""; } },
  { colId: "passing", headerName: "Passing tests", flex: 2, minWidth: VERDICT_MIN_WIDTHS.passing, sortable: false, cellRenderer: SparkCell },
  {
    colId: "last",
    headerName: "Last verdict",
    flex: 2,
    minWidth: VERDICT_MIN_WIDTHS.last,
    valueGetter: ({ data }) => { const job = jobOf(data); return job ? lastVerdictWords(job) : ""; },
  },
  { colId: "paid", headerName: "Paid", cellClass: "num", minWidth: VERDICT_MIN_WIDTHS.paid, valueGetter: ({ data }) => { const job = jobOf(data); return job?.paidCents == null ? "Not recorded" : dollars(job.paidCents); } },
  { colId: "ids", headerName: "PayPal ids", flex: 2, minWidth: VERDICT_MIN_WIDTHS.ids, sortable: false, cellRenderer: IdsCell },
];

const VERDICT_DEFAULTS: ColDef<GridRow> = { sortable: false, resizable: false, suppressMovable: true, flex: 1, minWidth: 56, headerClass: "grid-head" };

function AttemptLine({ row }: { row: AttemptRow }) {
  const { verdict, detail } = attemptWords(row.attempt);
  return (
    <div className="verdict-attempt">
      <span className="num">Attempt {row.attempt.ordinal}</span>
      <span className={`pill ${row.attempt.result === "VERIFIED" ? "ok" : "break"}`}>{verdict}</span>
      {row.attempt.tamper && <span className="pill break">Tamper caught</span>}
      <span className="muted verdict-detail">{detail}</span>
      <span className="muted num">{utc(row.attempt.at)}</span>
    </div>
  );
}

/** The pinned bottom row: the conservation law in four figures, green when it holds. */
function TotalsStrip({ row }: { row: TotalsRow }) {
  return (
    <div className="verdict-totals">
      <span className={`pill ${row.holds ? "ok" : "break"}`}>
        <span className="dot" />
        {row.holds ? "Ledger conserves" : "LEDGER BREAK"}
      </span>
      <span>Held <b className="num">{dollars(row.held)}</b></span>
      <span>+ Released <b className="num">{dollars(row.released)}</b></span>
      <span>+ Refunded <b className="num">{dollars(row.refunded)}</b></span>
      <span>+ Fees <b className="num">{dollars(row.fees)}</b></span>
      <span>= Funded <b className="num">{dollars(row.funded)}</b></span>
    </div>
  );
}

/** An escrow group's header: its words and its job count. Shared by the wide full-width row and the narrow list. */
function GroupHead({ row }: { readonly row: GroupRow }) {
  return (
    <div className="verdict-group">
      <b>{groupWords(row.escrow)}</b>
      <span className="muted">{row.count} {row.count === 1 ? "job" : "jobs"}</span>
    </div>
  );
}

/** A full-width row: an escrow group's header, an attempt's detail, or the totals strip. A job row never reaches here. */
function VerdictFullWidth({ data }: ICellRendererParams<GridRow>) {
  if (!data || data.kind === "job") return null;
  if (data.kind === "group") return <GroupHead row={data} />;
  if (data.kind === "attempt") return <AttemptLine row={data} />;
  return <TotalsStrip row={data} />;
}

/** Below this tile width the timeline lists its jobs as cards instead of table rows. */
const NARROW_TILE_PX = 640;

/** Whether the tile is at most NARROW_TILE_PX wide, read from the tile's own box so a narrow tile counts on any screen. */
function useNarrowTile(ref: RefObject<HTMLDivElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setNarrow(el.getBoundingClientRect().width <= NARROW_TILE_PX);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setNarrow(width <= NARROW_TILE_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

/** One job as a card: its title and id, its status and escrow, the last verdict, the passing shares, what it paid, and its PayPal ids. */
function JobCardView({ card, expanded, onToggle }: { readonly card: JobCard; readonly expanded: boolean; readonly onToggle: (jobId: string) => void }) {
  return (
    <div className="verdict-card">
      <button type="button" className="verdict-card-head" aria-expanded={expanded} onClick={() => onToggle(card.jobId)}>
        <span className="verdict-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className="verdict-card-title">
          <b>{card.title}</b>
          <small className="muted mono">{shortId(card.jobId)} · {tenantLabel(card.tenant)}</small>
        </span>
      </button>
      <div className="verdict-card-pills">
        <span className="pill">{card.status}</span>
        <span className="pill">{card.escrow}</span>
      </div>
      <dl className="verdict-card-facts">
        <dt>Last verdict</dt>
        <dd>{card.lastVerdict}</dd>
        <dt>Passing tests</dt>
        <dd>{card.passing.length === 0 ? <span className="muted">No counts yet</span> : <Spark points={card.passing} />}</dd>
        <dt>Paid</dt>
        <dd className="num">{card.paidCents === null ? "Not recorded" : dollars(card.paidCents)}</dd>
      </dl>
      {card.paypalIds.length > 0 && (
        <div className="verdict-card-ids">{card.paypalIds.map(({ label, id }) => <IdChip key={label} label={label} id={id} />)}</div>
      )}
    </div>
  );
}

/** The narrow timeline: a card per job, its attempts under it when it is open, and the totals pinned below the list. */
function VerdictCards({ rows, totals, onToggle }: { readonly rows: readonly CardRow[]; readonly totals: TotalsRow; readonly onToggle: (jobId: string) => void }) {
  return (
    <div className="verdict-cards">
      <ul className="verdict-list">
        {rows.map((row) => (
          <li key={row.id}>
            {row.kind === "group" ? <GroupHead row={row} />
              : row.kind === "attempt" ? <AttemptLine row={row} />
              : <JobCardView card={row.card} expanded={row.expanded} onToggle={onToggle} />}
          </li>
        ))}
      </ul>
      <TotalsStrip row={totals} />
    </div>
  );
}

/**
 * The escrow book, grouped by where each job's money sits. A job opens to its verifier attempts.
 * Rows come from the escrow stream through useEscrow, keyed by id, so a live change updates them in place.
 * A tile at most NARROW_TILE_PX wide lists the jobs as cards; a wider tile keeps the table.
 */
function VerdictTimeline() {
  const jobs = useEscrow();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => verdictRows(jobs, expanded), [jobs, expanded]);
  const totals = useMemo(() => totalsRow(jobs), [jobs]);
  const pinned = useMemo(() => [totals], [totals]);
  const tile = useRef<HTMLDivElement>(null);
  const narrow = useNarrowTile(tile);
  const toggle = (jobId: string) => setExpanded((prev) => toggleExpanded(prev, jobId));
  return (
    <div className="acquit-grid verdict-grid" ref={tile}>
      {narrow ? <VerdictCards rows={cardRows(rows)} totals={totals} onToggle={toggle} /> : (
        <AgGridReact<GridRow>
          theme={acquitTheme}
          rowData={rows as GridRow[]}
          columnDefs={VERDICT_COLUMNS}
          defaultColDef={VERDICT_DEFAULTS}
          getRowId={({ data }) => data.id}
          isFullWidthRow={({ rowNode }) => rowNode.data?.kind !== "job"}
          fullWidthCellRenderer={VerdictFullWidth}
          getRowHeight={({ data }: RowHeightParams<GridRow>) => (data ? VERDICT_HEIGHT[data.kind] : VERDICT_HEIGHT.job)}
          pinnedBottomRowData={pinned}
          onRowClicked={(event: RowClickedEvent<GridRow>) => {
            const row = event.data;
            if (row?.kind === "job") toggle(row.job.jobId);
          }}
          enableCellTextSelection={false}
          containerStyle={{ height: "100%" }}
        />
      )}
    </div>
  );
}

/** The change log of the dashboard's Studio instance, from the Studio page. Null until Studio is ready. */
export const ChangesContext = createContext<ChangeLog | null>(null);

/** One Changes row: a chain link, with whether its Undo is still offered. */
type ChangeRow = {
  readonly seq: number;
  readonly at: number;
  readonly agent: string;
  readonly tool: string;
  readonly what: string;
  readonly hash: string;
  readonly entryId: string;
  readonly kind: "change" | "undo";
  readonly undoable: boolean;
};

/**
 * The rows newest first. The baseline is not a row: the entries Studio held before the first action are
 * listed nowhere. A change is undoable while Studio still holds its entry on the undo stack.
 */
function changeRows({ links, undoIds }: ChangeSnapshot): ChangeRow[] {
  return listedLinks(links)
    .map((link) => ({
      seq: link.seq,
      at: link.at,
      agent: link.agent,
      tool: link.tool ?? "-",
      what: link.label,
      hash: link.hash.slice(0, 8),
      entryId: link.entryId,
      kind: link.kind,
      undoable: link.kind === "change" && undoIds.has(link.entryId),
    }))
    .reverse();
}

function UndoCell({ row, log }: { readonly row: ChangeRow | undefined; readonly log: ChangeLog }) {
  if (row?.kind !== "change") return null;
  return (
    <button type="button" className="btn sm ghost" disabled={!row.undoable} onClick={() => log.undo(row.entryId)}>
      Undo to here
    </button>
  );
}

function changeColumns(log: ChangeLog): ColDef<ChangeRow>[] {
  return [
    { headerName: "Time", field: "at", width: 170, valueFormatter: ({ value }) => utc(new Date(value).toISOString()) },
    { headerName: "Agent", field: "agent", width: 150 },
    { headerName: "Tool", field: "tool", width: 150 },
    { headerName: "What changed", field: "what", flex: 1, minWidth: 180 },
    { headerName: "Hash", field: "hash", width: 110, cellClass: "mono" },
    { headerName: "", field: "entryId", width: 150, sortable: false, cellRenderer: ({ data }: ICellRendererParams<ChangeRow>) => <UndoCell row={data} log={log} /> },
  ];
}

/** The chain check: green when every link verifies, the first failing position when one does not. */
function ChainCheck({ check }: { readonly check: ChangeSnapshot["check"] }) {
  if (check === "unavailable") return <small className="muted">This browser cannot check the chain.</small>;
  if (!check.ok) return <span className="pill break changes-check">Chain broken at #{check.seq}</span>;
  return (
    <span className="pill ok changes-check">
      <span className="dot" />
      Chain verifies
    </span>
  );
}

/**
 * The dashboard's changes, newest first, in a grid. The chain is kept in this browser and is not a
 * server receipt. Each change can be undone back through while Studio still holds it.
 */
function ChangesList({ log }: { readonly log: ChangeLog }) {
  const snapshot = useSyncExternalStore(log.subscribe, log.getSnapshot);
  const rows = useMemo(() => changeRows(snapshot), [snapshot]);
  const columns = useMemo(() => changeColumns(log), [log]);
  // Edits made by hand reach the log on the next state update, and the ones already made when the widget
  // first shows are read now.
  useEffect(() => {
    log.sync();
  }, [log]);
  return (
    <div className="changes-widget">
      <p className="changes-note muted">Kept in this browser. This is not a server receipt.</p>
      {rows.length === 0 ? (
        <p className="muted">No changes yet. Edits you make, and changes the assistant makes, appear here.</p>
      ) : (
        <div className="acquit-grid changes-grid">
          <AgGridReact<ChangeRow>
            theme={acquitTheme}
            rowData={rows}
            columnDefs={columns}
            getRowId={({ data }) => String(data.seq)}
            containerStyle={{ height: "100%" }}
          />
        </div>
      )}
      <ChainCheck check={snapshot.check} />
    </div>
  );
}

function ChangesWidget() {
  const log = useContext(ChangesContext);
  if (log === null) return <p className="muted">The change history opens once the dashboard is ready.</p>;
  return <ChangesList log={log} />;
}

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
  "acquit-verdict-grid": VerdictTimeline,
  "acquit-reconciliation": ReconciliationCard,
  "acquit-paid-out": stat(useEarnings, (d) => ({ value: dollars(earnings(d.receipts).paidOut), note: "Payouts on your job receipts" })),
  "acquit-fees-withheld": stat(useEarnings, (d) => ({ value: dollars(earnings(d.receipts).feesWithheld), note: "PayPal processing and Acquit" })),
  "acquit-jobs-paid": stat(useEarnings, (d) => ({ value: String(earnings(d.receipts).jobsPaid), note: "Verified, released, and paid" })),
  "acquit-receipt-card": ReceiptCard,
  "acquit-changes": ChangesWidget,
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

export function freshState(id: DashboardId): DashboardState {
  return {
    selectedPageId: "main",
    pages: [
      {
        id: "main",
        layout: PAGE_LAYOUT,
        widgets: seededWidgets(id),
        widgetLayout: seededPlacements(id),
      },
    ],
  };
}
