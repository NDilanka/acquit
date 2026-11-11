import type { CSSProperties, ReactNode } from "react";
import { Link } from "../../router.tsx";
import { jobLabel, stripRange, timeWords, type WorkEvent, type WorkLane } from "./work.ts";
import "./work.css";

export function WorkTime({ at, full = false }: { at: string; full?: boolean }) {
  return <time dateTime={at} title={timeWords(at, true)}>{timeWords(at, full)}</time>;
}

export function TimelineMark({ at, title, children, tone = "", index = 0, placeholder = false, id }: {
  at?: string; title: ReactNode; children?: ReactNode; tone?: string; index?: number; placeholder?: boolean; id?: string;
}) {
  return <li id={id} tabIndex={id ? -1 : undefined} className={`work-mark ${tone}`} data-tone={tone === "fail" ? "fail" : undefined} style={{ "--mark-delay": `${Math.min(index, 8) * 60}ms` } as CSSProperties}>
    <span className="work-time">{placeholder ? null : at ? <WorkTime at={at} /> : "Now"}</span>
    <span className="work-node" aria-hidden="true" />
    <div className="work-body"><p className="work-what">{title}</p>{children}</div>
  </li>;
}

export function EventMark({ event, index = 0 }: { event: WorkEvent; index?: number }) {
  return <TimelineMark at={event.at} index={index} tone={event.kind === "rejected" ? "fail" : ""}
    title={event.jobId ? <Link to={`/jobs/${encodeURIComponent(event.jobId)}`}>{jobLabel(event.jobId)}</Link> : "Workspace activity"}>
    <p className="work-status">{event.status}{event.kind === "bid" && event.status.includes("$") && " · PayPal sandbox"}</p>
  </TimelineMark>;
}

export function JobStrip({ lanes, through }: { lanes: readonly WorkLane[]; through?: string }) {
  const range = stripRange(lanes, through);
  if (!range) return <p className="work-strip-empty muted">No events to plot yet.</p>;
  const first = new Date(range.start).toISOString();
  const last = new Date(range.end).toISOString();
  return <figure className="work-strip">
      {lanes.map((lane) => {
        const x = (Date.parse(lane.start) - range.start) / range.span * 1000;
        const width = Math.max(4, (Date.parse(lane.end) - Date.parse(lane.start)) / range.span * 1000);
        return <div className="work-strip-lane" key={lane.id}><p className="strip-label">{lane.label}</p>
          <svg viewBox="0 0 1000 16" preserveAspectRatio="none" style={{ height:16 }} role="img"
            aria-label={`${lane.label}. ${timeWords(lane.start,true)} to ${timeWords(lane.end,true)}.`}>
            <rect className="strip-rule" x="0" y="8" width="1000" height="2" />
            <rect className={`strip-bar ${lane.tone}`} x={Math.min(x,996)} y="4" width={Math.min(width,1000 - Math.min(x,996))} height="8" />
            {through && <rect className="strip-now" x="998" y="0" width="2" height="16" />}
          </svg></div>;
      })}
    <figcaption className="strip-ends"><WorkTime at={first} /><span>{through && "Now · "}<WorkTime at={last} /></span></figcaption>
  </figure>;
}

export function WorkSkeleton({ count, label }: { count: number; label: string }) {
  return <div className="work-split" aria-label={label} aria-busy="true">
    <ol className="work-timeline">{Array.from({ length: count }, (_, i) =>
      <TimelineMark key={i} placeholder title={<span className="work-skeleton-line" />}><span className="work-skeleton-line short" /></TimelineMark>)}</ol>
    <div className="work-strip-skeleton" />
  </div>;
}
