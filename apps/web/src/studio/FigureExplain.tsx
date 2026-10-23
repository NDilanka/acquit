// A traced figure, drawn once: the Ask chat's card and the Explain panel both show a FigureTrace through FigureTraceView.

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgAiToolDetailParams } from "ag-studio";
import { api } from "../api";
import type { FigureId, FigureTrace, FigureTraceLine } from "../api-types";
import { checkedPart, figureCheck, isFigureTrace, paypalWords } from "../figure-trace";
import { dollars } from "../format";
import { Link } from "../router";
import { readFailure } from "./live";
import { FIGURE_LABELS } from "../../../../packages/core/src/explain.ts";

const LINE_WORDS: Record<FigureTraceLine["kind"], string> = {
  HELD: "Hold",
  RELEASED: "Release to operator",
  FEE: "Fee withheld",
  REFUND: "Refund to client",
};

/** One ledger line: its job, kind and amount, the PayPal object it names with PayPal's answer, and the receipt once the job is paid. */
function FigureLineItem({ line }: { line: FigureTraceLine }) {
  const status = paypalWords(line.paypal.status);
  const partial = checkedPart(line);
  return (
    <li className="explain-line">
      <div className="explain-line-head">
        <Link className="mono" to={`/jobs/${encodeURIComponent(line.jobId)}`}>{line.jobId}</Link>
        <span>{LINE_WORDS[line.kind]}</span>
        <b className="num">{dollars(line.cents)}</b>
      </div>
      <div className="explain-line-paypal">
        <span className={`pill ${status.tone}`}>{status.text}</span>
        {line.paypal.id !== null && <span className="mono">{line.paypal.id}</span>}
      </div>
      {partial !== null && <small className="muted">{partial}</small>}
      {line.paypal.status === "MISMATCHED" && line.paypal.observedCents !== null && (
        <small className="muted">PayPal shows {dollars(line.paypal.observedCents)}.</small>
      )}
      {line.paypal.note !== null && <small className="muted">{line.paypal.note}</small>}
      {line.receiptId !== null && <Link to={`/receipts/${encodeURIComponent(line.receiptId)}`}>Verifier receipt</Link>}
    </li>
  );
}

/** A traced figure: its total, its ledger lines with PayPal's status, and the sum check worked out from those lines. */
export function FigureTraceView({ trace }: { trace: FigureTrace }) {
  const { linesCents, holds } = figureCheck(trace);
  return (
    <div className="explain-body">
      <div className="explain-total">
        <span className="eyebrow">{trace.label}</span>
        <b className="studio-value num">{dollars(trace.totalCents)}</b>
      </div>
      {trace.lines.length === 0 ? (
        <p className="muted small">No ledger line makes up this figure yet.</p>
      ) : (
        <ol className="explain-lines" aria-label={`Ledger lines for ${trace.label}`}>
          {trace.lines.map((line) => (
            <FigureLineItem key={line.entryId} line={line} />
          ))}
        </ol>
      )}
      <div className="explain-check">
        <span className={`pill ${holds ? "ok" : "break"}`}>
          <span className="dot" />
          {holds ? "Sum of lines = figure" : "Sum of lines does not equal the figure"}
        </span>
        <small className="muted num">
          {dollars(linesCents)} {holds ? "=" : "≠"} {dollars(trace.totalCents)}
        </small>
      </div>
    </div>
  );
}

type ExplainState = { readonly kind: "reading" } | { readonly kind: "ready"; readonly trace: FigureTrace } | { readonly kind: "failed"; readonly error: string };

/** The Explain button for one escrow figure. It opens the figure's lines in a modal dialog, read live each time it opens. */
export function FigureExplain({ figure }: { figure: FigureId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn sm ghost explain-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Explain
      </button>
      {open && <ExplainDialog figure={figure} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A native modal dialog: Escape and Close dismiss it, and focus stays inside while it is open. */
function ExplainDialog({ figure, onClose }: { figure: FigureId; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [state, setState] = useState<ExplainState>({ kind: "reading" });
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  useEffect(() => {
    let current = true;
    api.platformExplain(figure).then(
      (trace) => { if (current) setState({ kind: "ready", trace }); },
      (error: unknown) => { if (current) setState({ kind: "failed", error: readFailure(error) }); },
    );
    return () => { current = false; };
  }, [figure]);
  // Portalled to body: inside a widget, row styles such as `.rows div` reach the dialog's own divs,
  // and the dashboard's key handling can swallow Escape before the dialog sees it.
  return createPortal(
    <dialog
      ref={dialog}
      className="explain-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        dialog.current?.close();
      }}
    >
      <div className="explain-head">
        <h2 id={titleId}>{FIGURE_LABELS[figure]}</h2>
        <button type="button" className="btn sm ghost" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      {state.kind === "reading" && <p className="muted small">Reading the ledger lines and PayPal's status for each one.</p>}
      {state.kind === "failed" && <div className="alert">The figure could not be traced just now because {state.error}.</div>}
      {state.kind === "ready" && <FigureTraceView trace={state.trace} />}
    </dialog>,
    document.body,
  );
}

/** The Studio chat's expanded body for a trace_figure call: the figure in place of its JSON. */
export function FigureCallCard({ status, result }: AgAiToolDetailParams) {
  if (result === undefined) {
    return <p className="muted small">{status === "done" || status === "cancelled" ? "The trace did not finish." : "Tracing the figure…"}</p>;
  }
  if (!result.success) return <div className="alert">{result.issues.map((issue) => issue.message).join(" ")}</div>;
  if (!isFigureTrace(result.data)) return <p className="muted small">The trace came back in a form this card does not show.</p>;
  return <FigureTraceView trace={result.data} />;
}
