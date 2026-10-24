import type { PlacedBid } from "../../bid-confirmation";
import type { JobView } from "../../api-types";
import { usd, utc } from "../../format";
import { bidStatusWord } from "../../job-status";
import { Link } from "../../router";
import { EmptyState, IdChip, StatusPill } from "../../ui";
import { BidForm } from "../BidForm";

export function OpenJobs({
  jobs,
  handle,
  bidding,
  onToggle,
  onPlaced,
}: {
  jobs: readonly JobView[];
  handle: string;
  bidding: string | null;
  onToggle: (jobId: string) => void;
  onPlaced: (placed: PlacedBid) => void;
}) {
  if (jobs.length === 0) return <EmptyState icon="search">No open jobs right now.</EmptyState>;
  return (
    <>
      {jobs.map((j) => {
        const mine = j.bids.operators.find((b) => b.handle === handle);
        return (
          <div key={j.id} className="card jobcard">
            <div className="pad jobline">
              <div>
                <Link to={`/jobs/${j.id}`}>
                  <b>{j.title}</b>
                </Link>{" "}
                <IdChip value={j.id} />
                <div className="meta">
                  <span>Budget <b className="num">{usd(j.budget)}</b></span>
                  <span>Deadline <b className="num">{utc(j.deliveryEndsAt)}</b></span>
                </div>
              </div>
              <div className="act">
                <StatusPill job={j} />
                {mine ? (
                  <span className="pill ok">Bid {usd(mine.price)} · {bidStatusWord(mine.status)}</span>
                ) : j.phase === "BIDDING" ? (
                  <button className="btn sm" onClick={() => onToggle(j.id)}>
                    {bidding === j.id ? "Close" : "Bid"}
                  </button>
                ) : null}
              </div>
            </div>
            {bidding === j.id && !mine && (
              <div className="pad bidpane">
                <BidForm job={j} onPlaced={onPlaced} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
