import { useState } from "react";
import type { BidView, JobView } from "./api-types";
import { shortId } from "./format";
import { statusLabel, type StatusInput } from "./job-status";
import { Link } from "./router";

export function StatusPill({ job }: { job: StatusInput }) {
  const { label, tone } = statusLabel(job);
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

/** A job id, commit, or PayPal id as a small chip. The full value rides on hover and copies on click. */
export function IdChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  return (
    <button type="button" className={`idchip${copied ? " copied" : ""}`} title={value} aria-label={`Copy ${value}`} onClick={copy}>
      {copied ? "Copied" : shortId(value)}
    </button>
  );
}

/** The one not-found card: a missing page, a missing job, a page another role may not open, and a signed-out bad URL. */
export function NotFound({
  title = "Page not found",
  message,
  action,
}: {
  title?: string;
  message?: string;
  action: { readonly to: string; readonly label: string };
}) {
  return (
    <section className="card pad notfound">
      <h1>{title}</h1>
      {message && <p className="muted">{message}</p>}
      <p>
        <Link to={action.to}>{action.label}</Link>
      </p>
    </section>
  );
}

export function RepoLink({ repository }: { repository: string | null }) {
  return repository ? (
    <a className="mono" href={`https://github.com/${repository}`} target="_blank" rel="noreferrer">
      {repository}
    </a>
  ) : (
    <>the deployment's shared repository</>
  );
}

/** What the demo connected for the visitor: shown once at sign-up and on the client's dashboard. */
export function ConnectedRepo({ repository }: { repository: string | null }) {
  return (
    <p className="connected">
      <b>Connected: issues, pull requests, checks</b>
      <span>
        Repository <RepoLink repository={repository} />
      </span>
    </p>
  );
}

export function houseName(handle: string): string {
  return handle.replace(/^house-/, "");
}

/** Operator bids first, then the House bid: the order the API serves them in. */
export function allBids(job: JobView): BidView[] {
  return [...job.bids.operators, ...(job.bids.house ? [job.bids.house] : [])];
}

export function lockedBid(job: JobView): BidView | null {
  if (!job.lockedTo) return null;
  return allBids(job).find((b) => b.operator === job.lockedTo) ?? null;
}

/** The order's payee: the locked operator once escrow holds, the chosen bid while the order is still being made. */
export function payeeBid(job: JobView): BidView | null {
  return lockedBid(job) ?? allBids(job).find((b) => b.status === "CHOSEN") ?? null;
}
