import { useEffect, useState } from "react";
import { Link } from "../../router.tsx";
import { EmptyState, SkeletonCard, Spinner } from "../../ui.tsx";
import { loadNightReplay } from "./client.ts";
import { useOwner } from "./OwnerPanel.tsx";
import { LoadFailed, SpecialistPage } from "./SpecialistPage.tsx";
import type { NightReplay, SpecialistAgent, Task } from "./types.ts";
import { useLoad } from "./useLoad.ts";
import { localTime, nightTone } from "./view.ts";

/** How long each replay event waits before the next one shows. */
const EVENT_MS = 900;

export function ActivityPage({ agentId }: { readonly agentId?: string }) {
  const { agent } = useOwner();
  return (
    <SpecialistPage
      step={4}
      agentId={agentId}
      lead="Replay of unattended work · PayPal sandbox."
    >
      {agent && <ActivityForAgent key={agent.id} agent={agent} />}
      <div className="spec-next">
        <Link to={`/earnings${agent ? `?agent=${encodeURIComponent(agent.id)}` : ""}`} className="btn">
          Next
        </Link>
      </div>
    </SpecialistPage>
  );
}

function ActivityForAgent({ agent }: { readonly agent: SpecialistAgent }) {
  if (agent.task !== "code") return <section><h1>Activity</h1><NoActivity task={agent.task} /></section>;
  return <ActivityReplayView task={agent.task} agentId={agent.id} />;
}

function NoActivity({ task }: { readonly task: Task }) {
  return (
    <EmptyState inline>
      {task === "print-fdm"
        ? "No activity yet. The simulated printer has no jobs posted."
        : "No activity yet. The simulated laser cutter is coming."}
    </EmptyState>
  );
}

function ActivityReplayView({ task, agentId }: { readonly task: Task; readonly agentId: string }) {
  // A missing file comes back as null, not as an error, so the screen can say no replay is recorded.
  const replay = useLoad(async () => ({ replay: await loadNightReplay(task) }), task);
  const [playId, setPlayId] = useState(0);
  if (replay.data === null) {
    return replay.error !== null ? (
      <LoadFailed error={replay.error} onRetry={replay.reload} />
    ) : (
      <SkeletonCard lines={4} />
    );
  }
  const recording = replay.data.replay;
  if (recording === null) return <section><h1>Activity</h1><EmptyState inline>No activity replay is recorded for this task yet.</EmptyState></section>;
  return <ActivityPlayer key={playId} recording={recording} agentId={agentId} onPlayAgain={() => setPlayId((n) => n + 1)} />;
}

function ActivityPlayer({ recording, agentId, onPlayAgain }: { readonly recording: NightReplay; readonly agentId: string; readonly onPlayAgain: () => void }) {
  const total = recording.events.length;
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= total) return;
    const timer = window.setTimeout(() => setShown((n) => n + 1), EVENT_MS);
    return () => window.clearTimeout(timer);
  }, [shown, total]);

  const done = shown >= total;

  return (
    <section className="card pad spec-activity" aria-labelledby="spec-activity-title">
      <div className="spec-exam-head">
        <h1 id="spec-activity-title">Activity</h1>
      </div>
      <p className="muted">{recording.source === "recorded" ? "Replay of a recorded run" : "Sample data · not a live run"}{recording.simulated ? " · Simulated" : ""} · <Link to={`/specialists/exam/${encodeURIComponent(agentId)}`}>Take the exam</Link></p>

      <p className="spec-status" role="status">
        {done ? "Work finished." : "Working unattended."}
        {!done && <Spinner />}
      </p>

      <ol className="timeline spec-timeline" aria-live="polite">
        {recording.events.slice(0, shown).map((event, i) => (
          <li key={i} className={`tl-node ${nightTone(event.kind)}`}>
            <span className="tl-dot" aria-hidden="true" />
            <div className="tl-body">
              <div className="tl-head">
                <b>{recording.source === "fixture" && event.kind === "bid" ? "Sample " : ""}{event.title}{event.title.includes("$") && !/held|released|pending|refunded|sandbox/i.test(event.title) ? " · pending" : ""}</b>
                <time className="muted" dateTime={event.at} title={event.at}>{localTime(event.at)}</time>
              </div>
              {recording.source !== "fixture" && <p className="tl-detail">{event.detail}{event.detail.includes("$") && !/held|released|pending|refunded|sandbox/i.test(event.detail) ? " · pending" : ""}</p>}
            </div>
          </li>
        ))}
      </ol>

      {done && (
        <div className="spec-actions">
          <button type="button" className="btn secondary sm" onClick={onPlayAgain}>
            Play again
          </button>
        </div>
      )}
    </section>
  );
}
