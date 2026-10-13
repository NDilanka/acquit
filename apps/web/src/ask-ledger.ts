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
import type { AskMessage, AskToolSchema, AskTurnRequest, AskTurnResponse } from "./api-types";
import { api, ApiError } from "./api.ts";

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
  "Give amounts in dollars, name the jobs and PayPal order ids you checked, and when the book and PayPal disagree, say so plainly with both figures.",
  "You only read. You cannot capture, refund, release or pay out money, and you never claim to have done so.",
  "When the reader wants a widget or chart, delegate it to the widget agent with delegate_to rather than building it yourself.",
  'Call delegate_to exactly in its schema\'s shape: {"type": {"id": "widget"}, "instructions": "<the task>"}. The delegate\'s id rides inside the type object.',
].join("\n");

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
const MAX_INSTRUCTIONS = 4_000;

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
    case "MODEL_BUDGET":
      return "The deployment's shared model budget is spent for now. Try again later.";
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

export async function runTool(call: AskToolCaller, name: string, args: Record<string, unknown>, ctx: AgAiToolContext): Promise<AgAiToolResult> {
  try {
    return ctx.success(JSON.stringify((await call(name, args ?? {}, ctx.signal)) ?? null));
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
    case "delegate_to":
      return "Handing off to the widget builder";
    default:
      return name;
  }
}

export const ASK_TOOL_NAMES = ["list_jobs", "get_job", "platform_totals", "get_order"] as const;

/** How the Studio chat panel words the ledger tools' rows; Studio's own tools keep theirs. */
export const ASK_TOOL_DISPLAY: Record<string, AgAiToolDisplay> = Object.fromEntries(
  ASK_TOOL_NAMES.map((name) => [name, { label: ({ args }) => ({ text: askToolLabel(name, args) }), hidden: false } satisfies AgAiToolDisplay]),
);

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

/** One transcript row as the drawer renders it. */
export type AskRow =
  | { readonly kind: "text"; readonly key: string; readonly role: "user" | "assistant" | "system"; readonly text: string }
  | { readonly kind: "step"; readonly key: string; readonly label: string; readonly state: "running" | "done" | "failed" | "cancelled" }
  | { readonly kind: "error"; readonly key: string; readonly text: string };

export function askRows(messages: readonly AgAiChatMessage[]): AskRow[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part, index): AskRow[] => {
      const key = `${message.id}-${index}`;
      switch (part.type) {
        case "text":
          return part.text.trim() === "" ? [] : [{ kind: "text", key, role: message.role, text: part.text }];
        case "tool_call": {
          const { status } = part.toolCall;
          const state = status === "complete" ? "done" : status === "error" ? "failed" : status === "cancelled" ? "cancelled" : "running";
          return [{ kind: "step", key, label: askToolLabel(part.toolCall.name, part.toolCall.args), state }];
        }
        case "error":
          return [{ kind: "error", key, text: part.message }];
        case "reasoning":
          return [];
      }
    }),
  );
}
