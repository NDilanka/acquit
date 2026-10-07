import { useCallback, useEffect, useState } from "react";
import type { BidView, JobView, MergeProgress, UserCommand } from "../api-types";
import { api, ApiError, type RepoIssue } from "../api";
import { arbiterNoteLine, authorityNote, disputeNote, escrowFee, eta, ledgerNote, mergeNote, refundNote, releaseNote, usd, utc } from "../format";
import { useIntent } from "../intent";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { houseName, lockedBid, StatusPill } from "../ui";
import { BidForm } from "./BidForm";

export function JobPage({ id }: { id: string }) {
  const { user } = useSession();
  const { location } = useRouter();
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suite, setSuite] = useState<RepoIssue["suite"] | null>(null);
  const [checkout, setCheckout] = useState<BidView | null>(null);
  const [confirm, setConfirm] = useState<BidView | null>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const accept = useIntent();
  const cancel = useIntent();
  const approve = useIntent();
  const dispute = useIntent();
  const isClient = user.role === "CLIENT";
  const fundingRetry = location.search.get("funding") === "retry";

  const load = useCallback(async () => {
    try {
      const r = await api.job(id);
      setJob(r.job);
      setError(null);
      return r.job;
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 404 ? "Job not found." : e.message) : String(e));
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fast poll while waiting for a PayPal order or release; slow poll while bids may still arrive, a verdict is due, or the merge runs.
  const polling =
    checkout !== null || job?.phase === "RELEASE_PENDING"
      ? 1000
      : job?.status === "OPEN" ||
          job?.phase === "VERIFYING" ||
          job?.phase === "AWAITING_CLIENT" ||
          job?.phase === "DISPUTED" ||
          job?.merge?.phase === "PENDING"
        ? 4000
        : null;
  useEffect(() => {
    if (polling === null) return;
    const t = window.setInterval(() => void load(), polling);
    return () => window.clearInterval(t);
  }, [polling, load]);

  useEffect(() => {
    if (checkout && job?.approveUrl) window.location.assign(job.approveUrl);
  }, [checkout, job?.approveUrl]);

  useEffect(() => {
    if (!isClient || !job || suite) return;
    api
      .repos()
      .then((r) => {
        for (const repo of r.repos) for (const i of repo.issues) if (i.title === job.title) setSuite(i.suite);
      })
      .catch(() => undefined);
  }, [isClient, job, suite]);

  if (error && !job) {
    return (
      <div className="card pad">
        <div className="alert">{error}</div>
        <Link to="/">Back to jobs</Link>
      </div>
    );
  }
  if (!job) return <p className="muted">Loading job…</p>;

  const locked = lockedBid(job);
  const funding = job.status === "OPEN" && job.phase === "FUNDING";
  const canCancel = isClient && job.status === "OPEN" && !funding && checkout === null;
  const mergeCommit = job.viewerCanApprove && !job.dispute ? job.mergeCommit : null;
  const disputeCommit = job.viewerCanDispute && !job.dispute ? job.mergeCommit : null;
  const reviewing = job.phase === "AWAITING_CLIENT" && !job.dispute;
  const held = job.ledger.find((line) => line.kind === "HELD") ?? null;

  const doAccept = async (bid: BidView) => {
    const outcome = await accept.send(`accept:${bid.id}`, (): UserCommand => ({
      type: "AcceptBid",
      jobId: job.id,
      bidId: bid.id,
    }));
    setConfirm(null);
    if (outcome) {
      setCheckout(bid);
      if (outcome.result.kind === "JOB") setJob(outcome.result.job);
    }
  };

  const doCancel = async () => {
    if (!window.confirm("Cancel this job? Bidders get their credits back.")) return;
    const outcome = await cancel.send(`cancel:${job.id}`, (): UserCommand => ({ type: "CancelJob", jobId: job.id }));
    if (outcome) await load();
  };

  const doApprove = async (commit: string) => {
    const outcome = await approve.send(`approve:${job.id}:${commit}`, (): UserCommand => ({
      type: "Approve",
      jobId: job.id,
      mergeCommit: commit,
    }));
    if (outcome?.result.kind === "JOB") setJob(outcome.result.job);
    const fresh = await load();
    // Another tab may have approved first. The refusal (REVIEW_CLOSED, or WRONG_STATE once PAID) then means success.
    if (!outcome && fresh && (fresh.status === "PAID" || fresh.phase === "RELEASE_PENDING")) approve.setError(null);
    setConfirmApprove(false);
  };

  const doDispute = async (commit: string, reason: string) => {
    const outcome = await dispute.send(`dispute:${job.id}:${commit}:${reason}`, (): UserCommand => ({
      type: "Dispute",
      jobId: job.id,
      mergeCommit: commit,
      reason,
    }));
    if (outcome?.result.kind === "JOB") setJob(outcome.result.job);
    const fresh = await load();
    // Another tab may have disputed first; the job then already reads DISPUTED.
    if (!outcome && fresh?.dispute) dispute.setError(null);
    if (outcome || fresh?.dispute) {
      setDisputing(false);
      setDisputeReason("");
    }
  };

  return (
    <>
      <div className="crumbs">
        <Link to={isClient ? "/" : "/operator"}>{isClient ? "Jobs" : "Open jobs"}</Link> / <b className="mono">{job.id}</b>
      </div>
      <div className="head">
        <div>
          <h1>{job.title}</h1>
          <div className="meta">
            <StatusPill job={job} />
            <span>
              Budget <b className="num">{usd(job.budget)}</b>
            </span>
            <span>
              Deadline <b className="num">{utc(job.deliveryEndsAt)}</b>
            </span>
            {suite && (
              <span>
                Suite frozen at <b className="mono">{suite.commit}</b> ({suite.visible} tests, {suite.hidden} hidden)
              </span>
            )}
          </div>
        </div>
        {canCancel && (
          <button className="btn ghost" disabled={cancel.busy} onClick={() => void doCancel()}>
            {cancel.busy ? "Cancelling…" : "Cancel job"}
          </button>
        )}
      </div>
      {cancel.error && <div className="alert">{cancel.error}</div>}

      {fundingRetry && (
        <div className="alert warn">
          PayPal did not confirm the payment yet. Your approval is kept; no money moved twice.{" "}
          <a href={`/paypal/return?jobId=${encodeURIComponent(job.id)}`}>Check the payment again</a>
        </div>
      )}

      {job.status === "OPEN" && job.refundReason && (
        <div className="alert warn">{refundNote(job.refundReason, false, job.attempts.used + job.attempts.left)}</div>
      )}

      <div className="grid">
        <div>
          {job.status === "OPEN" && !funding && checkout === null && (
            <Bids job={job} isClient={isClient} busy={accept.busy} onAccept={setConfirm} />
          )}
          {accept.error && <div className="alert">{accept.error}</div>}

          {(checkout || (funding && isClient)) && (
            <Checkout
              bid={checkout ?? locked}
              approveUrl={job.approveUrl}
              redirecting={checkout !== null}
            />
          )}

          {job.status !== "OPEN" && <StatusPanel job={job} locked={locked} />}
          {(mergeCommit || disputeCommit || (reviewing && job.reviewEndsAt)) && (
            <section className="card pad">
              <h2>Client review</h2>
              <p className="muted">
                {job.mergeCommit && (
                  <>
                    The verifier passed commit <b className="mono">{short(job.mergeCommit)}</b>.{" "}
                  </>
                )}
                {job.reviewEndsAt &&
                  (mergeCommit || disputeCommit ? (
                    <>If you do nothing, Acquit releases the payment at {utc(job.reviewEndsAt)}.</>
                  ) : (
                    <>
                      The client can approve or dispute until {utc(job.reviewEndsAt)}. If the client does nothing, Acquit releases the
                      payment then.
                    </>
                  ))}
              </p>
              {disputing && disputeCommit ? (
                <form
                  className="form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const reason = disputeReason.trim();
                    if (reason) void doDispute(disputeCommit, reason);
                  }}
                >
                  <label>
                    <span>What is wrong with the delivery?</span>
                    <textarea
                      rows={2}
                      value={disputeReason}
                      onChange={(e) => setDisputeReason(e.target.value)}
                      placeholder="The fix passes the tests but breaks rounding for EUR invoices."
                    />
                  </label>
                  {dispute.error && <div className="alert">{dispute.error}</div>}
                  <div className="act">
                    <small className="muted">The review clock pauses. An arbiter decides within 48 hours.</small>
                    <button type="button" className="btn ghost" disabled={dispute.busy} onClick={() => setDisputing(false)}>
                      Back
                    </button>
                    <button className="btn" disabled={dispute.busy || disputeReason.trim() === ""}>
                      {dispute.busy ? "Opening…" : "Open dispute"}
                    </button>
                  </div>
                </form>
              ) : (
                (mergeCommit || disputeCommit) && (
                  <div className="act">
                    {disputeCommit && (
                      <button className="btn ghost" onClick={() => setDisputing(true)}>
                        Open dispute
                      </button>
                    )}
                    {mergeCommit && (
                      <button className="btn green" disabled={approve.busy} onClick={() => setConfirmApprove(true)}>
                        Approve and release
                      </button>
                    )}
                  </div>
                )
              )}
            </section>
          )}
          {approve.error && !confirmApprove && <div className="alert">{approve.error}</div>}
          {dispute.error && !disputing && <div className="alert">{dispute.error}</div>}
          {job.dispute && (
            <section className="card pad">
              <h2>Disputed</h2>
              <p>{disputeNote(job.dispute)}</p>
              <p className="muted">
                The review clock is paused. The arbiter releases the payment, refunds the client, or sends the work back. If the arbiter
                misses the deadline, Acquit releases the payment.
              </p>
            </section>
          )}
          {judgedStatuses.includes(job.status) && <Verifier job={job} />}

          {!isClient && job.status === "OPEN" && !funding && !job.bids.operators.some((b) => b.handle === user.handle) && (
            <div className="card pad">
              <h2>Place a bid</h2>
              <BidForm job={job} onPlaced={() => void load()} />
            </div>
          )}
        </div>

        <aside>
          <div className="card pad">
            <h2>Escrow</h2>
            <div className="kv">
              <span>Status</span>
              <b>{job.status}</b>
            </div>
            <div className="kv">
              <span>Phase</span>
              <b>{job.phase}</b>
            </div>
            <div className="kv">
              <span>Escrow</span>
              <b>{job.escrow}</b>
            </div>
            {locked && (
              <div className="kv">
                <span>Locked to</span>
                <b>{locked.handle}</b>
              </div>
            )}
            {reviewing && job.reviewEndsAt && (
              <div className="kv">
                <span>Review ends</span>
                <b className="num">{utc(job.reviewEndsAt)}</b>
              </div>
            )}
            {job.dispute && (
              <div className="kv">
                <span>Arbiter decides by</span>
                <b className="num">{utc(job.dispute.resolveBy)}</b>
              </div>
            )}
            <div className="kv">
              <span>Attempts</span>
              <b className="num">
                {job.receipt ? `${job.attempts.used} used` : `${job.attempts.used} used, ${job.attempts.left} left`}
              </b>
            </div>
          </div>
          <Ledger job={job} locked={locked} />
        </aside>
      </div>

      {confirm && (
        <div className="scrim" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Accept {confirm.label === "HOUSE" ? `House: ${houseName(confirm.handle)}` : confirm.handle}?</h3>
            <p>Acquit creates a PayPal order that can pay only this operator. You pay now; money is released on verified proof.</p>
            <Breakdown price={confirm.price} />
            {accept.error && <div className="alert">{accept.error}</div>}
            <div className="act">
              <button className="btn ghost" onClick={() => setConfirm(null)}>Back</button>
              <button className="btn green" disabled={accept.busy} onClick={() => void doAccept(confirm)}>
                {accept.busy ? "Creating order…" : "Accept and pay with PayPal"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmApprove && mergeCommit && (
        <div className="scrim" onClick={() => !approve.busy && setConfirmApprove(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Approve and release {held ? usd(held.cents) : "the escrow"}?</h3>
            <p>
              PayPal releases the escrow: {locked ? <b>{locked.handle}</b> : "the operator"} is paid for the job and the rest covers the
              fees. Acquit merges commit <b className="mono">{short(mergeCommit)}</b>
              {job.pullRequest !== null && <> (pull request #{job.pullRequest})</>}. This cannot be undone.
            </p>
            <div className="rows">
              {held && (
                <div>
                  <span>Held in escrow</span>
                  <b className="num">{usd(held.cents)}</b>
                </div>
              )}
              {locked && (
                <div>
                  <span>Job price, paid to {locked.handle} less the operator fee</span>
                  <b className="num">{usd(locked.price)}</b>
                </div>
              )}
              <div>
                <span>Commit to merge</span>
                <b className="mono">{mergeCommit}</b>
              </div>
            </div>
            {approve.error && <div className="alert">{approve.error}</div>}
            <div className="act">
              <button className="btn ghost" disabled={approve.busy} onClick={() => setConfirmApprove(false)}>Back</button>
              <button className="btn green" disabled={approve.busy} onClick={() => void doApprove(mergeCommit)}>
                {approve.busy ? "Releasing…" : "Approve and release"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Bids({
  job,
  isClient,
  busy,
  onAccept,
}: {
  job: JobView;
  isClient: boolean;
  busy: boolean;
  onAccept: (bid: BidView) => void;
}) {
  const ops = job.bids.operators;
  const house = job.bids.house;
  return (
    <section className="card bids">
      <div className="pad hd">
        <h2>Bids</h2>
        <small className="muted">
          {ops.length + (house ? 1 : 0)} waiting. Receipts count escrow releases, not star ratings.
        </small>
      </div>
      <div className="section-label">Operators</div>
      {ops.length === 0 && <p className="pad muted">No operator bids yet.</p>}
      {ops.map((b) => (
        <BidRow key={b.id} bid={b} isClient={isClient} busy={busy} onAccept={onAccept} />
      ))}
      <div className="section-label">House</div>
      {house ? (
        <BidRow bid={house} isClient={isClient} busy={busy} onAccept={onAccept} />
      ) : (
        <p className="pad muted">No House bid on this job.</p>
      )}
    </section>
  );
}

function BidRow({
  bid,
  isClient,
  busy,
  onAccept,
}: {
  bid: BidView;
  isClient: boolean;
  busy: boolean;
  onAccept: (bid: BidView) => void;
}) {
  const isHouse = bid.label === "HOUSE";
  return (
    <div className={`bidrow ${bid.status === "PENDING" ? "" : "dim"}`}>
      <div className="who">
        <b>{isHouse ? `House (quality bar): ${houseName(bid.handle)}` : bid.handle}</b>
        {bid.pitch && <p className="pitch">{bid.pitch}</p>}
      </div>
      <div className="num price">{usd(bid.price)}</div>
      <div className="num">{eta(bid.eta)}</div>
      <div className="mono agent" title={bid.runner}>
        {bid.agent}
      </div>
      <div className="receipts">
        {isHouse
          ? `${bid.paidReceipts} passed verified CI`
          : `${bid.paidReceipts} verified receipt${bid.paidReceipts === 1 ? "" : "s"}`}
      </div>
      <div className="r">
        {isClient && bid.status === "PENDING" ? (
          <button className="btn sm" disabled={busy} onClick={() => onAccept(bid)}>
            Accept
          </button>
        ) : (
          <small className="muted">{bid.status}</small>
        )}
      </div>
    </div>
  );
}

function Breakdown({ price }: { price: number }) {
  const fee = escrowFee(price);
  return (
    <div className="rows">
      <div>
        <span>Job budget</span>
        <b className="num">{usd(price)}</b>
      </div>
      <div>
        <span>Verified escrow fee (5%)</span>
        <b className="num">{usd(fee)}</b>
      </div>
      <div className="total">
        <span>Total</span>
        <b className="num">{usd(price + fee)}</b>
      </div>
    </div>
  );
}

function Checkout({ bid, approveUrl, redirecting }: { bid: BidView | null; approveUrl: string | null; redirecting: boolean }) {
  return (
    <section className="card pad checkout">
      <h2>PayPal sandbox checkout</h2>
      <p className="muted">
        {bid ? (
          <>
            The order can pay only <b>{bid.handle}</b>, or refund you.
          </>
        ) : (
          "The order names the accepted operator as its only payee."
        )}
      </p>
      {bid && <Breakdown price={bid.price} />}
      {redirecting ? (
        <p className="muted">{approveUrl ? "Sending you to PayPal…" : "Creating the PayPal order…"}</p>
      ) : approveUrl ? (
        <a className="btn green" href={approveUrl}>
          Resume PayPal checkout
        </a>
      ) : (
        <p className="muted">Waiting for PayPal to confirm the payment.</p>
      )}
    </section>
  );
}

const mergeTone: Record<MergeProgress["phase"], string> = { PENDING: "pill held", MERGED: "pill ok", NEEDS_HUMAN: "alert warn" };

function StatusPanel({ job, locked }: { job: JobView; locked: BidView | null }) {
  const { receipt, contract } = job;
  const refund = job.ledger.find((line) => line.kind === "REFUND");
  const pr = receipt?.pullRequest ?? job.pullRequest;
  const reason = refundNote(job.refundReason, job.status === "REFUNDED", job.attempts.used + job.attempts.left);
  const arbiter = arbiterNoteLine(job);
  return (
    <section className="card pad statuspanel">
      <pre className="mono">
        {`Status: ${job.status}\n`}
        {locked ? `Operator: ${locked.handle}\n` : ""}
        {`Escrow: ${job.escrow}${locked && job.escrow === "HELD" ? `, locked to ${locked.handle}` : ""}`}
        {receipt ? `\nReceipt: ${receipt.id}` : ""}
      </pre>
      {pr !== null &&
        (contract ? (
          <p>
            Pull request{" "}
            <a href={`https://github.com/${contract.repository}/pull/${pr}`} target="_blank" rel="noreferrer">
              {contract.repository}#{pr}
            </a>
          </p>
        ) : (
          <p>Pull request #{pr}</p>
        ))}
      {receipt && (
        <p className="muted">
          Paid {usd(receipt.paid)} at {utc(receipt.releasedAt)}. Frozen tests {receipt.frozen.passed}/{receipt.frozen.expected}, hidden
          tests {receipt.hidden.passed}/{receipt.hidden.expected}, attempts {receipt.attemptsUsed} of {job.attempts.used + job.attempts.left}.
          Approved commit <span className="mono">{short(receipt.mergeCommit)}</span>.
        </p>
      )}
      {job.merge && (
        <p>
          <span className={mergeTone[job.merge.phase]}>{mergeNote(job.merge, job.pullRequest, job.mergeCommit)}</span>
        </p>
      )}
      {job.status === "PAID" && job.releaseAuthority && (
        <p>
          <b>{authorityNote(job.releaseAuthority)}.</b>
        </p>
      )}
      {job.release && <p className="muted small mono">{releaseNote(job.release)}</p>}
      {refund && (
        <p>
          Refunded <b className="num">{usd(refund.cents)}</b> to the client at {utc(refund.at)}.
        </p>
      )}
      {reason && (
        <p>
          <b>{reason}</b>
        </p>
      )}
      {arbiter && <p className="muted">{arbiter}</p>}
    </section>
  );
}

type Tally = { readonly expected: number; readonly passed: number };

type Attempt = { readonly ordinal: number; readonly sourceCommit: string; readonly at: string } & (
  | { readonly result: "REJECTED"; readonly reasons: readonly string[]; readonly reasonsTruncated: number }
  | { readonly result: "VERIFIED"; readonly frozen: Tally; readonly hidden: Tally; readonly pullRequest: number }
);

type VerifierFields = {
  readonly attempts: {
    readonly used: number;
    readonly left: number;
    readonly history: readonly Attempt[];
    readonly pending: { readonly ordinal: number; readonly sourceCommit: string; readonly submittedAt: string; readonly runEndsAt: string } | null;
    readonly failure: { readonly sourceCommit: string; readonly name: string; readonly detail: string; readonly at: string } | null;
  };
};

const short = (sha: string) => sha.slice(0, 7);

/** Only these statuses carry the attempt history in the job view; a PAID job's proof lives in its receipt. */
const judgedStatuses: readonly JobView["status"][] = ["IN_PROGRESS", "VERIFIED", "REFUNDED"];

function Verifier({ job }: { job: JobView }) {
  // api-types.ts does not mirror the projection's history, pending, or failure fields.
  const { attempts, contract } = job as JobView & VerifierFields;
  const total = attempts.used + attempts.left;
  const { pending, failure, history } = attempts;
  return (
    <section className="card bids">
      <div className="pad hd">
        <h2>Verifier</h2>
        <small className="muted">
          {attempts.used} of {total} attempts used. A rejection keeps escrow held.
        </small>
      </div>
      {failure && (
        <div className="pad">
          <div className="alert warn">
            The run for commit <b className="mono">{short(failure.sourceCommit)}</b> ended without a verdict at {utc(failure.at)}:{" "}
            <b className="mono">{failure.name}</b>
            {failure.detail && `: ${failure.detail}`}. It did not use an attempt. Submit again.
          </div>
        </div>
      )}
      {pending && (
        <>
          <div className="section-label">Attempt {pending.ordinal} of {total}</div>
          <p className="pad">
            Verification in progress for commit <b className="mono">{short(pending.sourceCommit)}</b>, submitted{" "}
            {utc(pending.submittedAt)}. The run ends by {utc(pending.runEndsAt)}.
          </p>
        </>
      )}
      {history.length === 0 && !pending && <p className="pad muted">No attempt has been judged.</p>}
      {history.map((a) => (
        <div key={a.ordinal}>
          <div className="section-label">Attempt {a.ordinal} of {total}</div>
          <dl className="kvs pad">
            <dt>Verifier result</dt>
            <dd>
              <span className={`pill ${a.result === "VERIFIED" ? "ok" : "held"}`}>{a.result}</span>
            </dd>
            <dt>Source commit</dt>
            <dd className="mono">{short(a.sourceCommit)}</dd>
            <dt>Judged</dt>
            <dd className="num">{utc(a.at)}</dd>
            {a.result === "REJECTED" ? (
              <>
                <dt>Reasons</dt>
                <dd>
                  <ul className="reasons">
                    {a.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                    {a.reasonsTruncated > 0 && <li className="muted">and {a.reasonsTruncated} more reasons not shown</li>}
                  </ul>
                </dd>
              </>
            ) : (
              <>
                <dt>Frozen tests</dt>
                <dd className="num">
                  {a.frozen.passed} passed{contract && ` (suite frozen at ${short(contract.frozenAt)})`}
                </dd>
                <dt>Hidden tests</dt>
                <dd className="num">{a.hidden.passed} passed</dd>
                <dt>Required tests</dt>
                <dd className="num">{a.frozen.expected + a.hidden.expected} completed, 0 skipped or missing</dd>
                <dt>Pull request</dt>
                <dd>
                  {contract ? (
                    <a href={`https://github.com/${contract.repository}/pull/${a.pullRequest}`} target="_blank" rel="noreferrer">
                      {contract.repository}#{a.pullRequest}
                    </a>
                  ) : (
                    `#${a.pullRequest}`
                  )}
                </dd>
              </>
            )}
          </dl>
        </div>
      ))}
    </section>
  );
}

function Ledger({ job, locked }: { job: JobView; locked: BidView | null }) {
  return (
    <div className="card pad ledger">
      <h2>Ledger</h2>
      {job.ledger.length === 0 ? (
        <p className="muted small">No money has moved yet.</p>
      ) : (
        <ul>
          {job.ledger.map((line, i) => (
            <li key={`${line.kind}-${i}`} className="mono">
              <span className="when">{utc(line.at).replace(" UTC", "")}</span>
              <span>{job.id}</span>
              <b className={`k ${line.kind.toLowerCase()}`}>{line.kind}</b>
              <span className="num">{usd(line.cents)}</span>
              <span className="note">{ledgerNote(line, locked)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
