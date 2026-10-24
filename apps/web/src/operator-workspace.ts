import type { JobView, OperatorEscrowRow, ReceiptRow } from "./api-types.ts";
import { statusLabel, type StatusLabel } from "./job-status.ts";
import { nextStep, type TimelineJob, type Viewer } from "./job-timeline.ts";

/**
 * What one bid spends. The bid result serves only the balance left, so the spend mirrors
 * packages/core/src/credits.ts BID_COST.
 */
export const BID_COST_CREDITS = 10;

export type OperatorWorkspace = {
  /** OPEN jobs the operator may bid on. A job with the operator's own pending bid stays here, with that bid. */
  readonly open: readonly JobView[];
  /** Jobs locked to the operator, each with its state label and the next step read as the operator. */
  readonly mine: readonly { readonly job: JobView; readonly status: StatusLabel; readonly next: string }[];
  /** `heldCents` is the operator's net on escrow holds. `paidCents` sums the receipts' paid amounts. Both are whole cents. */
  readonly earnings: { readonly heldCents: number; readonly paidCents: number; readonly receipts: readonly ReceiptRow[] };
};

/** The API answers for one operator, as the page fetched them. */
export type OperatorSnapshot = {
  readonly operatorId: string;
  readonly handle: string;
  readonly jobs: readonly TimelineJob[];
  readonly receipts: readonly ReceiptRow[];
  readonly escrow: readonly OperatorEscrowRow[];
};

export function buildOperatorWorkspace(snapshot: OperatorSnapshot): OperatorWorkspace {
  const viewer: Viewer = { role: "OPERATOR", handle: snapshot.handle };
  const open = snapshot.jobs.filter(job => job.status === "OPEN");
  const mine = snapshot.jobs
    .filter(job => job.lockedTo === snapshot.operatorId)
    .map(job => ({ job, status: statusLabel(job), next: nextStep(job, viewer) }));
  const awarded = new Set(mine.map(row => row.job.id));
  const heldCents = snapshot.escrow.filter(row => awarded.has(row.jobId)).reduce((sum, row) => sum + row.cents, 0);
  // A seeded history row carries no amount, so it adds nothing here and still lists under receipts.
  const paidCents = snapshot.receipts.reduce((sum, row) => sum + (row.paid ?? 0), 0);
  return { open, mine, earnings: { heldCents, paidCents, receipts: snapshot.receipts } };
}

/**
 * A receipt row's marks. The Seeded badge follows the receipts table's source, and the job link follows the
 * job the row belongs to, so a job-backed seed carries both marks and a detached seed carries the badge only.
 */
export function receiptMarks(row: Pick<ReceiptRow, "source" | "jobId">): { readonly seeded: boolean; readonly jobHref: string | null } {
  return { seeded: row.source === "SEED", jobHref: row.jobId === null ? null : `/jobs/${row.jobId}` };
}
