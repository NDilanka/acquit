import { useEffect, useState } from "react";
import { Link, useRouter } from "../../router.tsx";
import { loadNightReplay } from "./client.ts";
import { useOwner } from "./OwnerPanel.tsx";
import { SpecialistPage } from "./SpecialistPage.tsx";
import { useLoad } from "./useLoad.ts";
import { useReport } from "./useReport.ts";
import { EventMark, JobStrip, TimelineMark, WorkSkeleton, WorkTime } from "./WorkTimeline.tsx";
import { agentDelta, jobLanes, reportEvents, type WorkLane } from "./work.ts";
import type { SpecialistAgent } from "./types.ts";

export function ActivityPage({ agentId }: { readonly agentId?: string }) {
  const { agent } = useOwner();
  const { location } = useRouter();
  return location.search.get("replay") === "1" && agent
    ? <ReplayActivity key={agent.id} agent={agent} />
    : <LiveActivity key={agent?.id ?? agentId ?? ""} />;
}

function LiveActivity() {
  const { agent, orders, announce } = useOwner();
  const report = useReport();
  const [readAt, setReadAt] = useState(() => new Date().toISOString());
  useEffect(() => {
    if (report.data) setReadAt(new Date().toISOString());
    announce(report.error ? "Activity did not load." : report.data ? "Activity updated." : "Loading activity.");
  }, [report.data, report.error, announce]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) report.reload(); }, 15000);
    return () => window.clearInterval(timer);
  }, [report.reload]);
  const events = report.data ? reportEvents(report.data).filter((entry) => entry.agentId === agent?.id) : [];
  const active = orders?.autopilot && agent?.runner === "claude-code";
  const jobs = new Set(events.flatMap((event) => event.jobId ? [event.jobId] : []));
  const suffix = agent ? `/${encodeURIComponent(agent.id)}` : "";
  return <SpecialistPage step={4} lead="" gradeDelta={agentDelta(report.data, agent?.id)} provenance="Live workspace activity">
    <section className="work-page">
      <header className="work-heading"><h1>You can close this tab now.</h1>
        <p className="spec-lead">{active
          ? <><b>{agent.name}</b> works on its own, within your orders.</>
          : <>Autopilot is off. No new bids are placed automatically.</>}</p></header>
      {report.error ? <div className="work-alert" role="alert" data-tone="fail"><h2>Activity did not load.</h2>
        <p>Could not read the server. Try again to see the latest events.</p></div>
        : !report.data ? <WorkSkeleton count={5} label="Loading activity." />
        : <div className="work-split"><ol className="work-timeline" aria-label="Activity, newest first">
          <TimelineMark title={active ? "Watching for work within your orders" : "Autopilot off"}>
            <p className="work-status">{events.length ? "Latest recorded events below." : "No activity recorded in this window."}</p></TimelineMark>
          {events.map((event, i) => <EventMark key={event.id} event={event} index={i + 1} />)}
        </ol><aside className="work-side" aria-label="Activity summary">
          <JobStrip lanes={jobLanes(events)} through={readAt} />
          <dl className="work-facts"><div><dt>Since <WorkTime at={report.data.since} full /></dt>
            <dd>{jobs.size} jobs · {events.filter((event) => event.kind === "bid").length} bids recorded</dd></div></dl>
          <p className="muted">Held money above is workspace-wide. Verification alone does not release payment.</p>
        </aside></div>}
      <div className="owner-actions">{report.error
        ? <button className="btn" type="button" onClick={() => { announce("Retrying activity."); report.reload(); }}>Retry</button>
        : <Link className="btn" to={`/earnings${agent ? `?agent=${encodeURIComponent(agent.id)}` : ""}`}>See earnings</Link>}
        <Link to={`/specialists/orders${suffix}`}>Review standing orders</Link>
      </div>
      {agent?.task === "code" && <Link className="work-replay-link" to={`/specialists/activity${suffix}?replay=1`}>View an example run</Link>}
    </section>
  </SpecialistPage>;
}

function ReplayActivity({ agent }: { agent: SpecialistAgent }) {
  const replay = useLoad(async () => ({ replay: await loadNightReplay(agent.task) }), agent.task);
  const { announce } = useOwner();
  const recording = replay.data?.replay;
  useEffect(() => { announce(!replay.data ? "Loading example activity." : recording ? "Example activity loaded." : "No example available."); }, [replay.data, recording, announce]);
  const provenance = recording?.source === "recorded" && recording.recordedAt
    ? `Replay of a recorded run · ${new Date(recording.recordedAt).toLocaleDateString("en-GB")}`
    : "Sample data · not a live run";
  const lanes: WorkLane[] = recording?.events.map((event, i) => ({ id: String(i), label: event.kind === "money-held" ? "Sample money held · PayPal sandbox" : event.kind === "verdict" ? "Example verdict" : event.kind === "bid" ? "Example bid · pending" : event.title,
    start: event.at, end: event.at, tone: "open" })) ?? [];
  return <SpecialistPage step={4} lead="" provenance={provenance}>
    <section className="work-page"><header className="work-heading"><h1>{recording?.source === "recorded" ? "A recorded run" : "An example run"}</h1>
      <p className="spec-lead">{provenance}. This is not {agent.name}’s live activity.</p></header>
      {!replay.data ? <WorkSkeleton count={5} label="Loading example activity." /> : !recording
        ? <p>No activity replay is available for this task.</p>
        : <div className="work-split"><ol className="work-timeline" aria-label="Example activity, newest first">
          {[...recording.events].reverse().map((event, i) => <TimelineMark key={`${event.at}:${i}`} at={event.at} index={i}
            title={event.kind === "verdict" ? "Example verdict" : event.kind === "bid" ? `${event.title} · pending · PayPal sandbox` : event.title}>
            <p className="work-status">{event.kind === "verdict" ? "Verification is separate from payment release."
              : event.kind === "money-held" ? "Example held money · PayPal sandbox" : "Example event · not live"}</p>
          </TimelineMark>)}
        </ol><aside className="work-side"><JobStrip lanes={lanes} /><p className="muted">Example timestamps, not current work. Release requires client approval, the release timer or an arbiter.</p></aside></div>}
      <div className="owner-actions"><Link className="btn" to={`/specialists/activity/${encodeURIComponent(agent.id)}`}>Run it live</Link></div>
    </section>
  </SpecialistPage>;
}
