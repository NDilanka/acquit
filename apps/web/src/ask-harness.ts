import {
  createAiHarness,
  directLlmRunner,
  type AgAiChatSession,
  type AgAiHarness,
  type AgAiRunOutcome,
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

const widgetCatalogue = (api: AgStudioApi) =>
  api.getAiContext().catalogue().map((entry) => ({ type: entry.type, description: entry.description }));

const NEW_WIDGET_WORKFLOW = `## New widgets on this dashboard
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
        instructions: (ctx, params) => `${builtIn.widget.instructions?.(ctx, params) ?? ""}\n\n${NEW_WIDGET_WORKFLOW}`,
        tools: (ctx, params) => [...(builtIn.widget.tools?.(ctx, params) ?? []), ctx.studio.addWidget()],
        // Studio types the widget delegation's widgetType against the widget catalogue of the api it
        // runs on, and that catalogue reads empty on the harness's api, which left the delegate tool
        // unadvertised and its calls rejected with "Expected one of: ". Plain strings keep the branch
        // resolvable; the widget agent's own tools take the type and widget ids as strings anyway.
        schema: (s) =>
          s.object({ widgetType: s.string(), widgetId: s.string(), pageId: s.string().optional() }),
      }),
    ],
    primary: ASK_AGENT_ID,
    promptStarters: ASK_PROMPT_STARTERS,
    observers: [observer],
  }));
}

// Studio's harness opens only threads it already holds, so the drawer's conversation is created
// once per harness and reopened from then on; the promise is kept so two opens share one thread.
const askThreads = new WeakMap<AgAiHarness, Promise<AgAiChatSession>>();

export function openAskThread(harness: AgAiHarness): Promise<AgAiChatSession> {
  let session = askThreads.get(harness);
  if (!session) {
    session = harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
    askThreads.set(harness, session);
  }
  return session;
}
