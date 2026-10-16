import { useCallback, useEffect, useState } from "react";
import type { CreditAccountView, OperatorView } from "../api-types";
import { api, ApiError } from "../api";
import { creditLine } from "../format";
import { buildOperatorWorkspace, homeCrumbs, type OperatorWorkspace } from "../operator-workspace";
import { useSession } from "../session";
import { NotFound } from "../ui";
import type { PlacedBid } from "./BidForm";
import { BidConfirmation } from "./operator/BidConfirmation";
import { Earnings } from "./operator/Earnings";
import { MyWork } from "./operator/MyWork";
import { OpenJobs } from "./operator/OpenJobs";

export function OperatorHome() {
  const { user } = useSession();
  const [workspace, setWorkspace] = useState<OperatorWorkspace | null>(null);
  const [credits, setCredits] = useState<CreditAccountView | null>(null);
  const [operator, setOperator] = useState<OperatorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bidding, setBidding] = useState<string | null>(null);
  const [placed, setPlaced] = useState<PlacedBid | null>(null);

  const load = useCallback(async () => {
    try {
      const [j, c, o, r, e] = await Promise.all([api.jobs(), api.credits(), api.operator(), api.receipts(), api.escrow()]);
      setOperator(o.operator);
      setCredits(c.credits);
      setWorkspace(
        buildOperatorWorkspace({
          operatorId: o.operator.id,
          handle: o.operator.handle,
          jobs: j.jobs,
          receipts: r.receipts,
          escrow: e.escrow,
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (user.role === "OPERATOR") void load();
  }, [load, user.role]);

  if (user.role !== "OPERATOR") {
    return <NotFound title="This page is for operators" message={`You are signed in as ${user.handle} (${user.role.toLowerCase()}).`} action={{ to: "/", label: "Back to your jobs" }} />;
  }

  const onPlaced = (bid: PlacedBid) => {
    setPlaced(bid);
    setBidding(null);
    setCredits((prev) => (prev ? { ...prev, available: bid.creditsLeft } : prev));
    void load();
  };

  return (
    <>
      <div className="crumbs">
        <b>{homeCrumbs(user.role).join(" / ")}</b>
      </div>
      <div className="head">
        <div>
          <div className="eyebrow">Operator</div>
          <h1>Your workspace</h1>
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
      {placed && <BidConfirmation placed={placed} onDismiss={() => setPlaced(null)} />}

      <section className="ws" aria-labelledby="ws-open">
        <h2 id="ws-open">Open jobs to bid on</h2>
        {!workspace && !error && <p className="muted">Loading your workspace…</p>}
        {workspace && (
          <OpenJobs
            jobs={workspace.open}
            handle={operator?.handle ?? ""}
            bidding={bidding}
            onToggle={(id) => setBidding(bidding === id ? null : id)}
            onPlaced={onPlaced}
          />
        )}
      </section>

      <section className="ws" aria-labelledby="ws-mine">
        <h2 id="ws-mine">My work</h2>
        {workspace && <MyWork mine={workspace.mine} />}
      </section>

      <section className="ws" aria-labelledby="ws-earn">
        <h2 id="ws-earn">Earnings</h2>
        {workspace && <Earnings earnings={workspace.earnings} />}
      </section>
    </>
  );
}
