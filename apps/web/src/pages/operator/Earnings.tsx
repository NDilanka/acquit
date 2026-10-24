import type { ReceiptRow } from "../../api-types";
import { usd, utc } from "../../format";
import { Link } from "../../router";
import { earningsPipeline, payoutLine } from "../../operator-views";
import { receiptMarks } from "../../operator-workspace";
import { receiptPageHref } from "../../receipt-view";
import { EmptyState, IdChip } from "../../ui";
import type { OperatorData } from "./OperatorPage";

/** The operator's money in four stages, at the operator's net after the operator fee, then the payouts and receipts. */
export function Earnings({ data }: { data: OperatorData }) {
  const pipe = earningsPipeline(data.jobs, data.escrow, data.receipts);
  const stages = [
    { label: "Held in escrow", cents: pipe.held, note: "Paid in by the client for work you won and have not delivered yet." },
    { label: "Being verified", cents: pipe.verifying, note: "The verifier is running the hidden tests on your delivery." },
    { label: "Awaiting client review", cents: pipe.awaiting, note: "Released when the client approves or the review window closes." },
    { label: "Paid to you", cents: pipe.paid, note: "Sent to your PayPal account." },
  ];
  const anySeeded = data.receipts.some((row) => receiptMarks(row).seeded);

  return (
    <div className="earn-page">
      <p className="muted small">Amounts are what you receive, after Acquit's operator fee.</p>
      <div className="earn-stages" data-tour="earn-stages">
        {stages.map((stage) => (
          <div key={stage.label} className="card pad earn-stage">
            <p className="eyebrow">{stage.label}</p>
            <p className="earn-amount num">{usd(stage.cents)}</p>
            <small className="muted">{stage.note}</small>
          </div>
        ))}
      </div>

      <section className="card pad" aria-labelledby="payouts-status">
        <h2 id="payouts-status">PayPal payouts</h2>
        <p>{payoutLine(data.operator.payouts)}</p>
        {data.operator.payouts !== "READY" && data.operator.onboardingUrl && (
          <a className="btn secondary sm" href={data.operator.onboardingUrl}>
            Connect PayPal payouts
          </a>
        )}
      </section>

      <section className="card receipts" aria-labelledby="receipts-head">
        <div className="pad hd">
          <h2 id="receipts-head">Receipts</h2>
          <small className="muted">
            Each settled job leaves a receipt.{anySeeded && " Seeded rows are sample history that came with Acquit."}
          </small>
        </div>
        {data.receipts.length === 0 ? (
          <EmptyState inline icon="earnings" action={{ to: "/operator", label: "Find work" }}>
            Your first payout shows here after a client approves your work.
          </EmptyState>
        ) : (
          data.receipts.map((row) => <ReceiptLine key={row.id} row={row} />)
        )}
      </section>
    </div>
  );
}

function ReceiptLine({ row }: { row: ReceiptRow }) {
  const marks = receiptMarks(row);
  return (
    <div className="receipt-line">
      <div className="receipt-id">
        <IdChip value={row.id} />
        {marks.seeded && <span className="pill new">Seeded</span>}
        {marks.jobHref !== null && <Link to={marks.jobHref}>Job page</Link>}
        {marks.jobHref !== null && <Link to={receiptPageHref(row.id)}>Receipt</Link>}
      </div>
      <div className="rcell">
        <span className="rcell-label">Amount</span>
        <b className="num">{row.paid === null ? "Not yet" : usd(row.paid)}</b>
      </div>
      <div className="rcell">
        <span className="rcell-label">Fee</span>
        <span className="num">{row.fee === null ? "Not yet" : usd(row.fee)}</span>
      </div>
      <div className="rcell">
        <span className="rcell-label">Paid at</span>
        <span className="num">{row.releasedAt === null ? "Not yet" : utc(row.releasedAt)}</span>
      </div>
    </div>
  );
}
