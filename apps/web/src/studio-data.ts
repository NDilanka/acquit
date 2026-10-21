import type { JobReceiptRow, PlatformJobLedger, ReceiptRow } from "./api-types";
import { figureCents } from "../../../packages/core/src/explain.ts";
import { COLUMNS, NATIVE_WIDGETS, STACKED_MIN_YSPAN, WIDGET_ROWS, WIDGET_SPANS, type AcquitWidgetId, type DashboardId, type DashboardState, type NativeWidgetSpec } from "./dashboard-widgets.ts";

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

type PageWidgets = NonNullable<DashboardState["pages"][number]["widgets"]>;
type WidgetRecord = NonNullable<PageWidgets[string]>;

/** A native widget's title and cross filter: a click on one widget filters the others on the page. */
const nativeFormat = (title: string) => ({ title: { text: title, enabled: true }, crossFilter: "filter" as const });

/** A seeded native widget's Studio record. Its sort is copied, so the spec stays readonly. */
export function nativeWidgetRecord(spec: NativeWidgetSpec): WidgetRecord {
  return {
    type: spec.type,
    dataMapping: spec.dataMapping,
    format: nativeFormat(spec.title),
    ...(spec.sort ? { sort: [...spec.sort] } : {}),
  };
}

/**
 * A seeded native widget that the saved layout leaves without a sort takes its spec's sort. A sort the
 * viewer already has stays, because it is their own choice.
 */
export function withNativeSorts(state: DashboardState, id: DashboardId): DashboardState {
  const specs: readonly NativeWidgetSpec[] = NATIVE_WIDGETS[id].flat();
  return {
    ...state,
    pages: state.pages.map((page) => {
      if (!page.widgets) return page;
      const widgets: PageWidgets = {};
      for (const [widgetId, widget] of Object.entries(page.widgets)) {
        const sort = specs.find((spec) => spec.id === widgetId)?.sort;
        widgets[widgetId] = !widget || sort === undefined || widget.sort !== undefined ? widget : { ...widget, sort: [...sort] };
      }
      return { ...page, widgets };
    }),
  };
}

type WidgetRow = { readonly id: AcquitWidgetId; readonly xSpan: number; readonly ySpan: number };

/** A dashboard's custom widget rows, one inner array per row of a fresh layout. */
const customRows = (id: DashboardId): readonly (readonly WidgetRow[])[] => WIDGET_ROWS[id];

/** A dashboard's native widget rows, which a fresh layout draws beneath the custom rows. */
const nativeRows = (id: DashboardId): readonly (readonly NativeWidgetSpec[])[] => NATIVE_WIDGETS[id];

/** Every widget a dashboard seeds, custom then native. A saved layout records these as acquitSeeded. */
export function seededIds(id: DashboardId): string[] {
  return [...customRows(id).flat(), ...nativeRows(id).flat()].map((w) => w.id);
}

/** The records a fresh layout gives the seeded widgets: a custom widget with no mapping, a native widget with its table mapping. */
export function seededWidgets(id: DashboardId): PageWidgets {
  return {
    ...Object.fromEntries(customRows(id).flat().map((w) => [w.id, { type: w.id, dataMapping: {} }] as const)),
    ...Object.fromEntries(nativeRows(id).flat().map((w) => [w.id, nativeWidgetRecord(w)] as const)),
  };
}

/** Where a fresh layout places the seeded widgets: each custom row, then the native charts beneath them. */
export function seededPlacements(id: DashboardId): Record<string, Track> {
  return placeRows([...customRows(id), ...nativeRows(id)]);
}

/**
 * The seed before acquit-verdict-grid joined it. A saved layout with no acquitSeeded has seen these and
 * nothing newer, so a widget a later build seeds still reaches it. Literal on purpose: deriving it from the
 * current seed would count every future widget as already seen.
 */
const LEGACY_SEEDED: Record<DashboardId, readonly string[]> = {
  escrow: [
    "acquit-held",
    "acquit-released",
    "acquit-refunded",
    "acquit-fees",
    "acquit-pass-rate",
    "acquit-reject-rate",
    "acquit-tamper-caught",
    "acquit-conserves",
    "acquit-reconciliation",
    "escrow-funnel",
    "escrow-pivot",
    "escrow-treemap",
  ],
  earnings: ["acquit-paid-out", "acquit-fees-withheld", "acquit-jobs-paid", "acquit-receipt-card"],
};

/** The JSON a Studio state saves as: the state, plus the seeded widget ids this build has seen. */
export function savedLayoutJson(state: DashboardState, id: DashboardId): string {
  return JSON.stringify({ ...state, acquitSeeded: seededIds(id) });
}

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/**
 * Adds each seeded widget the viewer has not seen and that no page holds, to the selected page, with its
 * seed record. The seed placement goes in with it, and repairPlacements keeps it only where it fits.
 */
function addUnseen(state: DashboardState, id: DashboardId, seen: readonly string[]): DashboardState {
  const target = selectedPage(state);
  const held = new Set(state.pages.flatMap((page) => Object.keys(page.widgets ?? {})));
  const missing = seededIds(id).filter((widget) => !seen.includes(widget) && !held.has(widget));
  if (!target || missing.length === 0) return state;
  const records = seededWidgets(id);
  const placements = seededPlacements(id);
  return {
    ...state,
    pages: state.pages.map((page) =>
      page !== target
        ? page
        : {
            ...page,
            widgets: { ...page.widgets, ...Object.fromEntries(missing.map((widget) => [widget, records[widget]] as const)) },
            widgetLayout: { ...page.widgetLayout, ...Object.fromEntries(missing.map((widget) => [widget, placements[widget]] as const)) },
          },
    ),
  };
}

/**
 * A saved layout from the server, or null when it is missing or no longer reads as Studio state.
 * A seeded widget the viewer has not seen and no page holds is added with its seed record. A widget the
 * saved layout leaves without a placement, or places over another, gets the first free spot, so the
 * dashboard loads every widget. A seeded native widget with no sort gets its spec's sort. The saved
 * acquitSeeded list is read and stripped; a layout without one has seen LEGACY_SEEDED.
 */
export function parseSaved(json: string | null, id: DashboardId): DashboardState | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { pages?: unknown }).pages)) return null;
    const { acquitSeeded, ...saved } = parsed as DashboardState & { acquitSeeded?: unknown };
    const seen = isIdList(acquitSeeded) ? acquitSeeded : LEGACY_SEEDED[id];
    const restored = addUnseen(saved, id, seen);
    const placed = repairPlacements(restored, (w) => WIDGET_SPANS[id][w.type] ?? { xSpan: 4, ySpan: 2 });
    return withNativeSorts(placed, id);
  } catch {
    return null;
  }
}
