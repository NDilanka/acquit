import type { Checklist } from "./checklist.ts";
import type { Vec2 } from "./contract.ts";
import { pointAlong, type DrawList, type Stroke } from "./scene-draw.ts";

// Playback speeds in mm per second of animation at 1x. They only pace the picture; they are not the machine's speeds,
// and no time from this file is shown as a figure.
const SPEED: Readonly<Record<Stroke, number>> = {
  cut: 40,
  engrave: 80,
  travel: 220,
  copper: 60,
  drill: 60,
  route: 60,
  zone: 120,
  other: 60,
};
const TRACE_MIN = 4;
const TRACE_MAX = 9;
const ITEM_MIN = 0.12;
const DROP = 1.4;
const SETTLE = 0.4;
const ROW = 0.28;
const FAIL_HOLD = 1.6;
const SEALED_INTRO = 0.9;
const SEALED_ROW = 1.4;
const SEALED_FAIL_HOLD = 1.2;
const VERDICT = 0.8;

export type Span = { readonly start: number; readonly end: number };

export type Timeline = {
  readonly trace: readonly Span[];
  readonly traceEnd: number;
  readonly dropEnd: number;
  /** The moment each public row appears. */
  readonly publicAt: readonly number[];
  readonly sealedIntroAt: number;
  /** Each sealed check is "being checked" over its span and shows its result at the span's end. */
  readonly sealedAt: readonly Span[];
  readonly verdictAt: number;
  readonly total: number;
};

export type Phase = "trace" | "drop" | "checks" | "sealed" | "verdict";

export type Frame = {
  readonly t: number;
  readonly phase: Phase;
  /** Fraction of each draw item done, in draw-list order. */
  readonly progress: readonly number[];
  readonly head: Vec2 | null;
  readonly headItem: number;
  /** The beam is on: the head is on a path that is not travel. */
  readonly cutting: boolean;
  readonly drop: number;
  readonly publicShown: number;
  readonly sealedOpen: boolean;
  readonly sealedShown: number;
  readonly sealedChecking: number | null;
  /** Index into the public rows of the latest failing row on show, or null. */
  readonly focus: number | null;
  readonly verdict: boolean;
};

export function buildTimeline(list: DrawList, checks: Checklist): Timeline {
  const raw = list.items.map((i) => Math.max(ITEM_MIN, i.length / SPEED[i.stroke]));
  const rawTotal = raw.reduce((a, b) => a + b, 0);
  const scale = rawTotal === 0 ? 0 : Math.min(TRACE_MAX, Math.max(TRACE_MIN, rawTotal)) / rawTotal;
  const trace: Span[] = [];
  let t = 0;
  for (const d of raw) {
    trace.push({ start: t, end: t + d * scale });
    t += d * scale;
  }
  const traceEnd = t;
  const dropEnd = traceEnd + (list.pieces.outline ? DROP : 0);
  t = dropEnd + SETTLE;
  const publicAt: number[] = [];
  for (const row of checks.publicRows) {
    publicAt.push(t);
    t += ROW + (row.ok ? 0 : FAIL_HOLD);
  }
  const sealedIntroAt = t;
  if (checks.sealed.length > 0) t += SEALED_INTRO;
  const sealedAt: Span[] = [];
  for (const ok of checks.sealed) {
    sealedAt.push({ start: t, end: t + SEALED_ROW });
    t += SEALED_ROW + (ok ? 0 : SEALED_FAIL_HOLD);
  }
  const verdictAt = t;
  return { trace, traceEnd, dropEnd, publicAt, sealedIntroAt, sealedAt, verdictAt, total: verdictAt + VERDICT };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function frameAt(list: DrawList, checks: Checklist, tl: Timeline, time: number): Frame {
  const t = Math.min(tl.total, Math.max(0, time));
  const progress = tl.trace.map((s) => (s.end <= s.start ? (t >= s.end ? 1 : 0) : clamp01((t - s.start) / (s.end - s.start))));
  let headItem = tl.trace.findIndex((s) => t < s.end);
  if (headItem < 0) headItem = list.items.length - 1;
  const item = list.items[headItem];
  const head = item ? pointAlong(item.points, progress[headItem] ?? 0) : null;
  const cutting = t > 0 && t < tl.traceEnd && item !== undefined && item.stroke !== "travel";
  const drop = tl.dropEnd > tl.traceEnd ? clamp01((t - tl.traceEnd) / (tl.dropEnd - tl.traceEnd)) : t >= tl.traceEnd ? 1 : 0;
  const publicShown = tl.publicAt.filter((at) => t >= at).length;
  let focus: number | null = null;
  for (let i = 0; i < publicShown; i++) if (!checks.publicRows[i]!.ok) focus = i;
  const sealedOpen = checks.sealed.length > 0 && t >= tl.sealedIntroAt;
  const sealedShown = tl.sealedAt.filter((s) => t >= s.end).length;
  const checkingIndex = tl.sealedAt.findIndex((s) => t >= s.start && t < s.end);
  const verdict = t >= tl.verdictAt;
  const phase: Phase = verdict ? "verdict" : sealedOpen ? "sealed" : t >= tl.dropEnd && tl.publicAt.length > 0 && t >= tl.publicAt[0]! ? "checks" : t >= tl.traceEnd ? "drop" : "trace";
  return {
    t,
    phase,
    progress,
    head,
    headItem,
    cutting,
    drop,
    publicShown,
    sealedOpen,
    sealedShown,
    sealedChecking: checkingIndex < 0 ? null : checkingIndex,
    focus,
    verdict,
  };
}
