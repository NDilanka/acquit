import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { checklistOf, formatMeasured, type Checklist, type PublicRow } from "./checklist.ts";
import type { Delivery, InspectVerdict } from "./contract.ts";
import { onThemeChange, readPalette } from "./palette.ts";
import { DEMO_LINE, HONEST_LINE, MOMENT, unseenName, unseenNext, unseenRunning, VERDICT_LINE, verdictDetail } from "./demo-copy.ts";
import type { CheckerEntry } from "./registry.ts";
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

function ruleName(checker: CheckerEntry, rule: string): string {
  return checker.ruleNames[rule] ?? rule;
}

function failText(checker: CheckerEntry, row: PublicRow): string {
  return checker.failCaption(row.finding) ?? row.message;
}

export type InspectorProps = {
  readonly checker: CheckerEntry;
  /** The id of the delivery to open on. The first delivery when absent or unknown. */
  readonly delivery?: string;
  /** Draw the flat view even where WebGL works. */
  readonly flat?: boolean;
};

/** Pick a delivery, run the real checker on it in the browser, and play the simulated machine run and the checks. */
export function Inspector({ checker, delivery: initialId, flat = false }: InspectorProps) {
  const deliveries = checker.deliveries;
  const reduced = useReducedMotion();
  const [id, setId] = useState(() => (deliveries.some((d) => d.id === initialId) ? initialId! : deliveries[0]?.id ?? ""));
  const delivery = deliveries.find((d) => d.id === id) ?? deliveries[0]!;
  const run = useMemo(() => runOf(delivery), [delivery]);
  const total = run.timeline.total;
  const [t, setT] = useState(() => (reduced ? Infinity : 0));
  const [playing, setPlaying] = useState(!reduced);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [showFile, setShowFile] = useState(false);
  const [mode, setMode] = useState<"3d" | "2d">(() => (flat || !webglAvailable() ? "2d" : "3d"));
  const [contextLost, setContextLost] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [stageReady, setStageReady] = useState(0);

  const frame = useMemo(() => frameAt(run.list, run.checks, run.timeline, t), [run, t]);
  const focusRow = frame.focus === null ? null : run.checks.publicRows[frame.focus] ?? null;
  const place: Place | null = focusRow ? placeOf(run.list, focusRow.finding) : null;
  const refs = useMemo(() => focusRow?.finding.refs ?? [], [focusRow]);

  // Reduced motion never animates: every start lands on the finished state.
  const start = () => {
    if (reduced) {
      setT(total);
      setPlaying(false);
    } else {
      setT(0);
      setPlaying(true);
    }
  };
  const pick = (next: Delivery) => {
    setId(next.id);
    setT(reduced ? Infinity : 0);
    setPlaying(!reduced);
  };

  // Reduced motion switched on mid-run stops the run on its finished state.
  useEffect(() => {
    if (!reduced) return;
    setPlaying(false);
    setT(total);
  }, [reduced, total]);

  useEffect(() => {
    if (!playing || reduced) return;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      setT((cur) => {
        const next = Math.min(total, (Number.isFinite(cur) ? cur : 0) + dt * speed);
        if (next >= total) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, reduced, speed, total]);

  // The 3D stage loads three.js in its own chunk and is rebuilt for each delivery.
  useEffect(() => {
    if (mode !== "3d" || !host.current) return;
    let cancelled = false;
    let off = () => {};
    import("./stage-three.ts")
      .then(({ createThreeStage }) => {
        if (cancelled || !host.current) return;
        stage.current = createThreeStage(host.current, run.list, readPalette(), {
          reducedMotion: reduced,
          dressing: checker.dressing,
          onContextLost: () => {
            setContextLost(true);
            setMode("2d");
          },
        });
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
  }, [mode, run, reduced, checker.dressing]);

  useEffect(() => {
    stage.current?.update({ frame, focus: focusRow ? { place, refs } : null });
  }, [frame, focusRow, place, refs, stageReady]);

  const shownT = Math.min(t, total);
  const togglePlay = () => {
    if (playing) setPlaying(false);
    else if (reduced) setT(total);
    else {
      if (shownT >= total) setT(0);
      setPlaying(true);
    }
  };

  return (
    <section className="inspector" aria-label="Try to cheat the checker">
      <Picker checker={checker} selected={delivery} onPick={pick} />
      <div className="insp-about">
        <details className="insp-blurb"><summary>About this file</summary>
          <p><b>{delivery.title}.</b> {delivery.blurb}</p>
        </details>
        <p className="insp-honest">
          <span className="sandbox">Simulated</span>
          {HONEST_LINE}
        </p>
      </div>

      <div className="insp-grid">
        <div className="insp-stage-col">
          <div className="insp-stage-box">
          <div
            className={`insp-stage${mode === "2d" ? " flat" : ""}`}
            ref={host}
            tabIndex={mode === "3d" ? 0 : -1}
            role={mode === "3d" ? "application" : undefined}
            aria-label={mode === "3d" ? "3D view of the sheet on the machine bed. Drag or use the arrow keys to turn it, plus and minus to zoom, 0 to reset." : undefined}
          >
            {mode === "2d" && <Stage2D list={run.list} frame={frame} place={place} refs={refs} />}
            {frame.verdict && <p className={`insp-stage-verdict ${run.checks.pass ? "pass" : "fail"}`}>{run.checks.pass ? "Passed" : "Rejected"}</p>}
          </div>
          <StageCaption checker={checker} frame={frame} checks={run.checks} place={place} focusRow={focusRow} />
          </div>
          <Controls
            playing={playing}
            t={shownT}
            total={total}
            speed={speed}
            frame={frame}
            onReplay={start}
            onToggle={togglePlay}
            onScrub={(v) => {
              setPlaying(false);
              setT(v);
            }}
            onSpeed={setSpeed}
            onResetView={mode === "3d" ? () => stage.current?.resetView() : null}
            showFile={showFile}
            onShowFile={() => setShowFile((s) => !s)}
          />
          <VerdictLine checker={checker} checks={run.checks} done={frame.verdict} />
          {mode === "2d" && !flat && (
            <p className="insp-note">{contextLost ? "The browser stopped the 3D view, so the run is drawn flat." : "This browser has no WebGL, so the run is drawn flat."}</p>
          )}
        </div>
        <Checks checker={checker} checks={run.checks} frame={frame} />
      </div>

      {showFile && <Files delivery={delivery} checker={checker} />}
      <Measured checker={checker} measured={run.verdict.measured} />
    </section>
  );
}

function Picker({ checker, selected, onPick }: { checker: CheckerEntry; selected: Delivery; onPick: (d: Delivery) => void }) {
  const featured = checker.featured
    .map((id) => checker.deliveries.find((d) => d.id === id))
    .filter((d): d is Delivery => d !== undefined);
  const rest = checker.deliveries.filter((d) => !featured.includes(d));
  const [more, setMore] = useState(() => rest.includes(selected));
  const shown = more ? [...featured, ...rest] : featured;
  return (
    <div className="insp-picker-wrap">
      <div className="insp-picker" role="group" aria-label="Deliveries">
        {shown.map((d, i) => (
          <Fragment key={d.id}>
            {d.cheat && !shown[i - 1]?.cheat && <span className="insp-picker-label">Cheats</span>}
            <button type="button" className="insp-chip" aria-pressed={d.id === selected.id} onClick={() => onPick(d)}>
              {d.title}
            </button>
          </Fragment>
        ))}
        {rest.length > 0 && (
          <button type="button" className="insp-more" aria-expanded={more} onClick={() => setMore((m) => !m)}>
            {more ? "Fewer cheats" : `More cheats (${rest.length})`}
          </button>
        )}
      </div>
    </div>
  );
}

function StageCaption({ checker, frame, checks, place, focusRow }: { checker: CheckerEntry; frame: Frame; checks: Checklist; place: Place | null; focusRow: PublicRow | null }) {
  const sealedFailed = frame.sealedShown > 0 && checks.sealed.slice(0, frame.sealedShown).some((ok) => !ok);
  const allPublicPassed = checks.publicRows.every((r) => r.ok);
  if (sealedFailed && allPublicPassed)
    return (
      <div className="insp-caption moment" aria-live="polite">
        <p>{MOMENT.main}</p>
        <p className="insp-caption-sub">{MOMENT.sub}</p>
      </div>
    );
  let main: string;
  let sub: string | null = null;
  if (focusRow) {
    main = failText(checker, focusRow);
    sub = place ? `${ruleName(checker, focusRow.rule)}: marked on the part.` : `${ruleName(checker, focusRow.rule)}: the checker names no place on the part for this rule.`;
  } else if (frame.phase === "trace") main = checker.runCaption;
  else if (frame.phase === "drop") main = "The cut-out pieces fall away and the finished part is left.";
  else if (frame.phase === "sealed") main = frame.sealedChecking !== null ? unseenRunning() : unseenNext();
  else if (frame.phase === "checks") main = "Checking the public rules.";
  else main = checks.pass ? "Every rule passed." : "The checker found a problem.";
  return (
    <div className={`insp-caption${focusRow ? " fail" : ""}`} aria-live="polite">
      <p>{main}</p>
      {sub && <p className="insp-caption-sub">{sub}</p>}
    </div>
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
  trace: "machine run",
  drop: "pieces falling away",
  checks: "public rules",
  sealed: "the second check",
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
      <select className="insp-speed" value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value) as (typeof SPEEDS)[number])} aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}x
          </option>
        ))}
      </select>
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

const Checks = memo(function Checks({ checker, checks, frame }: { checker: CheckerEntry; checks: Checklist; frame: Frame }) {
  const n = checks.publicRows.length;
  const passed = checks.publicRows.filter((r) => r.ok).length;
  const allShown = frame.publicShown >= n;
  const sealedCount = checks.sealed.length;
  return (
    <aside className="insp-checks card" aria-label="Checks">
      <div className="insp-checks-head">
        <h2 className="insp-h">Public rules</h2>
        <p className={`insp-count${allShown ? (passed === n ? " pass" : " fail") : ""}`}>
          {allShown ? `${passed} of ${n} public rules passed` : `${frame.publicShown} of ${n} checked`}
        </p>
      </div>
      <ol className="insp-rules">
        {checks.publicRows.map((row, i) => {
          const shown = i < frame.publicShown;
          const state = !shown ? "pending" : row.ok ? "pass" : "fail";
          return (
            <li key={row.rule} className={`insp-rule ${state}`} tabIndex={shown ? 0 : undefined}>
              <Mark state={state} />
              <span className="insp-rule-name">{ruleName(checker, row.rule)}</span>
              {shown && <span className="insp-rule-desc">{row.ok ? row.message : failText(checker, row)}</span>}
            </li>
          );
        })}
      </ol>
      {sealedCount > 0 && (
        <div className={`insp-sealed${frame.sealedOpen ? " open" : ""}`}>
          <div className="insp-checks-head">
            <h2 className="insp-h">{unseenName(sealedCount)}</h2>
          </div>
          <ol className="insp-rules">
            {checks.sealed.map((ok, i) => {
              const shown = i < frame.sealedShown;
              const opening = frame.sealedChecking === i;
              const state = shown ? (ok ? "pass" : "fail") : opening ? "opening" : "pending";
              return (
                <li key={i} className={`insp-rule sealed ${state}`}>
                  <Envelope state={state} />
                  <span className="insp-rule-name">{shown ? (ok ? "Passed" : "Failed") : opening ? "Running" : "Not run yet"}</span>
                  <span className="insp-rule-id insp-demo">{sealedCount > 1 ? `${i + 1} of ${sealedCount}. ${DEMO_LINE}` : DEMO_LINE}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </aside>
  );
});

function Mark({ state }: { state: "pending" | "pass" | "fail" }) {
  const label = { pending: "Not checked yet", pass: "Passed", fail: "Failed" }[state];
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

/** An envelope: closed while waiting, its flap lifting while it runs, open in the result's colour. */
function Envelope({ state }: { state: "pending" | "opening" | "pass" | "fail" }) {
  const label = { pending: "Not run yet", opening: "Running", pass: "Passed", fail: "Failed" }[state];
  return (
    <span className={`insp-envelope ${state}`} role="img" aria-label={label}>
      <svg viewBox="0 0 24 20" aria-hidden="true">
        <rect x="1.5" y="5.5" width="21" height="13" rx="2" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.5" />
        <path className="insp-flap" d="M1.5 7.5 L12 14 L22.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

const VerdictLine = memo(function VerdictLine({ checker, checks, done }: { checker: CheckerEntry; checks: Checklist; done: boolean }) {
  // The verdict's place is kept while the run plays, so nothing moves when it arrives.
  if (!done) return <div className="insp-verdict waiting" aria-hidden="true" />;
  const failed = checks.publicRows.find((r) => !r.ok);
  const sealedFailed = checks.sealed.filter((ok) => !ok).length;
  const n = checks.publicRows.length;
  const s = checks.sealed.length;
  const detail = failed ? `${ruleName(checker, failed.rule)} failed. ${failText(checker, failed)}` : verdictDetail(n, s, sealedFailed, checks.pass);
  return (
    <div className={`insp-verdict ${checks.pass ? "pass" : "fail"}`} role="status">
      <p className="insp-verdict-line">{checks.pass ? VERDICT_LINE.pass : VERDICT_LINE.fail}</p>
      <p className="insp-verdict-detail">{detail}</p>
    </div>
  );
});

const Files = memo(function Files({ delivery, checker }: { delivery: Delivery; checker: CheckerEntry }) {
  return (
    <section className="insp-file card">
      <div className="insp-file-cols">
        <div>
          <h2 className="insp-h">
            The delivered file <span className="mono muted">{delivery.fileName}</span>
          </h2>
          <pre tabIndex={0} aria-label={`Contents of ${delivery.fileName}`}>{delivery.text}</pre>
        </div>
        <div>
          <h2 className="insp-h">
            The job spec <span className="mono muted">{checker.specFileName}</span>
          </h2>
          <pre tabIndex={0} aria-label={`Contents of ${checker.specFileName}`}>{checker.specText}</pre>
        </div>
      </div>
    </section>
  );
});

const Measured = memo(function Measured({ checker, measured }: { checker: CheckerEntry; measured: Readonly<Record<string, number | string>> }) {
  const entries = Object.entries(measured);
  if (entries.length === 0) return null;
  return (
    <details className="insp-measured">
      <summary>Show measurements</summary>
      <dl>
        {entries.map(([key, raw]) => {
          const { label, value, unit } = formatMeasured(key, raw, checker.measured[key]);
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd className="mono">
                {value}
                {unit && <span className="muted"> {unit}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
});
