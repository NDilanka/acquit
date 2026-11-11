import type { JobStatus, PlatformAttempt, PlatformJobLedger, TestTally } from "./api-types.ts";
import { figureCents } from "../../../packages/core/src/explain.ts";
import { escrowWord, verdictLabel } from "./job-status.ts";
import { reasonWords, tallyWords } from "./receipt-view.ts";

/** The escrow groups in the order the verdict timeline shows them. */
export const ESCROW_GROUPS = ["HELD", "RELEASED", "REFUNDED", "NONE"] as const;
export type EscrowGroup = (typeof ESCROW_GROUPS)[number];

export type FundedConserves = {
  readonly held: number;
  readonly released: number;
  readonly refunded: number;
  readonly fees: number;
  /** Every HELD line in the book, whatever became of its job: what clients funded. */
  readonly funded: number;
  /** Whether held, released, refunded, and fees add up to funded. */
  readonly holds: boolean;
};

export type GroupRow = { readonly kind: "group"; readonly id: string; readonly escrow: EscrowGroup; readonly count: number };
export type JobRow = { readonly kind: "job"; readonly id: string; readonly job: PlatformJobLedger; readonly expanded: boolean };
export type AttemptRow = { readonly kind: "attempt"; readonly id: string; readonly jobId: string; readonly attempt: PlatformAttempt };
export type TotalsRow = { readonly kind: "totals"; readonly id: "totals" } & FundedConserves;
export type VerdictRow = GroupRow | JobRow | AttemptRow;

export const VERDICT_ROW_HEIGHTS = { group: 34, job: 56, attempt: 40 } as const;

export function verdictRowHeight(row: VerdictRow | undefined): number {
  return VERDICT_ROW_HEIGHTS[row?.kind ?? "job"];
}

const byOrdinal = (a: { readonly ordinal: number }, b: { readonly ordinal: number }) => a.ordinal - b.ordinal;

/**
 * The grid's rows: one header per escrow group (always all four, so an empty group still reads as
 * empty), each job under its group, and an expanded job's attempts right after it in ordinal order.
 */
export function verdictRows(jobs: readonly PlatformJobLedger[], expanded: ReadonlySet<string>): readonly VerdictRow[] {
  return ESCROW_GROUPS.flatMap((escrow): VerdictRow[] => {
    const group = jobs.filter((job) => job.escrow === escrow);
    const header: GroupRow = { kind: "group", id: `group:${escrow}`, escrow, count: group.length };
    return [header, ...group.flatMap((job) => jobRows(job, expanded.has(job.jobId)))];
  });
}

function jobRows(job: PlatformJobLedger, open: boolean): readonly VerdictRow[] {
  const head: JobRow = { kind: "job", id: `job:${job.jobId}`, job, expanded: open };
  if (!open) return [head];
  const attempts = [...job.attempts].sort(byOrdinal).map((attempt): AttemptRow =>
    ({ kind: "attempt", id: `attempt:${job.jobId}#${attempt.ordinal}`, jobId: job.jobId, attempt }));
  return [head, ...attempts];
}

/** The book's conservation law: the four figures the escrow tiles show, and the HELD lines they fund. */
export function fundedConserves(jobs: readonly PlatformJobLedger[]): FundedConserves {
  const held = figureCents(jobs, "held");
  const released = figureCents(jobs, "released");
  const refunded = figureCents(jobs, "refunded");
  const fees = figureCents(jobs, "fees");
  const funded = jobs.flatMap((job) => job.lines).filter((line) => line.kind === "HELD").reduce((sum, line) => sum + line.cents, 0);
  return { held, released, refunded, fees, funded, holds: held + released + refunded + fees === funded };
}

export function totalsRow(jobs: readonly PlatformJobLedger[]): TotalsRow {
  return { kind: "totals", id: "totals", ...fundedConserves(jobs) };
}

export type PassingTests = { readonly text: string; readonly points: readonly number[] };

/** Latest recorded counts and the passing-share history; an uncounted rejection is not a zero. */
export function passingTests(attempts: readonly Pick<PlatformAttempt, "ordinal" | "frozen" | "hidden">[]): PassingTests {
  const counts = [...attempts].sort(byOrdinal).flatMap((attempt) => {
    const tallies = [attempt.frozen, attempt.hidden].filter((tally): tally is TestTally => tally !== null);
    const expected = tallies.reduce((sum, tally) => sum + tally.expected, 0);
    if (expected === 0) return [];
    return [{ passed: tallies.reduce((sum, tally) => sum + tally.passed, 0), expected }];
  });
  const latest = counts.at(-1);
  return { text: latest ? `${latest.passed}/${latest.expected}` : "No counts yet", points: counts.map(({ passed, expected }) => passed / expected) };
}

/** Each counted attempt's passing share, frozen and hidden together, in ordinal order. */
export function sparkPoints(attempts: readonly Pick<PlatformAttempt, "ordinal" | "frozen" | "hidden">[]): readonly number[] {
  return passingTests(attempts).points;
}

/** The polyline points for a sparkline: each ratio drawn from the bottom to the top, with a 2 px margin. One point sits mid-width. */
export function sparkCoords(points: readonly number[], width: number, height: number): string {
  const pad = 2;
  const y = (ratio: number) => pad + (1 - ratio) * (height - 2 * pad);
  return points.map((ratio, i) => {
    const x = points.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (points.length - 1);
    return `${Math.round(x * 10) / 10},${Math.round(y(ratio) * 10) / 10}`;
  }).join(" ");
}

/** The newest attempt by ordinal, which is the verdict the job reads as its last. */
export function lastAttempt(attempts: readonly PlatformAttempt[]): PlatformAttempt | null {
  return [...attempts].sort(byOrdinal).at(-1) ?? null;
}

/** Toggling a job's expansion never changes the set it was given. */
export function toggleExpanded(expanded: ReadonlySet<string>, jobId: string): ReadonlySet<string> {
  const next = new Set(expanded);
  if (next.has(jobId)) next.delete(jobId);
  else next.add(jobId);
  return next;
}

const GROUP_WORDS: Record<EscrowGroup, string> = { HELD: "Held in escrow", RELEASED: "Released", REFUNDED: "Refunded", NONE: "No escrow yet" };
export function groupWords(escrow: EscrowGroup): string {
  return GROUP_WORDS[escrow];
}

const STATUS_WORDS: Record<JobStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  VERIFIED: "Verified, awaiting release",
  PAID: "Paid",
  REFUNDED: "Refunded",
  CLOSED: "Closed",
};
/** The platform ledger carries no phase, so this names the status alone. The job page's statusLabel needs the phase too. */
export function platformStatusWord(status: JobStatus): string {
  return STATUS_WORDS[status];
}

/** One attempt in words: its verdict, its counts when both suites recorded them, and otherwise the reasons it was rejected for. */
export function attemptWords(attempt: PlatformAttempt): { readonly verdict: string; readonly detail: string } {
  const detail = tallyWords(attempt.frozen, attempt.hidden)
    ?? (attempt.reasons.length > 0 ? attempt.reasons.map(reasonWords).join("; ") : "No counts recorded");
  return { verdict: verdictLabel(attempt.result).label, detail };
}

/** The newest attempt in words, with the tamper flag when that attempt caught one. Shared by the wide column and the narrow card. */
export function lastVerdictWords(job: PlatformJobLedger): string {
  const last = lastAttempt(job.attempts);
  if (!last) return "No verdict yet";
  return `${attemptWords(last).verdict}${last.tamper ? ", tamper caught" : ""}`;
}

/** The PayPal ids a job names: its capture, then its payout item, each labelled the way PayPal names it. */
export function payPalIds(job: PlatformJobLedger): readonly { readonly label: string; readonly id: string }[] {
  const capture = job.capture?.captureId ?? job.payout?.captureId ?? null;
  const payoutItem = job.payout?.payoutItemId ?? null;
  return [
    ...(capture === null ? [] : [{ label: "PayPal capture", id: capture }]),
    ...(payoutItem === null ? [] : [{ label: "PayPal payout item", id: payoutItem }]),
  ];
}

/** Compact floors include 16px of cell padding; long titles ellipsize and verdict/status words wrap. */
export const VERDICT_MIN_WIDTHS = {
  job: 216,
  status: 136,
  /** Counts above a sparkline that can shrink below its 96px maximum. */
  passing: 112,
  last: 144,
  escrow: 88,
  /** "Not recorded" in the mono face, plus cell padding and borders. */
  paid: 120,
  operator: 180,
  ids: 188,
} as const;

export const VERDICT_COLUMN_PRIORITY = ["job", "status", "passing", "last", "escrow", "paid", "operator", "ids"] as const;
export type VerdictColumn = (typeof VERDICT_COLUMN_PRIORITY)[number];

/** Keep a prefix of the priority list, so a smaller low-priority column never displaces a verdict. */
export function verdictColumnsForWidth(width: number): VerdictColumn[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  const visible: VerdictColumn[] = [];
  let used = 0;
  for (const column of VERDICT_COLUMN_PRIORITY) {
    used += VERDICT_MIN_WIDTHS[column];
    if (used > Math.floor(width)) break;
    visible.push(column);
  }
  return visible;
}

/** One job in the narrow layout: the facts its wide row shows, in words, with the passing shares and the PayPal ids as values. */
export type JobCard = {
  readonly jobId: string;
  readonly title: string;
  /** The visitor that owns the job, or null for the deployment's own seeded world. */
  readonly tenant: string | null;
  readonly status: string;
  readonly escrow: string;
  readonly lastVerdict: string;
  readonly passing: PassingTests;
  readonly paidCents: number | null;
  readonly paypalIds: readonly { readonly label: string; readonly id: string }[];
};

export function jobCard(job: PlatformJobLedger): JobCard {
  return { jobId: job.jobId, title: job.title, tenant: job.tenant, status: platformStatusWord(job.status), escrow: escrowWord(job.escrow),
    lastVerdict: lastVerdictWords(job), passing: passingTests(job.attempts), paidCents: job.paidCents, paypalIds: payPalIds(job) };
}

/** The narrow layout's rows: a job row becomes its card, and the group headers and attempt lines pass through unchanged. */
export type CardRow = GroupRow | AttemptRow | { readonly kind: "card"; readonly id: string; readonly card: JobCard; readonly expanded: boolean };

export function cardRows(rows: readonly VerdictRow[]): readonly CardRow[] {
  return rows.map((row): CardRow => (row.kind === "job"
    ? { kind: "card", id: row.id, card: jobCard(row.job), expanded: row.expanded }
    : row));
}
