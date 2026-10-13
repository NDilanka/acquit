import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgAiChatMessage, AgAiChatSession, AgAiHarness, AgStudioApi } from "ag-studio";
import { ASK_AGENT_ID, ASK_AGENT_NAME, type AskAdapterDeps } from "./ask-ledger.ts";
import { createAskLedgerHarness, NEW_WIDGET_WORKFLOW, openAskThread } from "./ask-harness.ts";
import { WIDGET_IDS, WIDGET_ROWS, type DashboardId, type DashboardState } from "./dashboard-widgets.ts";
import { stacked } from "./studio-data.ts";

// The tests run the real harness over a mock Studio api: a Proxy that answers the SDK's internal
// symbol with test doubles, so no DOM, licence, or live model is involved. Every model turn rides
// the injected fetch, exactly as the app's route would carry it.

type MockCatalogueEntry = { type: string; name: string; description: string; usage?: string; configuration?: string };

type MockState = { selectedPageId: string; pages: [{ id: string; widgets: Record<string, Record<string, unknown>> }] };

const HELD_CATALOGUE: MockCatalogueEntry[] = [
  {
    type: "acquit-held",
    name: "acquit-held",
    description: "Total escrow held.",
    usage: "When the reader asks how much is held.",
    configuration: "Map one numeric value.",
  },
];

/**
 * A Studio api double faithful where the bug lives: `getAiContext().catalogue()` serves the given
 * entries; the widget tools the SDK's widget agent asks for come from here, and `configureWidget`
 * throws before any model call when the delegated type is not in the catalogue — the production
 * failure's shape. Added and configured widgets land in `state`.
 */
function mockStudioApi(catalogue: MockCatalogueEntry[]): { api: AgStudioApi; state: MockState } {
  const state: MockState = { selectedPageId: "main", pages: [{ id: "main", widgets: {} }] };
  const tool = (
    name: string,
    description: string,
    execute: (call: { toolCallId: string; name: string; args: Record<string, unknown> }) => unknown,
  ) => ({
    name,
    description,
    kind: "client" as const,
    schema: () => ({ name, description, parameters: { type: "object", properties: {} } }),
    execute,
  });
  const ok = (response: string) => ({ success: true as const, response });
  const internals = {
    translate: (key: string) => key,
    aiString: (key: string, fallback?: string) => fallback ?? key,
    buildAiTool: (def: { name: string; description?: string; shape?: { toJSONSchema: () => unknown }; execute?: unknown }) =>
      tool(def.name, def.description ?? "", (call) => (def.execute as (v: unknown, c: unknown) => unknown)(call.args, undefined)),
  };
  const base: Record<string, unknown> = {
    defineAiTool: (config: { name: string; description?: string; execute?: unknown }) =>
      tool(config.name, config.description ?? "", (call) => (config.execute as (v: unknown, c: unknown) => unknown)(call.args, undefined)),
    getAiContext: () => ({
      schema: () => ({ tables: [], relationships: [] }),
      catalogue: () => catalogue,
      vocabulary: { aggregations: [], filterOperators: [], dataTypes: [], fieldRoles: [] },
      fragments: { referenceSyntax: "" },
      health: { page: async () => ({ issues: [], forWidget: () => [] }), widget: async () => ({ issues: [], forWidget: () => [] }) },
    }),
    getAiTools: () => ({
      viewWidget: () => tool("view_widget", "view a widget", async () => ok("{}")),
      viewSchema: () => tool("view_schema", "view the schema", async () => ok("{}")),
      addWidgetFilter: () => tool("add_widget_filter", "filter a widget", async () => ok("ok")),
      removeWidgetFilter: () => tool("remove_widget_filter", "unfilter a widget", async () => ok("ok")),
      addWidget: () =>
        tool("add_widget", "add a widget", async (call) => {
          const args = call.args as { widgetId?: string; type?: string };
          if (args.widgetId == null || args.type == null) return { success: false as const, issues: [{ message: "widgetId and type are required" }] };
          state.pages[0].widgets[args.widgetId] = { type: args.type, dataMapping: {} };
          return ok(`Added widget ${args.widgetId}`);
        }),
      configureWidget: ({ widgetType, widgetId }: { widgetType: string; widgetId: string }) => {
        if (!catalogue.some((entry) => entry.type === widgetType)) {
          throw new Error(`DiscriminatedUnionLens.case: no variant with type === ${widgetType} in [${catalogue.map((e) => e.type).join(", ")}]`);
        }
        return tool("configure_widget", "configure the widget", async (call) => {
          const widget = state.pages[0].widgets[widgetId];
          if (widget == null) return { success: false as const, issues: [{ message: `configureWidget: widget ${widgetId} is not on page main` }] };
          Object.assign(widget, call.args);
          return ok(`Configured widget ${widgetId}`);
        });
      },
    }),
    getState: () => state,
  };
  const api = new Proxy(base, {
    get(target, prop) {
      if (typeof prop === "symbol") {
        // The SDK reads its module-private internal symbol off the api; its description is stable.
        return prop.description === "ag.internal" ? internals : (target as Record<string | symbol, unknown>)[prop];
      }
      return (target as Record<string | symbol, unknown>)[prop];
    },
  }) as unknown as AgStudioApi;
  return { api, state };
}

type Answer = { message: string | null; calls: { id: string; name: string; arguments: Record<string, unknown> }[] };
const answer = (a: Answer) => new Response(JSON.stringify({ ...a, ok: true, model: "m", sessionId: null, factoryCredits: null }), { status: 200, headers: { "content-type": "application/json" } });
const text = (message: string): Answer => ({ message, calls: [] });
const call = (id: string, name: string, args: Record<string, unknown>): Answer => ({ message: null, calls: [{ id, name, arguments: args }] });

const isParentTurn = (body: { tools?: { name: string }[] }) => body.tools?.some((t) => t.name === "delegate_to") === true;

/** A chat fetch stub that answers parent turns (it sees the delegate_to schema) and child turns separately. */
function scriptedFetch(
  parent: Answer[],
  child: Answer[],
): { fetch: typeof fetch; parentBodies: { instructions?: string }[]; childBodies: { instructions?: string }[] } {
  const parentBodies: { instructions?: string }[] = [];
  const childBodies: { instructions?: string }[] = [];
  const stub = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { tools?: { name: string }[]; instructions?: string };
    if (isParentTurn(body)) {
      parentBodies.push(body);
      return answer(parent.shift() ?? text("parent ran dry"));
    }
    childBodies.push(body);
    return answer(child.shift() ?? text("child ran dry"));
  }) as typeof fetch;
  return { fetch: stub, parentBodies, childBodies };
}

const settle = (session: AgAiChatSession, ms = 10_000) =>
  new Promise<"idle" | "error" | "awaiting_input">((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`settle timeout; status=${session.status}`));
    }, ms);
    const onChanged = () => {
      if (session.status !== "running") {
        cleanup();
        resolve(session.status);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      session.removeEventListener("changed", onChanged);
    };
    session.addEventListener("changed", onChanged);
    onChanged();
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const harnessFor = (api: AgStudioApi, deps?: AskAdapterDeps & { dashboard?: DashboardId }): AgAiHarness =>
  createAskLedgerHarness(api, () => [], { dashboard: "escrow", ...deps });

const toolParts = (session: AgAiChatSession) =>
  session.messages.flatMap((m) => m.parts).filter((part): part is Extract<AgAiChatMessage["parts"][number], { type: "tool_call" }> => part.type === "tool_call");

const delegateResult = (session: AgAiChatSession): { success: boolean; response?: string; issues?: { message: string }[] } | undefined => {
  const part = toolParts(session).find((p) => p.toolCall.name === "delegate_to");
  return part?.toolCall.result as { success: boolean; response?: string; issues?: { message: string }[] } | undefined;
};

const delegate = (widgetType: string, widgetId: string): Answer =>
  call("call-1", "delegate_to", { type: { id: "widget", widgetType, widgetId }, instructions: "Make the widget show held escrow." });

test("a failed widget delegate reaches the ledger agent as a failure, not a success", async () => {
  // The catalogue is empty, as on the real dashboard before its widgets declare AI metadata, so the
  // delegated widget type cannot resolve and the child dies before any model call.
  const { api, state } = mockStudioApi([]);
  const { fetch } = scriptedFetch([delegate("metric", "held-1"), text("Done. I have added the widget.")], []);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a widget showing held escrow.");
  await settle(session);
  const result = delegateResult(session);
  assert.ok(result, "the parent's transcript carries the delegate call");
  assert.equal(result.success, false, "a child that never ran is not a success");
  assert.match(result.issues?.[0]?.message ?? result.response ?? "", /delegate/i);
  assert.equal(Object.keys(state.pages[0].widgets).length, 0, "no widget was added");
});

test("the ledger agent's instructions carry the dashboard's widget catalogue", async () => {
  const { api } = mockStudioApi(HELD_CATALOGUE);
  const { fetch, parentBodies } = scriptedFetch([delegate("acquit-held", "held-1"), text("Added.")], [
    call("child-1", "complete_task", { summary: "Configured the widget.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a widget showing held escrow.");
  await settle(session);
  assert.ok(parentBodies.length >= 1);
  const instructions = parentBodies[0]?.instructions ?? "";
  assert.ok(instructions.includes("acquit-held"), "the catalogue's widget types are named for the model");
  assert.ok(instructions.includes("delegate_to"));
  assert.ok(instructions.length <= 4000, "the turn route's instruction cap holds");
});

test("every dashboard widget declares its AI catalogue metadata", () => {
  for (const rows of Object.values(WIDGET_ROWS)) {
    for (const spec of rows.flat()) {
      // The fix gives WidgetSpecData its `ai`; until then the field can only exist at a runtime that
      // never happens, which is the point of the red run.
      const ai = (spec as { ai?: { description?: string; usage?: string } }).ai;
      assert.ok(ai, `${spec.id} declares ai metadata`);
      assert.ok(typeof ai.description === "string" && ai.description.trim() !== "", `${spec.id} has a catalogue description`);
      assert.ok(typeof ai.usage === "string" && ai.usage.trim() !== "", `${spec.id} has catalogue usage guidance`);
    }
  }
});

test("one harness hands the same thread to every opener", async () => {
  const { api } = mockStudioApi([]);
  const { fetch } = scriptedFetch([text("About 5,000 cents.")], []);
  const harness = harnessFor(api, { fetch });
  const first = await openAskThread(harness);
  const second = await openAskThread(harness);
  assert.equal(second.threadId, first.threadId);
});

test("the Ask conversation survives a remount through the shared history store", async () => {
  // A narrow/wide crossing builds a new Studio api and so a new harness; the conversation must come
  // back from the store rather than start empty.
  const first = mockStudioApi([]);
  const second = mockStudioApi([]);
  const { fetch } = scriptedFetch([text("About 5,000 cents, and PayPal agrees.")], []);
  const before = harnessFor(first.api, { fetch });
  const session = await openAskThread(before);
  session.sendMessage("How much escrow is held right now?");
  await settle(session);
  await sleep(700); // past the history store's autosave debounce
  const after = harnessFor(second.api, { fetch });
  const restored = await openAskThread(after);
  assert.equal(restored.threadId, session.threadId, "the remounted harness reopens the same thread");
  const asked = restored.messages.some((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text.includes("How much escrow")));
  const answered = restored.messages.some((m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text.includes("5,000")));
  assert.ok(asked, "the question is restored");
  assert.ok(answered, "the answer is restored");
});

test("a delegated widget run really configures the widget on the dashboard", async () => {
  const { api, state } = mockStudioApi(HELD_CATALOGUE);
  state.pages[0].widgets["held-1"] = { type: "acquit-held", dataMapping: {} };
  const { fetch } = scriptedFetch([delegate("acquit-held", "held-1"), text("Added.")], [
    call("child-1", "configure_widget", { dataMapping: {}, format: {} }),
    call("child-2", "complete_task", { summary: "Configured the held-escrow widget.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a widget showing held escrow.");
  await settle(session);
  const result = delegateResult(session);
  assert.equal(result?.success, true);
  assert.match(result?.response ?? "", /held-escrow widget/i);
  assert.equal((state.pages[0].widgets["held-1"] as { type: string } | undefined)?.type, "acquit-held");
});

test("a delegated widget run adds the widget before configuring it", async () => {
  const { api, state } = mockStudioApi(HELD_CATALOGUE);
  const { fetch } = scriptedFetch([delegate("acquit-held", "held-new-1"), text("Added.")], [
    call("child-1", "add_widget", { widgetId: "held-new-1", type: "acquit-held", xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 }),
    call("child-2", "configure_widget", { dataMapping: {}, format: {} }),
    call("child-3", "complete_task", { summary: "Added and configured the held-escrow widget.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a widget showing held escrow.");
  await settle(session);
  const result = delegateResult(session);
  assert.equal(result?.success, true);
  const added = state.pages[0].widgets["held-new-1"] as { type: string } | undefined;
  assert.ok(added, "the widget exists on the dashboard");
  assert.equal(added?.type, "acquit-held");
});

test("the add_widget workflow survives the turn route's instruction clip", async () => {
  const { api } = mockStudioApi(HELD_CATALOGUE);
  const { fetch, childBodies } = scriptedFetch([delegate("acquit-held", "held-new-1"), text("Added.")], [
    call("child-1", "complete_task", { summary: "Added and configured the widget.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a widget showing held escrow.");
  await settle(session);
  assert.ok(childBodies.length >= 1, "the delegated widget agent took a turn");
  // The fetch body is already clipped, so a body at exactly the cap is one the clip cut short.
  const instructions = childBodies[0]?.instructions ?? "";
  assert.equal(instructions.length, 4000, "Studio's built-in widget template alone fills the turn route's instruction cap");
  assert.ok(instructions.includes(NEW_WIDGET_WORKFLOW), "the add_widget workflow is inside the clipped instructions the model receives");
});

test("each dashboard's widget ids stay on their own dashboard", () => {
  const escrowIds = new Set<string>(WIDGET_ROWS.escrow.flat().map((spec) => spec.id));
  const earningsIds = new Set<string>(WIDGET_ROWS.earnings.flat().map((spec) => spec.id));
  const escrow = new Set<string>(WIDGET_IDS.escrow);
  const earnings = new Set<string>(WIDGET_IDS.earnings);
  assert.deepEqual(escrow, escrowIds, "the escrow dashboard lists exactly its own widgets");
  assert.deepEqual(earnings, earningsIds, "the earnings dashboard lists exactly its own widgets");
  for (const id of earningsIds) assert.ok(!escrow.has(id), `the escrow dashboard does not list ${id}`);
  for (const id of escrowIds) assert.ok(!earnings.has(id), `the earnings dashboard does not list ${id}`);
  assert.deepEqual([...escrow].filter((id) => earnings.has(id)), [], "no widget id is on both dashboards");
});

test("a delegated add_widget of another dashboard's widget type is refused", async () => {
  const { api, state } = mockStudioApi([
    ...HELD_CATALOGUE,
    { type: "acquit-paid-out", name: "acquit-paid-out", description: "Total paid out.", usage: "...", configuration: "..." },
  ]);
  const { fetch, childBodies } = scriptedFetch([delegate("acquit-paid-out", "earnings-1"), text("Added the paid-out widget.")], [
    call("child-1", "add_widget", { widgetId: "earnings-1", type: "acquit-paid-out", xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 }),
    call("child-2", "complete_task", { summary: "I could not add the widget: that type is not on this dashboard.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch, dashboard: "escrow" });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a widget showing my total paid out.");
  await settle(session);
  assert.ok(childBodies.length >= 2, "the delegated widget agent reached its add_widget call");
  assert.equal(state.pages[0].widgets["earnings-1"], undefined, "the earnings widget was never added to the escrow dashboard");
  const foreign = Object.keys(state.pages[0].widgets).filter((id) => state.pages[0].widgets[id]?.type === "acquit-paid-out");
  assert.deepEqual(foreign, [], "no acquit-paid-out widget is on the escrow dashboard");
});

test("the stacked narrow layout leaves room for the receipt card's caption", () => {
  const state: DashboardState = {
    selectedPageId: "main",
    pages: [
      {
        id: "main",
        layout: { columns: 12, rowHeight: 60 },
        widgets: { "acquit-receipt-card": { type: "acquit-receipt-card", dataMapping: {} } },
        widgetLayout: { "acquit-receipt-card": { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 5 } },
      },
    ],
  };
  const stackedState = stacked(state);
  const card = (stackedState.pages[0]?.widgetLayout ?? {})["acquit-receipt-card"];
  assert.ok(card, "the receipt card survives stacking");
  assert.ok(card.ySpan >= 7, `the receipt card grows in the stacked layout (got ySpan ${card.ySpan})`);
});
