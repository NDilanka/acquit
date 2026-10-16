import type { BidView, JobView } from "../../api-types";
import { ledgerNote, usd, utc } from "../../format";
import { escrowWord, ledgerKindWord } from "../../job-status";
import { moneyRows } from "../../job-timeline";

/** The money only: where the escrow stands, its rows, and every ledger line folded under them. */
export function MoneyCard({ job, locked }: { job: JobView; locked: BidView | null }) {
  const rows = moneyRows(job, locked?.handle ?? "the operator");
  const lines = job.ledger.length;
  return (
    <section className="card pad money">
      <div className="money-head">
        <h2>Money</h2>
        <small className="muted">Escrow: {escrowWord(job.escrow)}</small>
      </div>
      <div className="rows">
        {rows.map((row) => (
          <div key={row.key}>
            <span>
              {row.label}
              {row.note && <small>{row.note}</small>}
            </span>
            <b className="num">{row.cents === null ? "None" : usd(row.cents)}</b>
          </div>
        ))}
      </div>
      {lines > 0 && (
        <details className="ledger-fold">
          <summary>
            Ledger, {lines} {lines === 1 ? "line" : "lines"}
          </summary>
          <ol className="ledger-lines">
            {job.ledger.map((line, i) => (
              <li key={`${line.kind}-${i}`}>
                <b className={`k ${line.kind.toLowerCase()}`}>{ledgerKindWord(line.kind)}</b>
                <span className="num">{usd(line.cents)}</span>
                <span className="num muted">{utc(line.at)}</span>
                <small className="muted">{ledgerNote(line, locked)}</small>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
