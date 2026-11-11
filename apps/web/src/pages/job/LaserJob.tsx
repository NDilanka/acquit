import type { JobView } from "../../api-types";
import { lockedBid } from "../../bids";
import { refundNote, usd, utc } from "../../format";
import { operatorJobCrumb } from "../../job-status";
import { laserDelivery, laserNextLine, laserTimelineEvents } from "../../laser-job";
import type { TimelineJob } from "../../job-timeline";
import { PageTitle } from "../../page-title";
import { receiptPageHref } from "../../receipt-view";
import { Link } from "../../router";
import { useSession } from "../../session";
import { HouseBadge, IdChip, StatusPill } from "../../ui";
import { MoneyCard } from "./MoneyCard";
import { Timeline } from "./Timeline";

/**
 * A laser-cut job as it stands. The page holds no control: the client approves through the API, and so do
 * bids and deliveries. It shows the delivery's file and spec, the proof timeline, and the money.
 */
export function LaserJob({ job }: { job: JobView }) {
  const { user } = useSession();
  const crumb = user.role === "CLIENT" ? { to: "/", label: "Jobs" } : user.role === "PLATFORM" ? { to: "/studio", label: "Dashboards" } : operatorJobCrumb(job.status);
  const timeline = job as TimelineJob;
  const locked = lockedBid(job);
  const delivery = laserDelivery(job.contract?.physical);
  const next = laserNextLine(timeline);
  const events = laserTimelineEvents(timeline);

  return (
    <>
      <div className="crumbs">
        <Link to={crumb.to}>{crumb.label}</Link> / <b>{job.title}</b>
      </div>
      <div className="head">
        <div>
          <PageTitle>{job.title}</PageTitle>
          <div className="meta">
            <IdChip value={job.id} />
          </div>
          <div className="meta">
            <StatusPill job={job} />
            <span>
              Budget <b className="num">{usd(job.budget)}</b>
            </span>
            <span>
              Deadline <b className="num">{utc(job.deliveryEndsAt)}</b>
            </span>
            {locked && (
              <span>
                Operator <b>{locked.handle}</b> {locked.label === "HOUSE" && <HouseBadge />}
              </span>
            )}
            {job.receipt && (
              <span>
                <Link to={receiptPageHref(job.receipt.id)}>Public receipt</Link>
              </span>
            )}
          </div>
        </div>
      </div>
      {job.status === "OPEN" && job.refundReason && (
        <div className="alert warn">{refundNote(job.refundReason, false, job.attempts.used + job.attempts.left)}</div>
      )}
      {next && (
        <p className="next-step">
          <span className="eyebrow">What happens next</span> <b>{next}</b>
        </p>
      )}

      <div className="grid">
        <div>
          {(delivery || job.mergeCommit) && (
            <section className="card pad">
              <h2>Delivery</h2>
              <div className="rows">
                {delivery && (
                  <>
                    <div>
                      <span>Workflow</span>
                      <b>{delivery.workflow}</b>
                    </div>
                    <div>
                      <span>File</span>
                      <b className="mono">{delivery.path}</b>
                    </div>
                    {delivery.rows.map((row) => (
                      <div key={row.label}>
                        <span>{row.label}</span>
                        <b className="num">{row.value}</b>
                      </div>
                    ))}
                    <div>
                      <span>Spec digest</span>
                      <IdChip value={delivery.specDigest} />
                    </div>
                  </>
                )}
                {job.mergeCommit && (
                  <div>
                    <span>Delivered commit</span>
                    <IdChip value={job.mergeCommit} />
                  </div>
                )}
              </div>
            </section>
          )}

          {events.length > 0 && <Timeline events={events} verifier={null} />}
        </div>

        <aside>
          <MoneyCard job={job} locked={locked} />
        </aside>
      </div>
    </>
  );
}
