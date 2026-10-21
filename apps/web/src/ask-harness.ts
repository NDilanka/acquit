import {
  createAiHarness,
  directLlmRunner,
  type AgAiChatSession,
  type AgAiHarness,
  type AgAiHistoryStore,
  type AgAiHistoryStoreEventListener,
  type AgAiRunOutcome,
  type AgAiStudioTools,
  type AgAiThread,
  type AgAiTelemetryObserver,
  type AgAiTool,
  type AgStudioApi,
} from "ag-studio";
import type { AskToolSchema } from "./api-types";
import {
  ASK_AGENT_ID,
  ASK_AGENT_NAME,
  ASK_MAX_TURNS,
  ASK_PROMPT_STARTERS,
  OPERATOR_ASK_INSTRUCTIONS,
  OPERATOR_ASK_PROMPT_STARTERS,
  askInstructions,
  askLedgerAdapter,
  buildAskTools,
  type AskAdapterDeps,
  type AskScope,
} from "./ask-ledger.ts";
import { COLUMNS, NATIVE_TYPES, WIDGET_IDS, WIDGET_SPANS, type DashboardId, type DashboardState } from "./dashboard-widgets.ts";
import { firstFreeTrack, placementFits, selectedPage, widgetPlaced, type Track } from "./studio-data.ts";
import { changeLogFor } from "./change-chain.ts";

// The api is typed against Studio's default widget registry; the state it holds is this app's.
const dashboardState = (api: AgStudioApi) => api.getState() as unknown as DashboardState;

const widgetCatalogue = (api: AgStudioApi) =>
  api.getAiContext().catalogue().map((entry) => ({ type: entry.type, description: entry.description }));

export const NEW_WIDGET_WORKFLOW = `## New widgets on this dashboard
The widget you were given may not be on the grid yet. If view_widget shows it does not exist, add it yourself:
1. Call add_widget with widgetId set to the task's widgetId, type set to the task's widgetType, and a small free spot on the grid (xTrack, yTrack, xSpan, ySpan).
2. Call configure_widget as usual.
3. Call complete_task saying what you added and configured.
If the widget already exists, configure it instead of adding a copy.`;

/**
 * Records how each delegated child run ended, and the child's last failed tool call, both keyed by
 * the parent's delegate_to call id.
 */
function delegateOutcomes(): {
  outcomes: Map<string, AgAiRunOutcome>;
  failures: Map<string, string>;
  observer: AgAiTelemetryObserver;
} {
  const outcomes = new Map<string, AgAiRunOutcome>();
  const failures = new Map<string, string>();
  return {
    outcomes,
    failures,
    observer: {
      onEvent(event) {
        const parent = event.trace.parentToolCallId;
        if (parent === undefined) return;
        if (event.type === "run_finished") outcomes.set(parent, event.status);
        if (event.type === "tool_execution_finished" && !event.ok) {
          failures.set(parent, `${event.name}: ${(event.issues ?? []).map((issue) => issue.message).join("; ")}`);
        }
      },
    },
  };
}

/** The widget id a delegate_to call hands the widget agent, when it names one. */
function delegatedWidgetId(args: Record<string, unknown>): string | undefined {
  const type = args.type;
  if (typeof type !== "object" || type === null) return undefined;
  const { id, widgetId } = type as { id?: unknown; widgetId?: unknown };
  return id === "widget" && typeof widgetId === "string" ? widgetId : undefined;
}

/** The page a page or widget delegation names, when it names one. */
function delegatedPageId(args: Record<string, unknown>): string | undefined {
  const type = args.type;
  if (typeof type !== "object" || type === null) return undefined;
  const { id, pageId } = type as { id?: unknown; pageId?: unknown };
  return (id === "page" || id === "widget") && typeof pageId === "string" ? pageId : undefined;
}

/**
 * Studio's delegate tool reports success whenever the child returns, even when it errored. This
 * passes a result through only when the child's run also finished 'ok' and the widget it was handed
 * ends with a placement of its own on the grid. A child that throws while resolving its tools ends
 * before any telemetry, so a missing outcome counts as a failure too. A failed child's partly added
 * widget is removed again, so the grid never keeps a half-made widget. The checks and the rollback
 * read the selected page only, so a page or widget delegation that names another page is refused before its child runs.
 */
function honestDelegate(
  inner: AgAiTool,
  runs: { readonly outcomes: ReadonlyMap<string, AgAiRunOutcome>; readonly failures: ReadonlyMap<string, string> },
  api: AgStudioApi,
  studio: AgAiStudioTools,
): AgAiTool {
  const selectedWidgetIds = () => {
    const state = api.getState();
    return Object.keys(state.pages.find((page) => page.id === state.selectedPageId)?.widgets ?? {});
  };
  return {
    ...inner,
    execute: async (call, ctx) => {
      const named = delegatedPageId(call.args);
      if (named !== undefined && named !== api.getState().selectedPageId) {
        return {
          success: false,
          issues: [{ message: `The page ${named} is not the selected page, and changes reach only the selected page. Delegate without a pageId, or select that page first.` }],
        };
      }
      const before = new Set(selectedWidgetIds());
      const result = (await inner.execute?.(call, ctx)) ?? { success: false, issues: [] };
      const ranOk = result.success && runs.outcomes.get(call.toolCallId) === "ok";
      const widgetId = delegatedWidgetId(call.args);
      const unplaced = widgetId !== undefined && !widgetPlaced(dashboardState(api), widgetId);
      if (ranOk && !unplaced) return result;
      const head = unplaced
        ? `The delegated widget ${widgetId} is not on the dashboard's grid with a placement of its own`
        : "The delegate did not complete";
      const detail =
        (ranOk && runs.failures.get(call.toolCallId)) ||
        (result.success ? result.response : result.issues.map((issue) => issue.message).join("; "));
      const added = selectedWidgetIds().filter((id) => !before.has(id));
      const removed: string[] = [];
      const kept: string[] = [];
      const remove = studio.removeWidget?.();
      for (const [index, id] of added.entries()) {
        const undo = await remove?.execute?.(
          { toolCallId: `${call.toolCallId}-rollback-${index}`, name: "remove_widget", args: { widgetId: id } },
          ctx,
        );
        (undo?.success ? removed : kept).push(id);
      }
      const rollback =
        (removed.length ? ` The partially added widget ${removed.join(", ")} was removed again.` : "") +
        (kept.length ? ` The partially added widget ${kept.join(", ")} could not be removed and is still on the dashboard.` : "");
      return {
        success: false,
        issues: [{ message: `${head}${detail ? `: ${detail}` : "."}${rollback}` }],
      };
    },
  };
}

/** How many of the widget type's tiles are on screen with real size right now. */
const countRendered = (type: string): number => {
  // No DOM on this surface (the unit tests run the harness headless): nothing to check, so the
  // state checks carry the truth and the count always satisfies.
  if (typeof document === "undefined") return Number.POSITIVE_INFINITY;
  // The tile markup below is this app's custom widget section. Studio draws its native types itself,
  // so for them the placement in state is the only check.
  if ((Object.values(NATIVE_TYPES).flat() as readonly string[]).includes(type)) return Number.POSITIVE_INFINITY;
  let count = 0;
  for (const tile of document.querySelectorAll(`section.studio-widget[data-widget-type="${type}"]`)) {
    const rect = tile.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) count++;
  }
  return count;
};

const RENDER_POLL_MS = 25;

/** Polls until `ok` holds or the time runs out, with one last look after the deadline. */
async function waitUntil(ok: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  do {
    if (ok()) return true;
    await new Promise((resolve) => setTimeout(resolve, RENDER_POLL_MS));
  } while (Date.now() < deadline);
  return ok();
}

const finiteTrack = (args: Record<string, unknown>): Track | undefined => {
  const { xTrack, yTrack, xSpan, ySpan } = args;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return finite(xTrack) && finite(yTrack) && finite(xSpan) && finite(ySpan) ? { xTrack, yTrack, xSpan, ySpan } : undefined;
};

/**
 * Studio's add_widget accepts any type in the api's catalogue, which can list another dashboard's
 * widgets, and keeps a widget whose placement overlaps another without placing it. This refuses a
 * type that is not on this dashboard (every type when the dashboard is unknown). A requested spot
 * that is missing or overlaps is replaced by the first free one before Studio sees it. The add
 * succeeds only when the widget ends placed in Studio's state and its tile renders; otherwise it is
 * removed again and the failure says so.
 */
function dashboardAdd(
  inner: AgAiTool,
  dashboard: DashboardId | undefined,
  api: AgStudioApi,
  studio: AgAiStudioTools,
  deps?: AskAdapterDeps,
): AgAiTool {
  const allowed: readonly string[] = dashboard ? [...WIDGET_IDS[dashboard], ...NATIVE_TYPES[dashboard]] : [];
  const spans = dashboard ? WIDGET_SPANS[dashboard] : {};
  const count = deps?.renderedCount ?? countRendered;
  return {
    ...inner,
    execute: async (call, ctx) => {
      const { type, widgetId } = call.args;
      if (typeof type !== "string" || !allowed.includes(type)) {
        return {
          success: false,
          issues: [{ message: `Widget type ${JSON.stringify(type)} is not on this dashboard. Its widget types are: ${allowed.join(", ") || "none"}.` }],
        };
      }
      if (typeof widgetId !== "string") {
        return { success: false, issues: [{ message: `Widget id ${JSON.stringify(widgetId)} is not a string.` }] };
      }
      const page = selectedPage(dashboardState(api));
      const columns = page?.layout?.columns ?? COLUMNS;
      const placed = Object.values(page?.widgetLayout ?? {}).filter((t): t is Track => t !== undefined);
      const requested = finiteTrack(call.args);
      const span = {
        xSpan: typeof call.args.xSpan === "number" ? call.args.xSpan : (spans[type]?.xSpan ?? 4),
        ySpan: typeof call.args.ySpan === "number" ? call.args.ySpan : (spans[type]?.ySpan ?? 2),
      };
      const fits = requested !== undefined && placementFits(requested, placed, columns);
      const track = fits ? requested : firstFreeTrack(placed, requested ?? span, columns);
      const before = count(type);
      const result =
        (await inner.execute?.(fits ? call : { ...call, args: { ...call.args, ...track } }, ctx)) ?? { success: false, issues: [] };
      if (!result.success) return result;
      const isPlaced = widgetPlaced(dashboardState(api), widgetId);
      if (isPlaced && (await waitUntil(() => count(type) >= before + 1, deps?.renderWaitMs ?? 2000))) {
        return fits ? result : { ...result, response: `${result.response} (placed at xTrack ${track.xTrack}, yTrack ${track.yTrack})` };
      }
      const undo = await studio.removeWidget?.().execute?.(
        { toolCallId: `${call.toolCallId}-rollback`, name: "remove_widget", args: { widgetId } },
        ctx,
      );
      const ending = undo?.success ? ", so it was removed again." : ", and it could not be removed and is still on the dashboard.";
      const head = isPlaced
        ? `Widget ${widgetId} was placed but its tile never rendered on the dashboard`
        : `Studio kept no placement for widget ${widgetId} on the grid`;
      return { success: false, issues: [{ message: `${head}${ending}` }] };
    },
  };
}

/** The served tool list as the agent's tools: re-resolved every turn, rebuilt only when the served list changes. */
function servedTools(served: () => readonly AskToolSchema[]): (api: AgStudioApi) => AgAiTool[] {
  let built: { specs: readonly AskToolSchema[]; tools: AgAiTool[] } | null = null;
  return (api) => {
    const specs = served();
    if (built?.specs !== specs) built = { specs, tools: buildAskTools(api, specs) };
    return built.tools;
  };
}

/**
 * The dashboard's harness: the ledger agent fronting the conversation, and Studio's widget, data, and
 * page agents as its delegates. All run on the one adapter, so every model turn goes through the app's
 * own route. An operator's harness (scope OPERATOR) is the ledger agent alone; see below.
 */
export function createAskLedgerHarness(
  studio: AgStudioApi,
  served: () => readonly AskToolSchema[],
  deps?: AskAdapterDeps & { readonly scope?: AskScope; readonly history?: AgAiHistoryStore },
): AgAiHarness {
  if (deps?.scope === "OPERATOR") return createOperatorAskLedgerHarness(studio, served, deps);
  const adapter = askLedgerAdapter(deps);
  const ledgerTools = servedTools(served);
  const { outcomes, failures, observer } = delegateOutcomes();
  const changes = changeLogFor(studio, ASK_AGENT_NAME);
  return createAiHarness(studio, ({ builtIn }) => ({
    agents: [
      directLlmRunner({
        id: ASK_AGENT_ID,
        name: ASK_AGENT_NAME,
        description: "Answers questions about Acquit's escrow ledger and PayPal's view of it, from read-only tools.",
        instructions: (ctx) => askInstructions(widgetCatalogue(ctx.api)),
        maxTurns: ASK_MAX_TURNS,
        tools: (ctx) => [...ledgerTools(ctx.api), honestDelegate(ctx.tools.delegateTo(["widget", "data", "page"]), { outcomes, failures }, ctx.api, ctx.studio)],
        adapter,
      }),
      directLlmRunner({
        ...builtIn.widget,
        adapter,
        instructions: (ctx, params) => `${NEW_WIDGET_WORKFLOW}\n\n${builtIn.widget.instructions?.(ctx, params) ?? ""}`,
        tools: (ctx, params) => [...(builtIn.widget.tools?.(ctx, params) ?? []), dashboardAdd(ctx.studio.addWidget(), deps?.dashboard, ctx.api, ctx.studio, deps)],
        // Studio types the widget delegation's widgetType against the api's widget catalogue. With the
        // AI module registered that catalogue is populated from the widgets' `ai` metadata. The plain
        // strings stay so the delegate branch remains resolvable when the catalogue reads empty (the
        // AI module not registered, for example) instead of the delegate tool being silently dropped.
        // The widget agent's own tools take the type and widget ids as strings anyway.
        schema: (s) =>
          s.object({ widgetType: s.string(), widgetId: s.string(), pageId: s.string().optional() }),
      }),
      directLlmRunner({ ...builtIn.data, adapter }),
      directLlmRunner({
        ...builtIn.page,
        adapter,
        // The page agent's add_widget is Studio's own tool, the same one the widget agent gets, so it
        // takes the same dashboard guard and the same rollback.
        tools: (ctx, params) =>
          (builtIn.page.tools?.(ctx, params) ?? []).map((tool) =>
            tool.name === "add_widget" ? dashboardAdd(tool, deps?.dashboard, ctx.api, ctx.studio, deps) : tool,
          ),
      }),
    ],
    primary: ASK_AGENT_ID,
    promptStarters: ASK_PROMPT_STARTERS,
    observers: [observer, changes.observer],
    history: deps?.history ?? askHistory,
  }));
}

/**
 * An operator's harness: the ledger agent alone, with the operator's four reads and no delegation, so no
 * delegate_to rides in a turn (the server would refuse one). The dashboard id is not needed here: it only
 * guards the widget and page agents' add_widget, which this harness does not have.
 */
function createOperatorAskLedgerHarness(
  studio: AgStudioApi,
  served: () => readonly AskToolSchema[],
  deps: AskAdapterDeps & { readonly history?: AgAiHistoryStore },
): AgAiHarness {
  const adapter = askLedgerAdapter(deps);
  const ledgerTools = servedTools(served);
  return createAiHarness(studio, () => ({
    agents: [
      directLlmRunner({
        id: ASK_AGENT_ID,
        name: ASK_AGENT_NAME,
        description: "Answers questions about the signed-in operator's own jobs, payouts, and totals on Acquit, from read-only tools.",
        instructions: () => OPERATOR_ASK_INSTRUCTIONS,
        maxTurns: ASK_MAX_TURNS,
        tools: (ctx) => ledgerTools(ctx.api),
        adapter,
      }),
    ],
    primary: ASK_AGENT_ID,
    promptStarters: OPERATOR_ASK_PROMPT_STARTERS,
    history: deps.history ?? askHistory,
  }));
}

/**
 * A conversation store in memory. The panel's owner (AskLedger's hook) keeps one per dashboard instance,
 * so a harness rebuilt on a narrow/wide crossing finds the conversation the previous one saved, while a
 * sign-out, which keeps this module loaded, does not hand the next session the last one's conversation.
 * Nothing else writes to it in a single-tab dashboard, so its "changed" listeners are held but never fired.
 */
export function memoryHistoryStore(): AgAiHistoryStore {
  const threads = new Map<string, AgAiThread>();
  const listeners = new Set<AgAiHistoryStoreEventListener>();
  return {
    listThreads: async () =>
      [...threads.values()].map((thread) => thread.summary).sort((a, b) => b.updatedAt - a.updatedAt),
    loadThread: async (threadId) => threads.get(threadId),
    saveThread: async (thread) => {
      threads.set(thread.summary.threadId, thread);
    },
    deleteThread: async (threadId) => {
      threads.delete(threadId);
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
}

const askHistory = memoryHistoryStore();

// One user and one dashboard conversation, so the thread to reopen on a new harness is just the last one.
let lastThreadId: string | undefined;

const REOPEN_ATTEMPTS = 5;
const REOPEN_DELAY_MS = 25;

/**
 * A fresh harness starts loading its roster from the history store without awaiting it, while
 * openThread looks the id up in the roster synchronously, so the first open can report "Unknown
 * thread" for a thread that is in the store. A few short retries let the roster load land; a thread
 * still unknown after that is gone, and the drawer starts a new conversation instead.
 */
async function reopenOrCreate(harness: AgAiHarness, threadId: string): Promise<AgAiChatSession> {
  for (let attempt = 1; attempt <= REOPEN_ATTEMPTS; attempt++) {
    try {
      return await harness.openThread(threadId);
    } catch {
      if (attempt < REOPEN_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, REOPEN_DELAY_MS));
    }
  }
  return harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
}

// The promise is kept per harness so two opens share one session.
const askThreads = new WeakMap<AgAiHarness, Promise<AgAiChatSession>>();

export function openAskThread(harness: AgAiHarness): Promise<AgAiChatSession> {
  let session = askThreads.get(harness);
  if (!session) {
    session = (
      lastThreadId === undefined
        ? harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME })
        : reopenOrCreate(harness, lastThreadId)
    ).then((opened) => {
      lastThreadId = opened.threadId;
      return opened;
    });
    askThreads.set(harness, session);
  }
  return session;
}
