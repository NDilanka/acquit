import { useState } from "react";
import type { BidView, JobView } from "../../api-types";
import { eta, usd } from "../../format";
import { Link } from "../../router";
import { BID_TABS, bidPillFor, bidTabFor, ownBid, type BidTab } from "../../operator-views";
import { EmptyState, Segmented } from "../../ui";
import type { OperatorData } from "./OperatorPage";

type Row = { readonly job: JobView; readonly bid: BidView };

const EMPTY: Record<BidTab, string> = {
  pending: "No pending bids. A bid stays here until the client decides on it.",
  accepted: "No bid has been accepted yet.",
  closed: "No declined or closed bids.",
};

/** The operator's own bids, one row each, split by where the bid stands. */
export function MyBids({ data }: { data: OperatorData }) {
  const [tab, setTab] = useState<BidTab>("pending");
  const rows: readonly Row[] = data.jobs.flatMap((job) => {
    const bid = ownBid(job, data.operator.id);
    return bid ? [{ job, bid }] : [];
  });
  const tabOf = (row: Row) => bidTabFor(row.bid, row.job);
  const shown = rows.filter((row) => tabOf(row) === tab);
  const options = BID_TABS.map((t) => ({
    value: t.value,
    label: `${t.label} ${rows.filter((row) => tabOf(row) === t.value).length}`,
  }));

  if (rows.length === 0) {
    return <EmptyState icon="bids" action={{ to: "/operator", label: "Find work" }}>You have not placed a bid yet. Bids you place show here.</EmptyState>;
  }

  return (
    <div className="bids-page">
      <Segmented label="Bid status" options={options} value={tab} onChange={setTab} round />
      {shown.length === 0 ? (
        <EmptyState icon="bids">{EMPTY[tab]}</EmptyState>
      ) : (
        shown.map(({ job, bid }) => {
          const pill = bidPillFor(bid, job);
          return (
            <article key={bid.id} className="card bid-row">
              <div className="bid-main">
                <Link to={`/jobs/${job.id}`} className="job-title">
                  {job.title}
                </Link>
                <p className="job-meta num">
                  {usd(bid.price)} · Delivery in {eta(bid.eta)} · Agent {bid.agent}
                </p>
              </div>
              <span className={`pill ${pill.tone}`}>{pill.label}</span>
              <Link to={`/jobs/${job.id}`} className="btn secondary sm">
                Open job
              </Link>
            </article>
          );
        })
      )}
    </div>
  );
}
