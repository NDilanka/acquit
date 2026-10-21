// The change chain: a record of the edits made to a dashboard, the assistant's and the user's, in the
// order they happened. Each link carries the hash of the link before it, so an edited, dropped or
// reordered link breaks the chain. The chain lives in this browser for the session. It is not a server
// receipt, and nothing on the server reads it. This module has no DOM, so the tests run under node.

import type { AgAiTelemetryObserver, AgStudioApi } from "ag-studio";

/** What a link records about the change it stands for. */
export type ChangeFields = {
  /** A change the dashboard recorded, or an undo back through an entry. */
  readonly kind: "change" | "undo";
  /** The history entry changed, or for an undo the entry the undo went back to. */
  readonly entryId: string;
  readonly label: string;
  /** When the change was written, as epoch milliseconds. */
  readonly at: number;
  readonly agent: string;
  readonly tool: string | null;
  readonly toolCallId: string | null;
  readonly parentToolCallId: string | null;
};

/** A link as stored: its position, the hash of the link before it, and its own hash. */
export type ChainLink = ChangeFields & {
  readonly seq: number;
  readonly prevHash: string | null;
  readonly hash: string;
};

/** What a link's hash covers: every field except the hash itself. */
type LinkBody = Omit<ChainLink, "hash">;

/** Where a chain first fails: `seq` is the 1-based position of the link that does not check. */
export type ChainVerdict = { readonly ok: true } | { readonly ok: false; readonly seq: number };

/** Canonical JSON: object keys sorted at every depth, so the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** The SHA-256 of a text, as lowercase hex, from the browser's Web Crypto. */
export async function digestHex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A link's hash: the SHA-256 of its canonical JSON. */
export function linkHash(body: LinkBody): Promise<string> {
  return digestHex(canonicalJson(body));
}

/** The chain with one more link: numbered after the last, and hashed over the last link's hash. */
export async function appendLink(links: readonly ChainLink[], fields: ChangeFields): Promise<ChainLink[]> {
  const body: LinkBody = { ...fields, seq: links.length + 1, prevHash: links.at(-1)?.hash ?? null };
  return [...links, { ...body, hash: await linkHash(body) }];
}

/**
 * Recomputes every link's hash, and checks each link's position and its link to the one before. The
 * first link that does not check is the one reported, so an altered label, a changed prevHash, or a
 * reordered or dropped link all fail at the first place they show.
 */
export async function verifyChain(links: readonly ChainLink[]): Promise<ChainVerdict> {
  for (const [index, link] of links.entries()) {
    const seq = index + 1;
    const prevHash = index === 0 ? null : (links[index - 1]?.hash ?? null);
    const { hash, ...body } = link;
    if (link.seq !== seq || link.prevHash !== prevHash || (await linkHash(body)) !== hash) return { ok: false, seq };
  }
  return { ok: true };
}

/** A history entry as the change log reads it: its id, its label, and when it was written. */
export type UndoEntry = { readonly id: string; readonly label: string; readonly at: number };

/** Who made a change: the tool call that made it, or none, which is a hand edit. */
export type ChangeSource = Pick<ChangeFields, "agent" | "tool" | "toolCallId" | "parentToolCallId">;

/** The source of an entry no tool call made. */
export const HAND_EDIT: ChangeSource = { agent: "You", tool: null, toolCallId: null, parentToolCallId: null };

/** The display names of the delegate targets. Any other agent id shows as it is. */
const DELEGATE_AGENTS: Readonly<Record<string, string>> = { widget: "Widget agent", data: "Data agent", page: "Page agent" };

const agentName = (id: string | undefined): string => (id === undefined ? "Agent" : (DELEGATE_AGENTS[id] ?? id));

type ChangeEvent = Parameters<AgAiTelemetryObserver["onEvent"]>[0];

/** A tool call that has started and not yet reported its end. */
type OpenCall = {
  readonly name: string;
  readonly agent: string;
  readonly parentToolCallId: string | null;
  readonly runId: string;
  /** For a delegate_to call: the agent its child run is handed to. */
  readonly delegate?: string;
};

/** The delegate target a delegate_to call names, from its arguments: `{ type: { id } }`. */
function delegateTarget(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const type: unknown = (args as { type?: unknown }).type;
  if (typeof type !== "object" || type === null) return undefined;
  const id: unknown = (type as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Works out who made each entry. The undo stack grows through the dashboard's own writes, so an entry
 * that appears while a tool call is open was made by that call, and an entry that appears while none is
 * open is a hand edit. A delegated child's calls belong to the agent its delegate_to call names. Each entry
 * is recorded once, the first time it is seen.
 */
export function createAttributor(options: {
  readonly askAgent: string;
  readonly readUndo: () => readonly UndoEntry[];
  readonly record: (entry: UndoEntry, source: ChangeSource) => void;
}) {
  const seen = new Set<string>();
  const open = new Map<string, OpenCall>();

  const attribute = (source: ChangeSource) => {
    for (const entry of options.readUndo()) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      options.record(entry, source);
    }
  };
  const sourceOf = (call: OpenCall, toolCallId: string): ChangeSource => ({
    agent: call.agent,
    tool: call.name,
    toolCallId,
    parentToolCallId: call.parentToolCallId,
  });

  return {
    /** Attributes the entries made since the last look to hand edits, when no call is open. */
    sync(): void {
      if (open.size === 0) attribute(HAND_EDIT);
    },
    onEvent(event: ChangeEvent): void {
      switch (event.type) {
        case "tool_execution_started": {
          if (open.size === 0) attribute(HAND_EDIT);
          const parent = event.trace.parentToolCallId ?? null;
          const parentCall = parent === null ? undefined : open.get(parent);
          open.set(event.toolCallId, {
            name: event.name,
            agent: parent === null ? options.askAgent : (parentCall?.delegate ?? agentName(event.trace.agentId)),
            parentToolCallId: parent,
            runId: event.trace.runId,
            delegate: event.name === "delegate_to" ? agentName(delegateTarget(event.args)) : undefined,
          });
          return;
        }
        case "tool_execution_finished": {
          const parent = event.trace.parentToolCallId ?? null;
          const call: OpenCall = open.get(event.toolCallId) ?? {
            name: event.name,
            agent: parent === null ? options.askAgent : agentName(event.trace.agentId),
            parentToolCallId: parent,
            runId: event.trace.runId,
          };
          open.delete(event.toolCallId);
          attribute(sourceOf(call, event.toolCallId));
          return;
        }
        case "run_finished": {
          // A run that ends with calls still open (an error or a cancel) may never report their ends.
          // Its entries go to its last open call, and those calls are closed, so they cannot hold back the
          // attribution of later hand edits.
          const ended = [...open].filter(([, call]) => call.runId === event.trace.runId);
          const last = ended.at(-1);
          if (last) attribute(sourceOf(last[1], last[0]));
          for (const [id] of ended) open.delete(id);
          return;
        }
        default:
          return;
      }
    },
  };
}

/** The change log as the widget and the page read it. Each snapshot is a new object, so a change is visible by identity. */
export type ChangeSnapshot = {
  readonly links: readonly ChainLink[];
  /** The ids of the entries Studio can still undo. */
  readonly undoIds: ReadonlySet<string>;
  /** The chain check, or "unavailable" when this browser cannot hash the chain. */
  readonly check: ChainVerdict | "unavailable";
};

export type ChangeLog = {
  readonly observer: AgAiTelemetryObserver;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ChangeSnapshot;
  /** Attributes the hand edits made since the last look, and rereads the undo stack. Call after a state update. */
  readonly sync: () => void;
  /** Undoes back through an entry and appends an undo link. Does nothing unless the entry can still be undone. */
  readonly undo: (entryId: string) => void;
  /** Resolves once every link queued so far is hashed and checked. */
  readonly settled: () => Promise<void>;
};

/** The part of Studio's api the change log reads and undoes through. */
export type ChangeApi = Pick<AgStudioApi, "getHistory" | "undo">;

const logs = new WeakMap<ChangeApi, ChangeLog>();

/** The change log of a Studio instance, made on first use. The ask harness and the page share one. */
export function changeLogFor(api: ChangeApi, askAgent: string): ChangeLog {
  const existing = logs.get(api);
  if (existing) return existing;
  const log = createChangeLog(api, askAgent);
  logs.set(api, log);
  return log;
}

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((id) => b.has(id));

function createChangeLog(api: ChangeApi, askAgent: string): ChangeLog {
  const listeners = new Set<() => void>();
  let snapshot: ChangeSnapshot = { links: [], undoIds: new Set<string>(), check: { ok: true } };
  let queue: Promise<void> = Promise.resolve();

  const publish = (next: Partial<ChangeSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const readUndo = (): UndoEntry[] => api.getHistory().undo.map(({ id, label, at }) => ({ id, label, at }));
  const refresh = () => {
    const ids = new Set(readUndo().map((entry) => entry.id));
    if (!sameIds(ids, snapshot.undoIds)) publish({ undoIds: ids });
  };
  // Hashing is async, so links are appended one at a time, in the order they were recorded.
  const enqueue = (fields: ChangeFields) => {
    queue = queue
      .then(async () => {
        const links = await appendLink(snapshot.links, fields);
        publish({ links, check: await verifyChain(links) });
      })
      .catch(() => publish({ check: "unavailable" }));
  };
  const attributor = createAttributor({
    askAgent,
    readUndo,
    record: (entry, source) => {
      enqueue({ kind: "change", entryId: entry.id, label: entry.label, at: entry.at, ...source });
    },
  });

  return {
    observer: {
      onEvent(event) {
        attributor.onEvent(event);
        refresh();
      },
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    sync: () => {
      attributor.sync();
      refresh();
    },
    undo: (entryId) => {
      const entry = readUndo().find((candidate) => candidate.id === entryId);
      if (!entry) return;
      api.undo(entryId);
      enqueue({
        kind: "undo",
        entryId,
        label: `Undo to ${entry.label}`,
        at: Date.now(),
        agent: HAND_EDIT.agent,
        tool: null,
        toolCallId: null,
        parentToolCallId: null,
      });
      refresh();
    },
    settled: () => queue,
  };
}
