import type { FilterCounts, JobView, ScopingApproveResponse, ScopingCase, ScopingResponse } from "./api-types";
import { ApiError } from "./api.ts";
import { errorText } from "./demo.ts";

/** What the client's scoping panel shows. Only REVIEW takes input; a frozen draft is immutable. */
export type ScopingPanel =
  | { readonly kind: "HIDDEN" }
  | { readonly kind: "UNREADABLE"; readonly message: string }
  | { readonly kind: "DRAFTING" }
  | { readonly kind: "FAILED"; readonly reason: string }
  | { readonly kind: "REVIEW"; readonly draft: ScopingResponse }
  | {
      readonly kind: "FROZEN";
      readonly draft: ScopingResponse;
      readonly approvedIds: readonly string[];
      readonly approvedAt: string | null;
      /** Only the approval's own reply carries the digest; a later read of the draft does not. */
      readonly digest: string | null;
    };

/** Whether the job still takes the draft's approval. An accepted bid commits the job to its contract while it stays OPEN. */
export type ApprovalWindow =
  | { readonly kind: "OPEN" }
  | { readonly kind: "CLOSED"; readonly reason: "BID_ACCEPTED" | "JOB_MOVED_ON"; readonly notice: string };

export function approvalWindow(job: Pick<JobView, "status" | "phase">): ApprovalWindow {
  if (job.status !== "OPEN") return { kind: "CLOSED", reason: "JOB_MOVED_ON", notice: "The job has moved on, so this draft can no longer be approved." };
  if (job.phase === "FUNDING") {
    return {
      kind: "CLOSED",
      reason: "BID_ACCEPTED",
      notice: "A bid was accepted and the job is committed to its contract, so this draft can no longer be approved.",
    };
  }
  return { kind: "OPEN" };
}

export type Settled<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly error: unknown };

/** What one approval attempt leaves: the panel to show, an error for the client, and whether to re-read the draft. */
export type ApprovalStep = { readonly panel: ScopingPanel; readonly error: string | null; readonly reread: boolean };

export function leaveOut(cases: readonly ScopingCase[], kept: ReadonlySet<string>): string[] {
  return cases.filter((c) => !kept.has(c.id)).map((c) => c.id);
}

export function countsLine(counts: FilterCounts): string {
  return [
    `${counts.candidates} drafted`,
    `${counts.f1} ran clean on the frozen commit`,
    `${counts.f2} discriminated`,
    `${counts.f3} passed the trusted fix`,
    `${counts.f4} justified`,
    `${counts.deduped} kept after dedupe`,
  ].join(", ");
}

export const shortDigest = (digest: string) => digest.slice(0, 12);

/**
 * A 403 (not the job's client) or 404 (no draft was ever kicked) means there is no panel at all. A failed
 * re-read keeps the panel already shown, and a re-read of a frozen draft keeps the digest its approval returned.
 */
export function readPanel(read: Settled<ScopingResponse>, shown: ScopingPanel): ScopingPanel {
  if (!read.ok) {
    if (read.error instanceof ApiError && (read.error.status === 403 || read.error.status === 404)) return { kind: "HIDDEN" };
    return shown.kind === "HIDDEN" || shown.kind === "UNREADABLE" ? { kind: "UNREADABLE", message: errorText(read.error) } : shown;
  }
  const draft = read.body;
  switch (draft.status) {
    case "DRAFTING":
      return { kind: "DRAFTING" };
    case "FAILED":
      return { kind: "FAILED", reason: draft.reason ?? "UNKNOWN" };
    case "AWAITING_APPROVAL":
      return { kind: "REVIEW", draft };
    case "APPROVED": {
      const digest = shown.kind === "FROZEN" ? shown.digest : null;
      return { kind: "FROZEN", draft, approvedIds: draft.cases.map((c) => c.id), approvedAt: draft.approvedAt, digest };
    }
  }
}

export function approvalStep(review: Extract<ScopingPanel, { kind: "REVIEW" }>, result: Settled<ScopingApproveResponse>): ApprovalStep {
  if (result.ok) {
    const { digest, approvedIds } = result.body;
    const approved = new Set(approvedIds);
    const draft = { ...review.draft, status: "APPROVED" as const, cases: review.draft.cases.filter((c) => approved.has(c.id)) };
    return { panel: { kind: "FROZEN", draft, approvedIds, approvedAt: null, digest }, error: null, reread: true };
  }
  const stay = (error: string): ApprovalStep => ({ panel: review, error, reread: false });
  const { error } = result;
  if (!(error instanceof ApiError)) return stay(errorText(error));
  switch (error.code) {
    case "COVERAGE_GATE":
      return stay(`The kept cases no longer cover: ${missingFamilies(error.body).join(", ")}. Keep a case for each, then approve again.`);
    case "NOTHING_APPROVED":
      return stay("Every case is left out. Keep at least one case to approve.");
    // Another tab approved first, or the draft is gone: the server's state, re-read, is the truth.
    case "ALREADY_FROZEN":
    case "NO_DRAFT":
      return { panel: review, error: null, reread: true };
    default:
      return stay(errorText(error));
  }
}

function missingFamilies(body: unknown): string[] {
  const missing = typeof body === "object" && body !== null && "missing" in body ? body.missing : null;
  return Array.isArray(missing) ? missing.filter((m): m is string => typeof m === "string") : [];
}
