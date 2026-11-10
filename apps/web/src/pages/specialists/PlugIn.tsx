import { useState } from "react";
import { Link } from "../../router.tsx";
import { CopyField, EmptyState, ErrorNote, Segmented, SkeletonCard, Spinner } from "../../ui.tsx";
import { AgentCard } from "./AgentCard.tsx";
import { specialists } from "./client.ts";
import { LoadFailed, SpecialistPage } from "./SpecialistPage.tsx";
import type { Sample, Task } from "./types.ts";
import { useLoad } from "./useLoad.ts";
import { isExaminable, pickAgent, runnerWords, simulatedNote, taskLabel } from "./view.ts";

// Laser cut has no exam, so an agent for it could never be Acquitted. Only examinable tasks are offered here.
const CONNECT_TASKS = ["code", "print-fdm"] as const satisfies readonly Task[];

export function PlugInPage() {
  return (
    <SpecialistPage step={1} lead="Plug in a sample agent, or connect your own. Each agent takes one task.">
      <PlugIn />
    </SpecialistPage>
  );
}

function PlugIn() {
  const samples = useLoad(() => specialists.samples(), "samples");
  const agents = useLoad(() => specialists.agents(), "agents");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [plugging, setPlugging] = useState<string | null>(null);
  const [plugError, setPlugError] = useState<unknown>(null);
  const [task, setTask] = useState<Task>("code");

  const list = agents.data ?? [];
  const picked = pickAgent(list, pickedId ?? undefined);

  const plug = async (sample: Sample) => {
    setPlugging(sample.id);
    setPlugError(null);
    try {
      const agent = await specialists.plugSample(sample.id);
      setPickedId(agent.id);
      agents.reload();
      samples.reload();
    } catch (e) {
      setPlugError(e);
    } finally {
      setPlugging(null);
    }
  };

  return (
    <>
      <section className="spec-section" aria-labelledby="spec-samples-title">
        <h2 id="spec-samples-title" className="spec-h2">
          Sample agents
        </h2>
        {plugError !== null && <ErrorNote error={plugError} />}
        {samples.data !== null ? (
          <div className="spec-samples">
            {samples.data.map((sample) => (
              <SampleCard key={sample.id} sample={sample} busy={plugging === sample.id} onPlug={() => void plug(sample)} />
            ))}
          </div>
        ) : samples.error !== null ? (
          <LoadFailed error={samples.error} onRetry={samples.reload} />
        ) : (
          <SkeletonCard lines={3} />
        )}
      </section>

      <section className="card pad spec-own" aria-labelledby="spec-own-title">
        <h2 id="spec-own-title" className="spec-h2">
          I have my own agent
        </h2>
        <p className="muted">Run this command on the machine where your agent lives. Pick the task it does first.</p>
        <Segmented label="Task" options={CONNECT_TASKS.map((t) => ({ value: t, label: taskLabel(t) }))} value={task} onChange={setTask} />
        <CopyField label="Connect command" value={`acquit agent create --task ${task}`} />
      </section>

      <section className="spec-section" aria-labelledby="spec-agents-title">
        <h2 id="spec-agents-title" className="spec-h2">
          Your agents
        </h2>
        {agents.data === null && agents.error !== null && <LoadFailed error={agents.error} onRetry={agents.reload} />}
        {agents.data === null && agents.error === null && <SkeletonCard lines={3} />}
        {agents.data !== null && list.length === 0 && (
          <EmptyState inline>No agent yet. Plug in a sample above, or connect your own.</EmptyState>
        )}
        {list.length > 0 && (
          <div className="spec-agents">
            {list.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </section>

      <div className="spec-next">
        {picked ? (
          <Link to={`/specialists/exam/${picked.id}`} className="btn">
            Next
          </Link>
        ) : (
          <button type="button" className="btn" disabled>
            Next
          </button>
        )}
        {!picked && <p className="muted">Plug in an agent to continue.</p>}
      </div>
    </>
  );
}

function SampleCard({ sample, busy, onPlug }: { readonly sample: Sample; readonly busy: boolean; readonly onPlug: () => void }) {
  const note = simulatedNote(sample.task);
  const plugged = sample.plugged !== null;
  return (
    <article className="card pad spec-sample">
      <h3 className="spec-agent-name">{sample.name}</h3>
      <p className="muted">{taskLabel(sample.task)}</p>
      {note && <p className="muted spec-agent-note">{note}</p>}
      <p>{sample.blurb}</p>
      <p className="muted">{runnerWords(sample.runner)}</p>
      {isExaminable(sample.task) && (
        <button type="button" className="btn secondary sm spec-plug" disabled={plugged || busy} onClick={onPlug}>
          {busy && <Spinner />}
          {plugged ? "Plugged in" : busy ? "Plugging in" : "Plug in"}
        </button>
      )}
    </article>
  );
}
