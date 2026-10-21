import type {
  AgAiChatMessage,
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgAiParamsBuilder,
  AgAiPromptStarter,
  AgAiRunStatus,
  AgAiTool,
  AgAiToolContext,
  AgAiToolResult,
  AgLlmAdapter,
  AgLlmRequest,
  AgLlmResponse,
  AgStudioApi,
} from "ag-studio";
import type { AgAiToolDisplay } from "ag-studio-react";
import type { AskMessage, AskToolSchema, AskTurnRequest, AskTurnResponse, FigureTrace } from "./api-types";
import { api, ApiError } from "./api.ts";
import type { DashboardId } from "./dashboard-widgets.ts";
import { FIGURE_LABELS, isFigureId } from "../../../packages/core/src/explain.ts";
import { isFigureTrace } from "./figure-trace.ts";
import { shortId, usd } from "./format.ts";

export const ASK_AGENT_ID = "ask-ledger";
export const ASK_AGENT_NAME = "Ask the ledger";
export const ASK_VALIDATION_QUESTION = "How much escrow is held right now, and does PayPal agree?";

// An agent that checks the book and PayPal needs about three rounds: totals, the held jobs' orders,
// the answer. A few spare cover a delegation, and anything longer is a loop that will not settle.
export const ASK_MAX_TURNS = 6;

export const ASK_INSTRUCTIONS = [
  "You are Ask the ledger, the agent on Acquit's platform escrow dashboard.",
  "You answer questions about Acquit's ledger and PayPal's view of it, from your tools alone; never answer from memory or guess a figure.",
  "Before you answer, check the book (platform_totals, list_jobs, get_job) and check PayPal (get_order on each held job's capture.orderId).",
  "When the reader asks about disputes, refunds, or recent payments, read PayPal with list_disputes, get_dispute, get_refund, or list_transactions; PayPal lists a new transaction about three hours late, and you say so.",
  "Give amounts in dollars, name the jobs and PayPal order ids you checked, and when the book and PayPal disagree, say so plainly with both figures.",
  "You only read. You cannot capture, refund, release or pay out money, and you never claim to have done so.",
  "When the reader wants a widget or chart, delegate it to the widget agent with delegate_to rather than building it yourself.",
  "When the reader asks a question the escrow tables answer across jobs, operators, bids, verdicts, or PayPal events, delegate it to the data agent with delegate_to.",
  "When the reader asks to change what the page shows or how it is laid out, delegate it to the page agent with delegate_to.",
  "delegate_to is always available. Say a delegation failed only when its result reports an error (the delegate_to result in this conversation), and then say why.",
].join("\n");

const DELEGATION_RECIPE = [
  "## Delegating a widget",
  'Call delegate_to exactly in this shape: {"type": {"id": "widget", "widgetType": "<a type from the catalogue>", "widgetId": "<a short new id for a new widget, or the id of the widget to change>"}, "instructions": "<what the widget should show>"}.',
  "The widget agent adds the widget if it is new, then configures it.",
  "If no catalogue type fits the request, decline and name the closest types instead of delegating.",
  "Report its result honestly: when it reports an error, tell the reader the widget was not made and why. Never claim the widget was made unless its result says so.",
].join("\n");

/** The data and page agents are Studio's built-ins; the ledger agent hands them questions and changes the same way. */
const DATA_AND_PAGE_RECIPES = [
  "## Delegating a question to the data agent",
  'Call delegate_to exactly in this shape: {"type": {"id": "data"}, "instructions": "<the question as the reader asked it>"}.',
  "The data agent answers from the escrow tables. Report its answer and the figures it gives. When its result reports an error, say the question was not answered and why.",
  "## Delegating a change to the page agent",
  'Call delegate_to exactly in this shape: {"type": {"id": "page"}, "instructions": "<the change the reader asked for>"}.',
  "Report its result honestly: when it reports an error, tell the reader the page was not changed and why. Never claim the page was changed unless its result says so.",
].join("\n");

/** The ledger agent's prompt, naming the widget types the dashboard publishes so a delegation picks a real one. */
export function askInstructions(catalogue: readonly { readonly type: string; readonly description?: string }[]): string {
  if (catalogue.length === 0) {
    return `${ASK_INSTRUCTIONS}\n\nThe dashboard currently publishes no widget types, so decline a widget request rather than delegating it.\n\n${DATA_AND_PAGE_RECIPES}`;
  }
  const entries = catalogue.map((entry) => (entry.description ? `- ${entry.type}: ${entry.description}` : `- ${entry.type}`));
  return [ASK_INSTRUCTIONS, ["## Widget catalogue", ...entries].join("\n"), DELEGATION_RECIPE, DATA_AND_PAGE_RECIPES].join("\n\n");
}

export const ASK_PROMPT_STARTERS: AgAiPromptStarter[] = [
  { label: "Escrow held vs PayPal", prompt: ASK_VALIDATION_QUESTION },
  {
    label: "A held job's PayPal order",
    prompt: "Pick one job that holds escrow and show me its PayPal order: its status, its capture, and whether the amount matches the book.",
  },
];

// The turn route's own bounds (apps/api/src/server.ts readAskMessages and the turn body). Anything
// past them is refused whole, so the conversation is trimmed to fit rather than sent to fail.
const MAX_MESSAGES = 64;
const MAX_CONTENT = 16_000;
const MAX_TOOL_RESULT = 32_000;
const MAX_ARGUMENTS = 16_000;
const MAX_ID = 100;
// The turn route's instruction bound (apps/api/src/server.ts). Studio's widget template alone is 8,490
// characters, so a lower cap clips it.
const MAX_INSTRUCTIONS = 16_000;

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
const present = (text: string | undefined): text is string => text !== undefined && text.trim() !== "";

/**
 * The loop's conversation as the turn route reads it. An output message and the calls that follow
 * it are one assistant message, as a chat transcript records them; reasoning is the model's own and
 * is not sent back.
 */
export function toAskMessages(items: readonly AgAiConversationItem[]): AskMessage[] {
  const messages: AskMessage[] = [];
  let assistant: { id: string; content: string; toolCalls: { id: string; function: { name: string; arguments: string } }[] } | null = null;
  const flush = () => {
    if (!assistant) return;
    const content = present(assistant.content) ? clip(assistant.content, MAX_CONTENT) : undefined;
    if (content !== undefined || assistant.toolCalls.length > 0) {
      messages.push({
        id: assistant.id,
        role: "assistant",
        ...(content === undefined ? {} : { content }),
        ...(assistant.toolCalls.length === 0 ? {} : { toolCalls: assistant.toolCalls }),
      });
    }
    assistant = null;
  };
  items.forEach((item, index) => {
    const fallbackId = `item-${index}`;
    switch (item.type) {
      case "message": {
        if (item.kind === "input") {
          flush();
          const content = item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
          if (present(content)) messages.push({ id: idOf(item.id, fallbackId), role: item.role, content: clip(content, MAX_CONTENT) });
          return;
        }
        flush();
        const text = item.content.map((part) => (part.type === "text" ? part.text : part.refusal)).join("\n");
        assistant = { id: idOf(item.id, fallbackId), content: text, toolCalls: [] };
        return;
      }
      case "function_call": {
        assistant ??= { id: idOf(item.id, fallbackId), content: "", toolCalls: [] };
        assistant.toolCalls.push({
          id: idOf(item.callId, fallbackId),
          function: { name: item.name, arguments: clip(present(item.arguments) ? item.arguments : "{}", MAX_ARGUMENTS) },
        });
        return;
      }
      case "function_call_output": {
        flush();
        const callId = idOf(item.callId, fallbackId);
        messages.push({
          id: idOf(item.id, `${callId}-result`),
          role: "tool",
          toolCallId: callId,
          content: clip(present(item.output) ? item.output : "(no output)", MAX_TOOL_RESULT),
        });
        return;
      }
      case "reasoning":
        return;
    }
  });
  flush();
  return fitWindow(messages);
}

function idOf(id: string | undefined, fallback: string): string {
  return clip(present(id) ? id : fallback, MAX_ID);
}

/** The newest messages the route accepts, never opening on a tool result whose call was cut off. */
function fitWindow(messages: AskMessage[]): AskMessage[] {
  if (messages.length <= MAX_MESSAGES) return messages;
  const tail = messages.slice(-MAX_MESSAGES);
  while (tail.length > 0 && tail[0]?.role === "tool") tail.shift();
  return tail;
}

/**
 * One relayed turn as the loop reads it. Call ids are minted here rather than taken from the model:
 * the transcript keys a call's row by its id across the whole thread, and a model reuses "1" every
 * turn.
 */
export function fromAskTurn(turn: AskTurnResponse, ids: { response: string; createdAt: number }): AgLlmResponse {
  const output: AgAiOutputItem[] = [];
  if (turn.message !== null && turn.message.trim() !== "") {
    output.push({
      id: `${ids.response}-message`,
      kind: "output",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "text", text: turn.message, annotations: [] }],
    });
  }
  turn.calls.forEach((call, index) => {
    const callId = `${ids.response}-call-${index}`;
    output.push({
      id: callId,
      kind: "output",
      type: "function_call",
      callId,
      name: call.name,
      arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
      status: "completed",
    });
  });
  return { id: ids.response, createdAt: ids.createdAt, status: "completed", output, model: turn.model };
}

/** A turn the route refused, as a failed response: the loop throws its message as the run's error. */
export function failedTurn(error: unknown, ids: { response: string; createdAt: number }, aborted: boolean): AgLlmResponse {
  const base = { id: ids.response, createdAt: ids.createdAt, output: [] };
  if (aborted) return { ...base, status: "cancelled", error: { code: "CANCELLED", message: "The question was cancelled." } };
  if (error instanceof ApiError) return { ...base, status: "failed", error: { code: error.code, message: askErrorText(error) } };
  return { ...base, status: "failed", error: { code: "NETWORK", message: `The server could not be reached: ${errorMessage(error)}` } };
}

export function askErrorText(error: ApiError): string {
  const detail = error.detail ? ` (${error.detail})` : "";
  switch (error.code) {
    case "MODEL_KEY_MISSING":
      return "Ask the ledger has no model key on the server, so it cannot answer yet.";
    case "MODEL_RATE_LIMITED":
      return `The model is rate limited right now. Try again in a minute.${detail}`;
    // A 429 for MODEL_BUDGET is either the shared budget or an operator's own turn limit, so the copy names neither.
    case "MODEL_BUDGET":
      return "Ask the ledger is out of model budget for now. Try again later.";
    case "MODEL_PROVIDER_ERROR":
      return `The model provider failed to answer.${detail}`;
    case "BAD_REQUEST":
      return `The server refused the conversation.${detail}`;
    case "PLATFORM_ONLY":
      return "Ask the ledger is for the platform role only.";
  }
  if (error.status === 401) return "Your session has ended. Sign in again to ask the ledger.";
  return `${error.code}${detail}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The content events the transcript is built from. The loop reads calls off `output`, but the chat
 * session renders only what the stream carries, so every item is replayed as events. */
export function eventsFor(output: readonly AgAiOutputItem[]): AgAiEvent[] {
  const events: AgAiEvent[] = [];
  for (const item of output) {
    if (item.type === "message") {
      const text = item.content.map((part) => (part.type === "text" ? part.text : part.refusal)).join("\n");
      events.push(
        { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text },
        { type: "TEXT_MESSAGE_END", messageId: item.id },
      );
    } else if (item.type === "function_call") {
      events.push(
        { type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name },
        { type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments },
        { type: "TOOL_CALL_END", toolCallId: item.callId },
      );
    }
  }
  return events;
}

export type AskAdapterDeps = {
  readonly fetch?: typeof fetch;
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly dashboard?: DashboardId;
  readonly renderedCount?: (type: string) => number;
  readonly renderWaitMs?: number;
};

let minted = 0;
const mintId = () => `ask-${Date.now().toString(36)}-${(++minted).toString(36)}`;

/**
 * The model boundary for every agent on the dashboard: one turn, relayed through the app's own
 * route. The server picks the model and holds the key; this never names a provider.
 */
export function askLedgerAdapter(deps: AskAdapterDeps = {}): AgLlmAdapter {
  const newId = deps.newId ?? mintId;
  const now = deps.now ?? Date.now;
  return {
    executeTurn(request: AgLlmRequest, options) {
      const signal = options?.signal;
      const ids = { response: newId(), createdAt: now() };
      // Never rejects: a refused or failed turn is a response the loop reads, not a thrown promise
      // that would also surface as an unhandled rejection when nothing awaits `complete`.
      const complete = api.askLedgerTurn(toAskTurnBody(request), { signal, fetch: deps.fetch }).then(
        (turn) => fromAskTurn(turn, ids),
        (error: unknown) => failedTurn(error, ids, signal?.aborted === true),
      );
      async function* stream(): AsyncGenerator<AgAiEvent> {
        yield* eventsFor((await complete).output);
      }
      return { stream: stream(), complete };
    },
  };
}

export function toAskTurnBody(request: AgLlmRequest): AskTurnRequest {
  const messages = toAskMessages(request.input);
  // The route caps instructions; a built-in agent's long prompt is cut to fit rather than refused.
  const instructions = present(request.instructions) ? clip(request.instructions, MAX_INSTRUCTIONS) : undefined;
  // The loop's own tool schemas ride along: the agent's read tools plus the harness's delegate_to,
  // so a delegated widget run is offered its tools. The server shapes the prompt with them; what
  // can execute stays gated there and in the loop.
  const tools = (request.tools ?? []).slice(0, 32).map((tool) => ({
    name: clip(tool.name, 60),
    description: clip(tool.description, 2000),
    parameters: tool.parameters,
  }));
  return {
    messages,
    ...(instructions === undefined ? {} : { instructions }),
    ...(tools.length === 0 ? {} : { tools }),
  };
}

// ---- tools ---------------------------------------------------------------------------------------

export type AskParamField = { readonly name: string; readonly type: "string" | "number" | "boolean"; readonly description?: string; readonly required: boolean };

/** The parameters a served tool schema declares, in the scalar types its shape can be built from. */
export function askParamFields(parameters: Record<string, unknown>): AskParamField[] {
  const properties = parameters["properties"];
  if (typeof properties !== "object" || properties === null) return [];
  const required = new Set(Array.isArray(parameters["required"]) ? parameters["required"].filter((key): key is string => typeof key === "string") : []);
  return Object.entries(properties as Record<string, unknown>).flatMap(([name, raw]) => {
    if (typeof raw !== "object" || raw === null) return [];
    const { type, description } = raw as { type?: unknown; description?: unknown };
    if (type !== "string" && type !== "number" && type !== "boolean") return [];
    return [{ name, type, required: required.has(name), ...(typeof description === "string" ? { description } : {}) }];
  });
}

export type AskToolCaller = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

const callTool: AskToolCaller = async (name, args, signal) => (await api.askLedgerTool(name, args, { signal })).result;

/** The served read-only tools as Studio tools, each executed by the app's own tool route. */
export function buildAskTools(studio: Pick<AgStudioApi, "defineAiTool">, specs: readonly AskToolSchema[], call: AskToolCaller = callTool): AgAiTool[] {
  return specs.map((spec) => {
    const fields = askParamFields(spec.parameters);
    return studio.defineAiTool({
      name: spec.name,
      description: spec.description,
      params: (s: AgAiParamsBuilder) => s.object(shapeFields(s, fields)) as never,
      execute: (args: Record<string, unknown>, ctx: AgAiToolContext) => runTool(call, spec.name, args, ctx),
    });
  });
}

function shapeFields(s: AgAiParamsBuilder, fields: readonly AskParamField[]) {
  const shapes: Record<string, ReturnType<AgAiParamsBuilder["string"]> | ReturnType<AgAiParamsBuilder["number"]> | ReturnType<AgAiParamsBuilder["boolean"]>> = {};
  for (const field of fields) {
    const options = field.description === undefined ? undefined : { description: field.description };
    const shape = field.type === "string" ? s.string(options) : field.type === "number" ? s.number(options) : s.boolean(options);
    shapes[field.name] = (field.required ? shape : shape.optional()) as typeof shape;
  }
  return shapes;
}

/** Tools whose result a Studio card draws from `data`. The model reads only the response text, which is the same either way. */
const CARD_TOOLS: readonly string[] = ["trace_figure"];

export async function runTool(call: AskToolCaller, name: string, args: Record<string, unknown>, ctx: AgAiToolContext): Promise<AgAiToolResult> {
  try {
    const value = (await call(name, args ?? {}, ctx.signal)) ?? null;
    const text = JSON.stringify(value);
    const card = ledgerCard(name, value);
    if (card !== null) return ctx.success(text, card);
    return CARD_TOOLS.includes(name) ? ctx.success(text, value) : ctx.success(text);
  } catch (error) {
    return ctx.error([error instanceof ApiError ? (error.detail ?? askErrorText(error)) : errorMessage(error)]);
  }
}

// ---- presentation -------------------------------------------------------------------------------

/** The words on a tool call's row, in the Studio panel and in the app's own drawer alike. */
export function askToolLabel(name: string, args: Partial<Record<string, unknown>>): string {
  const named = (key: string) => {
    const value = args[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  switch (name) {
    case "list_jobs":
      return "Reading the ledger";
    case "get_job": {
      const id = named("jobId");
      return id ? `Reading job ${id}` : "Reading a job";
    }
    case "platform_totals":
      return "Totalling the book";
    case "get_order": {
      const id = named("id");
      return id ? `Asking PayPal for order ${id}` : "Asking PayPal for an order";
    }
    case "list_disputes":
      return "Reading PayPal's disputes";
    case "get_dispute": {
      const id = named("disputeId");
      return id ? `Reading dispute ${id}` : "Reading a dispute";
    }
    case "get_refund": {
      const job = named("jobId");
      if (job) return `Reading the refund for job ${job}`;
      const id = named("refundId");
      return id ? `Reading refund ${id}` : "Reading a refund";
    }
    case "list_transactions":
      return "Reading PayPal's recent transactions";
    case "my_jobs":
      return "Reading your jobs";
    case "my_job": {
      const id = named("jobId");
      return id ? `Reading your job ${id}` : "Reading one of your jobs";
    }
    case "my_payouts":
      return "Reading your payouts";
    case "my_totals":
      return "Totalling your earnings";
    case "delegate_to": {
      const type = args.type;
      const id = typeof type === "object" && type !== null ? (type as { id?: unknown }).id : undefined;
      if (id === "data") return "Handing off to the data agent";
      if (id === "page") return "Handing off to the page agent";
      return "Handing off to the widget builder";
    }
    case "trace_figure": {
      const figure = args.figure;
      return isFigureId(figure) ? `Tracing ${FIGURE_LABELS[figure].toLowerCase()} to its ledger lines` : "Tracing a figure to its ledger lines";
    }
    default:
      return name;
  }
}

// Kept equal to the server's ASK_TOOL_NAMES (apps/api/src/ask.ts). The web program cannot import that module, so
// ask-ledger.test.ts reads the server's array from its source and compares.
export const ASK_TOOL_NAMES = ["list_jobs", "get_job", "platform_totals", "get_order", "list_disputes", "get_dispute", "get_refund",
  "list_transactions", "trace_figure"] as const;

/** Which dashboard's ask a harness serves: the platform's escrow book, or one operator's own earnings. */
export type AskScope = "PLATFORM" | "OPERATOR";

// Kept equal to the server's OPERATOR_ASK_TOOL_NAMES, which ask-ledger.test.ts reads from the server's source.
export const OPERATOR_ASK_TOOL_NAMES = ["my_jobs", "my_job", "my_payouts", "my_totals"] as const;

/** How the Studio chat panel words the ledger tools' rows, the platform's and an operator's; Studio's own tools keep theirs. */
export const ASK_TOOL_DISPLAY: Record<string, AgAiToolDisplay> = Object.fromEntries(
  [...ASK_TOOL_NAMES, ...OPERATOR_ASK_TOOL_NAMES].map((name) => [name, { label: ({ args }) => ({ text: askToolLabel(name, args) }), hidden: false } satisfies AgAiToolDisplay]),
);

/** An operator's ask: its own money only. The model is told its tools reach that operator's jobs alone, and it has no delegation. */
export const OPERATOR_ASK_INSTRUCTIONS = [
  "You are Ask the ledger, the agent on an operator's earnings dashboard on Acquit.",
  "You answer questions about the signed-in operator's own jobs, payouts, and totals, from your tools alone; never answer from memory or guess a figure.",
  "Your tools reach only this operator's own jobs. If a question needs anything else, say that you cannot see it.",
  "Check my_totals for totals, my_jobs for the list, my_job for one job by id, and my_payouts for payouts before you answer.",
  "Give amounts in dollars, name the jobs you checked, and say which money is still held and which has been paid.",
  "You only read. You cannot release, refund, or pay out money, and you never claim to have done so.",
].join("\n");

export const OPERATOR_ASK_PROMPT_STARTERS: AgAiPromptStarter[] = [
  { label: "What did I earn this week?", prompt: "What did I earn this week? Check your payouts and totals." },
  { label: "Which of my jobs are still held?", prompt: "Which of my jobs are still held, and how much is held for me?" },
];

// ---- the PayPal cards ---------------------------------------------------------------------------

/** The tools whose answer the Studio chat draws as a card: PayPal's order and reads, and an operator's payouts and totals. The model reads the same JSON either way. */
export const LEDGER_CARD_TOOLS = ["get_order", "list_disputes", "get_dispute", "get_refund", "list_transactions", "my_payouts", "my_totals"] as const;

/** One card row. `mono` sets the label or the value in monospace, for a PayPal id. */
export type LedgerCardRow = { readonly label: string; readonly value: string; readonly mono?: "label" | "value" };
export type LedgerCard = { readonly title: string; readonly rows: readonly LedgerCardRow[] };

export function isLedgerCard(value: unknown): value is LedgerCard {
  if (typeof value !== "object" || value === null) return false;
  const card = value as { title?: unknown; rows?: unknown };
  return typeof card.title === "string" && Array.isArray(card.rows);
}

type Wire = Record<string, unknown>;
const wire = (value: unknown): Wire => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Wire : {});
const wireList = (value: unknown): Wire[] => (Array.isArray(value) ? value.map(wire) : []);
const wireText = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
// PayPal's order amounts carry currency_code; the server's money carries currency.
const moneyText = (value: unknown): string | null => {
  const amount = wireText(wire(value).value);
  return amount === null ? null : [amount, wireText(wire(value).currency) ?? wireText(wire(value).currency_code)].filter((part) => part !== null).join(" ");
};
const joined = (parts: readonly (string | null)[]): string => parts.filter((part): part is string => part !== null).join(", ");
/** How many payouts the card lists before its count row. */
const PAYOUT_ROWS = 10;
/** Cents as the ledger's USD text, or null when the wire carries no number. */
const centsText = (value: unknown): string | null => (typeof value === "number" && Number.isFinite(value) ? usd(value) : null);
/** A count with its noun, singular for one, or null when the wire carries no number. */
const countText = (value: unknown, noun: string): string | null => (typeof value === "number" && Number.isFinite(value) ? `${value} ${noun}${value === 1 ? "" : "s"}` : null);

/** A PayPal tool's answer as its card: a title and the key fields as rows. Null for any other tool. */
export function ledgerCard(name: string, value: unknown): LedgerCard | null {
  const body = wire(value);
  switch (name) {
    case "list_disputes": {
      const disputes = wireList(body.disputes);
      return {
        title: `PayPal disputes (${disputes.length})`,
        rows: disputes.length === 0 ? [{ label: "Disputes", value: "None on this account" }]
          : disputes.map((dispute): LedgerCardRow => ({ label: wireText(dispute.disputeId) ?? "Dispute",
            value: joined([wireText(dispute.status), wireText(dispute.reason), moneyText(dispute.amount)]), mono: "label" })),
      };
    }
    case "get_dispute":
      return { title: `Dispute ${wireText(body.disputeId) ?? ""}`.trim(), rows: [
        { label: "Status", value: wireText(body.status) ?? "Not shown" },
        { label: "Reason", value: wireText(body.reason) ?? "Not shown" },
        { label: "Amount", value: moneyText(body.amount) ?? "Not shown" },
        { label: "Opened", value: wireText(body.createTime) ?? "Not shown" },
        { label: "Seller transaction", value: wireText(body.transactionId) ?? "Not shown", mono: "value" },
        { label: "Outcome", value: wireText(body.outcome) ?? "None yet" },
        { label: "Evidence items", value: typeof body.evidenceCount === "number" ? String(body.evidenceCount) : "Not shown" },
        { label: "Buyer's offer", value: moneyText(body.offerAmount) ?? "None" },
      ] };
    case "get_refund": {
      const rows: LedgerCardRow[] = [
        { label: "Refund", value: wireText(body.refundId) ?? "Not shown", mono: "value" },
        { label: "Status", value: wireText(body.status) ?? "Not shown" },
        { label: "Amount", value: moneyText(body.amount) ?? "Not shown" },
        { label: "Created", value: wireText(body.createTime) ?? "Not shown" },
        { label: "Read under", value: body.merchantAsserted === true ? "The merchant the book records" : "The platform account, with no book record" },
      ];
      const note = wireText(body.note);
      if (note !== null) rows.push({ label: "Note", value: note });
      return { title: "Refund", rows };
    }
    case "get_order": {
      // PayPal's order body. Its one purchase unit carries the amount, the payee, and the capture; a field the order lacks is left out.
      const unit: Wire = wireList(body.purchase_units)[0] ?? {};
      const capture: Wire = wireList(wire(unit.payments).captures)[0] ?? {};
      const payee = wire(unit.payee);
      const rows: LedgerCardRow[] = [];
      const orderId = wireText(body.id);
      if (orderId !== null) rows.push({ label: "Order", value: orderId, mono: "value" });
      const status = wireText(body.status);
      if (status !== null) rows.push({ label: "Status", value: status });
      const amount = moneyText(unit.amount);
      if (amount !== null) rows.push({ label: "Amount", value: amount });
      const captureId = wireText(capture.id);
      if (captureId !== null) rows.push({ label: "Capture", value: captureId, mono: "value" });
      const captureStatus = wireText(capture.status);
      if (captureStatus !== null) rows.push({ label: "Capture status", value: captureStatus });
      const merchant = wireText(payee.merchant_id);
      const email = wireText(payee.email_address);
      if (merchant !== null) rows.push({ label: "Payee", value: merchant, mono: "value" });
      else if (email !== null) rows.push({ label: "Payee", value: email });
      const created = wireText(body.create_time);
      if (created !== null) rows.push({ label: "Created", value: created });
      return { title: "PayPal order", rows };
    }
    case "my_payouts": {
      const payouts = wireList(body.payouts);
      if (payouts.length === 0) return { title: "Your payouts", rows: [{ label: "Payouts", value: "No payouts yet" }] };
      const rows: LedgerCardRow[] = payouts.slice(0, PAYOUT_ROWS).map((payout): LedgerCardRow => {
        const job = wireText(payout.jobId);
        return { label: wireText(payout.payoutItemId) ?? "Payout",
          value: joined([job === null ? null : shortId(job), centsText(payout.paidCents), wireText(payout.releasedAt)]), mono: "label" };
      });
      if (payouts.length > PAYOUT_ROWS) rows.push({ label: "Payouts", value: `${payouts.length} in all; the first ${PAYOUT_ROWS} are shown` });
      return { title: "Your payouts", rows };
    }
    case "my_totals": {
      const rows: LedgerCardRow[] = [];
      const paidOut = centsText(body.paidOutCents);
      if (paidOut !== null) rows.push({ label: "Paid out", value: paidOut });
      const fees = centsText(body.feesWithheldCents);
      if (fees !== null) rows.push({ label: "Fees withheld", value: fees });
      const jobsPaid = countText(body.jobsPaid, "job");
      if (jobsPaid !== null) rows.push({ label: "Jobs paid", value: jobsPaid });
      const held = joined([centsText(body.heldCents), countText(body.heldJobs, "job")]);
      if (held !== "") rows.push({ label: "Held", value: held });
      return { title: "Your totals", rows };
    }
    case "list_transactions": {
      const transactions = wireList(body.transactions);
      return {
        title: `PayPal transactions (${transactions.length})`,
        rows: transactions.length === 0 ? [{ label: "Transactions", value: "None in this window" }]
          : transactions.map((transaction): LedgerCardRow => ({ label: wireText(transaction.transactionId) ?? "Transaction",
            value: joined([wireText(transaction.eventCode), wireText(transaction.status), moneyText(transaction.amount), wireText(transaction.initiatedAt)]),
            mono: "label" })),
      };
    }
    default:
      return null;
  }
}

export function askStatusText(status: AgAiRunStatus): string {
  switch (status) {
    case "running":
      return "Checking the book and PayPal…";
    case "error":
      return "The last question did not finish.";
    case "awaiting_input":
      return "Waiting for your answer.";
    case "idle":
      return "Ready for a question.";
  }
}

/**
 * Whether the drawer can take a question. Without a model key on the server the conversation still
 * opens, but no question can be answered, so the starters and Send stay off and the drawer says why.
 */
export function askGate(
  load: { readonly kind: "loading" } | { readonly kind: "ready"; readonly keyConfigured: boolean } | { readonly kind: "failed" },
  sessionOpen: boolean,
): { readonly ready: boolean; readonly keyMissing: boolean } {
  const keyMissing = load.kind === "ready" && !load.keyConfigured;
  return { ready: sessionOpen && load.kind === "ready" && !keyMissing, keyMissing };
}

/** One transcript row as the drawer renders it. */
export type AskRow =
  | { readonly kind: "text"; readonly key: string; readonly role: "user" | "assistant" | "system"; readonly text: string }
  | { readonly kind: "step"; readonly key: string; readonly label: string; readonly state: "running" | "done" | "failed" | "cancelled" }
  | { readonly kind: "figure"; readonly key: string; readonly trace: FigureTrace }
  | { readonly kind: "error"; readonly key: string; readonly text: string };

/** trace_figure's answer, when it is a figure the drawer can show as a card. */
function figureOf(name: string, result: unknown): FigureTrace | null {
  if (name !== "trace_figure" || typeof result !== "object" || result === null) return null;
  const data = (result as { data?: unknown }).data;
  return isFigureTrace(data) ? data : null;
}

export function askRows(messages: readonly AgAiChatMessage[]): AskRow[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part, index): AskRow[] => {
      const key = `${message.id}-${index}`;
      switch (part.type) {
        case "text":
          return part.text.trim() === "" ? [] : [{ kind: "text", key, role: message.role, text: part.text }];
        case "tool_call": {
          const { status, result } = part.toolCall;
          // A tool that returns Studio's failure shape still settles at "complete".
          const reportedFailure = typeof result === "object" && result !== null && (result as { success?: unknown }).success === false;
          const state = reportedFailure ? "failed" : status === "complete" ? "done" : status === "error" ? "failed" : status === "cancelled" ? "cancelled" : "running";
          const step: AskRow = { kind: "step", key, label: askToolLabel(part.toolCall.name, part.toolCall.args), state };
          const trace = reportedFailure ? null : figureOf(part.toolCall.name, result);
          return trace === null ? [step] : [step, { kind: "figure", key: `${key}-figure`, trace }];
        }
        case "error":
          return [{ kind: "error", key, text: part.message }];
        case "reasoning":
          return [];
      }
    }),
  );
}
