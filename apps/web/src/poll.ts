import type { JobView } from "./api-types";

export type PollMs = 1000 | 4000 | null;

/** Statuses after which the server changes nothing the page shows, except a PAID job's pending merge. */
const SETTLED: ReadonlySet<JobView["status"]> = new Set(["PAID", "REFUNDED", "CLOSED"]);

/**
 * Fast while the client waits inside a PayPal order or a release is in flight; slow for every other
 * unsettled job, since bids, verdicts, and House runs all arrive from the server without a page action.
 */
export function pollInterval(job: Pick<JobView, "status" | "phase" | "merge">, opts: { awaitingOrder: boolean }): PollMs {
  if (opts.awaitingOrder || job.phase === "RELEASE_PENDING") return 1000;
  if (!SETTLED.has(job.status)) return 4000;
  return job.merge?.phase === "PENDING" ? 4000 : null;
}
