import type { ReactNode } from "react";
import { utc } from "../../format";
import { verifierIndex, type TimelineEvent } from "../../job-timeline";
import { HouseBadge, IdChip } from "../../ui";

/** The proof in time order. The verifier block sits in the middle of it, where the judging happens. */
export function Timeline({ events, verifier }: { events: readonly TimelineEvent[]; verifier: ReactNode }) {
  const split = verifierIndex(events);
  return (
    <section className="card pad timeline-card">
      <h2>Proof timeline</h2>
      <ol className="timeline">
        {events.slice(0, split).map((event, i) => (
          <EventNode key={`before-${i}`} event={event} />
        ))}
        {verifier && <li className="tl-block">{verifier}</li>}
        {events.slice(split).map((event, i) => (
          <EventNode key={`after-${i}`} event={event} />
        ))}
      </ol>
    </section>
  );
}

function EventNode({ event }: { event: TimelineEvent }) {
  return (
    <li className={`tl-node ${event.tone}`}>
      <span className="tl-dot" aria-hidden="true" />
      <div className="tl-body">
        <div className="tl-head">
          <b>{event.title}</b>
          {event.house && <HouseBadge>{event.house === "client" ? "House client" : "House"}</HouseBadge>}
          {event.at && <small className="num muted">{utc(event.at)}</small>}
        </div>
        <p className="tl-detail">{event.detail}</p>
        {event.reasons.map((reason, i) => (
          <p key={`reason-${i}`} className="tl-detail">
            {reason}
          </p>
        ))}
        {event.href && (
          <p className="tl-link">
            <a href={event.href} target="_blank" rel="noreferrer">
              Open the pull request
            </a>
          </p>
        )}
        {event.ids.length > 0 && (
          <div className="tl-ids">
            {event.ids.map((id, i) => (
              <span key={`${i}-${id.value}`} className="tl-id">
                {id.label && <small className="muted">{id.label}</small>}
                <IdChip value={id.value} />
              </span>
            ))}
          </div>
        )}
        {/* The A2.2 reveal link goes in this slot. */}
        {event.kind === "CONTRACT" && <span className="reveal-slot" />}
      </div>
    </li>
  );
}
