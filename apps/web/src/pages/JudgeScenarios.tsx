import { useEffect, useId, useState } from "react";
import { api, ApiError } from "../api";
import type { ScenarioName, ScenarioRun } from "../api-types";
import { errorText } from "../demo";
import { SCENARIO_CARDS } from "../judge-tour";
import { buildRunView, nextPollMs, startRefusalWords, type RunStepView, type ScenarioCard } from "../scenario-run";

type Panel = { readonly scenarioId: string; readonly run: ScenarioRun | null; readonly error: string | null };

/**
 * The five judge-scenario buttons. One click starts a run on the server, and the run's steps show as the server
 * finishes them. A run starts only from a demo, so `ensureDemo` gives the click its demo session first.
 */
export function JudgeScenarios({ ensureDemo }: { ensureDemo: () => Promise<unknown> }) {
  const [starting, setStarting] = useState<ScenarioName | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const id = useId();
  const running = panel !== null && panel.error === null && (panel.run === null || panel.run.state === "RUNNING");
  const busy = starting !== null || running;
  const scenarioId = panel?.scenarioId ?? null;

  // Reads the run now and every 2 s while it is RUNNING. Leaving the page, or starting another run, stops the reads.
  useEffect(() => {
    if (scenarioId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const run = await api.scenarioRun(scenarioId);
        if (stopped) return;
        setPanel(current => (current?.scenarioId === scenarioId ? { ...current, run, error: null } : current));
        const again = nextPollMs(run);
        if (again !== null) timer = setTimeout(() => void read(), again);
      } catch (e) {
        if (!stopped) setPanel(current => (current?.scenarioId === scenarioId ? { ...current, error: errorText(e) } : current));
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [scenarioId]);

  const start = async (card: ScenarioCard) => {
    setStarting(card.name);
    setStartError(null);
    setPanel(null);
    try {
      await ensureDemo();
      const started = await api.startScenario(card.name);
      setPanel({ scenarioId: started.scenarioId, run: null, error: null });
    } catch (e) {
      setStartError(e instanceof ApiError ? startRefusalWords(e.code, e.detail) : errorText(e));
    } finally {
      setStarting(null);
    }
  };

  return (
    <section className="scenarios" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Run a whole job story</h2>
      <p className="muted">
        Each button runs one job from start to end on the server, and its steps appear here as they finish. Each run gets its own
        client and operator, separate from your demo.
      </p>
      <div className="scenario-grid">
        {SCENARIO_CARDS.map(card => (
          <button key={card.name} type="button" className="scenario-card" disabled={busy} onClick={() => void start(card)}>
            <b>{card.title}</b>
            <span className="muted">{card.promise}</span>
            <small>{card.scripted}</small>
            <small>Ends: {card.endStateText}</small>
          </button>
        ))}
      </div>
      {starting !== null && <p className="muted" role="status">Starting the run…</p>}
      {startError !== null && <div className="alert">{startError}</div>}
      {panel !== null && <RunPanel run={panel.run} error={panel.error} />}
    </section>
  );
}

function RunPanel({ run, error }: { run: ScenarioRun | null; error: string | null }) {
  if (run === null) {
    return error ? <div className="alert">{error}</div> : <p className="muted" role="status">Starting the run…</p>;
  }
  const view = buildRunView(run);
  const failed = view.state === "FAILED";
  return (
    <section className="run-view" aria-label={`${view.title} run`} aria-live="polite">
      <div className="run-head">
        <b>{view.title}</b>
        <span className={failed ? "pill alert" : "pill"}>{view.stateWords}</span>
      </div>
      <p className="muted">Times are measured on the server.</p>
      <ol className="run-steps">
        {view.steps.map((step, index) => (
          <RunStep key={`${index}-${step.title}`} step={step} />
        ))}
      </ol>
      {error && <div className="alert">{error}</div>}
      <p className={failed ? "alert" : undefined} role="status">{view.endText}</p>
      {view.observed !== null && <p className="muted">Observed end state: {view.observed}</p>}
      {view.jobHref !== null && <a className="btn ghost sm" href={view.jobHref}>Open the job</a>}
      <p className="muted">{view.jobNote}</p>
    </section>
  );
}

function RunStep({ step }: { step: RunStepView }) {
  return (
    <li>
      <div>
        <b>{step.title}</b> <span className="muted">{step.actorText}</span>
      </div>
      <div className="run-meta">
        <span>{step.label}</span>
        {step.sandboxNote !== null && (
          <>
            <span className="sandbox">Sandbox</span>
            <span className="muted">{step.sandboxNote}</span>
          </>
        )}
        <span className="mono">{step.ms} ms</span>
      </div>
      <small className="muted">{step.result}</small>
    </li>
  );
}
