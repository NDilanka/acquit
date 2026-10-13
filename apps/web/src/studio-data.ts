import type { JobReceiptRow, LedgerLine, PlatformJobLedger, ReceiptRow } from "./api-types";
import { COLUMNS, STACKED_MIN_YSPAN, type DashboardState } from "./dashboard-widgets.ts";

function linesCents(jobs: readonly PlatformJobLedger[], kind: LedgerLine["kind"]): number {
  let total = 0;
  for (const job of jobs) for (const line of job.lines) if (line.kind === kind) total += line.cents;
  return total;
}

export function escrowTotals(jobs: readonly PlatformJobLedger[]) {
  return {
    held: linesCents(
      jobs.filter((j) => j.escrow === "HELD"),
      "HELD",
    ),
    released: linesCents(jobs, "RELEASED"),
    refunded: linesCents(jobs, "REFUND"),
    fees: linesCents(jobs, "FEE"),
  };
}

export function verifierStats(jobs: readonly PlatformJobLedger[]) {
  const attempts = jobs.flatMap((j) => j.attempts);
  const verified = attempts.filter((a) => a.result === "VERIFIED").length;
  const rejected = attempts.filter((a) => a.result === "REJECTED").length;
  const rate = (n: number) => (attempts.length === 0 ? 0 : n / attempts.length);
  return {
    passRate: rate(verified),
    rejectRate: rate(rejected),
    tamperAttempts: attempts.filter((a) => a.result === "REJECTED" && a.tamper).length,
    attempts: attempts.length,
  };
}

/** Over released jobs only: what the operator got plus what the fee took must equal what the client paid. */
export function conserves(jobs: readonly PlatformJobLedger[]) {
  const released = jobs.filter((j) => j.escrow === "RELEASED");
  const payout = linesCents(released, "RELEASED");
  const fee = linesCents(released, "FEE");
  const paid = linesCents(released, "HELD");
  return { payout, fee, paid, holds: payout + fee === paid };
}

function jobReceipts(rows: readonly ReceiptRow[]): JobReceiptRow[] {
  // A migrated receipt carries source SEED yet has a real job behind it, so provenance cannot tell a real receipt from a display seed.
  return rows.filter((r): r is JobReceiptRow => r.jobId !== null);
}

export function earnings(rows: readonly ReceiptRow[]) {
  const mine = jobReceipts(rows);
  return {
    paidOut: mine.reduce((t, r) => t + r.paid, 0),
    feesWithheld: mine.reduce((t, r) => t + (r.fee ?? 0), 0),
    jobsPaid: mine.length,
  };
}

export function newestReceipt(rows: readonly ReceiptRow[]): JobReceiptRow | null {
  let newest: JobReceiptRow | null = null;
  for (const row of jobReceipts(rows)) if (newest === null || row.releasedAt > newest.releasedAt) newest = row;
  return newest;
}

/** A widget's cell on the dashboard grid, in Studio's zero-based tracks. */
export type Track = { readonly xTrack: number; readonly yTrack: number; readonly xSpan: number; readonly ySpan: number };

export function placeRows(rows: readonly (readonly { readonly id: string; readonly xSpan: number; readonly ySpan: number }[])[]): Record<string, Track> {
  const placed: Record<string, Track> = {};
  let yTrack = 0;
  for (const row of rows) {
    let xTrack = 0;
    for (const { id, xSpan, ySpan } of row) {
      placed[id] = { xTrack, yTrack, xSpan, ySpan };
      xTrack += xSpan;
    }
    yTrack += Math.max(0, ...row.map((w) => w.ySpan));
  }
  return placed;
}

export function stackLayout(layout: Partial<Record<string, Track>>, columns: number): Record<string, Track> {
  const ordered = Object.entries(layout)
    .filter((e): e is [string, Track] => e[1] !== undefined)
    .sort(([, a], [, b]) => a.yTrack - b.yTrack || a.xTrack - b.xTrack);
  const stacked: Record<string, Track> = {};
  let yTrack = 0;
  for (const [id, { ySpan }] of ordered) {
    stacked[id] = { xTrack: 0, yTrack, xSpan: columns, ySpan };
    yTrack += ySpan;
  }
  return stacked;
}

export function stacked(state: DashboardState): DashboardState {
  return {
    ...state,
    pages: state.pages.map((page) => {
      // Heights are raised before stacking so each row's yTrack accounts for the taller rows above it.
      const raised = Object.fromEntries(
        Object.entries(page.widgetLayout ?? {}).map(([id, track]) => {
          const type = page.widgets?.[id]?.type;
          const min = type ? (STACKED_MIN_YSPAN[type] ?? 0) : 0;
          return [id, track && { ...track, ySpan: Math.max(track.ySpan, min) }];
        }),
      );
      return { ...page, widgetLayout: stackLayout(raised, page.layout?.columns ?? COLUMNS) };
    }),
  };
}
