import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createStudioTheme, type AgDataSourcesDefinition, type AgReportState } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { api, ApiError } from "../api";
import type { PlatformJobLedger } from "../api-types";
import { errorText } from "../demo";
import { Link } from "../router";
import { useSession } from "../session";
import { STUDIO_EARNINGS_DATA, STUDIO_ESCROW_DATA } from "../studio-source";
import {
  EarningsContext,
  EscrowContext,
  PAGE_LAYOUT,
  WIDGETS,
  freshState,
  parseSaved,
  stacked,
  type AcquitRegistry,
  type DashboardId,
  type DashboardState,
  type EarningsData,
} from "./dashboards";
import "./studio.css";

const ESCROW_REFRESH_MS = 30_000;
const SAVE_DEBOUNCE_MS = 300;
const NARROW = "(max-width: 640px)";

export default function StudioPage() {
  const { user } = useSession();
  switch (user.role) {
    case "PLATFORM":
      return <EscrowDashboard />;
    case "OPERATOR":
      return <EarningsDashboard handle={user.handle} />;
    case "CLIENT":
      return (
        <Notice title="Dashboards are for the platform and operator roles">
          A client's jobs and payments are on the jobs page. <Link to="/">Back to your jobs</Link>
        </Notice>
      );
  }
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card pad">
      <h2>{title}</h2>
      <p className="muted">{children}</p>
    </div>
  );
}

type Load<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "failed"; error: string };

function EscrowDashboard() {
  const [ledger, setLedger] = useState<Load<readonly PlatformJobLedger[]> | { kind: "denied" }>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
    function load() {
      api.platformLedger().then(
        (r) => live && setLedger({ kind: "ready", data: r.jobs }),
        (e: unknown) => {
          if (!live) return;
          if (e instanceof ApiError && e.status === 403) {
            stop();
            setLedger({ kind: "denied" });
            return;
          }
          // A failed refresh keeps the last good book on screen; only a first load shows the error.
          setLedger((prev) => (prev.kind === "ready" ? prev : { kind: "failed", error: errorText(e) }));
        },
      );
    }
    load();
    timer = setInterval(load, ESCROW_REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      stop();
    };
  }, []);

  if (ledger.kind === "denied") {
    return (
      <Notice title="The platform dashboards need the platform role">
        This session cannot read the platform ledger. <Link to="/">Back to the dashboard</Link>
      </Notice>
    );
  }
  return (
    <Dashboard id="escrow" title="Platform escrow" lead="Every job's money across all tenants, refreshed every 30 seconds." load={ledger}>
      {(jobs, studio) => <EscrowContext.Provider value={jobs}>{studio}</EscrowContext.Provider>}
    </Dashboard>
  );
}

function EarningsDashboard({ handle }: { handle: string }) {
  const [data, setData] = useState<Load<EarningsData>>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    Promise.all([api.receipts(), api.payouts()]).then(
      ([r, p]) => live && setData({ kind: "ready", data: { receipts: r.receipts, payouts: p.payouts, handle } }),
      (e: unknown) => live && setData({ kind: "failed", error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [handle]);
  return (
    <Dashboard id="earnings" title="Operator earnings" lead="What your verified jobs paid you, and the receipt for the newest one." load={data}>
      {(earnings, studio) => <EarningsContext.Provider value={earnings}>{studio}</EarningsContext.Provider>}
    </Dashboard>
  );
}

function Dashboard<T>({
  id,
  title,
  lead,
  load,
  children,
}: {
  id: DashboardId;
  title: string;
  lead: string;
  load: Load<T>;
  children: (data: T, studio: ReactNode) => ReactNode;
}) {
  const layout = useSavedLayout(id);
  const narrow = useMedia(NARROW);
  const [editing, setEditing] = useState(false);
  return (
    <div className="studio-page">
      <div className="head">
        <div>
          <div className="eyebrow">Dashboards</div>
          <h1>{title}</h1>
          <p className="muted">{lead}</p>
        </div>
        {!narrow && layout.save && (
          <button className={`btn sm ${editing ? "green" : "ghost"}`} aria-pressed={editing} onClick={() => setEditing((on) => !on)}>
            {editing ? "Done arranging" : "Arrange layout"}
          </button>
        )}
      </div>
      {load.kind === "failed" && <div className="alert">{load.error}</div>}
      {layout.loadError && <div className="alert warn">{layout.loadError}</div>}
      {layout.saveError && <div className="alert warn">Your layout change was not saved: {layout.saveError}</div>}
      {load.kind === "loading" || !layout.loaded ? (
        <p className="muted">Loading the dashboard…</p>
      ) : (
        load.kind === "ready" &&
        children(
          load.data,
          <AcquitStudio
            // Studio reads initialState once, so a narrow/wide switch remounts it with the matching arrangement.
            key={narrow ? "narrow" : "wide"}
            state={narrow ? stacked(layout.latest.current) : layout.latest.current}
            mode={editing && !narrow ? "edit" : "view"}
            onState={narrow ? undefined : layout.save}
            data={id === "escrow" ? STUDIO_ESCROW_DATA : STUDIO_EARNINGS_DATA}
          />,
        )
      )}
    </div>
  );
}


/**
 * The user's own arrangement from the server. A failed read shows the fresh layout and does not save
 * over it, so a stored arrangement the page could not read is never replaced by the default.
 */
function useSavedLayout(id: DashboardId) {
  const latest = useRef<DashboardState>(freshState(id));
  const [status, setStatus] = useState<{ kind: "loading" } | { kind: "ready" } | { kind: "failed"; error: string }>({ kind: "loading" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; state: DashboardState } | null>(null);

  useEffect(() => {
    let live = true;
    api.loadStudioLayout(id).then(
      (r) => {
        if (!live) return;
        latest.current = parseSaved(r.state) ?? freshState(id);
        setStatus({ kind: "ready" });
      },
      (e: unknown) => live && setStatus({ kind: "failed", error: `Your saved layout could not be loaded, so this is the default: ${errorText(e)}` }),
    );
    return () => {
      live = false;
    };
  }, [id]);

  const flush = useCallback(
    (state: DashboardState) => {
      pending.current = null;
      api.saveStudioLayout(id, JSON.stringify(state)).then(
        () => setSaveError(null),
        (e: unknown) => setSaveError(errorText(e)),
      );
    },
    [id],
  );

  const save = useCallback(
    (state: DashboardState) => {
      latest.current = state;
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = { state, timer: setTimeout(() => flush(state), SAVE_DEBOUNCE_MS) };
    },
    [flush],
  );

  useEffect(
    () => () => {
      const waiting = pending.current;
      if (!waiting) return;
      clearTimeout(waiting.timer);
      flush(waiting.state);
    },
    [flush],
  );

  return {
    loaded: status.kind !== "loading",
    loadError: status.kind === "failed" ? status.error : null,
    latest,
    save: status.kind === "ready" ? save : undefined,
    saveError,
  };
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Studio's theme params are read from the app's custom properties at mount, so its computed font and
 * accent are the app's own values rather than a second copy of the palette.
 */
function acquitStudioTheme() {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const sans = token("--sans");
  const green = token("--green");
  return createStudioTheme().withParams({
    fontFamily: sans,
    accentColor: green,
    textColor: token("--ink"),
    borderColor: token("--line"),
    backgroundColor: token("--card"),
    studioCanvasFontFamily: sans,
    studioWidgetTitleFontFamily: sans,
    studioWidgetSubtitleFontFamily: sans,
    studioWidgetCaptionFontFamily: sans,
    studioPanelHeaderFontFamily: sans,
    studioToggleButtonActiveBackgroundColor: green,
    studioToggleButtonActiveBorderColor: green,
    studioToggleButtonActiveColor: green,
    studioCanvasBackgroundColor: token("--paper"),
    studioMinWidth: 0,
    studioCanvasMinWidth: PAGE_LAYOUT.minWidth ?? 300,
  });
}

// The dashboards are read-only in view mode, so the studio's filter panel is only noise there and
// covers the stacked narrow layout. Edit mode keeps its default panels.
const STUDIO_PANELS = { view: { left: [], right: [] } };

function AcquitStudio({
  state,
  mode,
  onState,
  data,
}: {
  state: DashboardState;
  mode: "view" | "edit";
  onState: ((state: DashboardState) => void) | undefined;
  data: AgDataSourcesDefinition<AcquitRegistry>;
}) {
  const theme = useMemo(acquitStudioTheme, []);
  // Studio may keep the first handler it is given, so it calls through a ref to the current one.
  const handler = useRef(onState);
  handler.current = onState;
  const onStateUpdated = useCallback((event: { state: AgReportState }) => handler.current?.(event.state as unknown as DashboardState), []);
  return (
    <AgStudioProvider licenseKey={import.meta.env.VITE_AG_STUDIO_LICENSE_KEY as string}>
      <AgStudio<AcquitRegistry>
        className="studio-host"
        initialState={state}
        mode={mode}
        theme={theme}
        layout={PAGE_LAYOUT}
        widgets={WIDGETS}
        data={data}
        panels={STUDIO_PANELS}
        onStateUpdated={onStateUpdated}
      />
    </AgStudioProvider>
  );
}
