import { useEffect, useRef } from "react";
import { Link, useRouter } from "../../router.tsx";
import { activityDomId, activityEvents, activityLanes, activityReleasePending, activityStateWords, activitySteps, closedMoneyWords, closedReasonWords, MONEY_FLOW_WORDS, runnerAction, runnerStatusWords, sampleActivityLabel } from "./liveWork.ts";
import { useOwner } from "./OwnerPanel.tsx";
import type { OwnerActivity } from "./types.ts";
import { JobStrip, TimelineMark, WorkTime } from "./WorkTimeline.tsx";

export function ActivityFeed({ feed }: { feed: OwnerActivity }) {
  const { location } = useRouter();
  const selected = location.search.get("job");
  const focused = useRef<string | null>(null);
  const { agent } = useOwner();
  const action = runnerAction(feed.runner,agent?.id);
  useEffect(() => {
    if (!selected) { focused.current = null; return; }
    if (focused.current === selected) return;
    const target = document.getElementById(activityDomId(selected));
    if (!target) return;
    focused.current = selected;
    target?.focus({ preventScroll:true });
    target?.scrollIntoView({ block:"center",behavior:"instant" });
  }, [selected,feed]);
  return <div className="work-split activity-feed">
    <ol className="work-timeline" aria-label="Your jobs, newest updated first">
      {feed.activity.map((job,index) => <TimelineMark key={job.jobId} id={activityDomId(job.jobId)} at={job.updatedAt} index={index}
        tone={job.state === "RETRYING" ? "fail" : ""} title={<Link to={`/jobs/${encodeURIComponent(job.jobId)}`}>{job.title}</Link>}>
        <p className="work-status">{activityStateWords(job.state)}</p>
        {activityReleasePending(job) && <p className="muted">Verified is not paid.</p>}
        {job.state === "CLOSED" && closedReasonWords(job.closedReason) && <p className="work-status">{closedReasonWords(job.closedReason)}</p>}
        {closedMoneyWords(job) && <p className="work-status">{closedMoneyWords(job)}</p>}
        <p className="work-status">{[sampleActivityLabel(job),feed.labels.verifier,feed.labels.money].filter(Boolean).join(" · ")}</p>
        <p className="work-status"><Link to={`/agents/${encodeURIComponent(job.agentId)}/record`}>Agent record</Link></p>
        <ol className="activity-track" aria-label="Job progress">{activitySteps(job).map(step =>
          <li key={step.key} aria-current={step.current ? "step" : undefined} data-recorded={step.at ? "true" : "false"}>
            <span className="activity-step-icon" aria-hidden="true">{step.at ? "✓" : step.current ? "•" : "—"}</span>
            <div><p className="activity-step-main"><span>{step.title}</span>{step.at
              ? <WorkTime at={step.at} /> : <span className="muted">{step.current ? "In progress" : "Not recorded"}</span>}</p>
              {step.detail && <p className="activity-step-detail">{step.detail}</p>}</div>
          </li>)}</ol>
        {(job.bid || job.moneyHeld || job.release) && <p className="work-money-flow">{MONEY_FLOW_WORDS}</p>}
        {(job.attempts.length > 1 || job.attempts.some(attempt => attempt.result !== "VERIFIED")) && <details className="earnings-history">
          <summary>Check attempts</summary><ol className="earnings-events">{activityEvents(job,feed.labels).filter(event => event.id.startsWith("attempt-")).map(event =>
            <li key={event.id} data-tone={event.rejected ? "fail" : undefined}><WorkTime at={event.at} /> · {event.title}
              {event.details.map(detail => <p key={detail}>{detail}</p>)}</li>)}</ol></details>}
        {job.review && ("disputed" in job.review && job.review.disputed
          ? <p className="work-status">Disputed · arbiter deadline <WorkTime at={job.review.resolveBy} full /></p>
          : "endsAt" in job.review && job.review.endsAt && <p className="work-status">Client review deadline <WorkTime at={job.review.endsAt} full /></p>)}
      </TimelineMark>)}
      {!feed.activity.length && <TimelineMark title="No jobs recorded"><p className="work-status">Work will appear here when a bid is placed.</p></TimelineMark>}
    </ol>
    <aside className="work-side" aria-label="Runner and activity summary">
      <section className="runner-status" aria-label="Sample runner"><h2>Sample runner</h2><p>{runnerStatusWords(feed.runner)}</p>
        {action && <Link className="runner-action" to={action.to}>{action.label}</Link>}
        {feed.runner.status === "QUEUED" && feed.runner.queuedSince && <p className="muted">Queued <WorkTime at={feed.runner.queuedSince} full /></p>}
        <p className="runner-count">{feed.runner.runsToday} of {feed.runner.runsPerDay} sample runs used today</p></section>
      {!!feed.activity.length && <JobStrip lanes={activityLanes(feed.activity,feed.labels)} />}
    </aside>
  </div>;
}
