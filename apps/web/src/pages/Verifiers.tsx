import { Link } from "../router";
import { milestoneLine, PAGE_INTRO, scoreLines, VERIFIER_ROWS, type VerifierRow } from "../verifiers-view";

const STATUS_PILL: Record<VerifierRow["status"], string> = {
  Live: "pill ok",
  "Live, simulated farms": "pill ok",
  Next: "pill new",
};

/** The public registry of verifiers. Read-only, and it renders with or without a session, like a receipt. */
export function VerifiersPage() {
  return (
    <>
      <div className="head">
        <div>
          <h1>Verifiers</h1>
          <p className="muted">{PAGE_INTRO}</p>
        </div>
      </div>
      {VERIFIER_ROWS.map((row) => (
        <section className="card pad" key={row.title}>
          <div className="meta">
            <h2>{row.title}</h2>
            <span className={STATUS_PILL[row.status]}>
              <span className="dot" />
              {row.status}
            </span>
            {row.simulatedNote !== null && <span className="sandbox">Simulated</span>}
            {row.version !== null && <span>Version {row.version}</span>}
          </div>
          {row.milestones.map((milestone) => (
            <p key={milestone.title}>{milestoneLine(milestone)}</p>
          ))}
          {row.scoreCard !== null && row.scoreWords !== null && (
            <>
              <p>
                <b>Score card</b>
              </p>
              {scoreLines(row.scoreCard, row.scoreWords).map((line) => (
                <p key={line}>{line}</p>
              ))}
              {row.scoreNote !== null && <small className="muted">{row.scoreNote}</small>}
            </>
          )}
          {row.simulatedNote !== null && <p className="muted">{row.simulatedNote}</p>}
          {row.hiddenCheck !== null && (
            <p>
              <b>Hidden check</b>
              <br />
              {row.hiddenCheck}
            </p>
          )}
          {row.demo !== null && (
            <p>
              <Link to={row.demo.to} className="btn ghost sm">
                {row.demo.label}
              </Link>
            </p>
          )}
        </section>
      ))}
    </>
  );
}
