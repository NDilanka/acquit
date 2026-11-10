import type { CSSProperties, ReactNode } from "react";
import { Link } from "../../router.tsx";
import { jobLabel, stripRange, timeWords, type WorkEvent, type WorkLane } from "./work.ts";
import "./work.css";

export function WorkTime({ at, full = false }: { at: string; full?: boolean }) {
  return <time dateTime={at} title={timeWords(at, true)}>{timeWords(at, full)}</time>;
}

export function TimelineMark({ at, title, children, tone = "", index = 0 }: {
  at?: string; title: ReactNode; children?: ReactNode; tone?: string; index?: number;
}) {
  return <li className={`work-mark ${tone}`} style={{ "--mark-delay": `${Math.min(index, 8) * 60}ms` } as CSSProperties}>
    <span className="work-time">{at ? <WorkTime at={at} /> : "Now"}</span>
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
    <svg viewBox={`0 0 1000 ${lanes.length * 56}`} preserveAspectRatio="none" style={{ height: lanes.length * 56 }}
      role="img" aria-label={`${lanes.map((lane) => lane.label).join("; ")}. ${timeWords(first, true)} to ${timeWords(last, true)}.`}>
      {lanes.map((lane, i) => {
        const x = (Date.parse(lane.start) - range.start) / range.span * 1000;
        const width = Math.max(4, (Date.parse(lane.end) - Date.parse(lane.start)) / range.span * 1000);
        return <g key={lane.id}><rect className="strip-rule" x="0" y={i * 56 + 44} width="1000" height="2" />
          <rect className={`strip-bar ${lane.tone}`} x={Math.min(x, 996)} y={i * 56 + 40} width={Math.min(width, 1000 - Math.min(x, 996))} height="8" /></g>;
      })}
      {through && <rect className="strip-now" x="998" y="0" width="2" height={lanes.length * 56} />}
    </svg>
    {lanes.map((lane, i) => {
      const x = (Date.parse(lane.start) - range.start) / range.span;
      const end = (Date.parse(lane.end) - range.start) / range.span;
      return <span key={lane.id} className={`strip-label ${x > .6 ? "end" : ""}`}
        style={{ top: i * 56 + 8, left: `${(x > .6 ? end : x) * 100}%` }}>{lane.label}</span>;
    })}
    <figcaption className="strip-ends"><WorkTime at={first} /><span>{through && "Now · "}<WorkTime at={last} /></span></figcaption>
  </figure>;
}

export function WorkSkeleton({ count, label }: { count: number; label: string }) {
  return <div className="work-split" aria-label={label} aria-busy="true">
    <ol className="work-timeline">{Array.from({ length: count }, (_, i) =>
      <TimelineMark key={i} title={<span className="work-skeleton-line" />}><span className="work-skeleton-line short" /></TimelineMark>)}</ol>
    <div className="work-strip-skeleton" />
  </div>;
}
