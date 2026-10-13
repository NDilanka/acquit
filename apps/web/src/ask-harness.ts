import { createAiHarness, directLlmRunner, type AgAiChatSession, type AgAiHarness, type AgAiTool, type AgStudioApi } from "ag-studio";
import type { AskToolSchema } from "./api-types";
import {
  ASK_AGENT_ID,
  ASK_AGENT_NAME,
  ASK_INSTRUCTIONS,
  ASK_MAX_TURNS,
  ASK_PROMPT_STARTERS,
  askLedgerAdapter,
  buildAskTools,
  type AskAdapterDeps,
} from "./ask-ledger.ts";

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
  return createAiHarness(studio, ({ builtIn }) => ({
    agents: [
      directLlmRunner({
        id: ASK_AGENT_ID,
        name: ASK_AGENT_NAME,
        description: "Answers questions about Acquit's escrow ledger and PayPal's view of it, from read-only tools.",
        instructions: () => ASK_INSTRUCTIONS,
        maxTurns: ASK_MAX_TURNS,
        tools: (ctx) => [...ledgerTools(ctx.api), ctx.tools.delegateTo(["widget"])],
        adapter,
      }),
      directLlmRunner({
        ...builtIn.widget,
        adapter,
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
