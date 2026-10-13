import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  createAiHarness,
  directLlmRunner,
  type AgAiChatMessage,
  type AgAiChatSession,
  type AgAiHarness,
  type AgAiHarnessSetupParams,
  type AgAiRunStatus,
  type AgAiTool,
  type AgStudioApi,
} from "ag-studio";
import type { AgAiToolDisplay } from "ag-studio-react";
import { api } from "../api";
import type { AskToolSchema } from "../api-types";
import {
  ASK_AGENT_ID,
  ASK_AGENT_NAME,
  ASK_INSTRUCTIONS,
  ASK_MAX_TURNS,
  ASK_PROMPT_STARTERS,
  ASK_TOOL_NAMES,
  askLedgerAdapter,
  askRows,
  askStatusText,
  askToolLabel,
  buildAskTools,
} from "../ask-ledger";
import { errorText } from "../demo";

/** How the Studio chat panel words the ledger tools' rows; Studio's own tools keep theirs. */
export const ASK_TOOL_DISPLAY: Record<string, AgAiToolDisplay> = Object.fromEntries(
  ASK_TOOL_NAMES.map((name) => [name, { label: ({ args }) => ({ text: askToolLabel(name, args) }), hidden: false } satisfies AgAiToolDisplay]),
);

/**
 * The dashboard's harness: the ledger agent fronting the conversation, and Studio's widget agent as
 * its delegate. Both run on the one adapter, so every model turn goes through the app's own route.
 */
export function createAskLedgerHarness(studio: AgStudioApi, served: () => readonly AskToolSchema[]): AgAiHarness {
  const adapter = askLedgerAdapter();
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

export type AskLoad = { kind: "loading" } | { kind: "ready"; keyConfigured: boolean } | { kind: "failed"; error: string };

export type AskLedger = {
  readonly load: AskLoad;
  /** The harness of the Studio instance on screen, once its API is ready. */
  readonly harness: AgAiHarness | null;
  /** For AgStudio's `ai`: Studio resolves it only when its chat panel first opens. */
  readonly setup: (params: AgAiHarnessSetupParams) => AgAiHarness;
  /** For AgStudio's `onApiReady`, so the app's own drawer reaches the same harness in view mode. */
  readonly onApiReady: (event: { api: AgStudioApi }) => void;
};

/**
 * One harness per Studio instance, shared by Studio's chat panel and the app's drawer. A remount
 * (the narrow/wide switch) brings a new Studio API and so a new, empty harness.
 */
export function useAskLedger(): AskLedger {
  const [load, setLoad] = useState<AskLoad>({ kind: "loading" });
  const served = useRef<readonly AskToolSchema[]>([]);
  useEffect(() => {
    let live = true;
    api.askLedgerTools().then(
      (r) => {
        if (!live) return;
        served.current = r.tools;
        setLoad({ kind: "ready", keyConfigured: r.keyConfigured });
      },
      (e: unknown) => live && setLoad({ kind: "failed", error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, []);

  const built = useRef<{ studio: AgStudioApi; harness: AgAiHarness } | null>(null);
  const [harness, setHarness] = useState<AgAiHarness | null>(null);
  const harnessFor = useCallback((studio: AgStudioApi) => {
    if (built.current?.studio !== studio) built.current = { studio, harness: createAskLedgerHarness(studio, () => served.current) };
    return built.current.harness;
  }, []);
  const setup = useCallback((params: AgAiHarnessSetupParams) => harnessFor(params.api), [harnessFor]);
  const onApiReady = useCallback((event: { api: AgStudioApi }) => setHarness(harnessFor(event.api)), [harnessFor]);
  return useMemo(() => ({ load, harness, setup, onApiReady }), [load, harness, setup, onApiReady]);
}

// Studio's harness opens only threads it already holds, so the drawer's conversation is created
// once per harness and reopened from then on; the promise is kept so two opens share one thread.
const askThreads = new WeakMap<AgAiHarness, Promise<AgAiChatSession>>();

function openAskThread(harness: AgAiHarness): Promise<AgAiChatSession> {
  let session = askThreads.get(harness);
  if (!session) {
    session = harness.createThread({ agentId: ASK_AGENT_ID, title: ASK_AGENT_NAME });
    askThreads.set(harness, session);
  }
  return session;
}

type Snapshot = { messages: readonly AgAiChatMessage[]; status: AgAiRunStatus };

function useAskSession(harness: AgAiHarness | null, wanted: boolean) {
  const [session, setSession] = useState<AgAiChatSession | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({ messages: [], status: "idle" });
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    if (!harness || !wanted) return;
    let live = true;
    let current: AgAiChatSession | null = null;
    const onChanged = () => current && setSnapshot({ messages: current.messages, status: current.status });
    openAskThread(harness).then(
      (opened) => {
        if (!live) return;
        current = opened;
        opened.addEventListener("changed", onChanged);
        setSession(opened);
        setOpenError(null);
        onChanged();
      },
      (e: unknown) => live && setOpenError(errorText(e)),
    );
    return () => {
      live = false;
      if (current) {
        current.removeEventListener("changed", onChanged);
        current.close();
      }
      setSession(null);
      setSnapshot({ messages: [], status: "idle" });
    };
  }, [harness, wanted]);
  return { session, snapshot, openError };
}

/**
 * The app's own view of the ledger conversation. Studio's chat panel lives in edit mode only, and
 * the narrow layout is view-only, so this is how the agent is reached on the dashboard as read.
 */
export function AskLedgerDrawer({ id, ask, open, onClose }: { id: string; ask: AskLedger; open: boolean; onClose: () => void }) {
  // The conversation is opened on first use and kept while the drawer is closed, so closing it
  // neither loses the thread nor interrupts a question still being answered.
  const [wanted, setWanted] = useState(open);
  useEffect(() => {
    if (open) setWanted(true);
  }, [open]);
  const { session, snapshot, openError } = useAskSession(ask.harness, wanted);
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const log = useRef<HTMLOListElement>(null);
  const rows = useMemo(() => askRows(snapshot.messages), [snapshot.messages]);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const running = snapshot.status === "running";
  const ready = session !== null && ask.load.kind === "ready";
  const send = (text: string) => {
    if (!session || running || text.trim() === "") return;
    session.sendMessage(text.trim());
    setDraft("");
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(draft);
    }
  };

  return (
    <section id={id} className="card ask-drawer" aria-label={ASK_AGENT_NAME} hidden={!open}>
      <div className="ask-head">
        <div>
          <h2>{ASK_AGENT_NAME}</h2>
          <p className="muted small">Answers from the book and PayPal's read-only view of it. It cannot move money.</p>
        </div>
        <button type="button" className="btn sm ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {ask.load.kind === "failed" && <div className="alert">The ledger agent's tools could not be loaded: {ask.load.error}</div>}
      {ask.load.kind === "ready" && !ask.load.keyConfigured && (
        <div className="alert warn">The server has no model key configured, so questions will not be answered yet.</div>
      )}
      {openError && <div className="alert">The conversation could not be opened: {openError}</div>}
      {rows.length > 0 ? (
        <ol className="ask-log" ref={log} aria-label="Conversation">
          {rows.map((row) =>
            row.kind === "text" ? (
              <li key={row.key} className={`ask-msg ${row.role}`}>
                <span className="eyebrow">{row.role === "user" ? "You" : ASK_AGENT_NAME}</span>
                <p>{row.text}</p>
              </li>
            ) : row.kind === "step" ? (
              <li key={row.key} className={`ask-step ${row.state}`}>
                <span className="dot" aria-hidden="true" />
                <span>{row.label}</span>
                <span className="muted small">{STEP_WORDS[row.state]}</span>
              </li>
            ) : (
              <li key={row.key} className="alert">
                {row.text}
              </li>
            ),
          )}
        </ol>
      ) : (
        <div className="ask-starters" role="group" aria-label="Suggested questions">
          {ASK_PROMPT_STARTERS.map((starter) => (
            <button key={starter.label} type="button" className="btn sm ghost" disabled={!ready || running} onClick={() => send(starter.prompt)}>
              {starter.prompt}
            </button>
          ))}
        </div>
      )}
      <p className="ask-status muted small" role="status" aria-live="polite">
        {ready || ask.load.kind === "failed" ? askStatusText(snapshot.status) : "Opening the conversation…"}
      </p>
      <form className="ask-form" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="small">
          Your question
        </label>
        <textarea id={inputId} rows={2} value={draft} placeholder={ASK_PROMPT_STARTERS[0]?.prompt} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
        <div className="ask-actions">
          {running && (
            <button type="button" className="btn sm ghost" onClick={() => session?.cancel()}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn sm green" disabled={!ready || running || draft.trim() === ""}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

const STEP_WORDS = { running: "working", done: "done", failed: "failed", cancelled: "cancelled" } as const;
