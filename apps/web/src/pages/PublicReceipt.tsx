import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { errorText } from "../errors";
import { utc } from "../format";
import { Link } from "../router";
import { digestOfHiddenCases } from "../receipt-digest";
import {
  attemptLine,
  digestVerdict,
  moneyLines,
  operatorLine,
  outcomeLine,
  paypalLines,
  SANDBOX_NOTE,
  SCRIPTED_NOTE,
  scoreCardLines,
  type DigestCheck,
  type PublicReceipt,
} from "../receipt-view";
import { IdChip, NotFound } from "../ui";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly receipt: PublicReceipt };

/** The public receipt of one paid job. Read-only: the page has no action, because the proof is the whole page. */
export function PublicReceiptPage({ receiptId, signedIn }: { receiptId: string; signedIn: boolean }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [check, setCheck] = useState<DigestCheck>({ kind: "PENDING" });

  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    api.publicReceipt(receiptId).then(
      (body) => { if (live) setLoad({ kind: "ready", receipt: body.receipt }); },
      (error: unknown) => {
        if (!live) return;
        setLoad(error instanceof ApiError && error.status === 404
          ? { kind: "missing" }
          : { kind: "failed", message: errorText(error) });
      },
    );
    return () => { live = false; };
  }, [receiptId]);

  const revealed = load.kind === "ready" ? (load.receipt.hiddenCases?.revealed ?? null) : null;
  useEffect(() => {
    if (revealed === null) return;
    let live = true;
    setCheck({ kind: "PENDING" });
    digestOfHiddenCases(revealed.cases, revealed.salt).then(
      (digest) => { if (live) setCheck({ kind: "COMPUTED", digest }); },
      () => { if (live) setCheck({ kind: "UNAVAILABLE" }); },
    );
    return () => { live = false; };
  }, [revealed]);

  if (load.kind === "loading") return <div className="muted">Loading the receipt…</div>;
  if (load.kind === "missing") {
    return <NotFound signedIn={signedIn} title="Receipt not found" message="No paid job has this receipt." />;
  }
  if (load.kind === "failed") return <div className="alert">{load.message}</div>;

  const r = load.receipt;
  const verdict = digestVerdict(r.hiddenCases, check);
  const committed = r.hiddenCases?.committedAt ? ` Committed ${utc(r.hiddenCases.committedAt)}, before the work started.` : "";
  return (
    <>
      <div className="crumbs">Receipt</div>
      <div className="head">
        <div>
          <h1>{r.title ?? "Paid job"}</h1>
          <div className="meta">
            <IdChip value={r.id} />
            {r.issue !== null && <span>Issue #{r.issue}</span>}
            <span className="pill ok"><span className="dot" />Paid</span>
            <span className="sandbox" title={SANDBOX_NOTE}>Sandbox</span>
            {r.scripted && <span className="sandbox" title={SCRIPTED_NOTE}>Simulated</span>}
            {r.source === "SEED" && <span className="pill new">Seeded</span>}
          </div>
        </div>
      </div>

      <section className="card pad">
        <h2>Outcome</h2>
        <p>{outcomeLine(r)}</p>
        <p className="muted">{operatorLine(r.operator)} {SANDBOX_NOTE}</p>
        {r.scripted && <p className="muted">{SCRIPTED_NOTE}</p>}
        <div className="rows">
          {moneyLines(r.money).map((line) => (
            <div key={line.label}>
              <span>{line.label}</span>
              <b className="num">{line.value}</b>
            </div>
          ))}
        </div>
      </section>

      <section className="card pad">
        <h2>Verdicts</h2>
        <p>
          Visible tests {r.verdict.frozen.passed} of {r.verdict.frozen.expected}, hidden tests {r.verdict.hidden.passed} of{" "}
          {r.verdict.hidden.expected}. Attempts used {r.verdict.attemptsUsed} of {r.verdict.attemptsAllowed}.
        </p>
        <ol>
          {r.verdict.history.map((attempt) => (
            <li key={attempt.ordinal}>{attemptLine(attempt, r.verdict.attemptsAllowed)}</li>
          ))}
        </ol>
        <p className="muted">
          Pull request #{r.verdict.pullRequest}, judged tree <IdChip value={r.verdict.mergeCommit} />
        </p>
      </section>

      <section className="card pad">
        <h2>Hidden cases</h2>
        {r.hiddenCases === null ? (
          <p className="muted">
            This job ran the fixture's own hidden tests. They are shared by every account, so they are never published.
          </p>
        ) : (
          <>
            <p>
              Committed digest <IdChip value={r.hiddenCases.committedDigest} />.{committed}
            </p>
            <p>
              {verdict === "MATCH" && <b>Match. Your browser recomputed this digest from the revealed cases and salt.</b>}
              {verdict === "NO_MATCH" && <b className="alert">No match. The revealed cases do not produce the committed digest.</b>}
              {verdict === "PENDING" && <span className="muted">Checking the revealed cases in your browser…</span>}
              {verdict === "UNAVAILABLE" && (
                <span className="muted">This browser cannot run the SHA-256 check here. Web Crypto needs https or localhost.</span>
              )}
              {verdict === "NOT_REVEALED" && (
                <span className="muted">
                  The cases are not revealed here, so this browser cannot check them. The commitment above still stands.
                </span>
              )}
            </p>
            {r.hiddenCases.revealed !== null && (
              <ol>
                {r.hiddenCases.revealed.cases.map((hidden) => (
                  <li key={hidden.id}>
                    <span className="mono">{hidden.target.module}</span> {hidden.target.export}({JSON.stringify(hidden.args)}) is{" "}
                    <span className="mono">{JSON.stringify(hidden.expected)}</span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>

      <section className="card pad money">
        <h2>PayPal ids</h2>
        <div className="rows">
          {paypalLines(r.paypal).map((line) => (
            <div key={line.label}>
              <span>
                {line.label}
                <small>{line.note}</small>
              </span>
              {line.id === null ? <b className="muted">None</b> : <IdChip value={line.id} />}
            </div>
          ))}
        </div>
      </section>

      <section className="card pad">
        <h2>Verifier score card</h2>
        {scoreCardLines(r.scoreCard).map((line) => (
          <p key={line}>{line}</p>
        ))}
        <small className="muted">The code judge's card as its CI run last verified it. The same card covers every job; it is not a per-job record.</small>
        <p>
          <Link to="/verifiers">How this verifier is tested</Link>
        </p>
      </section>
    </>
  );
}
