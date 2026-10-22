import { Fragment, useEffect, useId, useState } from "react";
import { api, ApiError } from "../api";
import type { PrintDemoRunView, PrintRunView } from "../api-types";
import { errorText } from "../demo";
import { utc } from "../format";
import { Link } from "../router";
import type { Session } from "../session";
import { FRAUDS } from "../../../../packages/verifier-print/src/catalog.ts";
import {
  challengeStatus,
  evidenceRows,
  failureWords,
  farmDoingLine,
  farmHeading,
  HONEST_LIMIT,
  MONEY_LINE,
  PRINT_INTRO,
  PRINT_TITLE,
  printRefusalWords,
  QUALIFICATION_RULE,
  REAL_AND_SIMULATED,
  tallyLine,
  TRAP_NOTE,
  verdictView,
} from "../print-view";
import { PRINT_ROW, scoreLines } from "../verifiers-view";

type Props = { readonly session: Session | null | undefined; readonly onSignedIn: (session: Session) => void };

/**
 * The public print demo. A simulated farm qualifies, then prints one job, and the real print judge decides. It reads
 * without a session, like the verifier registry. A run needs a demo of its own, so the first run starts one.
 */
export function PrintDemoPage({ session, onSignedIn }: Props) {
  const [run, setRun] = useState<PrintRunView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fraud, setFraud] = useState<string>(FRAUDS[0]?.id ?? "skip-infill");
  const id = useId();
  const running = run !== null && run.state === "RUNNING" && error === null;
  const busy = starting || running;
  const loading = session === undefined;

  // Reads the run every second while it is RUNNING. Leaving the page stops the reads; the server keeps the run.
  useEffect(() => {
    if (run === null || run.state !== "RUNNING") return;
    let stopped = false;
    const timer = setTimeout(() => {
      api.printRun(run.id).then(
        next => {
          if (!stopped) setRun(next);
        },
        (e: unknown) => {
          if (!stopped) setError(errorOf(e));
        },
      );
    }, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [run]);

  const start = async (farm: string) => {
    setStarting(true);
    setError(null);
    setRun(null);
    try {
      if (!session?.visitor) {
        const demo = await api.startDemo();
        onSignedIn({ user: demo.user, visitor: demo.visitor });
      }
      setRun(await api.startPrintRun(farm));
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setStarting(false);
    }
  };

  const result = run?.result ?? null;
  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Simulated farms</div>
          <h1>{PRINT_TITLE}</h1>
          <p className="muted">{PRINT_INTRO}</p>
        </div>
      </div>

      <section className="card pad" aria-label="What is real and what is Simulated">
        <ul className="print-list">
          {REAL_AND_SIMULATED.map(item => (
            <li key={item.label}>
              <b>{item.label}</b> {item.text}
            </li>
          ))}
        </ul>
      </section>

      <section className="card pad print-run" aria-labelledby={`${id}-qualify`}>
        <h2 id={`${id}-qualify`}>Qualification</h2>
        <p>{QUALIFICATION_RULE}</p>
        <p className="muted">{TRAP_NOTE}</p>
        {result === null ? (
          <p className="muted">Start a run to see the farm's five challenges and its answer to the trap.</p>
        ) : (
          <QualificationPanel result={result} />
        )}
      </section>

      <section className="card pad print-run" aria-labelledby={`${id}-run`}>
        <h2 id={`${id}-run`}>Run a farm</h2>
        <p className="muted">
          Each run draws new challenges and a new part. A run starts a demo of your own first, if you have none. The judge runs on
          the server.
        </p>
        <div className="print-controls">
          <button type="button" className="btn" disabled={busy || loading} onClick={() => void start("honest")}>
            Run the honest farm
          </button>
          <select
            aria-label="Fraud to run"
            value={fraud}
            disabled={busy || loading}
            onChange={e => setFraud(e.target.value)}
          >
            {FRAUDS.map(option => (
              <option key={option.id} value={option.id}>
                {option.knownGap ? `${option.label} (known gap)` : option.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn ghost" disabled={busy || loading} onClick={() => void start(`fraud:${fraud}`)}>
            Run this fraud
          </button>
        </div>
        {starting && <p className="muted" role="status">Starting the run…</p>}
        {running && <p className="muted" role="status">Running on the server. The times come from the server.</p>}
        {error !== null && <div className="alert">{error}</div>}
        {run?.state === "FAILED" && <div className="alert">{failureWords(run.failure)}</div>}
        {result !== null && <PrintPanel result={result} />}
      </section>

      {PRINT_ROW.scoreCard !== null && PRINT_ROW.scoreWords !== null && (
        <section className="card pad">
          <h2>Print score card</h2>
          {scoreLines(PRINT_ROW.scoreCard, PRINT_ROW.scoreWords).map(line => (
            <p key={line}>{line}</p>
          ))}
          {PRINT_ROW.scoreNote !== null && <small className="muted">{PRINT_ROW.scoreNote}</small>}
        </section>
      )}

      <section className="card pad">
        <p>
          <b>{HONEST_LIMIT}</b>
        </p>
        <p>{MONEY_LINE}</p>
        <p className="muted">
          <Link to="/verifiers">See every verifier</Link>
        </p>
      </section>
    </>
  );
}

function errorOf(e: unknown): string {
  return e instanceof ApiError ? (printRefusalWords(e.code) ?? errorText(e)) : errorText(e);
}

function QualificationPanel({ result }: { result: PrintDemoRunView }) {
  const { qualification, certificate } = result;
  return (
    <div className="print-run">
      <p>
        <b>{farmHeading(result.farm.name)}</b>{" "}
        <span className={qualification.qualified ? "pill ok" : "pill alert"}>{qualification.qualified ? "Qualified" : "Not qualified"}</span>
      </p>
      <p className="muted">{tallyLine(qualification)}</p>
      <ol className="print-list">
        {qualification.challenges.map((challenge, index) => (
          <li key={challenge.id}>
            <span>
              <b>{challenge.expect === "FULFIL" ? `Challenge ${index + 1}` : "Trap job"}</b>{" "}
              <span className={challenge.passed ? "pill ok" : "pill alert"}>{challengeStatus(challenge)}</span>
            </span>
            <small>{challenge.label}</small>
            <small>{challenge.detail}</small>
          </li>
        ))}
      </ol>
      {certificate !== null && (
        <dl className="kvs">
          <dt>Certificate</dt>
          <dd>Qualification certificate (Simulated)</dd>
          <dt>Seller</dt>
          <dd>{certificate.seller}</dd>
          <dt>Valid</dt>
          <dd>
            {utc(certificate.issuedAt)} to {utc(certificate.expiresAt)}
          </dd>
          <dt>Digest</dt>
          <dd className="mono print-digest">{certificate.digest}</dd>
        </dl>
      )}
    </div>
  );
}

function PrintPanel({ result }: { result: PrintDemoRunView }) {
  const print = result.print;
  if (print === null) {
    return <div className="alert warn">The farm did not qualify, so it printed nothing and the judge saw no print.</div>;
  }
  const verdict = verdictView(print);
  return (
    <section className="print-run" aria-label="The print and the judge's verdict" aria-live="polite">
      <div className="meta">
        <span className={verdict.tone === "ok" ? "pill ok" : "pill alert"}>
          <span className="dot" />
          {verdict.title}
        </span>
        <span className="sandbox">Simulated print</span>
      </div>
      <p>{farmDoingLine(print)}</p>
      <p>
        <b>{verdict.sentence}</b>
      </p>
      {print.reasons.length > 0 && (
        <ul className="print-list">
          {print.reasons.map((reason, index) => (
            <li key={`${reason.kind}-${index}`}>{reason.text}</li>
          ))}
        </ul>
      )}
      <p>
        <b>Evidence the judge read</b>
      </p>
      <dl className="kvs">
        {evidenceRows(print.evidence).map(row => (
          <Fragment key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="muted">Job: {print.job.label}.</p>
    </section>
  );
}
