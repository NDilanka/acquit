import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { checklistOf, measuredLabel, type Checklist } from "./checklist.ts";
import type { Delivery, InspectVerdict } from "./contract.ts";
import { onThemeChange, readPalette } from "./palette.ts";
import { placeOf, toDrawList, type DrawList, type Place } from "./scene-draw.ts";
import { Stage2D } from "./Stage2D.tsx";
import type { Stage } from "./stage-three.ts";
import { buildTimeline, frameAt, type Frame } from "./timeline.ts";
import "./inspect.css";

const SPEEDS = [0.5, 1, 2, 4] as const;
const REDUCED = "(prefers-reduced-motion: reduce)";

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED).matches);
  useEffect(() => {
    const media = window.matchMedia(REDUCED);
    const on = () => setReduced(media.matches);
    media.addEventListener("change", on);
    return () => media.removeEventListener("change", on);
  }, []);
  return reduced;
}

type Run = { verdict: InspectVerdict; list: DrawList; checks: Checklist; timeline: ReturnType<typeof buildTimeline> };

function runOf(delivery: Delivery): Run {
  const verdict = delivery.run();
  const list = toDrawList(verdict.scene);
  const checks = checklistOf(verdict);
  return { verdict, list, checks, timeline: buildTimeline(list, checks) };
}

export type InspectorProps = {
  readonly deliveries: readonly Delivery[];
  /** One sentence naming the job the deliveries answer. */
  readonly job?: string;
  /** Draw the flat view even where WebGL works. */
  readonly flat?: boolean;
  readonly initialId?: string;
};

/** Pick a delivery, run the real checker on it in the browser, and play the simulated machine run and the checks. */
export function Inspector({ deliveries, job, flat = false, initialId }: InspectorProps) {
  const reduced = useReducedMotion();
  const [id, setId] = useState(() => (deliveries.some((d) => d.id === initialId) ? initialId! : deliveries[0]?.id ?? ""));
  const delivery = deliveries.find((d) => d.id === id) ?? deliveries[0]!;
  const run = useMemo(() => runOf(delivery), [delivery]);
  const [t, setT] = useState(() => (reduced ? Infinity : 0));
  const [playing, setPlaying] = useState(!reduced);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [showFile, setShowFile] = useState(false);
  const [mode, setMode] = useState<"3d" | "2d">(() => (flat || !webglAvailable() ? "2d" : "3d"));
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [stageReady, setStageReady] = useState(0);

  const frame = useMemo(() => frameAt(run.list, run.checks, run.timeline, t), [run, t]);
  const focusRow = frame.focus === null ? null : run.checks.publicRows[frame.focus] ?? null;
  const place: Place | null = focusRow ? placeOf(run.list, focusRow.finding) : null;
  const refs = focusRow?.finding.refs ?? [];

  const pick = (next: Delivery) => {
    setId(next.id);
    setT(reduced ? Infinity : 0);
    setPlaying(!reduced);
  };

  // Playback clock. Reduced motion leaves it parked on the finished state.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      setT((cur) => {
        const next = Math.min(run.timeline.total, (Number.isFinite(cur) ? cur : 0) + dt * speed);
        if (next >= run.timeline.total) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, run]);

  // The 3D stage loads three.js in its own chunk and is rebuilt for each delivery.
  useEffect(() => {
    if (mode !== "3d" || !host.current) return;
    let cancelled = false;
    let off = () => {};
    import("./stage-three.ts")
      .then(({ createThreeStage }) => {
        if (cancelled || !host.current) return;
        stage.current = createThreeStage(host.current, run.list, readPalette(), { reducedMotion: reduced });
        off = onThemeChange(() => stage.current?.setPalette(readPalette()));
        setStageReady((n) => n + 1);
      })
      .catch(() => {
        if (!cancelled) setMode("2d");
      });
    return () => {
      cancelled = true;
      off();
      stage.current?.dispose();
      stage.current = null;
    };
  }, [mode, run, reduced]);

  useEffect(() => {
    stage.current?.update({ frame, focus: focusRow ? { place, refs } : null });
  }, [frame, focusRow, place, refs, stageReady]);

  const total = run.timeline.total;
  const shownT = Math.min(t, total);
  const done = frame.verdict;
  const togglePlay = () => {
    if (playing) setPlaying(false);
    else {
      if (shownT >= total) setT(0);
      setPlaying(true);
    }
  };

  return (
    <section className="inspector" aria-label="Try to cheat the checker">
      {job && <p className="insp-job">{job}</p>}
      <div className="insp-picker" role="group" aria-label="Deliveries">
        {deliveries.map((d, i) => (
          <Fragment key={d.id}>
            {d.cheat && !deliveries[i - 1]?.cheat && <span className="insp-picker-label">Cheats</span>}
            <button type="button" className="insp-chip" aria-pressed={d.id === delivery.id} onClick={() => pick(d)}>
              {d.title}
            </button>
          </Fragment>
        ))}
      </div>
      <p className="insp-blurb">
        <b>{delivery.title}.</b> {delivery.blurb}
      </p>
      <p className="insp-honest">
        <span className="sandbox">Simulated</span>
        The file is checked by the real checker, running in your browser. The machine run is simulated.
      </p>

      <div className="insp-grid">
        <div className="insp-stage-col">
          <div
            className={`insp-stage${mode === "2d" ? " flat" : ""}`}
            ref={host}
            tabIndex={mode === "3d" ? 0 : -1}
            role={mode === "3d" ? "application" : undefined}
            aria-label={mode === "3d" ? "3D view of the sheet on the laser bed. Drag or use the arrow keys to turn it, plus and minus to zoom, 0 to reset." : undefined}
          >
            {mode === "2d" && <Stage2D list={run.list} frame={frame} place={place} refs={refs} />}
            <StageCaption frame={frame} checks={run.checks} place={place} focusRule={focusRow?.rule ?? null} />
            {done && (
              <p className={`insp-stage-verdict ${run.checks.pass ? "pass" : "fail"}`}>{run.checks.pass ? "Passed" : "Rejected"}</p>
            )}
          </div>
          <Controls
            playing={playing}
            t={shownT}
            total={total}
            speed={speed}
            frame={frame}
            onReplay={() => { setT(0); setPlaying(true); }}
            onToggle={togglePlay}
            onScrub={(v) => { setPlaying(false); setT(v); }}
            onSpeed={setSpeed}
            onResetView={mode === "3d" ? () => stage.current?.resetView() : null}
            showFile={showFile}
            onShowFile={() => setShowFile((s) => !s)}
          />
          {mode === "2d" && !flat && <p className="insp-note">This browser has no WebGL, so the run is drawn flat.</p>}
        </div>
        <div className="insp-side">
          <div className="insp-side-inner">
            <Checks checks={run.checks} frame={frame} />
            <VerdictCard checks={run.checks} done={done} />
          </div>
        </div>
      </div>

      {showFile && <FileText name={delivery.fileName} text={delivery.text} />}
      <Measured measured={run.verdict.measured} />
    </section>
  );
}

function StageCaption({ frame, checks, place, focusRule }: { frame: Frame; checks: Checklist; place: Place | null; focusRule: string | null }) {
  const sealedFailed = frame.sealedShown > 0 && checks.sealed.slice(0, frame.sealedShown).some((ok) => !ok);
  const allPublicPassed = checks.publicRows.every((r) => r.ok);
  let text: string;
  if (sealedFailed && allPublicPassed) text = "Every public rule passed. A sealed check did not. Where it looked stays sealed, so nothing is marked.";
  else if (focusRule !== null)
    text = place ? `${focusRule} failed. Marked on the part: the paths the checker named.` : `${focusRule} failed. The checker names no place on the part for this rule.`;
  else if (frame.phase === "trace") text = "Simulated laser run, in the checker's cut order. Engraving is blue, moves between cuts are faint.";
  else if (frame.phase === "drop") text = "The cut-out pieces fall away and the finished part is left.";
  else if (frame.phase === "sealed") text = frame.sealedChecking !== null ? "Running a sealed check. What it checks is not shown." : "Now the sealed checks.";
  else if (frame.phase === "checks") text = "Checking the public rules.";
  else text = checks.pass ? "Every rule passed." : "The checker found a problem.";
  return (
    <p className={`insp-caption${sealedFailed && allPublicPassed ? " moment" : ""}`} aria-live="polite">
      {text}
    </p>
  );
}

type ControlsProps = {
  playing: boolean;
  t: number;
  total: number;
  speed: number;
  frame: Frame;
  onReplay: () => void;
  onToggle: () => void;
  onScrub: (t: number) => void;
  onSpeed: (s: (typeof SPEEDS)[number]) => void;
  onResetView: (() => void) | null;
  showFile: boolean;
  onShowFile: () => void;
};

const PHASE_WORDS: Readonly<Record<Frame["phase"], string>> = {
  trace: "cutting",
  drop: "pieces falling away",
  checks: "public rules",
  sealed: "sealed checks",
  verdict: "verdict",
};

function Controls(p: ControlsProps) {
  return (
    <div className="insp-controls">
      <button type="button" className="btn secondary sm" onClick={p.onReplay}>
        Replay
      </button>
      <button type="button" className="btn secondary sm" onClick={p.onToggle}>
        {p.playing ? "Pause" : "Play"}
      </button>
      <input
        className="insp-scrub"
        type="range"
        min={0}
        max={p.total}
        step={0.01}
        value={p.t}
        aria-label="Playback position"
        aria-valuetext={`${Math.round((p.t / p.total) * 100)} percent, ${PHASE_WORDS[p.frame.phase]}`}
        onChange={(e) => p.onScrub(Number(e.target.value))}
      />
      <label className="insp-speed">
        <select value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value) as (typeof SPEEDS)[number])} aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </label>
      {p.onResetView && (
        <button type="button" className="btn ghost sm" onClick={p.onResetView}>
          Reset view
        </button>
      )}
      <button type="button" className="btn ghost sm" aria-expanded={p.showFile} onClick={p.onShowFile}>
        {p.showFile ? "Hide the file" : "Show the file"}
      </button>
    </div>
  );
}

const Checks = memo(function Checks({ checks, frame }: { checks: Checklist; frame: Frame }) {
  const sealedCount = checks.sealed.length;
  const box = useRef<HTMLElement>(null);
  // Keep the row that matters in view inside the list, without scrolling the page: the failing row once it shows,
  // else the sealed checks once they open, else the latest row.
  const target = frame.focus !== null ? `p${frame.focus}` : frame.sealedOpen ? "sealed" : frame.publicShown > 0 ? `p${frame.publicShown - 1}` : null;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (target === null) { el.scrollTop = 0; return; }
    const row = el.querySelector<HTMLElement>(`[data-row="${target}"]`);
    if (!row) return;
    const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    if (top < el.scrollTop + 8 || top + row.offsetHeight > el.scrollTop + el.clientHeight - 8)
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
  }, [target, frame.verdict]);
  return (
    <aside className="insp-checks card" aria-label="Checks" ref={box}>
      <h2 className="insp-h">Public rules</h2>
      <p className="insp-sub muted">Published in the job. Any agent can read them.</p>
      <ol className="insp-rules">
        {checks.publicRows.map((row, i) => {
          const shown = i < frame.publicShown;
          const state = !shown ? "pending" : row.ok ? "pass" : "fail";
          return (
            <li key={row.rule} data-row={`p${i}`} className={`insp-rule ${state}${frame.focus === i ? " focus" : ""}`}>
              <Mark state={state} />
              <span className="insp-rule-text">
                <span className="insp-rule-id">{row.rule}</span>
                {shown && <span>{row.message}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {sealedCount > 0 && (
        <div className={`insp-sealed${frame.sealedOpen ? " open" : ""}`} data-row="sealed">
          <h2 className="insp-h">Sealed checks</h2>
          <p className="insp-sub muted">
            {sealedCount === 1 ? "1 sealed check." : `${sealedCount} sealed checks.`} The agent never sees what is checked, so it cannot aim at it.
          </p>
          <ol className="insp-rules">
            {checks.sealed.map((ok, i) => {
              const shown = i < frame.sealedShown;
              const checking = frame.sealedChecking === i;
              const state = shown ? (ok ? "pass" : "fail") : checking ? "checking" : "pending";
              return (
                <li key={i} className={`insp-rule sealed ${state}`}>
                  <Mark state={state} />
                  <span className="insp-rule-text">
                    <span className="insp-rule-id">Sealed check {i + 1}</span>
                    <span>{shown ? (ok ? "Passed." : "Failed.") : checking ? "Checking." : "Not run yet."}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </aside>
  );
});

function Mark({ state }: { state: "pending" | "pass" | "fail" | "checking" }) {
  const label = { pending: "Not checked yet", pass: "Passed", fail: "Failed", checking: "Checking" }[state];
  return (
    <span className={`insp-mark ${state}`} role="img" aria-label={label}>
      {state === "pass" && (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      )}
      {state === "fail" && (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      )}
    </span>
  );
}

const VerdictCard = memo(function VerdictCard({ checks, done }: { checks: Checklist; done: boolean }) {
  if (!done)
    return (
      <div className="insp-verdict card pending">
        <p className="insp-verdict-detail muted">The verdict shows once every check has run.</p>
      </div>
    );
  const failed = checks.publicRows.find((r) => !r.ok);
  const sealedFailed = checks.sealed.filter((ok) => !ok).length;
  const n = checks.publicRows.length;
  const s = checks.sealed.length;
  const detail = checks.pass
    ? `All ${n} public rules passed${s ? `, and ${s === 1 ? "the sealed check" : `all ${s} sealed checks`} too` : ""}.`
    : failed
      ? `Failed ${failed.rule}: ${failed.message}`
      : `Every public rule passed, and ${sealedFailed === 1 ? "a sealed check" : `${sealedFailed} sealed checks`} failed.`;
  return (
    <div className={`insp-verdict card ${checks.pass ? "pass" : "fail"}`} role="status">
      <p className="insp-verdict-line">{checks.pass ? "Passed. Payment could be released." : "Rejected. No payment."}</p>
      <p className="insp-verdict-detail">{detail}</p>
    </div>
  );
});

const FileText = memo(function FileText({ name, text }: { name: string; text: string }) {
  return (
    <section className="insp-file card">
      <h2 className="insp-h">
        The file <span className="mono muted">{name}</span>
      </h2>
      <pre tabIndex={0} aria-label={`Contents of ${name}`}>{text}</pre>
    </section>
  );
});

const Measured = memo(function Measured({ measured }: { measured: Readonly<Record<string, number | string>> }) {
  const entries = Object.entries(measured);
  if (entries.length === 0) return null;
  return (
    <section className="insp-measured card">
      <h2 className="insp-h">Measured by the checker</h2>
      <dl>
        {entries.map(([key, value]) => {
          const { label, unit } = measuredLabel(key);
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd className="mono">
                {String(value)}
                {unit && <span className="muted"> {unit}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
});
