import { useCallback, useEffect, useState } from "react";
import type { BidView, JobView, UserCommand } from "../api-types";
import { api, ApiError, type RepoIssue } from "../api";
import { escrowFee, eta, ledgerNote, usd, utc } from "../format";
import { useIntent } from "../intent";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { houseName, lockedBid, StatusPill } from "../ui";
import { BidForm } from "./BidForm";

export function JobPage({ id }: { id: string }) {
  const { user } = useSession();
  const { location } = useRouter();
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suite, setSuite] = useState<RepoIssue["suite"] | null>(null);
  const [checkout, setCheckout] = useState<BidView | null>(null);
  const [confirm, setConfirm] = useState<BidView | null>(null);
  const accept = useIntent();
  const cancel = useIntent();
  const isClient = user.role === "CLIENT";
  const fundingRetry = location.search.get("funding") === "retry";

  const load = useCallback(async () => {
    try {
      const r = await api.job(id);
      setJob(r.job);
      setError(null);
      return r.job;
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 404 ? "Job not found." : e.message) : String(e));
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fast poll while waiting for the PayPal order; slow poll while bids may still arrive.
  const polling = checkout !== null ? 1000 : job?.status === "OPEN" ? 4000 : null;
  useEffect(() => {
    if (polling === null) return;
    const t = window.setInterval(() => void load(), polling);
    return () => window.clearInterval(t);
  }, [polling, load]);

  useEffect(() => {
    if (checkout && job?.approveUrl) window.location.assign(job.approveUrl);
  }, [checkout, job?.approveUrl]);

  useEffect(() => {
    if (!isClient || !job || suite) return;
    api
      .repos()
      .then((r) => {
        for (const repo of r.repos) for (const i of repo.issues) if (i.title === job.title) setSuite(i.suite);
      })
      .catch(() => undefined);
  }, [isClient, job, suite]);

  if (error && !job) {
    return (
      <div className="card pad">
        <div className="alert">{error}</div>
        <Link to="/">Back to jobs</Link>
      </div>
    );
  }
  if (!job) return <p className="muted">Loading job…</p>;

  const locked = lockedBid(job);
  const funding = job.status === "OPEN" && job.phase === "FUNDING";
  const canCancel = isClient && job.status === "OPEN" && !funding && checkout === null;

  const doAccept = async (bid: BidView) => {
    const outcome = await accept.send(`accept:${bid.id}`, (): UserCommand => ({
      type: "AcceptBid",
      jobId: job.id,
      bidId: bid.id,
    }));
    setConfirm(null);
    if (outcome) {
      setCheckout(bid);
      if (outcome.result.kind === "JOB") setJob(outcome.result.job);
    }
  };

  const doCancel = async () => {
    if (!window.confirm("Cancel this job? Bidders get their credits back.")) return;
    const outcome = await cancel.send(`cancel:${job.id}`, (): UserCommand => ({ type: "CancelJob", jobId: job.id }));
    if (outcome) await load();
  };

  return (
    <>
      <div className="crumbs">
        <Link to={isClient ? "/" : "/operator"}>{isClient ? "Jobs" : "Open jobs"}</Link> / <b className="mono">{job.id}</b>
      </div>
      <div className="head">
        <div>
          <h1>{job.title}</h1>
          <div className="meta">
            <StatusPill job={job} />
            <span>
              Budget <b className="num">{usd(job.budget)}</b>
            </span>
            <span>
              Deadline <b className="num">{utc(job.deliveryEndsAt)}</b>
            </span>
            {suite && (
              <span>
                Suite frozen at <b className="mono">{suite.commit}</b> ({suite.visible} tests, {suite.hidden} hidden)
              </span>
            )}
          </div>
        </div>
        {canCancel && (
          <button className="btn ghost" disabled={cancel.busy} onClick={() => void doCancel()}>
            {cancel.busy ? "Cancelling…" : "Cancel job"}
          </button>
        )}
      </div>
      {cancel.error && <div className="alert">{cancel.error}</div>}

      {fundingRetry && (
        <div className="alert warn">
          PayPal did not confirm the payment yet. Your approval is kept; no money moved twice.{" "}
          <a href={`/paypal/return?jobId=${encodeURIComponent(job.id)}`}>Check the payment again</a>
        </div>
      )}

      <div className="grid">
        <div>
          {job.status === "OPEN" && !funding && checkout === null && (
            <Bids job={job} isClient={isClient} busy={accept.busy} onAccept={setConfirm} />
          )}
          {accept.error && <div className="alert">{accept.error}</div>}

          {(checkout || (funding && isClient)) && (
            <Checkout
              bid={checkout ?? locked}
              approveUrl={job.approveUrl}
              redirecting={checkout !== null}
            />
          )}

          {job.status !== "OPEN" && <StatusPanel job={job} locked={locked} />}

          {!isClient && job.status === "OPEN" && !funding && !job.bids.operators.some((b) => b.handle === user.handle) && (
            <div className="card pad">
              <h2>Place a bid</h2>
              <BidForm job={job} onPlaced={() => void load()} />
            </div>
          )}
        </div>

        <aside>
          <div className="card pad">
            <h2>Escrow</h2>
            <div className="kv">
              <span>Status</span>
              <b>{job.status}</b>
            </div>
            <div className="kv">
              <span>Phase</span>
              <b>{job.phase}</b>
            </div>
            <div className="kv">
              <span>Escrow</span>
              <b>{job.escrow}</b>
            </div>
            {locked && (
              <div className="kv">
                <span>Locked to</span>
                <b>{locked.handle}</b>
              </div>
            )}
            <div className="kv">
              <span>Attempts</span>
              <b className="num">
                {job.attempts.used} used, {job.attempts.left} left
              </b>
            </div>
          </div>
          <Ledger job={job} locked={locked} />
        </aside>
      </div>

      {confirm && (
        <div className="scrim" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Accept {confirm.label === "HOUSE" ? `House: ${houseName(confirm.handle)}` : confirm.handle}?</h3>
            <p>Acquit creates a PayPal order that can pay only this operator. You pay now; money is released on verified proof.</p>
            <Breakdown price={confirm.price} />
            {accept.error && <div className="alert">{accept.error}</div>}
            <div className="act">
              <button className="btn ghost" onClick={() => setConfirm(null)}>Back</button>
              <button className="btn green" disabled={accept.busy} onClick={() => void doAccept(confirm)}>
                {accept.busy ? "Creating order…" : "Accept and pay with PayPal"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Bids({
  job,
  isClient,
  busy,
  onAccept,
}: {
  job: JobView;
  isClient: boolean;
  busy: boolean;
  onAccept: (bid: BidView) => void;
}) {
  const ops = job.bids.operators;
  const house = job.bids.house;
  return (
    <section className="card bids">
      <div className="pad hd">
        <h2>Bids</h2>
        <small className="muted">
          {ops.length + (house ? 1 : 0)} waiting. Receipts count escrow releases, not star ratings.
        </small>
      </div>
      <div className="section-label">Operators</div>
      {ops.length === 0 && <p className="pad muted">No operator bids yet.</p>}
      {ops.map((b) => (
        <BidRow key={b.id} bid={b} isClient={isClient} busy={busy} onAccept={onAccept} />
      ))}
      <div className="section-label">House</div>
      {house ? (
        <BidRow bid={house} isClient={isClient} busy={busy} onAccept={onAccept} />
      ) : (
        <p className="pad muted">No House bid on this job.</p>
      )}
    </section>
  );
}

function BidRow({
  bid,
  isClient,
  busy,
  onAccept,
}: {
  bid: BidView;
  isClient: boolean;
  busy: boolean;
  onAccept: (bid: BidView) => void;
}) {
  const isHouse = bid.label === "HOUSE";
  return (
    <div className={`bidrow ${bid.status === "PENDING" ? "" : "dim"}`}>
      <div className="who">
        <b>{isHouse ? `House (quality bar): ${houseName(bid.handle)}` : bid.handle}</b>
        {bid.pitch && <p className="pitch">{bid.pitch}</p>}
      </div>
      <div className="num price">{usd(bid.price)}</div>
      <div className="num">{eta(bid.eta)}</div>
      <div className="mono agent" title={bid.runner}>
        {bid.agent}
      </div>
      <div className="receipts">
        {isHouse
          ? `${bid.paidReceipts} passed verified CI`
          : `${bid.paidReceipts} verified receipt${bid.paidReceipts === 1 ? "" : "s"}`}
      </div>
      <div className="r">
        {isClient && bid.status === "PENDING" ? (
          <button className="btn sm" disabled={busy} onClick={() => onAccept(bid)}>
            Accept
          </button>
        ) : (
          <small className="muted">{bid.status}</small>
        )}
      </div>
    </div>
  );
}

function Breakdown({ price }: { price: number }) {
  const fee = escrowFee(price);
  return (
    <div className="rows">
      <div>
        <span>Job budget</span>
        <b className="num">{usd(price)}</b>
      </div>
      <div>
        <span>Verified escrow fee (5%)</span>
        <b className="num">{usd(fee)}</b>
      </div>
      <div className="total">
        <span>Total</span>
        <b className="num">{usd(price + fee)}</b>
      </div>
    </div>
  );
}

function Checkout({ bid, approveUrl, redirecting }: { bid: BidView | null; approveUrl: string | null; redirecting: boolean }) {
  return (
    <section className="card pad checkout">
      <h2>PayPal sandbox checkout</h2>
      <p className="muted">
        {bid ? (
          <>
            The order can pay only <b>{bid.handle}</b>, or refund you.
          </>
        ) : (
          "The order names the accepted operator as its only payee."
        )}
      </p>
      {bid && <Breakdown price={bid.price} />}
      {redirecting ? (
        <p className="muted">{approveUrl ? "Sending you to PayPal…" : "Creating the PayPal order…"}</p>
      ) : approveUrl ? (
        <a className="btn green" href={approveUrl}>
          Resume PayPal checkout
        </a>
      ) : (
        <p className="muted">Waiting for PayPal to confirm the payment.</p>
      )}
    </section>
  );
}

function StatusPanel({ job, locked }: { job: JobView; locked: BidView | null }) {
  return (
    <section className="card pad statuspanel">
      <pre className="mono">
        {`Status: ${job.status}\n`}
        {locked ? `Operator: ${locked.handle}\n` : ""}
        {`Escrow: ${job.escrow}${locked && job.escrow === "HELD" ? `, locked to ${locked.handle}` : ""}`}
      </pre>
      {job.pullRequest !== null && <p>Pull request #{job.pullRequest}</p>}
      {job.attempts.reasons.length > 0 && (
        <ul className="reasons">
          {job.attempts.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Ledger({ job, locked }: { job: JobView; locked: BidView | null }) {
  return (
    <div className="card pad ledger">
      <h2>Ledger</h2>
      {job.ledger.length === 0 ? (
        <p className="muted small">No money has moved yet.</p>
      ) : (
        <ul>
          {job.ledger.map((line, i) => (
            <li key={`${line.kind}-${i}`} className="mono">
              <span className="when">{utc(line.at).replace(" UTC", "")}</span>
              <span>{job.id}</span>
              <b className={`k ${line.kind.toLowerCase()}`}>{line.kind}</b>
              <span className="num">{usd(line.cents)}</span>
              <span className="note">{ledgerNote(line, line.kind === "HELD" ? (locked?.price ?? null) : null)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
