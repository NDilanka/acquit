import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgAiChatMessage, AgAiChatSession, AgAiHarness, AgAiHarnessSetupParams, AgAiRunStatus, AgAiToolDetailParams, AgStudioApi } from "ag-studio";
import type { AgAiToolDisplay } from "ag-studio-react";
import { api } from "../api";
import type { AskToolSchema } from "../api-types";
import { createAskLedgerHarness, openAskThread } from "../ask-harness.ts";
import { ASK_AGENT_NAME, ASK_PROMPT_STARTERS, ASK_TOOL_DISPLAY, LEDGER_CARD_TOOLS, askGate, askRows, askStatusText, askToolLabel, isLedgerCard } from "../ask-ledger";
import type { DashboardId } from "../dashboard-widgets.ts";
import { FigureCallCard, FigureTraceView } from "./FigureExplain";
import { readFailure } from "./live";

export { createAskLedgerHarness, openAskThread };

/** A PayPal tool's answer as a card: its title, and its key fields as rows with PayPal ids in mono type. */
export function LedgerCallCard({ status, result }: AgAiToolDetailParams) {
  if (result === undefined) {
    return <p className="muted small">{status === "done" || status === "cancelled" ? "The read did not finish." : "Reading PayPal…"}</p>;
  }
  if (!result.success) return <div className="alert">{result.issues.map((issue) => issue.message).join(" ")}</div>;
  if (!isLedgerCard(result.data)) return <p className="muted small">The read came back in a form this card does not show.</p>;
  const card = result.data;
  return (
    <div className="explain-body">
      <span className="eyebrow">{card.title}</span>
      <dl>
        {card.rows.map((row, index) => (
          <div key={`${index}-${row.label}`}>
            <dt className={row.mono === "label" ? "mono" : undefined}>{row.label}</dt>
            <dd className={row.mono === "value" ? "mono" : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The ledger tools' rows as the Studio chat draws them: the same words, trace_figure's expanded body is the figure card, and a PayPal read is its card. */
export const ASK_TOOL_DISPLAY_CARDS: Record<string, AgAiToolDisplay> = {
  ...ASK_TOOL_DISPLAY,
  trace_figure: { label: ({ args }) => ({ text: askToolLabel("trace_figure", args) }), detail: FigureCallCard, hidden: false },
  ...Object.fromEntries(LEDGER_CARD_TOOLS.map((name) => [name, { label: ({ args }) => ({ text: askToolLabel(name, args) }), detail: LedgerCallCard, hidden: false } satisfies AgAiToolDisplay])),
};

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
export function useAskLedger(dashboard: DashboardId): AskLedger {
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
      (e: unknown) => live && setLoad({ kind: "failed", error: readFailure(e) }),
    );
    return () => {
      live = false;
    };
  }, []);

  const built = useRef<{ studio: AgStudioApi; harness: AgAiHarness } | null>(null);
  const [harness, setHarness] = useState<AgAiHarness | null>(null);
  const harnessFor = useCallback((studio: AgStudioApi) => {
    if (built.current?.studio !== studio) built.current = { studio, harness: createAskLedgerHarness(studio, () => served.current, { dashboard }) };
    return built.current.harness;
  }, [dashboard]);
  const setup = useCallback((params: AgAiHarnessSetupParams) => harnessFor(params.api), [harnessFor]);
  const onApiReady = useCallback((event: { api: AgStudioApi }) => setHarness(harnessFor(event.api)), [harnessFor]);
  return useMemo(() => ({ load, harness, setup, onApiReady }), [load, harness, setup, onApiReady]);
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
      (e: unknown) => live && setOpenError(readFailure(e)),
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
  const { ready, keyMissing } = askGate(ask.load, session !== null);
  const send = (text: string) => {
    if (!session || keyMissing || running || text.trim() === "") return;
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
      {ask.load.kind === "failed" && <div className="alert">The ledger agent's tools could not be loaded because {ask.load.error}.</div>}
      {ask.load.kind === "ready" && !ask.load.keyConfigured && (
        <div className="alert warn">The server has no model key configured, so Ask the ledger is off. Its starter questions and Send stay disabled until a key is set.</div>
      )}
      {openError && <div className="alert">The conversation could not be opened because {openError}.</div>}
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
            ) : row.kind === "figure" ? (
              <li key={row.key} className="ask-figure">
                <FigureTraceView trace={row.trace} />
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
        {keyMissing ? "Off until the server has a model key." : ready || ask.load.kind === "failed" ? askStatusText(snapshot.status) : "Opening the conversation…"}
      </p>
      <form className="ask-form" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="small">
          Your question
        </label>
        <textarea id={inputId} rows={2} value={draft} disabled={keyMissing} placeholder={ASK_PROMPT_STARTERS[0]?.prompt} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
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
