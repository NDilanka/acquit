import { useEffect, useRef } from "react";
import { Link, useRouter } from "../../router.tsx";
import { activityDomId, activityEvents, activityLanes, activityStateWords, runnerStatusWords, sampleActivityLabel } from "./liveWork.ts";
import type { OwnerActivity } from "./types.ts";
import { JobStrip, TimelineMark, WorkTime } from "./WorkTimeline.tsx";

export function ActivityFeed({ feed }: { feed: OwnerActivity }) {
  const { location } = useRouter();
  const selected = location.search.get("job");
  const focused = useRef<string | null>(null);
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
        <p className="work-status">{[sampleActivityLabel(job),feed.labels.verifier,feed.labels.money].filter(Boolean).join(" · ")}</p>
        <p className="work-status">Agent <Link to={`/agents/${encodeURIComponent(job.agentId)}/record`}>{job.agentId}</Link></p>
        <ol className="earnings-events" aria-label="Job events, oldest first">{activityEvents(job,feed.labels).map(event =>
          <li key={event.id} data-tone={event.rejected ? "fail" : undefined}><WorkTime at={event.at} /> · {event.title}
            {event.details.map(detail => <p key={detail}>{detail}</p>)}</li>)}</ol>
        {job.review && ("disputed" in job.review && job.review.disputed
          ? <p className="work-status">Disputed · arbiter deadline <WorkTime at={job.review.resolveBy} full /></p>
          : "endsAt" in job.review && job.review.endsAt && <p className="work-status">Client review deadline <WorkTime at={job.review.endsAt} full /></p>)}
      </TimelineMark>)}
      {!feed.activity.length && <TimelineMark title="No jobs recorded"><p className="work-status">Work will appear here when a bid is placed.</p></TimelineMark>}
    </ol>
    <aside className="work-side" aria-label="Runner and activity summary">
      <section className="runner-status" aria-label="Sample runner"><p>{runnerStatusWords(feed.runner)}</p>
        {feed.runner.status === "QUEUED" && feed.runner.queuedSince && <p className="muted">Queued <WorkTime at={feed.runner.queuedSince} full /></p>}
        <p className="muted">Hosted runs used: {feed.runner.runsToday} of {feed.runner.runsPerDay}.</p></section>
      <JobStrip lanes={activityLanes(feed.activity,feed.labels)} />
      <p className="muted">All your agents’ jobs. Verification alone does not release payment.</p>
    </aside>
  </div>;
}
