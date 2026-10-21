import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgAiChatMessage, AgAiConversationItem, AgAiEvent, AgAiToolContext, AgLlmRequest, AgStudioApi } from "ag-studio";
import type { AskToolSchema } from "./api-types";
import {
  ASK_INSTRUCTIONS,
  ASK_PROMPT_STARTERS,
  ASK_TOOL_NAMES,
  ASK_VALIDATION_QUESTION,
  askGate,
  askInstructions,
  askLedgerAdapter,
  askParamFields,
  askRows,
  askToolLabel,
  buildAskTools,
  LEDGER_CARD_TOOLS,
  ledgerCard,
  runTool,
  toAskMessages,
  toAskTurnBody,
} from "./ask-ledger.ts";
import { WIDGET_ROWS } from "./dashboard-widgets.ts";
import { ApiError } from "./api.ts";

type Recorded = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, seen: Recorded[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const conversation: AgAiConversationItem[] = [
  { id: "m1", kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text: "How much is held?" }] },
  { id: "r1", kind: "output", type: "reasoning", summary: [{ type: "summary", text: "thinking" }] },
  {
    id: "o1",
    kind: "output",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "text", text: "Checking the book.", annotations: [] }],
  },
  { id: "c1", kind: "output", type: "function_call", callId: "call-a", name: "platform_totals", arguments: "{}", status: "completed" },
  { id: "c2", kind: "output", type: "function_call", callId: "call-b", name: "get_order", arguments: '{"id":"ORD-1"}', status: "completed" },
  { type: "function_call_output", callId: "call-a", output: '{"held":5000}', status: "completed" },
  { type: "function_call_output", callId: "call-b", output: "", status: "completed" },
];

const request = (input: AgAiConversationItem[], instructions?: string, tools?: AgLlmRequest["tools"]): AgLlmRequest => ({
  input,
  instructions,
  tools: tools ?? [],
  responseFormat: { type: "text" },
});

async function drain(stream: { [Symbol.asyncIterator](): AsyncIterator<AgAiEvent> }): Promise<AgAiEvent[]> {
  const events: AgAiEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("the loop's conversation maps onto the turn route's message shape", () => {
  assert.deepEqual(toAskMessages(conversation), [
    { id: "m1", role: "user", content: "How much is held?" },
    {
      id: "o1",
      role: "assistant",
      content: "Checking the book.",
      toolCalls: [
        { id: "call-a", function: { name: "platform_totals", arguments: "{}" } },
        { id: "call-b", function: { name: "get_order", arguments: '{"id":"ORD-1"}' } },
      ],
    },
    { id: "call-a-result", role: "tool", toolCallId: "call-a", content: '{"held":5000}' },
    // The route refuses blank content, so an empty tool result still says something.
    { id: "call-b-result", role: "tool", toolCallId: "call-b", content: "(no output)" },
  ]);
});

test("a call with no message before it is its own assistant message, and a system input keeps its role", () => {
  assert.deepEqual(
    toAskMessages([
      { id: "s1", kind: "input", type: "message", role: "system", status: "completed", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { id: "c9", kind: "output", type: "function_call", callId: "x", name: "list_jobs", arguments: "", status: "completed" },
    ]),
    [
      { id: "s1", role: "system", content: "a\nb" },
      { id: "c9", role: "assistant", toolCalls: [{ id: "x", function: { name: "list_jobs", arguments: "{}" } }] },
    ],
  );
});

test("a long conversation keeps the newest 64 messages and never opens on an orphaned tool result", () => {
  const items: AgAiConversationItem[] = [];
  for (let i = 0; i < 40; i++) {
    items.push({ id: `c${i}`, kind: "output", type: "function_call", callId: `k${i}`, name: "list_jobs", arguments: "{}", status: "completed" });
    items.push({ type: "function_call_output", callId: `k${i}`, output: "{}", status: "completed" });
  }
  const messages = toAskMessages(items);
  assert.ok(messages.length <= 64);
  assert.equal(messages[0]?.role, "assistant");
  assert.equal(messages.at(-1)?.role, "tool");
});

test("the turn body carries the agent's instructions, cut to the route's cap", () => {
  assert.deepEqual(toAskTurnBody(request(conversation.slice(0, 1), "Be brief.")), {
    messages: [{ id: "m1", role: "user", content: "How much is held?" }],
    instructions: "Be brief.",
  });
  assert.equal(toAskTurnBody(request(conversation.slice(0, 1), "x".repeat(20_000))).instructions?.length, 16_000);
  assert.equal("instructions" in toAskTurnBody(request(conversation.slice(0, 1), "  ")), false);
  assert.ok(ASK_INSTRUCTIONS.length < 16_000);
});

const escrowCatalogue = WIDGET_ROWS.escrow.flat().map((spec) => ({ type: spec.id, description: spec.ai.description }));

test("the platform's instructions, built from the escrow dashboard's own widgets, reach the turn body whole", () => {
  const instructions = askInstructions(escrowCatalogue);
  assert.ok(instructions.length < 16_000, "the prompt sits under the turn route's cap");
  assert.ok(instructions.endsWith("Never claim the page was changed unless its result says so."), "the page recipe ends the prompt");
  assert.equal(toAskTurnBody(request(conversation.slice(0, 1), instructions)).instructions, instructions);
});

test("the ledger agent is told delegate_to is always there, and a delegation counts as failed only on an error result", () => {
  for (const entries of [[], escrowCatalogue]) {
    const instructions = askInstructions(entries);
    assert.ok(instructions.includes("delegate_to is always available."));
    assert.ok(instructions.includes("only when its result reports an error"));
    assert.doesNotMatch(instructions, /unavailab|may not be available|if delegate_to fails/i);
  }
});

test("the turn body relays the loop's own tool schemas, so a delegated widget run is offered its tools", () => {
  const relayed = toAskTurnBody(request(conversation.slice(0, 1), undefined, [
    { name: "platform_totals", description: "The book's totals.", parameters: { type: "object", properties: {} }, kind: "client" },
    { name: "delegate_to", description: "Hand work to another agent.", parameters: { type: "object", properties: { agent: { type: "string" } } } },
  ]));
  assert.deepEqual(relayed.tools?.map((tool: { name: string }) => tool.name), ["platform_totals", "delegate_to"]);
  assert.equal("kind" in (relayed.tools?.[1] ?? {}), false, "the relayed schema is the loop's, not the served one's");
  assert.equal("tools" in toAskTurnBody(request(conversation.slice(0, 1))), false, "a turn with no tools sends none");
  const long = toAskTurnBody(request(conversation.slice(0, 1), undefined,
    Array.from({ length: 40 }, (_, i) => ({ name: `tool_${i}`, description: "x", parameters: { type: "object", properties: {} } }))));
  assert.equal(long.tools?.length, 32, "the route's cap holds");
});

test("the adapter posts one turn to the app's own route and maps the answer onto output items and events", async () => {
  const seen: Recorded[] = [];
  const fetch = fakeFetch(
    200,
    {
      ok: true,
      message: "I will check PayPal.",
      calls: [
        { id: "1", name: "get_order", arguments: { id: "ORD-1" } },
        { id: null, name: "platform_totals", arguments: {} },
      ],
      model: "glm-5.3-flash",
      sessionId: "s",
      factoryCredits: 1,
    },
    seen,
  );
  const adapter = askLedgerAdapter({ fetch, newId: () => "t1", now: () => 42 });
  const controller = new AbortController();
  const handler = adapter.executeTurn(request(conversation, "Check both."), { signal: controller.signal });
  const events = await drain(handler.stream);
  const response = await handler.complete;

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "/api/ask-ledger/turn");
  assert.equal(seen[0]?.init.method, "POST");
  assert.equal(seen[0]?.init.credentials, "same-origin");
  assert.equal(seen[0]?.init.signal, controller.signal);
  const body = JSON.parse(String(seen[0]?.init.body)) as { messages: unknown[]; instructions: string };
  assert.deepEqual(body.messages, toAskMessages(conversation));
  assert.equal(body.instructions, "Check both.");
  assert.equal("tools" in body, false);

  assert.equal(response.status, "completed");
  assert.equal(response.id, "t1");
  assert.equal(response.createdAt, 42);
  assert.equal(response.model, "glm-5.3-flash");
  assert.deepEqual(response.output, [
    {
      id: "t1-message",
      kind: "output",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "text", text: "I will check PayPal.", annotations: [] }],
    },
    { id: "t1-call-0", kind: "output", type: "function_call", callId: "t1-call-0", name: "get_order", arguments: '{"id":"ORD-1"}', status: "completed" },
    { id: "t1-call-1", kind: "output", type: "function_call", callId: "t1-call-1", name: "platform_totals", arguments: "{}", status: "completed" },
  ]);
  // The chat session renders only what the stream carries, so every output item is replayed on it.
  assert.deepEqual(
    events.map((e) => e.type),
    ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"],
  );
  assert.deepEqual(events[1], { type: "TEXT_MESSAGE_CONTENT", messageId: "t1-message", delta: "I will check PayPal." });
  assert.deepEqual(events[3], { type: "TOOL_CALL_START", toolCallId: "t1-call-0", toolCallName: "get_order" });
  assert.deepEqual(events[4], { type: "TOOL_CALL_ARGS", toolCallId: "t1-call-0", delta: '{"id":"ORD-1"}' });
});

test("an answer with no message and no calls is a completed, empty turn", async () => {
  const fetch = fakeFetch(200, { ok: true, message: null, calls: [], model: "m", sessionId: null, factoryCredits: null });
  const handler = askLedgerAdapter({ fetch, newId: () => "t2", now: () => 1 }).executeTurn(request(conversation));
  assert.deepEqual(await drain(handler.stream), []);
  assert.deepEqual(await handler.complete, { id: "t2", createdAt: 1, status: "completed", output: [], model: "m" });
});

test("a missing model key fails the turn with its code, and the stream ends empty", async () => {
  const fetch = fakeFetch(503, { error: "MODEL_KEY_MISSING" });
  const handler = askLedgerAdapter({ fetch, newId: () => "t3", now: () => 1 }).executeTurn(request(conversation));
  assert.deepEqual(await drain(handler.stream), []);
  const response = await handler.complete;
  assert.equal(response.status, "failed");
  assert.deepEqual(response.output, []);
  assert.equal(response.error?.code, "MODEL_KEY_MISSING");
  assert.match(response.error?.message ?? "", /no model key/);
});

test("a rate limit and an out-of-budget turn fail the turn with their own codes and wording", async () => {
  for (const [code, wording] of [
    ["MODEL_RATE_LIMITED", /rate limited.*slow down/],
    // A 429 for MODEL_BUDGET is either the shared budget or an operator's own turn limit, so the copy names neither.
    ["MODEL_BUDGET", /out of model budget/],
  ] as const) {
    const fetch = fakeFetch(429, { error: code, detail: "slow down" });
    const response = await askLedgerAdapter({ fetch, newId: () => "t4", now: () => 1 }).executeTurn(request(conversation)).complete;
    assert.equal(response.status, "failed");
    assert.equal(response.error?.code, code);
    assert.match(response.error?.message ?? "", wording);
  }
});

test("a cancelled turn resolves as cancelled rather than rejecting", async () => {
  const controller = new AbortController();
  const fetch = (async (_url: string, init: RequestInit) => {
    controller.abort();
    throw init.signal?.reason ?? new Error("aborted");
  }) as typeof globalThis.fetch;
  const handler = askLedgerAdapter({ fetch, newId: () => "t5", now: () => 1 }).executeTurn(request(conversation), { signal: controller.signal });
  assert.deepEqual(await drain(handler.stream), []);
  assert.equal((await handler.complete).status, "cancelled");
});

test("Studio's own loop runs a tool round and an answer over the adapter, and a refused turn ends the run in error", async () => {
  const { directLlmRunner } = await import("ag-studio");
  const bodies: { messages: { role: string }[]; instructions?: string }[] = [];
  const answers = [
    { ok: true, message: null, calls: [{ id: "1", name: "platform_totals", arguments: {} }], model: "m", sessionId: null, factoryCredits: null },
    { ok: true, message: "$50.00 is held, and PayPal agrees.", calls: [], model: "m", sessionId: null, factoryCredits: null },
  ];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(answers[bodies.length - 1]), { status: 200 });
  }) as typeof globalThis.fetch;
  const totals = {
    name: "platform_totals",
    description: "totals",
    kind: "client" as const,
    schema: () => ({ name: "platform_totals", description: "totals", parameters: { type: "object", properties: {} } }),
    execute: async () => ({ success: true as const, response: '{"held":5000}' }),
  };
  const input = { threadId: "th", runId: "run", messages: [{ id: "u1", role: "user" as const, content: "Held?" }], tools: [], state: {}, context: [], forwardedProps: {} };
  const runCtx = (tools: (typeof totals)[]) => ({ params: undefined, instructions: () => "Check both.", tools: () => tools, signal: new AbortController().signal });

  const agent = directLlmRunner({ id: "ask-ledger", adapter: askLedgerAdapter({ fetch }) });
  const events: AgAiEvent[] = [];
  for await (const event of agent.run(input, runCtx([totals]))) events.push(event);
  assert.deepEqual(
    events.map((e) => e.type),
    ["RUN_STARTED", "STEP_STARTED", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "STEP_FINISHED", "TOOL_CALL_RESULT",
      "STEP_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "STEP_FINISHED", "RUN_FINISHED"],
  );
  assert.equal(bodies.length, 2);
  assert.deepEqual(
    bodies[1]?.messages.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(bodies[1]?.instructions, "Check both.");

  const refused = directLlmRunner({
    id: "ask-ledger",
    adapter: askLedgerAdapter({ fetch: fakeFetch(503, { error: "MODEL_KEY_MISSING" }) }),
  });
  const failed: AgAiEvent[] = [];
  for await (const event of refused.run(input, runCtx([]))) failed.push(event);
  const last = failed.at(-1);
  assert.equal(last?.type, "RUN_ERROR");
  assert.match(last?.type === "RUN_ERROR" ? last.message : "", /no model key/);
});

test("a served tool schema's parameters become the fields its shape is built from", () => {
  assert.deepEqual(askParamFields({ type: "object", properties: {}, required: [] }), []);
  assert.deepEqual(
    askParamFields({
      type: "object",
      properties: { jobId: { type: "string", description: "The job's id" }, note: { type: "string" }, deep: { type: "object" } },
      required: ["jobId"],
    }),
    [
      { name: "jobId", type: "string", required: true, description: "The job's id" },
      { name: "note", type: "string", required: false },
    ],
  );
});

const toolCtx = {
  signal: new AbortController().signal,
  run: { threadId: "th", runId: "run" },
  success: (response: string) => ({ success: true as const, response }),
  error: (messages: string | string[]) => ({ success: false as const, issues: [messages].flat().map((message) => ({ message })) }),
} as AgAiToolContext;

test("the served tools are defined under their own names and run through the tool route", async () => {
  const specs: AskToolSchema[] = [
    { name: "list_jobs", description: "every job", parameters: { type: "object", properties: {}, required: [] }, kind: "client" },
    {
      name: "get_job",
      description: "one job",
      parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
      kind: "client",
    },
  ];
  const defined: { name: string; execute: (args: Record<string, unknown>, ctx: AgAiToolContext) => unknown }[] = [];
  const studio = { defineAiTool: (config: never) => (defined.push(config), config) } as unknown as Pick<AgStudioApi, "defineAiTool">;
  const calls: [string, Record<string, unknown>][] = [];
  buildAskTools(studio, specs, async (name, args) => (calls.push([name, args]), { jobId: "j1", escrow: "HELD" }));
  assert.deepEqual(
    defined.map((tool) => tool.name),
    ["list_jobs", "get_job"],
  );
  assert.deepEqual(await defined[1]?.execute({ jobId: "j1" }, toolCtx), { success: true, response: '{"jobId":"j1","escrow":"HELD"}' });
  assert.deepEqual(calls, [["get_job", { jobId: "j1" }]]);
});

test("a refused tool call reaches the model as an error with the route's detail", async () => {
  const failed = await runTool(
    async () => {
      throw new ApiError(502, "TOOL_FAILED", "no job named j9");
    },
    "get_job",
    { jobId: "j9" },
    toolCtx,
  );
  assert.deepEqual(failed, { success: false, issues: [{ message: "no job named j9" }] });
  const denied = await runTool(
    async () => {
      throw new ApiError(403, "PLATFORM_ONLY");
    },
    "list_jobs",
    {},
    toolCtx,
  );
  assert.deepEqual(denied, { success: false, issues: [{ message: "Ask the ledger is for the platform role only." }] });
});

test("tool rows are worded by what they read", () => {
  assert.equal(askToolLabel("list_jobs", {}), "Reading the ledger");
  assert.equal(askToolLabel("get_job", { jobId: "job_7" }), "Reading job job_7");
  assert.equal(askToolLabel("get_job", {}), "Reading a job");
  assert.equal(askToolLabel("platform_totals", {}), "Totalling the book");
  assert.equal(askToolLabel("get_order", { id: "5O190127TN364715T" }), "Asking PayPal for order 5O190127TN364715T");
  assert.equal(askToolLabel("get_order", { id: " " }), "Asking PayPal for an order");
  assert.equal(askToolLabel("delegate_to", {}), "Handing off to the widget builder");
  assert.equal(askToolLabel("delegate_to", { type: { id: "widget", widgetType: "acquit-held", widgetId: "w" } }), "Handing off to the widget builder");
  assert.equal(askToolLabel("delegate_to", { type: { id: "data" } }), "Handing off to the data agent");
  assert.equal(askToolLabel("delegate_to", { type: { id: "page" } }), "Handing off to the page agent");
  assert.equal(askToolLabel("something_else", {}), "something_else");
  assert.equal(askToolLabel("trace_figure", { figure: "held" }), "Tracing held escrow to its ledger lines");
  assert.equal(askToolLabel("trace_figure", { figure: "paid-by-clients" }), "Tracing paid by clients to its ledger lines");
  assert.equal(askToolLabel("trace_figure", { figure: "nope" }), "Tracing a figure to its ledger lines");
  assert.equal(askToolLabel("list_disputes", {}), "Reading PayPal's disputes");
  assert.equal(askToolLabel("get_dispute", { disputeId: "PP-D-1" }), "Reading dispute PP-D-1");
  assert.equal(askToolLabel("get_refund", { jobId: "job_7" }), "Reading the refund for job job_7");
  assert.equal(askToolLabel("get_refund", { refundId: "REF1" }), "Reading refund REF1");
  assert.equal(askToolLabel("list_transactions", {}), "Reading PayPal's recent transactions");
});

test("the Studio's ASK_TOOL_NAMES is the server's, read from its source", () => {
  const source = readFileSync(new URL("../../api/src/ask.ts", import.meta.url), "utf8");
  const declared = /export const ASK_TOOL_NAMES = (\[[\s\S]*?\]) as const;/.exec(source);
  assert.ok(declared, "the server declares ASK_TOOL_NAMES as a literal array");
  assert.deepEqual(JSON.parse(declared[1]!), [...ASK_TOOL_NAMES]);
});

test("a dispute and a refund read as cards: a title, the key fields as rows, PayPal ids in mono type", () => {
  assert.deepEqual(ledgerCard("get_dispute", { disputeId: "PP-D-1", status: "OPEN", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    amount: { currency: "USD", value: "378.00" }, createTime: "2026-03-02T10:00:00Z", transactionId: "TX1", outcome: null,
    evidenceCount: 2, offerAmount: null }), {
    title: "Dispute PP-D-1",
    rows: [
      { label: "Status", value: "OPEN" },
      { label: "Reason", value: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" },
      { label: "Amount", value: "378.00 USD" },
      { label: "Opened", value: "2026-03-02T10:00:00Z" },
      { label: "Seller transaction", value: "TX1", mono: "value" },
      { label: "Outcome", value: "None yet" },
      { label: "Evidence items", value: "2" },
      { label: "Buyer's offer", value: "None" },
    ],
  });
  assert.deepEqual(ledgerCard("get_refund", { refundId: "REF1", status: "COMPLETED", amount: { currency: "USD", value: "378.00" },
    createTime: "2026-03-05T09:00:00Z", merchantAsserted: true, note: null }), {
    title: "Refund",
    rows: [
      { label: "Refund", value: "REF1", mono: "value" },
      { label: "Status", value: "COMPLETED" },
      { label: "Amount", value: "378.00 USD" },
      { label: "Created", value: "2026-03-05T09:00:00Z" },
      { label: "Read under", value: "The merchant the book records" },
    ],
  });
  assert.equal(ledgerCard("list_jobs", {}), null, "a tool without a card has none");
});

test("an order reads as a card: its id, status, amount, capture, payee, and time, with PayPal ids in mono type", () => {
  // The recorded sandbox order from packages/core/test/paypal.test.ts. Its create_time is the order's own field, which PayPal's Orders v2 body carries; this fixture supplies it.
  const order = { id: "27T27404LP7444538", intent: "CAPTURE", status: "COMPLETED", create_time: "2026-10-07T00:33:02Z",
    purchase_units: [{ reference_id: "f2probe-prefer-1791333255794", amount: { currency_code: "USD", value: "420.00" },
      payee: { merchant_id: "D3SSQU3ZEN7R2" },
      payments: { captures: [{ id: "2GU594768B218031G", status: "COMPLETED", amount: { currency_code: "USD", value: "420.00" }, create_time: "2026-10-07T00:34:19Z" }] } }] };
  assert.deepEqual(ledgerCard("get_order", order), {
    title: "PayPal order",
    rows: [
      { label: "Order", value: "27T27404LP7444538", mono: "value" },
      { label: "Status", value: "COMPLETED" },
      { label: "Amount", value: "420.00 USD" },
      { label: "Capture", value: "2GU594768B218031G", mono: "value" },
      { label: "Capture status", value: "COMPLETED" },
      { label: "Payee", value: "D3SSQU3ZEN7R2", mono: "value" },
      { label: "Created", value: "2026-10-07T00:33:02Z" },
    ],
  });
});

test("an order without captures omits the capture rows, and a field it lacks is left out, never shown as undefined", () => {
  const unpaid = { id: "ORDER9", status: "CREATED", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" },
    payee: { email_address: "merchant@example.com" }, payments: { captures: [] } }] };
  assert.deepEqual(ledgerCard("get_order", unpaid), { title: "PayPal order", rows: [
    { label: "Order", value: "ORDER9", mono: "value" },
    { label: "Status", value: "CREATED" },
    { label: "Amount", value: "10.00 USD" },
    { label: "Payee", value: "merchant@example.com" },
  ] });
  assert.deepEqual(ledgerCard("get_order", { id: "ORDER10" }), { title: "PayPal order", rows: [{ label: "Order", value: "ORDER10", mono: "value" }] });
});

test("my payouts read as one row per payout up to ten, then a count row; an empty list says no payouts yet", () => {
  const payout = (n: number) => ({ jobId: `job_${n}`, payoutItemId: `ITEM${n}`, captureId: `CAP${n}`, paidCents: 36000,
    releasedAt: "2026-10-07T00:34:19Z", releaseAuthority: "PAYER" });
  assert.deepEqual(ledgerCard("my_payouts", { payouts: [] }), { title: "Your payouts", rows: [{ label: "Payouts", value: "No payouts yet" }] });
  const ten = ledgerCard("my_payouts", { payouts: Array.from({ length: 10 }, (_, i) => payout(i + 1)) });
  assert.equal(ten?.rows.length, 10, "ten payouts show ten rows and no count row");
  const twelve = ledgerCard("my_payouts", { payouts: Array.from({ length: 12 }, (_, i) => payout(i + 1)) });
  assert.equal(twelve?.title, "Your payouts");
  assert.deepEqual(twelve?.rows[0], { label: "ITEM1", value: "job_1, 360.00 USD, 2026-10-07T00:34:19Z", mono: "label" });
  assert.equal(twelve?.rows.length, 11, "the first ten payout rows and one count row");
  assert.deepEqual(twelve?.rows[10], { label: "Payouts", value: "12 in all; the first 10 are shown" });
});

test("my totals read as four rows, in dollars and counts", () => {
  assert.deepEqual(ledgerCard("my_totals", { paidOutCents: 36000, feesWithheldCents: 4485, jobsPaid: 1, heldCents: 0, heldJobs: 0 }), {
    title: "Your totals",
    rows: [
      { label: "Paid out", value: "360.00 USD" },
      { label: "Fees withheld", value: "44.85 USD" },
      { label: "Jobs paid", value: "1 job" },
      { label: "Held", value: "0.00 USD, 0 jobs" },
    ],
  });
});

test("the chat draws get_order and the operator's payouts and totals with the call card", () => {
  const cards: readonly string[] = LEDGER_CARD_TOOLS;
  for (const name of ["get_order", "my_payouts", "my_totals"]) assert.ok(cards.includes(name), `${name} is a card tool`);
  // The display map is in a .tsx file this test cannot import, so its wiring is read from source.
  const view = readFileSync(new URL("./studio/AskLedger.tsx", import.meta.url), "utf8");
  const display = /export const ASK_TOOL_DISPLAY_CARDS[\s\S]*?\r?\n\};/.exec(view)?.[0] ?? "";
  assert.ok(display.length > 0, "the display map is declared");
  assert.match(display, /LEDGER_CARD_TOOLS\.map\(/, "the map builds a row for each card tool");
  assert.match(display, /detail: LedgerCallCard/, "each of those rows draws the call card");
  // The earnings page and the escrow page share one Studio, so both chats take the same map.
  const page = readFileSync(new URL("./studio/StudioPage.tsx", import.meta.url), "utf8");
  assert.match(page, /aiToolDisplay=\{ask \? ASK_TOOL_DISPLAY_CARDS : undefined\}/);
});

test("a list reads as one row per item, and an empty list says so", () => {
  assert.deepEqual(ledgerCard("list_disputes", { disputes: [] }), { title: "PayPal disputes (0)", rows: [{ label: "Disputes", value: "None on this account" }] });
  assert.deepEqual(ledgerCard("list_disputes", { disputes: [{ disputeId: "PP-D-1", status: "OPEN", reason: "NOT_RECEIVED",
    amount: { currency: "USD", value: "378.00" }, createTime: "2026-03-02T10:00:00Z", transactionId: "TX1" }] }), {
    title: "PayPal disputes (1)", rows: [{ label: "PP-D-1", value: "OPEN, NOT_RECEIVED, 378.00 USD", mono: "label" }],
  });
  assert.deepEqual(ledgerCard("list_transactions", { transactions: [{ transactionId: "TX1", eventCode: "T0006", status: "S",
    amount: { currency: "USD", value: "-12.50" }, initiatedAt: "2026-03-30T08:00:00+0000" }] }), {
    title: "PayPal transactions (1)", rows: [{ label: "TX1", value: "T0006, S, -12.50 USD, 2026-03-30T08:00:00+0000", mono: "label" }],
  });
});

test("a PayPal read's card travels as the result's data, and the model still reads the JSON", async () => {
  const ctx = {
    ...toolCtx,
    success: (response: string, data?: unknown) => (data === undefined ? { success: true as const, response } : { success: true as const, response, data }),
  } as unknown as AgAiToolContext;
  const refund = { refundId: "REF1", status: null, amount: null, createTime: null, merchantAsserted: false, note: "not in the book" };
  assert.deepEqual(await runTool(async () => refund, "get_refund", { refundId: "REF1" }, ctx), {
    success: true,
    response: JSON.stringify(refund),
    data: { title: "Refund", rows: [
      { label: "Refund", value: "REF1", mono: "value" },
      { label: "Status", value: "Not shown" },
      { label: "Amount", value: "Not shown" },
      { label: "Created", value: "Not shown" },
      { label: "Read under", value: "The platform account, with no book record" },
      { label: "Note", value: "not in the book" },
    ] },
  });
});

test("trace_figure is one of the read-only ledger tools, and only its result carries data for the card", async () => {
  assert.ok(ASK_TOOL_NAMES.includes("trace_figure"));
  const trace = { figure: "fees", label: "Fees collected", totalCents: 300, lines: [] };
  const ctx = {
    ...toolCtx,
    success: (response: string, data?: unknown) => (data === undefined ? { success: true as const, response } : { success: true as const, response, data }),
  } as unknown as AgAiToolContext;
  const traced = await runTool(async () => trace, "trace_figure", { figure: "fees" }, ctx);
  assert.deepEqual(traced, { success: true, response: JSON.stringify(trace), data: trace });
  const listed = await runTool(async () => ({ jobs: [] }), "list_jobs", {}, ctx);
  assert.deepEqual(listed, { success: true, response: '{"jobs":[]}' }, "a tool off the card list sends no data");
});

test("the prompt starters include the validation question", () => {
  assert.ok(ASK_PROMPT_STARTERS.some((starter) => starter.prompt === ASK_VALIDATION_QUESTION));
  assert.equal(ASK_VALIDATION_QUESTION, "How much escrow is held right now, and does PayPal agree?");
});

test("the drawer's rows carry text, labelled steps and errors, and skip reasoning", () => {
  const messages: AgAiChatMessage[] = [
    { id: "u", role: "user", createdAt: 0, parts: [{ type: "text", text: "Held?" }] },
    { id: "r", role: "assistant", createdAt: 1, parts: [{ type: "reasoning", text: "hmm" }] },
    {
      id: "k",
      role: "assistant",
      createdAt: 2,
      parts: [{ type: "tool_call", toolCall: { toolCallId: "k", name: "get_order", status: "executing", args: { id: "O1" } } }],
    },
    { id: "k2", role: "assistant", createdAt: 3, parts: [{ type: "tool_call", toolCall: { toolCallId: "k2", name: "list_jobs", status: "complete", args: {} } }] },
    { id: "a", role: "assistant", createdAt: 4, parts: [{ type: "text", text: "$50.00 held; PayPal agrees." }] },
    { id: "e", role: "assistant", createdAt: 5, parts: [{ type: "error", message: "No key." }] },
  ];
  assert.deepEqual(askRows(messages), [
    { kind: "text", key: "u-0", role: "user", text: "Held?" },
    { kind: "step", key: "k-0", label: "Asking PayPal for order O1", state: "running" },
    { kind: "step", key: "k2-0", label: "Reading the ledger", state: "done" },
    { kind: "text", key: "a-0", role: "assistant", text: "$50.00 held; PayPal agrees." },
    { kind: "error", key: "e-0", text: "No key." },
  ]);
});

test("a delegation the child failed shows failed in the panel, not done", () => {
  const messages: AgAiChatMessage[] = [
    { id: "d1", role: "assistant", createdAt: 1, parts: [{ type: "tool_call", toolCall: { toolCallId: "d", name: "delegate_to", status: "complete", args: { type: { id: "widget", widgetType: "acquit-held", widgetId: "held-escrow-main" } }, result: { success: false, issues: [{ message: "The delegate did not complete: the child turn was refused." }] } } }] },
    { id: "d2", role: "assistant", createdAt: 2, parts: [{ type: "tool_call", toolCall: { toolCallId: "d2", name: "delegate_to", status: "complete", args: {}, result: { success: true, response: "Added widget held-escrow-main." } } }] },
  ];
  assert.deepEqual(askRows(messages), [
    { kind: "step", key: "d1-0", label: "Handing off to the widget builder", state: "failed" },
    { kind: "step", key: "d2-0", label: "Handing off to the widget builder", state: "done" },
  ]);
});

test("a traced figure reads as its step and then as the figure card, and a refused trace reads as a failed step alone", () => {
  const trace = { figure: "fees", label: "Fees collected", totalCents: 300, lines: [] };
  const messages: AgAiChatMessage[] = [
    { id: "f1", role: "assistant", createdAt: 1, parts: [{ type: "tool_call", toolCall: { toolCallId: "f", name: "trace_figure", status: "complete", args: { figure: "fees" }, result: { success: true, response: "{}", data: trace } } }] },
    { id: "f2", role: "assistant", createdAt: 2, parts: [{ type: "tool_call", toolCall: { toolCallId: "g", name: "trace_figure", status: "complete", args: { figure: "fees" }, result: { success: false, issues: [{ message: "no" }] } } }] },
  ];
  assert.deepEqual(askRows(messages), [
    { kind: "step", key: "f1-0", label: "Tracing fees collected to its ledger lines", state: "done" },
    { kind: "figure", key: "f1-0-figure", trace },
    { kind: "step", key: "f2-0", label: "Tracing fees collected to its ledger lines", state: "failed" },
  ]);
});

test("Ask the ledger takes a question only with a model key on the server and an open conversation", () => {
  assert.deepEqual(askGate({ kind: "ready", keyConfigured: true }, true), { ready: true, keyMissing: false });
  assert.deepEqual(askGate({ kind: "ready", keyConfigured: false }, true), { ready: false, keyMissing: true });
  assert.deepEqual(askGate({ kind: "ready", keyConfigured: true }, false), { ready: false, keyMissing: false });
  assert.deepEqual(askGate({ kind: "loading" }, true), { ready: false, keyMissing: false });
  assert.deepEqual(askGate({ kind: "failed" }, true), { ready: false, keyMissing: false });
});
