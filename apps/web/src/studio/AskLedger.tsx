import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgAiHarness, AgAiHarnessSetupParams, AgAiToolDetailParams, AgStudioApi } from "ag-studio";
import type { AgAiToolDisplay } from "ag-studio-react";
import { api } from "../api";
import type { AskToolSchema } from "../api-types";
import { createAskLedgerHarness } from "../ask-harness.ts";
import { ASK_TOOL_DISPLAY, LEDGER_CARD_TOOLS, askToolLabel, isLedgerCard } from "../ask-ledger";
import type { DashboardId } from "../dashboard-widgets.ts";
import { FigureCallCard } from "./FigureExplain";
import { readFailure } from "./live";

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
  /** For AgStudio's `ai`: Studio resolves it only when its chat panel first opens. */
  readonly setup: (params: AgAiHarnessSetupParams) => AgAiHarness;
};

/**
 * One harness per Studio instance, shared by the instance's chat panel. A new Studio API (a new
 * instance) gets a new, empty harness.
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
  const setup = useCallback(
    (params: AgAiHarnessSetupParams) => {
      if (built.current?.studio !== params.api) built.current = { studio: params.api, harness: createAskLedgerHarness(params.api, () => served.current, { dashboard }) };
      return built.current.harness;
    },
    [dashboard],
  );
  return useMemo(() => ({ load, setup }), [load, setup]);
}
