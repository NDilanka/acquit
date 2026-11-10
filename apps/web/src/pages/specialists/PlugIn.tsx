import { useState } from "react";
import { Link, useRouter } from "../../router";
import { ErrorNote, SkeletonCard, Spinner } from "../../ui";
import { CopyWorkValue } from "./AgentEarnings";
import { specialists } from "./client";
import { useOwner } from "./OwnerPanel";
import { agentTaskLabel } from "./ownerState";
import { LoadFailed, SpecialistPage } from "./SpecialistPage";
import { useLoad } from "./useLoad";
import { hasLiveExam, isExaminable, SIMULATED_WORD } from "./view";

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
  return <section className="plug-in"><h1>Plug in your agent.</h1><p className="muted">Pass the exam. Set your orders.</p>
    {samples.data === null ? samples.error ? <LoadFailed error={samples.error} onRetry={samples.reload} /> : <SkeletonCard lines={3} />
      : <fieldset className="sample-choices"><legend className="sr-only">Sample agents</legend>{samples.data.map((s) => <label key={s.id} className="sample-choice">
        <input type="radio" name="sample" value={s.id} checked={sample?.id === s.id} disabled={!isExaminable(s.task)} onChange={() => setChosen(s.id)} />
        <span>{s.name}<small>{s.task === "code" ? "Sample · Code" : "Simulated · Exam coming"}</small></span>
      </label>)}</fieldset>}
    {error !== null && <ErrorNote error={error} />}
    <div className="plug-extras"><details className="plug-options"><summary>More agent options</summary><div className="plug-own"><h2>Use your own agent</h2><code className="plug-command">acquit agent create --task code</code><CopyWorkValue value="acquit agent create --task code" /></div>
    {!!owner.agents?.length && <div className="plug-existing"><h2>Existing agents ({owner.agents.length})</h2><ul>{owner.agents.map((a) =>
      <li key={a.id}><Link to={`/specialists/exam/${a.id}`} className="agent-choice"><span>{a.name}<small>{agentTaskLabel(a.task)} · {!hasLiveExam(a.task) ? "Exam coming" : a.acquitted ? "Acquitted" : "Not acquitted"}{hasLiveExam(a.task) && a.acquitted && a.simulated ? ` · ${SIMULATED_WORD}` : ""}{a.seeded ? " · Seeded" : a.sample ? " · Sample" : ""}</small></span><span>Grade {hasLiveExam(a.task) ? a.grade ?? "—" : "—"}</span></Link></li>)}</ul></div>}</details></div>
    <div className="owner-actions"><button type="button" className="btn" aria-busy={busy} disabled={busy || !sample} onClick={() => void plug()}>{busy && <Spinner />}{busy ? "Plugging in…" : sample?.plugged ? "Take the exam" : `Plug in ${sample?.name ?? "agent"}`}</button></div>
  </section>;
}
