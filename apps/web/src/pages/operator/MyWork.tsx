import { lockedBid } from "../../bids.ts";
import { usd } from "../../format";
import { Link } from "../../router";
import type { OperatorWorkspace } from "../../operator-workspace";
import { IdChip } from "../../ui";

export function MyWork({ mine }: { mine: OperatorWorkspace["mine"] }) {
  if (mine.length === 0) {
    return <div className="card pad muted">No awarded work yet. A bid the client accepts shows here with its next step.</div>;
  }
  return (
    <>
      {mine.map(({ job, status, next }) => {
        const price = lockedBid(job)?.price;
        return (
          <div key={job.id} className="card jobcard">
            <div className="pad jobline">
              <div>
                <Link to={`/jobs/${job.id}`}>
                  <b>{job.title}</b>
                </Link>{" "}
                <IdChip value={job.id} />
                <div className="meta">
                  {price !== undefined && <span>Price <b className="num">{usd(price)}</b></span>}
                </div>
                <p className="work-next">{next}</p>
              </div>
              <div className="act">
                <span className={`pill ${status.tone}`}>
                  <span className="dot" />
                  {status.label}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
