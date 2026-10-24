import { Fragment, useEffect, useId, useState } from "react";
import { api, ApiError } from "../api";
import type { PrintDemoRunView, PrintLayerView, PrintOutcomeView, PrintReceiptView, PrintRunView, PrintTimelineView } from "../api-types";
import { errorText } from "../errors";
import { utc } from "../format";
import { Link } from "../router";
import type { Session } from "../session";
import { FRAUDS } from "../../../../packages/verifier-print/src/catalog.ts";
import {
  browserDigestWords,
  challengeStatus,
  checkDigestInBrowser,
  distanceWords,
  evidenceRows,
  failureWords,
  farmDoingLine,
  farmHeading,
  fulfilmentWords,
  HONEST_LIMIT,
  layerFlag,
  MONEY_LINE,
  overlapWords,
  PRINT_INTRO,
  PRINT_TITLE,
  pngSource,
  printRefusalWords,
  QUALIFICATION_RULE,
  REAL_AND_SIMULATED,
  serverDigestWords,
  tallyLine,
  TRAP_NOTE,
  trapWords,
  verdictView,
} from "../print-view";
import { PRINT_ROW, scoreLines } from "../verifiers-view";

type Props = { readonly session: Session | null | undefined; readonly onSignedIn: (session: Session) => void };

/**
 * The public print demo, one job page read top to bottom: what is real, the run, the contract, the qualification
 * certificate, the layer timeline, the verdict, the evidence, the score card, and the receipt. A simulated farm
 * qualifies, then prints one job, and the real print judge decides. It reads without a session, like the verifier
 * registry. A run needs an account of its own, so the first run makes one.
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
      if (!session?.account) {
        const made = await api.createAccount();
        onSignedIn({ user: made.user, account: made.account });
      }
      setRun(await api.startPrintRun(farm));
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setStarting(false);
    }
  };

  const result = run?.result ?? null;
  const print = result?.print ?? null;
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

      <section className="card pad print-run" aria-labelledby={`${id}-run`}>
        <h2 id={`${id}-run`}>Run a farm</h2>
        <p className="muted">
          Each run draws new challenges and a new coupon. Every print is the same job: two 14 mm square parts, 8 mm high, at 25%
          infill. A run makes your own Acquit account first, if you have none. The judge runs on the server.
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
      </section>

      <section className="card pad print-run" aria-labelledby={`${id}-contract`}>
        <h2 id={`${id}-contract`}>Contract</h2>
        {print === null ? (
          <p className="muted">
            {result === null
              ? "Start a run to see the contract the judge froze for the job."
              : "The farm did not qualify, so no job was opened for it to print."}
          </p>
        ) : (
          <dl className="kvs">
            <dt>Job</dt>
            <dd>{print.job.label}</dd>
            <dt>Quantity</dt>
            <dd>{print.job.quantity}</dd>
            <dt>Infill</dt>
            <dd>{print.job.infillPct}%</dd>
            <dt>Layers</dt>
            <dd>
              {print.job.layerCount} at {print.job.layerHeightMm} mm
            </dd>
            <dt>Tolerance</dt>
            <dd>{print.job.toleranceMm} mm</dd>
            <dt>Coupon marker</dt>
            <dd>{print.job.markerId}, committed at open</dd>
          </dl>
        )}
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

      {print !== null && (
        <section className="card pad print-run" aria-labelledby={`${id}-timeline`}>
          <h2 id={`${id}-timeline`}>Layer timeline</h2>
          <LayerTimeline timeline={print.timeline} />
        </section>
      )}

      {print !== null && (
        <section className="card pad print-run" aria-labelledby={`${id}-verdict`}>
          <h2 id={`${id}-verdict`}>Verdict and reasons</h2>
          <VerdictPanel print={print} />
        </section>
      )}

      {print !== null && (
        <section className="card pad print-run" aria-labelledby={`${id}-evidence`}>
          <h2 id={`${id}-evidence`}>Evidence numbers</h2>
          <dl className="kvs">
            {evidenceRows(print.evidence).map(row => (
              <Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      )}

      {PRINT_ROW.scoreCard !== null && PRINT_ROW.scoreWords !== null && (
        <section className="card pad">
          <h2>Print score card</h2>
          {scoreLines(PRINT_ROW.scoreCard, PRINT_ROW.scoreWords).map(line => (
            <p key={line}>{line}</p>
          ))}
          {PRINT_ROW.scoreNote !== null && <small className="muted">{PRINT_ROW.scoreNote}</small>}
        </section>
      )}

      {print !== null && run !== null && (
        <section className="card pad print-run" aria-labelledby={`${id}-receipt`}>
          <h2 id={`${id}-receipt`}>Receipt</h2>
          <ReceiptPanel receipt={print.receipt} run={run} />
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
  const trap = qualification.challenges.find(challenge => challenge.expect === "DECLINE");
  return (
    <div className="print-run">
      <p>
        <b>{farmHeading(result.farm.name)}</b>{" "}
        <span className={qualification.qualified ? "pill ok" : "pill alert"}>{qualification.qualified ? "Qualified" : "Not qualified"}</span>
      </p>
      <p className="muted">{tallyLine(qualification)}</p>
      {certificate === null ? (
        <div className="alert warn">This farm did not qualify, so it holds no certificate.</div>
      ) : (
        <div className="certificate" role="group" aria-label="Qualification certificate (Simulated)">
          <div className="cert-head">
            <span className="pill">Simulated</span>
            <b>Qualification certificate</b>
          </div>
          <p className="cert-seller">{certificate.seller}</p>
          <p>{fulfilmentWords(qualification.fulfilled)}.</p>
          <p>{trap === undefined ? "No trap was run." : trapWords(trap)}</p>
          <dl className="kvs">
            <dt>Valid from</dt>
            <dd>{utc(certificate.issuedAt)}</dd>
            <dt>Valid to</dt>
            <dd>{utc(certificate.expiresAt)}</dd>
            <dt>Digest</dt>
            <dd className="mono print-digest">{certificate.digest}</dd>
          </dl>
        </div>
      )}
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
    </div>
  );
}

function LayerTimeline({ timeline }: { timeline: PrintTimelineView }) {
  return (
    <div className="print-run">
      <p className="muted">
        One row for each layer the contract samples. The left picture is the contract section, placed by the G-code, and the
        right is the farm's photo (Simulated). Both are drawn at one pixel per {timeline.imageScale} cells. The judge measured
        every 0.1 mm cell, so the numbers and the pictures differ in scale. A row covers the photo checks only; the G-code and
        telemetry checks can still reject the print, and the verdict below names them.
      </p>
      <ol className="layer-list">
        {timeline.layers.map(row => (
          <LayerRow key={row.layer} row={row} timeline={timeline} />
        ))}
      </ol>
    </div>
  );
}

function LayerRow({ row, timeline }: { row: PrintLayerView; timeline: PrintTimelineView }) {
  const flag = layerFlag(row, timeline);
  return (
    <li className={row.pass ? "layer-row" : "layer-row fail"}>
      <div className="layer-head">
        <b>Layer {row.layer}</b>
        <small>at {row.heightMm} mm</small>
        <span className={row.pass ? "pill ok" : "pill alert"}>{row.pass ? "Photo checks pass" : "Photo checks fail"}</span>
      </div>
      <div className="layer-pics">
        <figure className="layer-pic">
          <img src={pngSource(row.reference.png)} width={row.reference.cols} height={row.reference.rows} alt={`Contract section for layer ${row.layer}`} />
          <figcaption>Contract section (reference)</figcaption>
        </figure>
        <figure className="layer-pic">
          <img src={pngSource(row.photo.png)} width={row.photo.cols} height={row.photo.rows} alt={`Photo of layer ${row.layer}, Simulated`} />
          <figcaption>Photo (Simulated)</figcaption>
        </figure>
      </div>
      <p>{row.readable ? overlapWords(row.iou, timeline.iouMin) : "The overlap could not be measured."}</p>
      {flag !== null && (
        <p className="layer-flag">
          <b>{flag}</b>
        </p>
      )}
      <small>{distanceWords(row.distance)}</small>
      <small className="mono">Photo fingerprint {row.fingerprint}</small>
    </li>
  );
}

function VerdictPanel({ print }: { print: PrintOutcomeView }) {
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
      <p className="muted">Job: {print.job.label}.</p>
    </section>
  );
}

function ReceiptPanel({ receipt, run }: { receipt: PrintReceiptView; run: PrintRunView }) {
  const [check, setCheck] = useState<"pending" | "match" | "mismatch" | "unavailable">("pending");
  useEffect(() => {
    let live = true;
    checkDigestInBrowser(receipt).then(
      result => {
        if (live) setCheck(result);
      },
      () => {
        if (live) setCheck("unavailable");
      },
    );
    return () => {
      live = false;
    };
  }, [receipt]);
  return (
    <div className="print-run">
      <p className="muted">
        The job is closed now, so the terms it froze are revealed. The salt and the sampled layers rebuild the digest the job
        committed at open.
      </p>
      <dl className="kvs">
        <dt>Job</dt>
        <dd>{receipt.jobId}</dd>
        <dt>Contract digest</dt>
        <dd className="mono print-digest">{receipt.contractDigest}</dd>
        <dt>Hidden digest, committed at open</dt>
        <dd className="mono print-digest">{receipt.hiddenDigest}</dd>
        <dt>Sampled layers, revealed</dt>
        <dd>{receipt.reveal.hidden.sampleLayers.join(", ")}</dd>
        <dt>Salt, revealed</dt>
        <dd className="mono print-digest">{receipt.reveal.salt}</dd>
        <dt>G-code SHA-256</dt>
        <dd className="mono print-digest">{receipt.gcodeSha256}</dd>
        <dt>Telemetry frames (Simulated)</dt>
        <dd>{receipt.telemetry.frames}</dd>
        <dt>Telemetry chain head (Simulated)</dt>
        <dd className="mono print-digest">{receipt.telemetry.chainHead ?? "none"}</dd>
        <dt>Printer key SHA-256 (Simulated)</dt>
        <dd className="mono print-digest">{receipt.telemetry.printerKeySha256}</dd>
        <dt>Certificate digest</dt>
        <dd className="mono print-digest">{receipt.certificateDigest}</dd>
        <dt>Verdict and reasons</dt>
        <dd>
          {receipt.verdict}
          {receipt.reasonKinds.length > 0 ? `: ${receipt.reasonKinds.join(", ")}` : ""}
        </dd>
        <dt>Opened</dt>
        <dd>{utc(receipt.openedAt)}</dd>
        <dt>Run started</dt>
        <dd>{utc(run.startedAt)}</dd>
        <dt>Run ended</dt>
        <dd>{run.endedAt === null ? "Not yet" : utc(run.endedAt)}</dd>
      </dl>
      <div className="print-check" role="status">
        <p>
          <b>Check the digest</b>
        </p>
        <p>{browserDigestWords(check)}</p>
        <p className="muted">{serverDigestWords(receipt.digestMatches)}</p>
      </div>
    </div>
  );
}
