import { useCallback, useEffect, useState } from "react";
import type { CreditAccountView, JobView, OperatorView } from "../api-types";
import { api, ApiError } from "../api";
import { usd, utc } from "../format";
import { Link } from "../router";
import { useSession } from "../session";
import { BidForm } from "./BidForm";

export function OperatorHome() {
  const { user } = useSession();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [credits, setCredits] = useState<CreditAccountView | null>(null);
  const [operator, setOperator] = useState<OperatorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bidding, setBidding] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [j, c, o] = await Promise.all([api.jobs("OPEN"), api.credits(), api.operator()]);
      setJobs(j.jobs);
      setCredits(c.credits);
      setOperator(o.operator);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (user.role !== "OPERATOR") {
    return (
      <div className="card pad">
        <p>This page is for operators. You are signed in as a client.</p>
        <Link to="/">Back to your jobs</Link>
      </div>
    );
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
            <small className="muted">Next grant {utc(credits.nextGrantAt)}</small>
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
    </>
  );
}
