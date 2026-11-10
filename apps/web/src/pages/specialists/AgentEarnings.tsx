import { useEffect, useState } from "react";
import { Link } from "../../router.tsx";
import { specialists } from "./client.ts";
import { useOwner } from "./OwnerPanel.tsx";
import { SpecialistPage } from "./SpecialistPage.tsx";
import { useLoad } from "./useLoad.ts";
import { useReport } from "./useReport.ts";
import { dollars, paidTotalCents } from "./view.ts";
import { JobStrip, TimelineMark, WorkSkeleton, WorkTime } from "./WorkTimeline.tsx";
import { agentDelta, earningsEvents, groupJobs, jobLabel, jobLanes } from "./work.ts";

export function AgentEarningsPage() {
  const { agent, agents, selectionPending } = useOwner();
  // Do not advance the workspace cursor before the owner has finished loading.
  if (agents === null || selectionPending) return <SpecialistPage step={5} lead="">{null}</SpecialistPage>;
  return <Earnings key={agent?.id ?? "workspace"} />;
}

function Earnings() {
  const { agent, announce } = useOwner();
  const report = useReport(true);
  const totals = useLoad(async () => agent ? specialists.agent(agent.id) : null, agent?.id ?? "");
  const [readAt] = useState(() => new Date().toISOString());
  useEffect(() => { announce(report.error ? "Earnings did not load." : report.data ? "Earnings loaded." : "Loading earnings."); }, [report.data, report.error, announce]);
  const data = report.data;
  const events = data ? earningsEvents(data) : [];
  const quiet = data && !events.length && !data.gradeChanges.length;
  const paid = data ? paidTotalCents(data.payouts) : 0;
  const firstPaid = data?.payouts[0];
  const ordersPath = `/specialists/orders${agent ? `/${encodeURIComponent(agent.id)}` : ""}`;
  return <SpecialistPage step={5} lead="" gradeDelta={agentDelta(data, agent?.id)} provenance="Live workspace report">
    <section className="work-page earnings-page">
      {report.error ? <><h1>Earnings did not load.</h1><div className="work-alert" role="alert" data-tone="fail">
        <p>Could not read the report. Retry to check recorded work and money.</p></div></>
        : !data ? <><h1 className="sr-only">Earnings</h1><div className="earnings-key-skeleton" />
          <WorkSkeleton count={3} label="Loading earnings." /></>
        : <>
          <header className="earnings-head"><div className="work-heading">
            <h1 className={quiet ? "" : "earnings-key"}>{quiet ? "Nothing new since you last looked." : paid ? `${dollars(paid)} released` : "Nothing released yet."}</h1>
            <p className="spec-lead">Workspace report since <WorkTime at={data.since} full />. {quiet ? "No work was recorded." : `${data.verified.length} verified · ${data.rejected.length} rejected · ${data.bids.length} bids recorded.`}</p>
          </div><div className="earnings-refs"><p>PayPal sandbox · workspace earnings</p>
            {data.payouts.map((payout) => <div className="earnings-reference" key={`${payout.reference}:${payout.jobId}`}>
              <p>{dollars(payout.amountCents)} released · {jobLabel(payout.jobId)}</p>
              <p className="muted">Reference <code>{payout.reference.match(/.{1,4}/g)?.join(" ")}</code></p>
              <CopyWorkValue value={payout.reference} label="Copy reference" />
            </div>)}
            {!quiet && <p className="muted">Payouts are workspace-wide, not attributed to the selected agent.</p>}
          </div></header>
          <div className="work-split"><ol className="work-timeline" aria-label="Earnings by job, newest first">
            {quiet ? <TimelineMark title="No new work recorded"><p className="work-status">Nothing released in this report · PayPal sandbox</p></TimelineMark>
              : groupJobs(events).map(({ id, entries }, index) => {
                const latest = entries[0]!;
                return <TimelineMark key={id} at={latest.at} index={index} tone={latest.kind === "rejected" ? "fail" : ""}
                  title={latest.jobId ? <Link to={`/jobs/${encodeURIComponent(latest.jobId)}`}>{jobLabel(latest.jobId)}</Link> : "Workspace activity"}>
                  <p className="work-status">{latest.status}{latest.kind === "released" && " · PayPal sandbox"}</p>
                  <ul className="earnings-events">{entries.slice(1).map((entry) => <li key={entry.id}>{entry.status} · <WorkTime at={entry.at} /></li>)}</ul>
                </TimelineMark>;
              })}
            {!quiet && !events.length && <TimelineMark title="Grade updated"><p className="work-status">No job events supplied in this report.</p></TimelineMark>}
          </ol><aside className="work-side" aria-label="Earnings summary">
            {!quiet && <JobStrip lanes={jobLanes(events)} through={readAt} />}
            <dl className="work-facts">
              <div><dt>Workspace report</dt><dd>{dollars(paid)} released · PayPal sandbox</dd></div>
              {totals.data?.record && <div><dt>{agent?.name} · all jobs</dt><dd>{totals.data.record.jobsTaken} taken · {totals.data.record.verified} verified · {totals.data.record.rejected} rejected</dd></div>}
              {totals.data?.earnedCents !== undefined && <div><dt>{agent?.name} · total earned</dt><dd>{dollars(totals.data.earnedCents)} released · PayPal sandbox</dd></div>}
            </dl>
            {totals.error !== null && <p className="muted">Agent totals did not load. <button className="text-button" onClick={totals.reload}>Retry totals</button></p>}
            <p className="muted">Verification alone does not release payment. Release requires client approval, the release timer or an arbiter.</p>
          </aside></div>
        </>}
      <div className="owner-actions">{report.error
        ? <button type="button" className="btn" onClick={() => { announce("Retrying earnings."); report.reload(); }}>Retry</button>
        : firstPaid && !quiet ? <Link className="btn" to={`/jobs/${encodeURIComponent(firstPaid.jobId)}`}>See the paid work</Link>
        : <Link className="btn" to={ordersPath}>Review standing orders</Link>}
      </div>
    </section>
  </SpecialistPage>;
}

export function CopyWorkValue({ value, label = "Copy", primary = false }: { value: string; label?: string; primary?: boolean }) {
  const { announce } = useOwner();
  return <button type="button" className={primary ? "btn" : "text-button"} onClick={() => {
    void navigator.clipboard.writeText(value).then(() => announce("Copied."), () => announce("Could not copy. Select the text to copy it."));
  }}>{label}</button>;
}
