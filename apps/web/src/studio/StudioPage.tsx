import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AgStudioAiModule,
  AgStudioModuleRegistry,
  studioTheme,
  type AgDataSourcesDefinition,
  type AgReportState,
  type AgStudioApi,
  type AgStudioLocaleText,
  type AgWidgetsConfig,
} from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { api, ApiError } from "../api";
import type { PlatformJobLedger, PlatformTables } from "../api-types";
import { Link } from "../router";
import { useSession } from "../session";
import { ASK_TOOL_DISPLAY_CARDS, useAskLedger, type AskLedger } from "./AskLedger";
import { escrowData, STUDIO_EARNINGS_DATA } from "../studio-source";
import { ASK_AGENT_NAME } from "../ask-ledger";
import { EMPTY_STORY_TEXT, RECEIPT_WIDGET_ID, escrowStoryShown, receiptWidgetShown, studioPanels, withWidgetsFrom, withoutWidgets } from "../studio-story";
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
import { parseSaved, savedLayoutJson } from "../studio-data";
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
  canRetry,
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
const readReconciliation = (): Promise<ReconcileView> =>
  api.platformReconciliation({ signal: AbortSignal.timeout(READ_TIMEOUT_MS) }).catch((): ReconcileView => "UNAVAILABLE");
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
          figures = bookRead(figures, { ok: false, error: reason, retry: canRetry(e) }, new Date().toISOString());
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
  // No job on the book yet: the story frames the money tiles, which stay on the page.
  const emptyBook = ledger.kind === "ready" && escrowStoryShown(ledger.data.jobs);
  return (
    <Dashboard
      id="escrow"
      title="Platform escrow"
      lead={lead}
      notice={freshnessNotice(transport, book)}
      load={ledger}
      ask={ask}
      story={emptyBook}
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
  const ask = useAskLedger("earnings", "OPERATOR");
  const [data, setData] = useState<Load<EarningsData>>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    Promise.all([api.receipts(), api.payouts()]).then(
      ([r, p]) => live && setData({ kind: "ready", data: { receipts: r.receipts, payouts: p.payouts, handle } }),
      (e: unknown) => live && setData({ kind: "failed", error: `The earnings figures could not be loaded because ${readFailure(e)}.` }),
    );
    return () => {
      live = false;
    };
  }, [handle]);
  // With no receipt the receipt widget is left off the page and the story stands in for it.
  const noReceipts = data.kind === "ready" && !receiptWidgetShown(data.data.receipts);
  return (
    <Dashboard
      id="earnings"
      title="Operator earnings"
      lead="What your verified jobs paid you, and the receipt for the newest one."
      load={data}
      ask={ask}
      story={noReceipts}
      hidden={noReceipts ? [RECEIPT_WIDGET_ID] : []}
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
  story = false,
  hidden = [],
  source,
  children,
}: {
  id: DashboardId;
  title: string;
  lead: string;
  notice?: FreshnessNotice | null;
  load: Load<T>;
  ask?: AskLedger;
  /** The book has nothing on it yet: the story card shows above the canvas. */
  story?: boolean;
  /** Widgets left off the page while the book has nothing for them. They stay in the saved layout. */
  hidden?: readonly string[];
  source: (data: T) => AgDataSourcesDefinition<AcquitRegistry>;
  children: (data: T, studio: ReactNode) => ReactNode;
}) {
  const layout = useSavedLayout(id);
  const narrow = useMedia(NARROW);
  const [editing, setEditing] = useState(false);
  const studioData = useMemo(() => (load.kind === "ready" ? source(load.data) : null), [load, source]);
  const save = layout.save;
  return (
    <div className="studio-page">
      <div className="head">
        <div>
          <div className="eyebrow">Dashboards</div>
          <h1>{title}</h1>
          <p className="muted">{lead}</p>
        </div>
        <div className="head-actions">
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
      {ask?.load.kind === "failed" && <div className="alert">The ledger agent's tools could not be loaded because {ask.load.error}.</div>}
      {ask?.load.kind === "ready" && !ask.load.keyConfigured && (
        <div className="alert warn">The server has no model key configured, so Ask the ledger is off until a key is set.</div>
      )}
      {load.kind === "loading" || !layout.loaded ? (
        <p className="muted">Loading the dashboard…</p>
      ) : (
        load.kind === "ready" &&
        studioData !== null && (
          <>
            {story && <EmptyStory />}
            {children(
              load.data,
              <AcquitStudio
                narrow={narrow}
                state={shownState(narrow ? stacked(layout.latest.current) : layout.latest.current, hidden)}
                mode={editing && !narrow ? "edit" : "view"}
                onState={narrow || save === undefined ? undefined : (state) => save(withHidden(state, layout.latest.current, hidden))}
                data={studioData}
                widgets={WIDGETS[id]}
                ask={ask}
              />,
            )}
          </>
        )
      )}
    </div>
  );
}

/** The arrangement with the hidden widgets left off the page. */
const shownState = (state: DashboardState, hidden: readonly string[]) => (hidden.length > 0 ? withoutWidgets(state, hidden) : state);

/** Studio's state put back together with the hidden widgets, so saving the page never drops them. */
const withHidden = (state: DashboardState, full: DashboardState, hidden: readonly string[]) =>
  hidden.length > 0 ? withWidgetsFrom(state, full, hidden) : state;

/**
 * The book with nothing on it yet: one line and how its money arrives, above the tiles it frames. It has no link to /demo:
 * for a signed-in viewer that route does not reach the scenarios, so the line says how the data appears instead.
 */
function EmptyStory() {
  return (
    <section className="card pad empty-story" aria-label="Empty book">
      <h2>{EMPTY_STORY_TEXT}</h2>
      <p className="muted">Jobs appear here once a client funds one. Money shows on this page as each job settles on the PayPal sandbox.</p>
    </section>
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
      api.saveStudioLayout(id, savedLayoutJson(state, id)).then(
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
  // Starts from Studio's own theme: its icon sets are parts of that theme, and createStudioTheme() leaves them out, so the icons draw blank.
  return studioTheme.withParams({
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

// The AI panel's tab is titled from Studio's locale text; this makes it name the agent it is.
const STUDIO_LOCALE_TEXT: AgStudioLocaleText = { panelTitleAi: ASK_AGENT_NAME };

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
  const onApiReady = useCallback((event: { api: AgStudioApi }) => setStudio(event.api), []);
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
        panels={studioPanels(ask !== undefined, narrow)}
        localeText={STUDIO_LOCALE_TEXT}
        ai={ask?.setup}
        aiToolDisplay={ask ? ASK_TOOL_DISPLAY_CARDS : undefined}
        onApiReady={onApiReady}
        onStateUpdated={onStateUpdated}
      />
    </AgStudioProvider>
  );
}
