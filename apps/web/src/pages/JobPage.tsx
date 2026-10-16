import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColDef, GetRowIdFunc } from "ag-grid-community";
import type { BidView, CheckoutPhase, FundingMode, JobDiff, JobView, LedgerLine, MergeProgress, ScopingCase, UserCommand } from "../api-types";
import { api, ApiError } from "../api";
import { clockAhead, CLOCK_STEPS, demoControls, errorText, withJobChangedRetry } from "../demo";
import { arbiterNoteLine, authorityNote, disputeNote, escrowFee, eta, ledgerNote, mergeNote, refundNote, usd, utc } from "../format";
import { AcquitGrid } from "../grid";
import { bidStatusWord, draftFailureWord, escrowWord, ledgerKindWord, runFailureWord, statusLabel, verdictLabel } from "../job-status";
import { useIntent } from "../intent";
import { pollInterval } from "../poll";
import { approvalStep, approvalWindow, countsLine, leaveOut, readPanel, seededLabel, shortDigest, suiteLine, type ScopingPanel, type Settled } from "../scoping-review";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { allBids, houseName, IdChip, lockedBid, NotFound, payeeBid, StatusPill } from "../ui";
import { BidForm } from "./BidForm";

export function JobPage({ id }: { id: string }) {
  const { user, visitor, fundingMode } = useSession();
  const { location } = useRouter();
  const [job, setJob] = useState<JobView | null>(null);
  const [diff, setDiff] = useState<JobDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
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
      setDiff(r.diff ?? null);
      setError(null);
      setMissing(false);
      return r.job;
    } catch (e) {
      setDiff(null);
      setMissing(e instanceof ApiError && e.status === 404);
      setError(e instanceof ApiError ? e.message : String(e));
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // A card order captures without a redirect, so the checkout wait ends once the job leaves OPEN.
  const polling = job ? pollInterval(job, { awaitingOrder: checkout !== null && job.status === "OPEN" }) : null;
  useEffect(() => {
    if (polling === null) return;
    const t = window.setInterval(() => void load(), polling);
    return () => window.clearInterval(t);
  }, [polling, load]);

  useEffect(() => {
    if (checkout && job?.approveUrl) window.location.assign(job.approveUrl);
  }, [checkout, job?.approveUrl]);

  if (missing && !job) return <NotFound title="Job not found" action={{ to: user.role === "CLIENT" ? "/" : "/operator", label: "Back to jobs" }} />;
  if (error && !job) {
    return (
      <div className="card pad">
        <div className="alert">{error}</div>
        <Link to="/">Back to jobs</Link>
      </div>
    );
  }
  if (!job) return <p className="muted">Loading job…</p>;
  // Only the code vertical has a page here. The API names the vertical; a row stored before it reads as code.
  const vertical = (job as JobView & { readonly vertical?: string }).vertical ?? "code";
  if (vertical !== "code") {
    return (
      <div className="card pad">
        <h2>Unsupported vertical</h2>
        <p>This job is judged by the {vertical} vertical. This page does not show that vertical yet.</p>
        <Link to="/">Back to jobs</Link>
      </div>
    );
  }

  const locked = lockedBid(job);
  const funding = job.status === "OPEN" && job.phase === "FUNDING";
  // Before Accept the bids are the page; from Accept on the ledger spine leads instead.
  const bidding = job.status === "OPEN" && job.phase === "BIDDING" && checkout === null;
  const canCancel = isClient && bidding;
  const mergeCommit = job.viewerCanApprove && !job.dispute ? job.mergeCommit : null;
  const disputeCommit = job.viewerCanDispute && !job.dispute ? job.mergeCommit : null;
  const reviewing = job.phase === "AWAITING_CLIENT" && !job.dispute;
  const held = job.ledger.find((line) => line.kind === "HELD") ?? null;
  const controls = demoControls(job, { user, visitor });
  // A job's own choice wins; before accept, a job nobody chose for funds with the deployment's default.
  const source: FundingMode = job.funding ?? fundingMode;

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
        <Link to={isClient ? "/" : "/operator"}>{isClient ? "Jobs" : "Open jobs"}</Link> / <b>{job.title}</b>
      </div>
      <div className="head">
        <div>
          <h1>{job.title}</h1>
          <div className="meta">
            <IdChip value={job.id} />
          </div>
          <div className="meta">
            <StatusPill job={job} />
            <span>
              Budget <b className="num">{usd(job.budget)}</b>
            </span>
            <span>
              Deadline <b className="num">{utc(job.deliveryEndsAt)}</b>
            </span>
            {job.contract && <span>{suiteLine(job.contract)}</span>}
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
          {isClient && <ScopingReview job={job} />}
          {bidding ? (
            <Bids job={job} isClient={isClient} busy={accept.busy} onAccept={setConfirm} />
          ) : (
            <Ledger job={job} locked={locked} />
          )}
          {accept.error && <div className="alert">{accept.error}</div>}

          {job.status === "OPEN" && (checkout || (funding && isClient)) && (
            <Checkout job={job} bid={checkout ?? payeeBid(job)} redirecting={checkout !== null} card={source === "card"} />
          )}

          {job.status !== "OPEN" && <StatusPanel job={job} locked={locked} />}
          {(mergeCommit || disputeCommit || (reviewing && job.reviewEndsAt)) && (
            <section className="card pad">
              <h2>Client review</h2>
              <p className="muted">
                {job.mergeCommit && (
                  <>
                    The verifier passed commit <IdChip value={job.mergeCommit} />.{" "}
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
          {judgedStatuses.includes(job.status) && <Verifier job={job} diff={diff} />}

          {!isClient && bidding && !job.bids.operators.some((b) => b.handle === user.handle) && (
            <div className="card pad">
              <h2>Place a bid</h2>
              <BidForm job={job} onPlaced={() => void load()} />
            </div>
          )}
        </div>

        <aside>
          {controls.funding && <FundingChoice job={job} onChosen={() => void load()} />}
          {controls.clock && <JobClock job={job} onAdvanced={setJob} />}
          <div className="card pad">
            <h2>Escrow</h2>
            <div className="kv">
              <span>Status</span>
              <b>{statusLabel(job).label}</b>
            </div>
            <div className="kv">
              <span>Escrow</span>
              <b>{escrowWord(job.escrow)}</b>
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
        </aside>
      </div>

      {confirm && (
        <div className="scrim" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Accept {confirm.label === "HOUSE" ? `House: ${houseName(confirm.handle)}` : confirm.handle}?</h3>
            <p>
              {source === "card"
                ? "Acquit charges the sandbox test card now, for a payment that can pay only this operator. Money is released on verified proof."
                : "Acquit creates a PayPal order that can pay only this operator. You pay now; money is released on verified proof."}
            </p>
            <Breakdown price={confirm.price} payee={confirm.handle} />
            {accept.error && <div className="alert">{accept.error}</div>}
            <div className="act">
              <button className="btn ghost" onClick={() => setConfirm(null)}>Back</button>
              <button className="btn green" disabled={accept.busy} onClick={() => void doAccept(confirm)}>
                {accept.busy ? "Creating order…" : source === "card" ? "Accept and pay with the test card" : "Accept and pay with PayPal"}
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
              fees. Acquit merges commit <IdChip value={mergeCommit} />
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
                <IdChip value={mergeCommit} />
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

const DRAFTING_POLL_MS = 4000;

const settle = <T,>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (body) => ({ ok: true, body }),
    (error: unknown) => ({ ok: false, error }),
  );

/** The job's client reviews the drafted hidden cases and approves the ones it keeps; the approval freezes them. */
function ScopingReview({ job }: { job: JobView }) {
  const jobId = job.id;
  const [panel, setPanel] = useState<ScopingPanel>({ kind: "HIDDEN" });
  // Null until the first checkbox change: every drafted case starts kept.
  const [kept, setKept] = useState<ReadonlySet<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(
    async (shown: ScopingPanel) => {
      const next = readPanel(await settle(api.scoping(jobId)), shown);
      setPanel(next);
      return next;
    },
    [jobId],
  );

  useEffect(() => {
    void read({ kind: "HIDDEN" });
  }, [read]);

  const drafting = panel.kind === "DRAFTING";
  useEffect(() => {
    if (!drafting) return;
    const t = window.setInterval(() => void read({ kind: "DRAFTING" }), DRAFTING_POLL_MS);
    return () => window.clearInterval(t);
  }, [drafting, read]);

  if (panel.kind === "HIDDEN") return null;
  if (panel.kind === "UNREADABLE") return <div className="alert">The acceptance contract could not be read. {panel.message}</div>;
  if (panel.kind === "DRAFTING") {
    return (
      <section className="card pad">
        <h2>Acceptance contract</h2>
        <p className="muted">The acceptance contract is being drafted from the issue. You review it here before it freezes.</p>
      </section>
    );
  }
  if (panel.kind === "FAILED") {
    return (
      <section className="card pad">
        <h2>Acceptance contract</h2>
        <p>
          The draft failed: <b>{draftFailureWord(panel.reason)}</b>. Nothing was frozen. A draft never retries; a new job starts a new
          draft.
        </p>
      </section>
    );
  }

  const { draft } = panel;
  const approval = approvalWindow(job);
  const reviewing = panel.kind === "REVIEW" && approval.kind === "OPEN" ? panel : null;
  const keptIds = kept ?? new Set(draft.cases.map((c) => c.id));
  const toggle = (id: string) => {
    const next = new Set(keptIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setKept(next);
  };
  const approve = async () => {
    if (!reviewing) return;
    setBusy(true);
    const step = approvalStep(reviewing, await settle(api.approveScoping(jobId, leaveOut(draft.cases, keptIds))));
    setPanel(step.panel);
    setError(step.error);
    if (step.reread) await read(step.panel);
    setBusy(false);
  };

  return (
    <section className="card scoping">
      <div className="pad hd">
        <h2>Acceptance contract</h2>
        {draft.counts && <small className="muted">{countsLine(draft.counts)}.</small>}
      </div>
      <div className="pad">
        {panel.kind === "FROZEN" ? (
          <dl className="kvs">
            <dt>Status</dt>
            <dd>
              <span className="pill ok">Approved and frozen</span>
            </dd>
            {panel.digest && (
              <>
                <dt>Hidden manifest</dt>
                <dd className="mono" title={panel.digest}>
                  {shortDigest(panel.digest)}
                </dd>
              </>
            )}
            {panel.approvedAt && (
              <>
                <dt>Approved</dt>
                <dd className="num">{utc(panel.approvedAt)}</dd>
              </>
            )}
            <dt>Approved cases</dt>
            <dd className="mono">{panel.approvedIds.join(", ")}</dd>
          </dl>
        ) : approval.kind === "CLOSED" ? (
          <div className="alert">{approval.notice}</div>
        ) : (
          <p className="muted">
            Review the drafted hidden cases. Clear a case to leave it out; the approval freezes the rest and cannot be changed.
          </p>
        )}
        {draft.contract && <p className="contract">{draft.contract}</p>}
        {draft.issueBody && (
          <details>
            <summary>Issue body, the text each citation must quote</summary>
            <pre className="receipt-box">{draft.issueBody}</pre>
          </details>
        )}
      </div>
      <table className="tbl">
        <thead>
          <tr>
            {reviewing && <th>Keep</th>}
            <th>Case</th>
            <th>Target</th>
            <th>Args</th>
            <th>Expected</th>
            <th>Citation</th>
          </tr>
        </thead>
        <tbody>
          {draft.cases.map((c) => (
            <CaseRow key={c.id} c={c} keep={reviewing ? { on: keptIds.has(c.id), busy, toggle } : null} />
          ))}
        </tbody>
      </table>
      {reviewing && (
        <div className="pad">
          {error && <div className="alert">{error}</div>}
          <div className="act">
            <small className="muted">
              {keptIds.size} of {draft.cases.length} cases kept.
            </small>
            <button className="btn green" disabled={busy || keptIds.size === 0} onClick={() => void approve()}>
              {busy ? "Freezing…" : "Approve the kept cases"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function CaseRow({
  c,
  keep,
}: {
  c: ScopingCase;
  keep: { on: boolean; busy: boolean; toggle: (id: string) => void } | null;
}) {
  return (
    <tr>
      {keep && (
        <td>
          <input type="checkbox" aria-label={`Keep ${c.id}`} checked={keep.on} disabled={keep.busy} onChange={() => keep.toggle(c.id)} />
        </td>
      )}
      <td className="mono">{c.id}</td>
      <td className="mono">
        {c.target.module} <span className="muted">{c.target.export}</span>
      </td>
      <td className="mono">{JSON.stringify(c.args)}</td>
      <td className="mono">{JSON.stringify(c.expected)}</td>
      <td>{c.citation}</td>
    </tr>
  );
}

function bidder(bid: BidView): string {
  return bid.label === "HOUSE" ? `House: ${houseName(bid.handle)}` : bid.handle;
}

function proofLine(bid: BidView): string {
  if (bid.label === "HOUSE") return bid.houseLine || `${bid.paidReceipts} passed verified CI`;
  return `${bid.paidReceipts} verified receipt${bid.paidReceipts === 1 ? "" : "s"}`;
}

const bidRowId: GetRowIdFunc<BidView> = (p) => p.data.id;

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
  const rows = useMemo(() => allBids(job), [job]);
  const columns = useMemo<ColDef<BidView>[]>(
    () => [
      {
        headerName: "Operator",
        flex: 2,
        minWidth: 92,
        valueGetter: (p) => (p.data ? bidder(p.data) : ""),
        cellRenderer: (p: { data?: BidView }) =>
          p.data && (
            <div className="cellstack">
              <b>{bidder(p.data)}</b>
              {p.data.pitch && <small className="muted">{p.data.pitch}</small>}
            </div>
          ),
      },
      { headerName: "Proof", flex: 1.5, minWidth: 64, valueGetter: (p) => (p.data ? proofLine(p.data) : "") },
      { headerName: "Price", field: "price", minWidth: 62, cellClass: "num strong", valueFormatter: (p) => usd(p.value as number) },
      { headerName: "ETA", field: "eta", minWidth: 46, flex: 0.8, valueFormatter: (p) => eta(p.value as number) },
      {
        headerName: "",
        colId: "action",
        flex: 0,
        width: 92,
        minWidth: 92,
        cellRenderer: (p: { data?: BidView }) =>
          p.data &&
          (isClient && p.data.status === "PENDING" ? (
            <button className="btn sm" disabled={busy} onClick={() => onAccept(p.data!)}>
              Accept
            </button>
          ) : (
            <small className="muted">{bidStatusWord(p.data.status)}</small>
          )),
      },
    ],
    [isClient, busy, onAccept],
  );
  return (
    <section className="card bids">
      <div className="pad hd">
        <h2>Bids</h2>
        <small className="muted">{rows.length} waiting. Receipts count escrow releases, not star ratings.</small>
      </div>
      <AcquitGrid rows={rows} columns={columns} rowId={bidRowId} empty="No bids yet." />
    </section>
  );
}

function Breakdown({ price, payee }: { price: number; payee: string }) {
  const fee = escrowFee(price);
  return (
    <div className="rows">
      <div>
        <span>Payee</span>
        <b className="payee">{payee}</b>
      </div>
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

const FUNDING_CHOICES: readonly { mode: FundingMode; label: string; note: string }[] = [
  { mode: "card", label: "Sandbox test card", note: "Acquit charges a PayPal sandbox test card when you accept. No PayPal login." },
  { mode: "checkout", label: "PayPal checkout", note: "You approve the order on PayPal's sandbox site with a sandbox buyer account." },
];

function FundingChoice({ job, onChosen }: { job: JobView; onChosen: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (mode: FundingMode) => {
    setBusy(true);
    setError(null);
    try {
      await api.setFunding(job.id, mode);
      onChosen();
    } catch (e) {
      setError(errorText(e));
      // An accept bound the funding in the meantime, so the reload closes this card on the job's real state.
      if (e instanceof ApiError && e.code === "FUNDING_BOUND") onChosen();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card pad">
      <h2>Payment method</h2>
      <p className="muted small">How you pay when you accept a bid. Only this job changes.</p>
      {FUNDING_CHOICES.map((c) => (
        <label key={c.mode} className="choice">
          <input
            type="radio"
            name="funding"
            checked={job.funding === c.mode}
            disabled={busy}
            onChange={() => void choose(c.mode)}
          />
          <span>
            <b>{c.label}</b>
            <small>{c.note}</small>
          </span>
        </label>
      ))}
      {error && <div className="alert">{error}</div>}
    </div>
  );
}

function JobClock({ job, onAdvanced }: { job: JobView; onAdvanced: (job: JobView) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const advance = async (step: (typeof CLOCK_STEPS)[number]) => {
    setBusy(step.label);
    setError(null);
    try {
      const r = await withJobChangedRetry(() => api.advanceJobClock(job.id, step.ms));
      onAdvanced(r.job);
      setMoved(step.label.replace("Advance", "Moved this job forward"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="card pad">
      <h2>Job clock</h2>
      <p className="muted small">Skip ahead on this job's deadlines and review window. Other jobs keep their own time.</p>
      <p><b>{clockAhead(job.clockShiftMs ?? 0)}</b></p>
      <div className="act">
        {CLOCK_STEPS.map((s) => (
          <button key={s.label} className="btn ghost sm" disabled={busy !== null} onClick={() => void advance(s)}>
            {busy === s.label ? "Moving…" : s.label}
          </button>
        ))}
      </div>
      {moved && !error && <p className="muted small">{moved}.</p>}
      {error && <div className="alert">{error}</div>}
    </div>
  );
}

const CHECKOUT_STEP: Record<CheckoutPhase, string> = {
  CREATING_ORDER: "Creating the order…",
  AWAITING_APPROVAL: "Waiting for buyer approval",
  CAPTURING: "Capturing the payment…",
  REFUND_PENDING: "Refunding the payment…",
};

/** Names the stored checkout substate, so a reload mid-checkout still says where the payment is. */
function Checkout({ job, bid, redirecting, card }: { job: JobView; bid: BidView | null; redirecting: boolean; card: boolean }) {
  const phase = job.checkoutPhase;
  const waiting = card ? "Waiting for the sandbox test card to confirm the payment." : "Waiting for PayPal to confirm the payment.";
  const step = phase
    ? CHECKOUT_STEP[phase]
    : redirecting
      ? card
        ? "Charging the sandbox test card…"
        : "Creating the PayPal order…"
      : waiting;
  return (
    <section className="card pad checkout">
      <h2>{card ? "Sandbox test card payment" : "PayPal sandbox checkout"}</h2>
      <p className="checkout-step" role="status">
        <b>{step}</b>
      </p>
      <p className="muted">
        {bid ? (
          <>
            The order can pay only <b>{bid.handle}</b>, or refund you.
          </>
        ) : (
          "The order names the accepted operator as its only payee."
        )}
      </p>
      {bid && <Breakdown price={bid.price} payee={bid.handle} />}
      {phase === "AWAITING_APPROVAL" && job.approveUrl && (
        <div className="act">
          {redirecting && <small className="muted">Sending you to PayPal…</small>}
          <a className="btn green" href={job.approveUrl}>
            Resume PayPal checkout
          </a>
        </div>
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
  const seeded = receipt && seededLabel(receipt.source);
  return (
    <section className="card pad statuspanel">
      <pre className="mono">
        {`Status: ${statusLabel(job).label}\n`}
        {locked ? `Operator: ${locked.handle}\n` : ""}
        {`Escrow: ${escrowWord(job.escrow)}${locked && job.escrow === "HELD" ? `, locked to ${locked.handle}` : ""}`}
        {receipt && (
          <>
            {"\nReceipt: "}
            <IdChip value={receipt.id} />
          </>
        )}
        {seeded && (
          <>
            {" "}
            <span className="pill new">{seeded}</span>
          </>
        )}
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
          Approved commit <IdChip value={receipt.mergeCommit} />.
        </p>
      )}
      {job.merge && (
        <p>
          <span className={`${mergeTone[job.merge.phase]} merge-note`}>{mergeNote(job.merge, job.pullRequest, job.mergeCommit)}</span>
        </p>
      )}
      {job.status === "PAID" && job.releaseAuthority && (
        <p>
          <b>{authorityNote(job.releaseAuthority)}.</b>
        </p>
      )}
      {job.release && (
        <p className="muted small">
          Payout item <IdChip value={job.release.payoutItemId} />, capture <IdChip value={job.release.captureId} />
        </p>
      )}
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

function VerdictPill({ result }: { result: "VERIFIED" | "REJECTED" }) {
  const { label, tone } = verdictLabel(result);
  return <span className={`pill ${tone}`}>{label}</span>;
}

/** Only these statuses carry the attempt history in the job view; a PAID job's proof lives in its receipt. */
const judgedStatuses: readonly JobView["status"][] = ["IN_PROGRESS", "VERIFIED", "REFUNDED"];

function Verifier({ job, diff }: { job: JobView; diff: JobDiff | null }) {
  // api-types.ts does not mirror the projection's history, pending, or failure fields.
  const { attempts, contract } = job as JobView & VerifierFields;
  const total = attempts.used + attempts.left;
  const { pending, failure, history } = attempts;
  // A diff recorded for an older run would describe work the verifier is no longer judging.
  const latest = [pending?.sourceCommit, history[history.length - 1]?.sourceCommit];
  const shownDiff = diff && latest.includes(diff.commit) ? diff : null;
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
            The run for commit <IdChip value={failure.sourceCommit} /> ended without a verdict at {utc(failure.at)}:{" "}
            <b>{runFailureWord(failure.name)}</b>
            {failure.detail && `: ${failure.detail}`}. It did not use an attempt. Submit again.
          </div>
        </div>
      )}
      {pending && (
        <>
          <div className="section-label">Attempt {pending.ordinal} of {total}</div>
          <p className="pad">
            Verification in progress for commit <IdChip value={pending.sourceCommit} />, submitted{" "}
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
              <VerdictPill result={a.result} />
            </dd>
            <dt>Source commit</dt>
            <dd>
              <IdChip value={a.sourceCommit} />
            </dd>
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
                  {a.frozen.passed} passed{contract && ` (suite frozen at ${contract.frozenAt.slice(0, 7)})`}
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
      {shownDiff && (
        <>
          <div className="section-label">House run diff</div>
          <div className="pad">
            <p>
              Commit <IdChip value={shownDiff.commit} />
            </p>
            <ul className="mono">
              {shownDiff.files.map((f) => (
                <li key={f.path}>
                  {f.path} <span className="muted">{f.binary ? "binary" : `${f.added} lines`}</span>
                </li>
              ))}
            </ul>
            <details>
              <summary>Full patch</summary>
              <pre className="mono">{shownDiff.patch}</pre>
            </details>
          </div>
        </>
      )}
    </section>
  );
}

/** The ledger spine: once a bid is accepted, the money lines lead the page. */
function Ledger({ job, locked }: { job: JobView; locked: BidView | null }) {
  const columns = useMemo<ColDef<LedgerLine>[]>(
    () => [
      {
        headerName: "Kind",
        field: "kind",
        minWidth: 70,
        flex: 0.9,
        cellRenderer: (p: { value?: LedgerLine["kind"] }) => p.value && <b className={`k ${p.value.toLowerCase()}`}>{ledgerKindWord(p.value)}</b>,
      },
      { headerName: "Amount", field: "cents", minWidth: 66, cellClass: "num strong", valueFormatter: (p) => usd(p.value as number) },
      { headerName: "When", field: "at", minWidth: 70, cellClass: "num", valueFormatter: (p) => utc(p.value as string) },
      { headerName: "Note", colId: "note", flex: 2, minWidth: 90, valueGetter: (p) => (p.data ? ledgerNote(p.data, locked) : "") },
    ],
    [locked],
  );
  return (
    <section className="card spine">
      <div className="pad hd">
        <h2>Ledger</h2>
        <small className="muted">Every movement of this job's money, in order.</small>
      </div>
      <AcquitGrid rows={job.ledger} columns={columns} empty="No money has moved yet." />
    </section>
  );
}
