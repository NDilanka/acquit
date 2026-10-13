import {
  createAiHarness,
  directLlmRunner,
  type AgAiChatSession,
  type AgAiHarness,
  type AgAiHistoryStore,
  type AgAiHistoryStoreEventListener,
  type AgAiRunOutcome,
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
  askInstructions,
  askLedgerAdapter,
  buildAskTools,
  type AskAdapterDeps,
} from "./ask-ledger.ts";
import { WIDGET_IDS, type DashboardId } from "./dashboard-widgets.ts";

const widgetCatalogue = (api: AgStudioApi) =>
  api.getAiContext().catalogue().map((entry) => ({ type: entry.type, description: entry.description }));

export const NEW_WIDGET_WORKFLOW = `## New widgets on this dashboard
The widget you were given may not be on the grid yet. If view_widget shows it does not exist, add it yourself:
1. Call add_widget with widgetId set to the task's widgetId, type set to the task's widgetType, and a small free spot on the grid (xTrack, yTrack, xSpan, ySpan).
2. Call configure_widget as usual.
3. Call complete_task saying what you added and configured.
If the widget already exists, configure it instead of adding a copy.`;

/** Records how each delegated child run ended, keyed by the parent's delegate_to call id. */
function delegateOutcomes(): { outcomes: Map<string, AgAiRunOutcome>; observer: AgAiTelemetryObserver } {
  const outcomes = new Map<string, AgAiRunOutcome>();
  return {
    outcomes,
    observer: {
      onEvent(event) {
        const parent = event.trace.parentToolCallId;
        if (event.type === "run_finished" && parent !== undefined) outcomes.set(parent, event.status);
      },
    },
  };
}

/**
 * Studio's delegate tool reports success whenever the child returns, even when it errored. This
 * passes a result through only when the child's run also finished 'ok'. A child that throws while
 * resolving its tools ends before any telemetry, so a missing outcome counts as a failure too.
 */
function honestDelegate(inner: AgAiTool, outcomes: ReadonlyMap<string, AgAiRunOutcome>): AgAiTool {
  return {
    ...inner,
    execute: async (call, ctx) => {
      const result = (await inner.execute?.(call, ctx)) ?? { success: false, issues: [] };
      if (result.success && outcomes.get(call.toolCallId) === "ok") return result;
      const detail = result.success ? result.response : result.issues.map((issue) => issue.message).join("; ");
      return { success: false, issues: [{ message: `The widget delegate did not complete${detail ? `: ${detail}` : "."}` }] };
    },
  };
}

/**
 * Studio's add_widget accepts any type in the api's catalogue, which can list another dashboard's
 * widgets. This refuses a type that is not on this dashboard, and refuses every type when the
 * dashboard is unknown.
 */
function dashboardAdd(inner: AgAiTool, dashboard: DashboardId | undefined): AgAiTool {
  const allowed: readonly string[] = dashboard ? WIDGET_IDS[dashboard] : [];
  return {
    ...inner,
    execute: async (call, ctx) => {
      const type = call.args.type;
      if (typeof type === "string" && allowed.includes(type)) {
        return (await inner.execute?.(call, ctx)) ?? { success: false, issues: [] };
      }
      return {
        success: false,
        issues: [{ message: `Widget type ${JSON.stringify(type)} is not on this dashboard. Its widget types are: ${allowed.join(", ") || "none"}.` }],
      };
    },
  };
}

/**
 * The dashboard's harness: the ledger agent fronting the conversation, and Studio's widget agent as
 * its delegate. Both run on the one adapter, so every model turn goes through the app's own route.
 */
export function createAskLedgerHarness(
  studio: AgStudioApi,
  served: () => readonly AskToolSchema[],
  deps?: AskAdapterDeps,
): AgAiHarness {
  const adapter = askLedgerAdapter(deps);
  // The agent's tools are re-resolved every turn; they are rebuilt only when the served list changes.
  let built: { specs: readonly AskToolSchema[]; tools: AgAiTool[] } | null = null;
  const ledgerTools = (api: AgStudioApi) => {
    const specs = served();
    if (built?.specs !== specs) built = { specs, tools: buildAskTools(api, specs) };
    return built.tools;
  };
  const { outcomes, observer } = delegateOutcomes();
  return createAiHarness(studio, ({ builtIn }) => ({
    agents: [
      directLlmRunner({
        id: ASK_AGENT_ID,
        name: ASK_AGENT_NAME,
        description: "Answers questions about Acquit's escrow ledger and PayPal's view of it, from read-only tools.",
        instructions: (ctx) => askInstructions(widgetCatalogue(ctx.api)),
        maxTurns: ASK_MAX_TURNS,
        tools: (ctx) => [...ledgerTools(ctx.api), honestDelegate(ctx.tools.delegateTo(["widget"]), outcomes)],
        adapter,
      }),
      directLlmRunner({
        ...builtIn.widget,
        adapter,
        instructions: (ctx, params) => `${NEW_WIDGET_WORKFLOW}\n\n${builtIn.widget.instructions?.(ctx, params) ?? ""}`,
        tools: (ctx, params) => [...(builtIn.widget.tools?.(ctx, params) ?? []), dashboardAdd(ctx.studio.addWidget(), deps?.dashboard)],
        // Studio types the widget delegation's widgetType against the api's widget catalogue. With the
        // AI module registered that catalogue is populated from the widgets' `ai` metadata. The plain
        // strings stay so the delegate branch remains resolvable when the catalogue reads empty (the
        // AI module not registered, for example) instead of the delegate tool being silently dropped.
        // The widget agent's own tools take the type and widget ids as strings anyway.
        schema: (s) =>
          s.object({ widgetType: s.string(), widgetId: s.string(), pageId: s.string().optional() }),
      }),
    ],
    primary: ASK_AGENT_ID,
    promptStarters: ASK_PROMPT_STARTERS,
    observers: [observer],
    history: askHistory,
  }));
}

/**
 * Every harness this module builds shares one in-memory store, so a harness rebuilt on a narrow/wide
 * crossing finds the conversation the previous one saved. Nothing else writes to it in a single-tab
 * dashboard, so its "changed" listeners are held for the harness but never fired.
 */
function memoryHistoryStore(): AgAiHistoryStore {
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
