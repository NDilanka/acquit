import type { JobReceiptRow, PlatformJobLedger, ReceiptRow } from "./api-types";
import { figureCents } from "../../../packages/core/src/explain.ts";
import { COLUMNS, STACKED_MIN_YSPAN, WIDGET_SPANS, type DashboardId, type DashboardState } from "./dashboard-widgets.ts";

/** The four money KPIs. Each is the core figure function's sum over the lines that figure names. */
export function escrowTotals(jobs: readonly PlatformJobLedger[]) {
  return {
    held: figureCents(jobs, "held"),
    released: figureCents(jobs, "released"),
    refunded: figureCents(jobs, "refunded"),
    fees: figureCents(jobs, "fees"),
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
  const payout = figureCents(released, "released");
  const fee = figureCents(released, "fees");
  const paid = figureCents(released, "paid-by-clients");
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

type Span = { readonly xSpan: number; readonly ySpan: number };

/** Two placements share at least one grid cell. */
export function tracksOverlap(a: Track, b: Track): boolean {
  return a.xTrack < b.xTrack + b.xSpan && b.xTrack < a.xTrack + a.xSpan && a.yTrack < b.yTrack + b.ySpan && b.yTrack < a.yTrack + a.ySpan;
}

/** Studio renders the placement: it sits inside the page's columns and covers no cell already taken. */
export function placementFits(track: Track, placed: readonly Track[], columns: number): boolean {
  const inGrid = track.xTrack >= 0 && track.yTrack >= 0 && track.xSpan >= 1 && track.ySpan >= 1 && track.xTrack + track.xSpan <= columns;
  return inGrid && !placed.some((other) => tracksOverlap(track, other));
}

/** The first spot, top row first and then left to right, where the span covers no taken cell. */
export function firstFreeTrack(placed: readonly Track[], span: Span, columns: number): Track {
  const xSpan = Math.min(Math.max(span.xSpan, 1), columns);
  const ySpan = Math.max(span.ySpan, 1);
  // Nothing reaches below the lowest bottom edge, so the row there is always free.
  const bottom = Math.max(0, ...placed.map((t) => t.yTrack + t.ySpan));
  for (let yTrack = 0; yTrack <= bottom; yTrack++) {
    for (let xTrack = 0; xTrack + xSpan <= columns; xTrack++) {
      const track = { xTrack, yTrack, xSpan, ySpan };
      if (!placed.some((other) => tracksOverlap(track, other))) return track;
    }
  }
  return { xTrack: 0, yTrack: bottom, xSpan, ySpan };
}

type Page = DashboardState["pages"][number];

export const selectedPage = (state: DashboardState): Page | undefined =>
  state.pages.find((p) => p.id === state.selectedPageId) ?? state.pages[0];

/** The widget has a placement of its own on its page that Studio can render. */
export function widgetPlaced(state: DashboardState, widgetId: string): boolean {
  const page = selectedPage(state);
  const track = page?.widgetLayout?.[widgetId];
  if (!page || !track) return false;
  const others = Object.entries(page.widgetLayout ?? {})
    .filter((e): e is [string, Track] => e[0] !== widgetId && e[1] !== undefined)
    .map(([, t]) => t);
  return placementFits(track, others, page.layout?.columns ?? COLUMNS);
}

/**
 * Keeps every placement that fits beside the ones kept before it, in saved order, then gives each
 * widget left without one the first free spot, so every widget on a page renders and none is dropped.
 */
export function repairPlacements(state: DashboardState, spanFor?: (widget: { readonly type: string }) => Span): DashboardState {
  return {
    ...state,
    pages: state.pages.map((page) => {
      const columns = page.layout?.columns ?? COLUMNS;
      const kept: Record<string, Track> = {};
      for (const [id, track] of Object.entries(page.widgetLayout ?? {})) {
        if (track && placementFits(track, Object.values(kept), columns)) kept[id] = track;
      }
      for (const [id, widget] of Object.entries(page.widgets ?? {})) {
        if (kept[id] || !widget) continue;
        kept[id] = firstFreeTrack(Object.values(kept), spanFor?.(widget) ?? { xSpan: 4, ySpan: 2 }, columns);
      }
      return { ...page, widgetLayout: kept };
    }),
  };
}

/**
 * A saved layout from the server, or null when it is missing or no longer reads as Studio state.
 * A widget the saved layout leaves without a placement, or places over another, gets the first free
 * spot, so the dashboard loads every widget.
 */
export function parseSaved(json: string | null, id: DashboardId): DashboardState | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { pages?: unknown }).pages)) return null;
    return repairPlacements(parsed as DashboardState, (w) => WIDGET_SPANS[id][w.type] ?? { xSpan: 4, ySpan: 2 });
  } catch {
    return null;
  }
}
