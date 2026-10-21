import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgAiChatMessage, AgAiChatSession, AgAiHarness, AgStudioApi } from "ag-studio";
import { ASK_AGENT_ID, ASK_AGENT_NAME, askRows, type AskAdapterDeps } from "./ask-ledger.ts";
import { createAskLedgerHarness, NEW_WIDGET_WORKFLOW, openAskThread } from "./ask-harness.ts";
import { WIDGET_IDS, WIDGET_ROWS, type DashboardId, type DashboardState } from "./dashboard-widgets.ts";
import { stacked } from "./studio-data.ts";

// The tests run the real harness over a mock Studio api: a Proxy that answers the SDK's internal
// symbol with test doubles, so no DOM, licence, or live model is involved. Every model turn rides
// the injected fetch, exactly as the app's route would carry it.

type MockCatalogueEntry = {
  type: string;
  name: string;
  description: string;
  usage?: string;
  configuration?: string;
  sizing?: { min: { width: number; height: number }; default: { width: number; height: number } };
};

// The page agent's catalogue text reads each entry's sizing, so a catalogue entry without it throws.
const SIZING = { min: { width: 20, height: 20 }, default: { width: 30, height: 40 } };

type MockTrack = { xTrack: number; yTrack: number; xSpan: number; ySpan: number };

type MockPage = {
  id: string;
  layout?: { columns: number; rowHeight: number };
  widgets: Record<string, Record<string, unknown>>;
  widgetLayout?: Record<string, MockTrack>;
};

type MockState = {
  selectedPageId: string;
  pages: [MockPage, ...MockPage[]];
};

const HELD_CATALOGUE: MockCatalogueEntry[] = [
  {
    type: "acquit-held",
    name: "acquit-held",
    description: "Total escrow held.",
    usage: "When the reader asks how much is held.",
    configuration: "Map one numeric value.",
    sizing: SIZING,
  },
];

/**
 * A Studio api double faithful where the bug lives: `getAiContext().catalogue()` serves the given
 * entries; the widget tools the SDK's widget agent asks for come from here, and `configureWidget`
 * throws before any model call when the delegated type is not in the catalogue — the production
 * failure's shape. Added and configured widgets land in `state`. An add that carries a full track
 * is placed as Studio places a valid one; `dropPlacement` keeps the config but drops the placement,
 * which is what Studio did with an overlapping add in user-testing round 4.
 */
function mockStudioApi(
  catalogue: MockCatalogueEntry[],
  opts: { layout?: Record<string, MockTrack>; dropPlacement?: boolean; otherPage?: boolean } = {},
): { api: AgStudioApi; state: MockState } {
  const main: MockPage = { id: "main", layout: { columns: 12, rowHeight: 60 }, widgets: {}, widgetLayout: { ...opts.layout } };
  const extra: MockPage[] = opts.otherPage ? [{ id: "other", layout: { columns: 12, rowHeight: 60 }, widgets: {}, widgetLayout: {} }] : [];
  const state: MockState = { selectedPageId: "main", pages: [main, ...extra] };
  // A tool bound to a page (as the SDK binds page-scoped tools) writes there; unbound, it writes to the selected page.
  const pageOf = (options?: { pageId?: string }): MockPage =>
    state.pages.find((page) => page.id === (options?.pageId ?? state.selectedPageId)) ?? state.pages[0];
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
      // The data and page agents build their tool lists from these; the tests only need them present.
      executeQuery: () => tool("execute_query", "run a query", async () => ok("{}")),
      createExpression: () => tool("create_expression", "add a calculated column", async () => ok("{}")),
      updateExpression: () => tool("update_expression", "change a calculated column", async () => ok("{}")),
      deleteExpression: () => tool("delete_expression", "remove a calculated column", async () => ok("{}")),
      viewPage: () => tool("view_page", "view the page", async () => ok("{}")),
      addPageFilter: () => tool("add_page_filter", "filter the page", async () => ok("ok")),
      removePageFilter: () => tool("remove_page_filter", "unfilter the page", async () => ok("ok")),
      positionWidget: () => tool("position_widget", "move a widget", async () => ok("ok")),
      addWidget: (options?: { pageId?: string }) =>
        tool("add_widget", "add a widget", async (call) => {
          const args = call.args as { widgetId?: string; type?: string } & Partial<Record<keyof MockTrack, unknown>>;
          if (args.widgetId == null || args.type == null) return { success: false as const, issues: [{ message: "widgetId and type are required" }] };
          const page = pageOf(options);
          page.widgets[args.widgetId] = { type: args.type, dataMapping: {} };
          const { xTrack, yTrack, xSpan, ySpan } = args;
          if (!opts.dropPlacement && typeof xTrack === "number" && typeof yTrack === "number" && typeof xSpan === "number" && typeof ySpan === "number") {
            (page.widgetLayout ??= {})[args.widgetId] = { xTrack, yTrack, xSpan, ySpan };
          }
          return ok(`Added widget ${args.widgetId}`);
        }),
      removeWidget: (options?: { pageId?: string }) =>
        tool("remove_widget", "remove a widget", async (call) => {
          const args = call.args as { widgetId?: string };
          const page = pageOf(options);
          if (args.widgetId == null || page.widgets[args.widgetId] == null) {
            return { success: false as const, issues: [{ message: `removeWidget: widget ${args.widgetId} is not on page ${page.id}` }] };
          }
          delete page.widgets[args.widgetId];
          delete page.widgetLayout?.[args.widgetId];
          return ok(`Removed widget ${args.widgetId}`);
        }),
      configureWidget: ({ widgetType, widgetId }: { widgetType: string; widgetId: string }, options?: { pageId?: string }) => {
        if (!catalogue.some((entry) => entry.type === widgetType)) {
          throw new Error(`DiscriminatedUnionLens.case: no variant with type === ${widgetType} in [${catalogue.map((e) => e.type).join(", ")}]`);
        }
        return tool("configure_widget", "configure the widget", async (call) => {
          const page = pageOf(options);
          const widget = page.widgets[widgetId];
          if (widget == null) return { success: false as const, issues: [{ message: `configureWidget: widget ${widgetId} is not on page ${page.id}` }] };
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
/** A turn the provider fails: the route's 500 with no `outcome`, which ends the SDK run as an error. */
const providerFailure = () =>
  new Response(JSON.stringify({ error: "MODEL_PROVIDER_ERROR", detail: "the provider failed mid-run" }), { status: 500, headers: { "content-type": "application/json" } });

const isParentTurn = (body: { tools?: { name: string }[] }) => body.tools?.some((t) => t.name === "delegate_to") === true;

/** A chat fetch stub that answers parent turns (it sees the delegate_to schema) and child turns separately. */
function scriptedFetch(
  parent: Answer[],
  child: (Answer | Response)[],
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
    const next = child.shift() ?? text("child ran dry");
    return next instanceof Response ? next : answer(next);
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
  state.pages[0].widgetLayout!["held-1"] = { xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 };
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
  assert.ok(escrow.has("acquit-verdict-grid"), "the verdict timeline is on the escrow dashboard");
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

test("a child that adds a widget and then fails leaves no widget behind, and the ledger agent's reply says failure", async () => {
  const REPLY = "The widget was not made: the delegate failed, and the partially added widget was removed.";
  const { api, state } = mockStudioApi(HELD_CATALOGUE);
  const { fetch, childBodies, parentBodies } = scriptedFetch([delegate("acquit-held", "held-new-1"), text(REPLY)], [
    call("child-1", "add_widget", { widgetId: "held-new-1", type: "acquit-held", xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 }),
    providerFailure(),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a widget showing held escrow.");
  await settle(session);
  assert.ok(childBodies.length >= 2, "the delegated widget agent reached add_widget and continued past it");
  const result = delegateResult(session);
  assert.equal(result?.success, false, "a child that died mid-run is not a success");
  assert.match(result?.issues?.[0]?.message ?? "", /removed/i, "the failure says the partially added widget was removed");
  assert.equal(state.pages[0].widgets["held-new-1"], undefined, "the widget the failed child added is gone from the grid");
  assert.match(JSON.stringify(parentBodies[1]), /removed/i, "the ledger agent's next turn carried the rollback");
  const last = session.messages.filter((m) => m.role === "assistant").at(-1);
  assert.ok(last?.parts.some((p) => p.type === "text" && p.text === REPLY), "the reader's final word is the failure reply");
});

const delegateTo = (id: "data" | "page", instructions: string): Answer =>
  call("call-1", "delegate_to", { type: { id }, instructions });

const pageTo = (pageId: string, instructions: string): Answer =>
  call("call-1", "delegate_to", { type: { id: "page", pageId }, instructions });

const widgetOn = (widgetId: string, pageId: string | undefined, instructions: string): Answer =>
  call("call-1", "delegate_to", { type: { id: "widget", widgetType: "acquit-held", widgetId, ...(pageId === undefined ? {} : { pageId }) }, instructions });

test("a delegated data question runs the built-in data agent and returns its answer", async () => {
  const { api } = mockStudioApi([]);
  const { fetch, childBodies } = scriptedFetch([delegateTo("data", "Which operator holds the most escrow?"), text("Operator alpha holds the most.")], [
    call("child-1", "complete_task", { summary: "Operator alpha holds the most escrow, $378.00.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Which operator holds the most escrow?");
  await settle(session);
  const result = delegateResult(session);
  assert.equal(result?.success, true);
  assert.equal(result?.response, "Operator alpha holds the most escrow, $378.00.");
  assert.ok(childBodies[0]?.instructions?.includes("You are a data analyst."), "the delegate ran the built-in data agent");
});

test("a delegated page change runs the built-in page agent and returns its summary", async () => {
  const { api } = mockStudioApi([]);
  const { fetch, childBodies } = scriptedFetch([delegateTo("page", "Move the held widget to the top row."), text("Moved it.")], [
    call("child-1", "complete_task", { summary: "Moved the held widget to the top row.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Move the held widget to the top.");
  await settle(session);
  const result = delegateResult(session);
  assert.equal(result?.success, true);
  assert.equal(result?.response, "Moved the held widget to the top row.");
  assert.ok(childBodies[0]?.instructions?.includes("You are the page manager."), "the delegate ran the built-in page agent");
});

test("a page change that adds another dashboard's widget type is refused", async () => {
  const { api, state } = mockStudioApi([
    ...HELD_CATALOGUE,
    { type: "acquit-paid-out", name: "acquit-paid-out", description: "Total paid out.", usage: "...", configuration: "...", sizing: SIZING },
  ]);
  const { fetch, childBodies } = scriptedFetch([delegateTo("page", "Add a paid-out widget."), text("Could not add it.")], [
    call("child-1", "add_widget", { widgetId: "earnings-1", type: "acquit-paid-out", xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 }),
    call("child-2", "complete_task", { summary: "I could not add the widget: that type is not on this dashboard.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch, dashboard: "escrow" });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a paid-out widget.");
  await settle(session);
  assert.ok(childBodies.length >= 2, "the page agent reached its add_widget call");
  assert.equal(state.pages[0].widgets["earnings-1"], undefined, "the foreign widget was never added to the escrow dashboard");
});

test("a page change aimed at an unselected page is refused, and no widget lands on either page", async () => {
  const { api, state } = mockStudioApi([...HELD_CATALOGUE], { otherPage: true });
  const { fetch, childBodies } = scriptedFetch([pageTo("other", "Add the held widget to the other page."), text("Could not do that.")], [
    call("child-1", "add_widget", { widgetId: "held-other", type: "acquit-held", xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 }),
    call("child-2", "complete_task", { summary: "Added the held widget to the other page.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add the held widget to the other page.");
  await settle(session);
  assert.equal(state.pages[1]?.widgets["held-other"], undefined, "no widget landed on the other page");
  assert.equal(state.pages[0].widgets["held-other"], undefined, "no widget landed on the selected page");
  assert.equal(childBodies.length, 0, "the page agent never ran");
  const result = delegateResult(session);
  assert.equal(result?.success, false);
  assert.match(result?.issues?.[0]?.message ?? "", /The page other is not the selected page/);
});

test("a widget change aimed at an unselected page is refused, and nothing changes on either page", async () => {
  const { api, state } = mockStudioApi([...HELD_CATALOGUE], { otherPage: true });
  state.pages[0].widgets["held-1"] = { type: "acquit-held", dataMapping: {} };
  state.pages[1]!.widgets["held-other"] = { type: "acquit-held", dataMapping: {} };
  const { fetch, childBodies } = scriptedFetch([widgetOn("held-other", "other", "Show held escrow on the other page."), text("Could not do that.")], [
    call("child-1", "configure_widget", { dataMapping: {}, format: {} }),
    call("child-2", "complete_task", { summary: "Configured the held-escrow widget on the other page.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Show held escrow on the other page.");
  await settle(session);
  assert.equal(childBodies.length, 0, "the widget agent never ran");
  const result = delegateResult(session);
  assert.equal(result?.success, false);
  assert.match(result?.issues?.[0]?.message ?? "", /The page other is not the selected page/);
  assert.deepEqual(state.pages[1]?.widgets, { "held-other": { type: "acquit-held", dataMapping: {} } }, "the other page's widget is untouched");
  assert.deepEqual(Object.keys(state.pages[0].widgets), ["held-1"], "the selected page keeps its widget and gains none");
});

test("a widget change that names the selected page still configures its widget", async () => {
  const { api, state } = mockStudioApi(HELD_CATALOGUE);
  state.pages[0].widgets["held-1"] = { type: "acquit-held", dataMapping: {} };
  state.pages[0].widgetLayout!["held-1"] = { xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 };
  const { fetch } = scriptedFetch([widgetOn("held-1", "main", "Show held escrow."), text("Added.")], [
    call("child-1", "configure_widget", { dataMapping: {}, format: {} }),
    call("child-2", "complete_task", { summary: "Configured the held-escrow widget.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Show held escrow.");
  await settle(session);
  const result = delegateResult(session);
  assert.equal(result?.success, true);
  assert.match(result?.response ?? "", /held-escrow widget/i);
  assert.deepEqual(Object.keys(state.pages[0].widgets), ["held-1"]);
});

test("a native funnel chart is addable on the escrow dashboard", async () => {
  const { api, state } = mockStudioApi([...HELD_CATALOGUE]);
  const { fetch } = scriptedFetch([delegateTo("page", "Add a jobs funnel."), text("Added it.")], [
    call("child-1", "add_widget", { widgetId: "funnel-new", type: "funnel-chart", xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 5 }),
    call("child-2", "complete_task", { summary: "Added the jobs funnel.", artifacts: [] }),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a jobs funnel.");
  await settle(session);
  assert.equal(delegateResult(session)?.success, true);
  assert.equal(state.pages[0].widgets["funnel-new"]?.type, "funnel-chart");
});

test("a data delegate that dies reaches the ledger agent as a failure, not a success", async () => {
  const { api } = mockStudioApi([]);
  const { fetch, parentBodies } = scriptedFetch([delegateTo("data", "Which operator holds the most escrow?"), text("The question was not answered.")], [
    providerFailure(),
  ]);
  const harness = harnessFor(api, { fetch });
  const session = await harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Which operator holds the most escrow?");
  await settle(session);
  const result = delegateResult(session);
  assert.equal(result?.success, false, "a data run that died is not a success");
  assert.match(result?.issues?.[0]?.message ?? "", /^The delegate did not complete/, "the failure names the delegate, not the widget agent");
  assert.doesNotMatch(JSON.stringify(parentBodies[1] ?? {}), /widget delegate/, "the ledger agent's next turn does not blame the widget agent");
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

const ROUND4_LAYOUT = {
  "acquit-released": { xTrack: 3, yTrack: 0, xSpan: 3, ySpan: 2 },
  "acquit-refunded": { xTrack: 6, yTrack: 0, xSpan: 3, ySpan: 2 },
  "acquit-fees": { xTrack: 9, yTrack: 0, xSpan: 3, ySpan: 2 },
  "acquit-pass-rate": { xTrack: 0, yTrack: 2, xSpan: 4, ySpan: 2 },
  "acquit-reject-rate": { xTrack: 4, yTrack: 2, xSpan: 4, ySpan: 2 },
  "acquit-tamper-caught": { xTrack: 8, yTrack: 2, xSpan: 4, ySpan: 2 },
  "acquit-conserves": { xTrack: 0, yTrack: 4, xSpan: 12, ySpan: 4 },
};

const clash = (a: MockTrack, b: MockTrack) =>
  a.xTrack < b.xTrack + b.xSpan && b.xTrack < a.xTrack + a.xSpan && a.yTrack < b.yTrack + b.ySpan && b.yTrack < a.yTrack + a.ySpan;

const clashingPairs = (layout: Record<string, MockTrack>) => {
  const entries = Object.entries(layout);
  return entries.flatMap(([a, ta], i) => entries.slice(i + 1).filter(([, tb]) => clash(ta, tb)).map(([b]) => `${a} x ${b}`));
};

const heldAdd = (track: Partial<MockTrack>) => call("child-1", "add_widget", { widgetId: "held-escrow-main", type: "acquit-held", ...track });
const complete = (summary: string) => call("child-2", "complete_task", { summary, artifacts: [] });

async function runAdd(api: AgStudioApi, child: Answer[], reply: string, extra: Record<string, unknown> = {}) {
  const { fetch } = scriptedFetch([delegate("acquit-held", "held-escrow-main"), text(reply)], child);
  const deps = { fetch, ...extra };
  const session = await harnessFor(api, deps).createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
  session.sendMessage("Add a widget showing held escrow.");
  await settle(session);
  return session;
}

test("a delegated add at an occupied spot is placed on the first free spot and kept", async () => {
  const { api, state } = mockStudioApi(HELD_CATALOGUE, { layout: ROUND4_LAYOUT });
  const session = await runAdd(
    api,
    [heldAdd({ xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 2 }), complete("Added and configured the held-escrow widget.")],
    "Added the held-escrow widget.",
  );
  assert.equal(delegateResult(session)?.success, true, "the delegate succeeded");
  assert.ok(state.pages[0].widgets["held-escrow-main"], "the widget's config is on the page");
  assert.deepEqual(state.pages[0].widgetLayout?.["held-escrow-main"], { xTrack: 0, yTrack: 8, xSpan: 4, ySpan: 2 }, "the widget sits on the first free 4x2 spot");
  assert.deepEqual(clashingPairs(state.pages[0].widgetLayout ?? {}), [], "no two widgets share a cell");
});

test("an add whose placement does not stick fails and removes the widget", async () => {
  const { api, state } = mockStudioApi(HELD_CATALOGUE, { dropPlacement: true });
  const session = await runAdd(
    api,
    [heldAdd({ xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 2 }), complete("I could not add the widget: the placement did not hold.")],
    "The widget was not added: the placement did not hold.",
  );
  const result = delegateResult(session);
  assert.equal(result?.success, false, "a widget with no placement is not a success");
  assert.equal(state.pages[0].widgets["held-escrow-main"], undefined, "the unplaced widget was removed again");
  const message = result?.issues?.[0]?.message ?? "";
  assert.match(message, /held-escrow-main/, "the failure names the widget");
  assert.match(message, /not on the dashboard's grid/, "the failure says the widget is not on the grid");
  const step = askRows(session.messages).find((row) => row.kind === "step" && row.label === "Handing off to the widget builder");
  assert.equal(step?.kind === "step" ? step.state : undefined, "failed", "the drawer shows the hand-off as failed");
});

test("an add at a genuinely free spot keeps the spot it asked for", async () => {
  const { api, state } = mockStudioApi(HELD_CATALOGUE);
  const session = await runAdd(
    api,
    [heldAdd({ xTrack: 0, yTrack: 8, xSpan: 4, ySpan: 2 }), complete("Added and configured the held-escrow widget.")],
    "Added the held-escrow widget.",
  );
  assert.equal(delegateResult(session)?.success, true, "the delegate succeeded");
  assert.deepEqual(state.pages[0].widgetLayout?.["held-escrow-main"], { xTrack: 0, yTrack: 8, xSpan: 4, ySpan: 2 });
});

test("an add whose tile never renders fails and removes the widget", async () => {
  const { api, state } = mockStudioApi(HELD_CATALOGUE);
  const session = await runAdd(
    api,
    [heldAdd({ xTrack: 0, yTrack: 8, xSpan: 4, ySpan: 2 }), complete("I added the widget but it never showed up.")],
    "The widget was not added: it never showed up.",
    { renderedCount: (_type: string) => 0, renderWaitMs: 50 },
  );
  const result = delegateResult(session);
  assert.equal(result?.success, false, "a widget whose tile never renders is not a success");
  assert.equal(state.pages[0].widgets["held-escrow-main"], undefined, "the unrendered widget was removed again");
  assert.match(result?.issues?.[0]?.message ?? "", /render/i, "the failure says the tile did not render");
});

test("an add with no placement at all lands on the first free spot", async () => {
  const { api, state } = mockStudioApi(HELD_CATALOGUE);
  const session = await runAdd(api, [heldAdd({}), complete("Added and configured the held-escrow widget.")], "Added the held-escrow widget.");
  assert.equal(delegateResult(session)?.success, true, "the delegate succeeded");
  assert.deepEqual(state.pages[0].widgetLayout?.["held-escrow-main"], { xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 }, "the widget takes its spec's 3x2 at the origin");
});
