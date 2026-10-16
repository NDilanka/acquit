import { useCallback, useEffect, useState } from "react";
import type { ColDef, GetRowIdFunc } from "ag-grid-community";
import type { CreditAccountView, JobView, OperatorView, ReceiptRow } from "../api-types";
import { api, ApiError } from "../api";
import { creditLine, usd, utc } from "../format";
import { AcquitGrid } from "../grid";
import { Link } from "../router";
import { useSession } from "../session";
import { NotFound } from "../ui";
import { BidForm } from "./BidForm";

export function OperatorHome() {
  const { user } = useSession();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [credits, setCredits] = useState<CreditAccountView | null>(null);
  const [operator, setOperator] = useState<OperatorView | null>(null);
  const [receipts, setReceipts] = useState<ReceiptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bidding, setBidding] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [j, c, o, r] = await Promise.all([api.jobs("OPEN"), api.credits(), api.operator(), api.receipts()]);
      setJobs(j.jobs);
      setCredits(c.credits);
      setOperator(o.operator);
      setReceipts(r.receipts);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (user.role === "OPERATOR") void load();
  }, [load, user.role]);

  if (user.role !== "OPERATOR") {
    return <NotFound title="This page is for operators" message={`You are signed in as ${user.handle} (${user.role.toLowerCase()}).`} action={{ to: "/", label: "Back to your jobs" }} />;
  }

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Operator</div>
          <h1>Open jobs</h1>
        </div>
        {credits && (
          <div className="card pad credits">
            <div className="eyebrow">Bid credits</div>
            <div className="big num">
              {credits.available}
              <small> / {credits.weeklyAllowance} this week</small>
            </div>
            <small className="muted">{creditLine(credits)}</small>
          </div>
        )}
      </div>
      {operator && operator.payouts !== "READY" && (
        <div className="alert warn">
          Payouts are {operator.payouts.replace("_", " ").toLowerCase()}. Bids need PayPal payouts connected.{" "}
          {operator.onboardingUrl && <a href={operator.onboardingUrl}>Connect PayPal payouts</a>}
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      {!jobs && !error && <p className="muted">Loading open jobs…</p>}
      {jobs && jobs.length === 0 && <div className="card pad muted">No open jobs right now.</div>}
      {jobs?.map((j) => {
        const mine = j.bids.operators.find((b) => b.handle === user.handle);
        return (
          <div key={j.id} className="card jobcard">
            <div className="pad jobline">
              <div>
                <span className="mono muted">{j.id}</span>
                <Link to={`/jobs/${j.id}`}>
                  <b> {j.title}</b>
                </Link>
                <div className="meta">
                  <span>Mode <b>Bid</b></span>
                  <span>Budget <b className="num">{usd(j.budget)}</b></span>
                  <span>Deadline <b className="num">{utc(j.deliveryEndsAt)}</b></span>
                </div>
              </div>
              {mine ? (
                <span className="pill ok">Bid {usd(mine.price)} · {mine.status}</span>
              ) : j.phase === "BIDDING" || j.phase === j.status ? (
                <button className="btn sm" onClick={() => setBidding(bidding === j.id ? null : j.id)}>
                  {bidding === j.id ? "Close" : "Bid"}
                </button>
              ) : (
                <small className="muted">{j.phase}</small>
              )}
            </div>
            {bidding === j.id && !mine && (
              <div className="pad bidpane">
                <BidForm
                  job={j}
                  onPlaced={() => {
                    void api.credits().then((c) => setCredits(c.credits)).catch(() => undefined);
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
      {receipts && <Receipts receipts={receipts} />}
    </>
  );
}

function verifiedLine(row: ReceiptRow): string {
  if (row.jobId === null) return row.passedVerifiedCi ? "Passed verified CI" : "Not verified";
  return `${row.frozen.passed}/${row.frozen.expected} frozen, ${row.hidden.passed}/${row.hidden.expected} hidden`;
}

const receiptColumns: ColDef<ReceiptRow>[] = [
  { headerName: "Receipt", field: "id", flex: 1.4, minWidth: 72, cellClass: "mono" },
  { headerName: "Job", colId: "job", minWidth: 62, cellClass: "mono", valueGetter: (p) => p.data?.jobId ?? "—" },
  {
    headerName: "Amount",
    colId: "amount",
    minWidth: 72,
    cellClass: "num strong",
    valueGetter: (p) => (p.data && p.data.paid !== null ? usd(p.data.paid) : "—"),
  },
  { headerName: "Verified", colId: "verified", flex: 1.4, minWidth: 72, valueGetter: (p) => (p.data ? verifiedLine(p.data) : "") },
  {
    headerName: "Source",
    field: "source",
    minWidth: 70,
    flex: 0.8,
    cellRenderer: (p: { value?: ReceiptRow["source"] }) => (p.value === "SEED" ? <span className="pill new">Seeded</span> : null),
  },
];

const receiptRowId: GetRowIdFunc<ReceiptRow> = (p) => p.data.id;

function Receipts({ receipts }: { receipts: ReceiptRow[] }) {
  return (
    <section className="card receipts">
      <div className="pad hd">
        <h2>Receipts</h2>
        <small className="muted">Each settled job leaves a receipt. Seeded rows are the deployment's starting history.</small>
      </div>
      <AcquitGrid rows={receipts} columns={receiptColumns} rowId={receiptRowId} empty="No receipts yet." />
    </section>
  );
}
