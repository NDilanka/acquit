import type { ReceiptRow } from "../../api-types";
import { usd } from "../../format";
import { Link } from "../../router";
import { receiptMarks, type OperatorWorkspace } from "../../operator-workspace";
import { receiptPageHref } from "../../receipt-view";
import { IdChip } from "../../ui";

function verifiedLine(row: ReceiptRow): string {
  if (row.jobId === null) return row.passedVerifiedCi ? "Passed verified CI" : "Not verified";
  return `${row.frozen.passed}/${row.frozen.expected} frozen, ${row.hidden.passed}/${row.hidden.expected} hidden`;
}

export function Earnings({ earnings }: { earnings: OperatorWorkspace["earnings"] }) {
  return (
    <>
      <div className="ws-earn">
        <div className="card pad">
          <div className="eyebrow">Held for you</div>
          <div className="big num">{usd(earnings.heldCents)}</div>
          <small className="muted">In escrow at your net, after the operator fee. Released when the client approves or the review window closes, unless a PayPal dispute holds the payout.</small>
        </div>
        <div className="card pad">
          <div className="eyebrow">Paid to you</div>
          <div className="big num">{usd(earnings.paidCents)}</div>
          <small className="muted">What PayPal released to you, after the operator fee.</small>
        </div>
      </div>
      <section className="card receipts">
        <div className="pad hd">
          <h2>Receipts</h2>
          <small className="muted">Each settled job leaves a receipt. Seeded rows are the deployment's starting history.</small>
        </div>
        {earnings.receipts.length === 0 ? (
          <div className="pad muted">No receipts yet.</div>
        ) : (
          earnings.receipts.map((row) => {
            const marks = receiptMarks(row);
            return (
              <div key={row.id} className="receipt-row">
                <div>
                  <IdChip value={row.id} />
                  {marks.seeded && <span className="pill new">Seeded</span>}
                  {marks.jobHref !== null && <Link to={marks.jobHref}>Job page</Link>}
                  {marks.jobHref !== null && <Link to={receiptPageHref(row.id)}>Public receipt</Link>}
                </div>
                <div className="num strong">{row.paid === null ? "—" : usd(row.paid)}</div>
                <small className="muted">{verifiedLine(row)}</small>
              </div>
            );
          })
        )}
      </section>
    </>
  );
}
