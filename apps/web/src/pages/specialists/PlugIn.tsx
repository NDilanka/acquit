import { useState } from "react";
import { Link, useRouter } from "../../router";
import { CopyField, ErrorNote, SkeletonCard, Spinner } from "../../ui";
import { specialists } from "./client";
import { useOwner } from "./OwnerPanel";
import { LoadFailed, SpecialistPage } from "./SpecialistPage";
import { useLoad } from "./useLoad";
import { isExaminable, taskLabel } from "./view";

export function PlugInPage() {
  return <SpecialistPage step={1} lead=""><PlugIn /></SpecialistPage>;
}
function PlugIn() {
  const samples = useLoad(() => specialists.samples(), "samples");
  const owner = useOwner();
  const { navigate } = useRouter();
  const [chosen, setChosen] = useState("code-fixer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sample = samples.data?.find((s) => s.id === chosen) ?? samples.data?.find((s) => isExaminable(s.task));
  const plug = async () => {
    if (!sample) return;
    setBusy(true); setError(null);
    try {
      const agent = sample.plugged ? { id: sample.plugged } : await specialists.plugSample(sample.id);
      owner.reload(); navigate(`/specialists/exam/${agent.id}`);
    } catch (e) { setError(e); }
    finally { setBusy(false); }
  };
  return <section className="plug-in"><h1>Plug in one task.</h1><p className="muted">Try a sample agent, or connect your own.</p>
    {samples.data === null ? samples.error ? <LoadFailed error={samples.error} onRetry={samples.reload} /> : <SkeletonCard lines={3} />
      : <fieldset className="sample-choices"><legend className="sr-only">Sample agents</legend>{samples.data.map((s) => <label key={s.id} className="sample-choice">
        <input type="radio" name="sample" value={s.id} checked={sample?.id === s.id} disabled={!isExaminable(s.task)} onChange={() => setChosen(s.id)} />
        <span>{s.name}<small>{taskLabel(s.task)}{s.task !== "code" ? " · Simulated" : ""}{!isExaminable(s.task) ? " · coming" : ""}</small></span>
        <span className="sample-word">Sample</span>
      </label>)}</fieldset>}
    {error !== null && <ErrorNote error={error} />}
    <div className="owner-actions"><button type="button" className="btn" disabled={busy || !sample} onClick={() => void plug()}>{busy && <Spinner />}{busy ? "Plugging in…" : sample?.plugged ? "Take the exam" : "Plug in the sample"}</button></div>
    <details className="plug-own"><summary>Connect your own agent</summary><p>Run this on your agent’s machine.</p><CopyField label="Connect command" value="acquit agent create --task code" /></details>
    {!!owner.agents?.length && <details className="plug-existing"><summary>Choose an existing agent ({owner.agents.length})</summary><ul>{owner.agents.map((a) =>
      <li key={a.id}><Link to={`/specialists/exam/${a.id}`} className="agent-choice"><span>{a.name}<small>{taskLabel(a.task)} · {a.acquitted ? "Acquitted" : "Not acquitted"}{a.seeded ? " · Seeded" : a.sample ? " · Sample" : ""}</small></span><span>Grade {a.grade ?? "—"}</span></Link></li>)}</ul></details>}
  </section>;
}
