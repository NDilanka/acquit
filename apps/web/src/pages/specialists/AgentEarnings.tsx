import { useEffect, useState } from "react";
import { Link } from "../../router.tsx";
import { specialists } from "./client.ts";
import { useOwner } from "./OwnerPanel.tsx";
import { SpecialistPage } from "./SpecialistPage.tsx";
import { useLoad } from "./useLoad.ts";
import { useReport } from "./useReport.ts";
import { dollars, paidTotalCents } from "./view.ts";
import { JobStrip, TimelineMark, WorkSkeleton, WorkTime } from "./WorkTimeline.tsx";
import { agentDelta, earningsEvents, groupJobs, jobLabel, jobLanes, type WorkEvent } from "./work.ts";
import { releasedWorkHref } from "./liveWork.ts";
import { EarningsHeadingSkeleton } from "./OwnerLoading.tsx";
import { REPORT_WINDOW_RULE } from "./reportWindow.ts";

export function AgentEarningsPage() {
  const { agent, agents, selectionPending } = useOwner();
  // Wait for the saved agent selection; a page view never advances the report window.
  if (agents === null || selectionPending) return <SpecialistPage step={5} lead="">{null}</SpecialistPage>;
  return <Earnings key={agent?.id ?? "workspace"} />;
}

function Earnings() {
  const { agent, announce, activity } = useOwner();
  const report = useReport();
  const totals = useLoad(async () => agent ? specialists.agent(agent.id) : null, agent?.id ?? "");
  useEffect(() => { announce(report.error ? "Earnings did not load." : report.data ? "Earnings loaded." : "Loading earnings."); }, [report.data, report.error, announce]);
  const data = report.data;
  const events = data ? earningsEvents(data) : [];
  const quiet = data && !events.length && !data.gradeChanges.length;
  const paid = data ? paidTotalCents(data.payouts) : 0;
  const firstPaid = data?.payouts[0];
  const ordersPath = `/specialists/orders${agent ? `/${encodeURIComponent(agent.id)}` : ""}`;
  const actions = <div className="owner-actions">{report.error
    ? <button type="button" className="btn" onClick={() => { announce("Retrying earnings."); report.reload(); }}>Retry</button>
    : firstPaid && !quiet ? <Link className="btn" to={releasedWorkHref(firstPaid.jobId,activity.data?.activity)}>See the paid work</Link>
    : <Link className="btn" to={ordersPath}>Review standing orders</Link>}
  </div>;
  return <SpecialistPage step={5} lead="" gradeDelta={agentDelta(data, agent?.id)} provenance="Live workspace report">
    <section className="work-page earnings-page">
      {report.error ? <><header className="work-heading"><h1>Earnings</h1>
        <p className="spec-lead">PayPal sandbox · workspace earnings</p><p>Earnings did not load.</p></header>
        {actions}<div className="work-alert" role="alert" data-tone="fail">
        <p>Could not read the report. Retry to check recorded work and money.</p></div></>
        : !data ? <><EarningsHeadingSkeleton />
          {actions}
          <WorkSkeleton count={3} label="Loading earnings." /></>
        : <>
          <header className="earnings-overview"><div className="work-heading">
            <h1 className="earnings-key">{dollars(paid)} released</h1>
            <p className="spec-lead">PayPal sandbox · workspace earnings</p>
            <p>{quiet ? "No work recorded in this report." : `${data.verified.length} verified · ${data.rejected.length} rejected · ${data.bids.length} bids recorded.`}</p>
          </div><section className="report-window" aria-label="Report window">
            <p>From <WorkTime at={data.since} full />{report.through && <> to <WorkTime at={report.through} full /></>}</p>
            <details className="record-meaning"><summary>How this window is chosen</summary><p>{REPORT_WINDOW_RULE}</p></details>
            {totals.data?.record && <p>{agent?.name} · all jobs<br />{totals.data.record.jobsTaken} taken · {totals.data.record.verified} verified · {totals.data.record.rejected} rejected</p>}
          </section></header>
          {actions}
          {!quiet && <div className="work-split"><div>
            {!quiet && <ol className="work-timeline" aria-label="Earnings by job, newest first">
            {groupJobs(events).map(({ id, entries }, index) => {
                const latest = entries[0]!;
                return <TimelineMark key={id} at={latest.at} index={index} tone={latest.kind === "rejected" ? "fail" : ""}
                  title={latest.jobId ? <Link to={`/jobs/${encodeURIComponent(latest.jobId)}`}>{jobLabel(latest.jobId)}</Link> : "Workspace activity"}>
                  <p className="work-status">{latest.kind === "released" && latest.jobId
                    ? <Link to={releasedWorkHref(latest.jobId,activity.data?.activity)}>{latest.status} · PayPal sandbox</Link> : latest.status}</p>
                  <EarlierEarnings entries={entries.slice(1)} />
                </TimelineMark>;
              })}
            {!events.length && <TimelineMark title="Grade updated"><p className="work-status">No job events supplied in this report.</p></TimelineMark>}
          </ol>}
          </div><aside className="work-side" aria-label="Earnings summary">
            {!quiet && <JobStrip lanes={jobLanes(events)} through={report.through} />}
            {data.payouts.map((payout) => <div className="earnings-reference" key={`${payout.reference}:${payout.jobId}`}>
              <p><Link to={releasedWorkHref(payout.jobId,activity.data?.activity)}>{jobLabel(payout.jobId)} proof · PayPal sandbox</Link></p>
              <p className="muted">Reference <code>{payout.reference.match(/.{1,4}/g)?.join(" ")}</code></p>
              <CopyWorkValue value={payout.reference} label="Copy reference" />
            </div>)}
            {totals.error !== null && <p className="muted">Agent totals did not load. <button className="text-button" onClick={totals.reload}>Retry totals</button></p>}
          </aside></div>}
          <p className="muted">Verified is not paid. Release needs client approval, the release timer or an arbiter.</p>
        </>}
    </section>
  </SpecialistPage>;
}

function EarlierEarnings({ entries }: { entries: readonly WorkEvent[] }) {
  const [open,setOpen] = useState(false);
  if (!entries.length) return null;
  return <details className="earnings-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{entries.length} earlier events</summary>
    {open && <ul className="earnings-events">{entries.map(entry => <li key={entry.id}>{entry.status} · <WorkTime at={entry.at} /></li>)}</ul>}
  </details>;
}

export function CopyWorkValue({ value, label = "Copy", primary = false }: { value: string; label?: string; primary?: boolean }) {
  const { announce } = useOwner();
  return <button type="button" className={primary ? "btn" : "text-button"} onClick={() => {
    void navigator.clipboard.writeText(value).then(() => announce("Copied."), () => announce("Could not copy. Select the text to copy it."));
  }}>{label}</button>;
}
