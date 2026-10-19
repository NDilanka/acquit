import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AgStudioAiModule,
  AgStudioModuleRegistry,
  createStudioTheme,
  type AgDataSourcesDefinition,
  type AgPanelConfig,
  type AgReportState,
  type AgStudioApi,
  type AgWidgetsConfig,
} from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { api, ApiError } from "../api";
import type { PlatformJobLedger, PlatformTables } from "../api-types";
import { errorText } from "../demo";
import { Link } from "../router";
import { useSession } from "../session";
import { ASK_TOOL_DISPLAY_CARDS, AskLedgerDrawer, useAskLedger, type AskLedger } from "./AskLedger";
import { escrowData, STUDIO_EARNINGS_DATA } from "../studio-source";
import {
  EarningsContext,
  EscrowContext,
  ReconcileContext,
  PAGE_LAYOUT,
  WIDGETS,
  freshState,
  stacked,
  type AcquitRegistry,
  type DashboardId,
  type DashboardState,
  type EarningsData,
  type ReconcileView,
} from "./dashboards";
import { parseSaved } from "../studio-data";
import {
  BOOK_EMPTY,
  bookRead,
  FALLBACK_POLL_MS,
  freshnessNotice,
  isStale,
  onChange,
  onSettled,
  parseStreamEvent,
  PLATFORM_STREAM_PATH,
  readFailure,
  READ_IDLE,
  READ_TIMEOUT_MS,
  type Book,
  type FreshnessNotice,
  type ReadState,
  type Transport,
} from "./live";
import "./studio.css";

// The ESM entry registers only the data-engine module. The AI module brings the context service
// whose widget catalogue and schema the dashboard's agents read.
AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

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

/** The escrow dashboard's book: the ledger the custom widgets total, and the tables the native widgets query. */
type EscrowBook = { readonly jobs: readonly PlatformJobLedger[]; readonly tables: PlatformTables };

// Module-level sources keep their identity across renders, so Studio only rebuilds when the data does.
const escrowSource = (book: EscrowBook) => escrowData(book.tables);
const earningsSource = () => STUDIO_EARNINGS_DATA;
// PayPal's read is separate from the ledger's: a slow or failed PayPal read never holds the ledger back, and the card says so.
const readReconciliation = (): Promise<ReconcileView> => api.platformReconciliation().catch((): ReconcileView => "UNAVAILABLE");
// PayPal settles a line with no write to the local database, so the stream never announces it: the card reads again on its own.
const RECONCILE_REFRESH_MS = 3 * 60 * 1000;

function EscrowDashboard() {
  const ask = useAskLedger("escrow");
  const [ledger, setLedger] = useState<Load<EscrowBook> | { kind: "denied" }>({ kind: "loading" });
  const [reconciliation, setReconciliation] = useState<ReconcileView>("READING");
  const [transport, setTransport] = useState<Transport>("live");
  const [book, setBook] = useState<Book>(BOOK_EMPTY);
  useEffect(() => {
    let live = true;
    // Reads can overlap (a ledger change during a slow PayPal read), so only the newest answer reaches the card.
    let cardRead = 0;
    const readCard = () => {
      const mine = ++cardRead;
      readReconciliation().then((view) => {
        if (live && mine === cardRead) setReconciliation(view);
      });
    };
    let reads: ReadState = READ_IDLE;
    let figures: Book = BOOK_EMPTY;
    let fallback: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setInterval> | undefined;
    const source = new EventSource(PLATFORM_STREAM_PATH);
    // Only the PayPal card re-reads here, and only while the page is on screen: the ledger still waits for the stream.
    const reconcileTimer = setInterval(() => {
      if (document.visibilityState === "visible") readCard();
    }, RECONCILE_REFRESH_MS);
    const stop = () => {
      source.close();
      clearInterval(fallback);
      clearInterval(retry);
      clearInterval(reconcileTimer);
      window.removeEventListener("focus", refresh);
    };
    // A stale book retries on the fallback interval until a read lands. A poll already retries, so it needs no second timer.
    function retryWhileStale() {
      if (retry === undefined && fallback === undefined) retry = setInterval(refresh, FALLBACK_POLL_MS);
    }
    function clearRetry() {
      clearInterval(retry);
      retry = undefined;
    }
    // A change, a reconnect, or a focus asks for a read; reads run one at a time (see studio/live.ts).
    function refresh() {
      const step = onChange(reads);
      reads = step.state;
      if (step.read) load();
    }
    function settle() {
      const step = onSettled(reads);
      reads = step.state;
      if (step.read) load();
    }
    function load() {
      readCard();
      const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
      Promise.all([api.platformLedger({ signal }), api.platformTables({ signal })]).then(
        ([r, t]) => {
          if (!live) return;
          setLedger({ kind: "ready", data: { jobs: r.jobs, tables: t.tables } });
          figures = bookRead(figures, { ok: true }, new Date().toISOString());
          setBook(figures);
          clearRetry();
          settle();
        },
        (e: unknown) => {
          if (!live) return;
          if (e instanceof ApiError && e.status === 403) {
            stop();
            setLedger({ kind: "denied" });
            return;
          }
          // A failed refresh keeps the last good book on screen; only a first load shows the error.
          const reason = readFailure(e);
          setLedger((prev) => (prev.kind === "ready" ? prev : { kind: "failed", error: `The escrow figures could not be loaded because ${reason}.` }));
          figures = bookRead(figures, { ok: false, error: reason }, new Date().toISOString());
          setBook(figures);
          if (isStale(figures)) retryWhileStale();
          settle();
        },
      );
    }
    // The open is a read too: a commit made before the stream first watched would otherwise go unseen.
    source.onopen = () => {
      setTransport("live");
      refresh();
    };
    source.onmessage = (message) => {
      if (parseStreamEvent(String(message.data)) !== null) refresh();
    };
    source.onerror = () => {
      if (!live) return;
      if (source.readyState === EventSource.CONNECTING) {
        setTransport("reconnecting");
        return;
      }
      // The browser retries a dropped stream by itself; only one it has given up on (CLOSED) falls back to a plain poll.
      if (source.readyState !== EventSource.CLOSED || fallback !== undefined) return;
      setTransport("polling");
      clearRetry();
      fallback = setInterval(refresh, FALLBACK_POLL_MS);
      refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
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
  const lead =
    transport === "live"
      ? "Every job's money across all tenants, updated as PayPal and the ledger change."
      : transport === "reconnecting"
        ? "Every job's money across all tenants. Reconnecting to live updates."
        : "Live updates off: every job's money across all tenants, refreshed every 30 seconds.";
  return (
    <Dashboard
      id="escrow"
      title="Platform escrow"
      lead={lead}
      notice={freshnessNotice(transport, book)}
      load={ledger}
      ask={ask}
      source={escrowSource}
    >
      {(book, studio) => (
        <EscrowContext.Provider value={book.jobs}>
          <ReconcileContext.Provider value={reconciliation}>{studio}</ReconcileContext.Provider>
        </EscrowContext.Provider>
      )}
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
    <Dashboard
      id="earnings"
      title="Operator earnings"
      lead="What your verified jobs paid you, and the receipt for the newest one."
      load={data}
      source={earningsSource}
    >
      {(earnings, studio) => <EarningsContext.Provider value={earnings}>{studio}</EarningsContext.Provider>}
    </Dashboard>
  );
}

function Dashboard<T>({
  id,
  title,
  lead,
  notice,
  load,
  ask,
  source,
  children,
}: {
  id: DashboardId;
  title: string;
  lead: string;
  notice?: FreshnessNotice | null;
  load: Load<T>;
  ask?: AskLedger;
  source: (data: T) => AgDataSourcesDefinition<AcquitRegistry>;
  children: (data: T, studio: ReactNode) => ReactNode;
}) {
  const layout = useSavedLayout(id);
  const narrow = useMedia(NARROW);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const studioData = useMemo(() => (load.kind === "ready" ? source(load.data) : null), [load, source]);
  return (
    <div className="studio-page">
      <div className="head">
        <div>
          <div className="eyebrow">Dashboards</div>
          <h1>{title}</h1>
          <p className="muted">{lead}</p>
        </div>
        <div className="head-actions">
          {ask && (
            <button
              className={`btn sm ${asking ? "green" : "ghost"}`}
              aria-expanded={asking}
              aria-controls={ASK_PANEL_ID}
              onClick={() => setAsking((on) => !on)}
            >
              Ask the ledger
            </button>
          )}
          {!narrow && layout.save && (
            <button className={`btn sm ${editing ? "green" : "ghost"}`} aria-pressed={editing} onClick={() => setEditing((on) => !on)}>
              {editing ? "Done arranging" : "Arrange layout"}
            </button>
          )}
        </div>
      </div>
      {notice && (
        <div className={`alert ${notice.tone}`} role="status">
          {notice.text}
        </div>
      )}
      {load.kind === "failed" && <div className="alert">{load.error}</div>}
      {layout.loadError && <div className="alert warn">{layout.loadError}</div>}
      {layout.saveError && (
        <div className="alert warn">
          Your layout change was not saved because {layout.saveError}. Arrange it again when the dashboard is back.
        </div>
      )}
      {ask && <AskLedgerDrawer id={ASK_PANEL_ID} ask={ask} open={asking} onClose={() => setAsking(false)} />}
      {load.kind === "loading" || !layout.loaded ? (
        <p className="muted">Loading the dashboard…</p>
      ) : (
        load.kind === "ready" &&
        studioData !== null &&
        children(
          load.data,
          <AcquitStudio
            narrow={narrow}
            state={narrow ? stacked(layout.latest.current) : layout.latest.current}
            mode={editing && !narrow ? "edit" : "view"}
            onState={narrow ? undefined : layout.save}
            data={studioData}
            widgets={WIDGETS[id]}
            ask={ask}
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
        latest.current = parseSaved(r.state, id) ?? freshState(id);
        setStatus({ kind: "ready" });
      },
      (e: unknown) => live && setStatus({ kind: "failed", error: `Your saved layout could not be loaded because ${readFailure(e)}, so this is the default.` }),
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
        (e: unknown) => setSaveError(readFailure(e)),
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
// covers the stacked narrow layout. Declaring any layout drops Studio's defaults for both modes, so
// edit mode shows only what is declared: the chat panel, on the dashboard that has an agent.
const STUDIO_PANELS = { view: { left: [], right: [] } };
const STUDIO_PANELS_WITH_AI: AgPanelConfig = { view: { left: [], right: [] }, edit: { right: ["ai"] } };
const ASK_PANEL_ID = "ask-ledger-panel";

function AcquitStudio({
  state,
  narrow,
  mode,
  onState,
  data,
  widgets,
  ask,
}: {
  state: DashboardState;
  narrow: boolean;
  mode: "view" | "edit";
  onState: ((state: DashboardState) => void) | undefined;
  data: AgDataSourcesDefinition<AcquitRegistry>;
  widgets: AgWidgetsConfig<AcquitRegistry>;
  ask: AskLedger | undefined;
}) {
  const theme = useMemo(acquitStudioTheme, []);
  // Studio may keep the first handler it is given, so it calls through a ref to the current one.
  const handler = useRef(onState);
  handler.current = onState;
  const onStateUpdated = useCallback((event: { state: AgReportState }) => handler.current?.(event.state as unknown as DashboardState), []);
  // Studio reads initialState once, so the narrow/wide switch sets the arrangement on the mounted instance: a
  // remount would also drop the ask harness, which belongs to one Studio API (AskLedger.tsx).
  const [studio, setStudio] = useState<AgStudioApi | null>(null);
  const shown = useRef(narrow);
  const wanted = useRef(state);
  wanted.current = state;
  useEffect(() => {
    if (studio === null || shown.current === narrow) return;
    shown.current = narrow;
    studio.setState(wanted.current as unknown as AgReportState);
  }, [studio, narrow]);
  const readyHandler = useRef(ask?.onApiReady);
  readyHandler.current = ask?.onApiReady;
  const onApiReady = useCallback((event: { api: AgStudioApi }) => {
    setStudio(event.api);
    readyHandler.current?.(event);
  }, []);
  return (
    <AgStudioProvider licenseKey={import.meta.env.VITE_AG_STUDIO_LICENSE_KEY as string}>
      <AgStudio<AcquitRegistry>
        className="studio-host"
        initialState={state}
        mode={mode}
        theme={theme}
        layout={PAGE_LAYOUT}
        widgets={widgets}
        data={data}
        panels={ask ? STUDIO_PANELS_WITH_AI : STUDIO_PANELS}
        ai={ask?.setup}
        aiToolDisplay={ask ? ASK_TOOL_DISPLAY_CARDS : undefined}
        onApiReady={onApiReady}
        onStateUpdated={onStateUpdated}
      />
    </AgStudioProvider>
  );
}
