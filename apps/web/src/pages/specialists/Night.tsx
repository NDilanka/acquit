import { useEffect, useState } from "react";
import { Link } from "../../router.tsx";
import { EmptyState, SkeletonCard, Spinner } from "../../ui.tsx";
import { loadNightReplay, specialists } from "./client.ts";
import { LoadFailed, SpecialistPage } from "./SpecialistPage.tsx";
import type { NightReplay, SpecialistAgent, Task } from "./types.ts";
import { useLoad } from "./useLoad.ts";
import { localTime, nightKindWords, nightTone, pickAgent, replayLabel } from "./view.ts";

/** How long each night event waits before the next one shows. */
const EVENT_MS = 900;

export function NightPage({ agentId }: { readonly agentId?: string }) {
  return (
    <SpecialistPage
      step={4}
      agentId={agentId}
      lead="Replay of unattended work · PayPal sandbox."
    >
      <NightBody agentId={agentId} />
      <div className="spec-next">
        <Link to="/specialists/morning" className="btn">
          Next
        </Link>
      </div>
    </SpecialistPage>
  );
}

function NightBody({ agentId }: { readonly agentId?: string }) {
  const agents = useLoad(() => specialists.agents(), "agents");
  if (agents.data === null) {
    return agents.error !== null ? (
      <LoadFailed error={agents.error} onRetry={agents.reload} />
    ) : (
      <SkeletonCard lines={4} />
    );
  }
  const agent = pickAgent(agents.data, agentId);
  if (agent === null) {
    return (
      <EmptyState action={{ to: "/specialists", label: "Plug in an agent" }}>
        No agent yet. Plug one in first.
      </EmptyState>
    );
  }
  return <NightForAgent key={agent.id} agent={agent} />;
}

function NightForAgent({ agent }: { readonly agent: SpecialistAgent }) {
  // Only the code agent has a night replay. The print and laser machines have no jobs to bid on yet, so say that instead.
  if (agent.task !== "code") return <NoNight task={agent.task} />;
  return <NightReplayView task={agent.task} />;
}

function NoNight({ task }: { readonly task: Task }) {
  return (
    <EmptyState inline>
      {task === "print-fdm"
        ? "Nothing to bid on yet. The simulated printer has no jobs posted, so there is no night run to show."
        : "Laser cut is simulated and coming. There is no night run for it yet."}
    </EmptyState>
  );
}

function NightReplayView({ task }: { readonly task: Task }) {
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
  const night = replay.data.replay;
  if (night === null) return <EmptyState inline>No night replay is recorded for this task yet.</EmptyState>;
  return <NightPlayer key={playId} night={night} onPlayAgain={() => setPlayId((n) => n + 1)} />;
}

function NightPlayer({ night, onPlayAgain }: { readonly night: NightReplay; readonly onPlayAgain: () => void }) {
  const total = night.events.length;
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= total) return;
    const timer = window.setTimeout(() => setShown((n) => n + 1), EVENT_MS);
    return () => window.clearTimeout(timer);
  }, [shown, total]);

  const done = shown >= total;

  return (
    <section className="card pad spec-night" aria-labelledby="spec-night-title">
      <div className="spec-exam-head">
        <h1 id="spec-night-title">Night</h1>
        <span className="sandbox">{replayLabel(night.source)}</span>
      </div>
      <p className="muted">{night.source === "recorded" ? "Replay of a recorded run" : "Sample data · not a live run"}{night.simulated ? " · Simulated" : ""} · <Link to="/specialists/exam">Run it live</Link></p>

      <p className="spec-status" role="status">
        {done ? "Work finished." : "Working unattended."}
        {!done && <Spinner />}
      </p>

      <ol className="timeline spec-timeline" aria-live="polite">
        {night.events.slice(0, shown).map((event, i) => (
          <li key={i} className={`tl-node ${nightTone(event.kind)}`}>
            <span className="tl-dot" aria-hidden="true" />
            <div className="tl-body">
              <div className="tl-head">
                <b>{event.title}{event.title.includes("$") && !/held|released|pending|refunded|sandbox/i.test(event.title) ? " · pending" : ""}</b>
                <span className="spec-kind">{nightKindWords(event.kind)}</span>
                <time className="muted" dateTime={event.at} title={event.at}>{localTime(event.at)}</time>
              </div>
              <p className="tl-detail">{event.detail}{event.detail.includes("$") && !/held|released|pending|refunded|sandbox/i.test(event.detail) ? " · pending" : ""}</p>
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
