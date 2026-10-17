// A traced figure, drawn once: the Ask chat's card and the Explain panel both show a FigureTrace through FigureTraceView.

import type { AgAiToolDetailParams } from "ag-studio";
import type { FigureTrace, FigureTraceLine } from "../api-types";
import { figureCheck, isFigureTrace, paypalWords } from "../figure-trace";
import { dollars } from "../format";
import { Link } from "../router";

const LINE_WORDS: Record<FigureTraceLine["kind"], string> = {
  HELD: "Hold",
  RELEASED: "Release to operator",
  FEE: "Fee withheld",
  REFUND: "Refund to client",
};

/** One ledger line: its job, kind and amount, the PayPal object it names with PayPal's answer, and the receipt once the job is paid. */
function FigureLineItem({ line }: { line: FigureTraceLine }) {
  const status = paypalWords(line.paypal.status);
  return (
    <li className="explain-line">
      <div className="explain-line-head">
        <span className="mono">{line.jobId}</span>
        <span>{LINE_WORDS[line.kind]}</span>
        <b className="num">{dollars(line.cents)}</b>
      </div>
      <div className="explain-line-paypal">
        <span className={`pill ${status.tone}`}>{status.text}</span>
        {line.paypal.id !== null && <span className="mono">{line.paypal.id}</span>}
      </div>
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

/** The Studio chat's expanded body for a trace_figure call: the figure in place of its JSON. */
export function FigureCallCard({ status, result }: AgAiToolDetailParams) {
  if (result === undefined) {
    return <p className="muted small">{status === "done" || status === "cancelled" ? "The trace did not finish." : "Tracing the figure…"}</p>;
  }
  if (!result.success) return <div className="alert">{result.issues.map((issue) => issue.message).join(" ")}</div>;
  if (!isFigureTrace(result.data)) return <p className="muted small">The trace came back in a form this card does not show.</p>;
  return <FigureTraceView trace={result.data} />;
}
