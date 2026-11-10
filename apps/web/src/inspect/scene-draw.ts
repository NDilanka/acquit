import type { InspectFinding, InspectPath, InspectScene, Vec2 } from "./contract.ts";

/** How a path is drawn. Each checker's path kinds map onto one of these; an unknown kind draws as "other". */
export type Stroke = "cut" | "engrave" | "travel" | "copper" | "drill" | "route" | "zone" | "other";

const STROKES: Readonly<Record<string, Stroke>> = {
  outline: "cut",
  cut: "cut",
  engrave: "engrave",
  travel: "travel",
  copper: "copper",
  pad: "copper",
  via: "drill",
  drill: "drill",
  extrusion: "route",
  flight: "route",
  footprint: "zone",
  zone: "zone",
  area: "zone",
  part: "other",
};

export function strokeFor(kind: string): Stroke {
  return STROKES[kind] ?? "other";
}

export type DrawItem = {
  readonly id: string;
  readonly kind: string;
  readonly stroke: Stroke;
  readonly closed: boolean;
  readonly z: number;
  readonly width: number | null;
  /** The path's points resampled to at most RESAMPLE_MM apart, closed paths ending back at their start. */
  readonly points: readonly Vec2[];
  readonly length: number;
  /** True for a travel move the viewer adds between two drawn paths; the checker's scene did not carry it. */
  readonly synthetic: boolean;
};

export type Bounds = { readonly min: Vec2; readonly max: Vec2 };

export type Pieces = {
  /** The outer cut's polygon, or null when the scene has no closed outline. */
  readonly outline: readonly Vec2[] | null;
  /** Closed cuts that lie inside the outline: these fall out when the cut is done. */
  readonly inner: readonly { readonly id: string; readonly points: readonly Vec2[] }[];
};

export type DrawList = {
  readonly items: readonly DrawItem[];
  /** Bounds of every drawn path that is not travel; the stock when nothing is drawn. */
  readonly bounds: Bounds;
  readonly stock: { readonly size: readonly [number, number, number]; readonly material: string } | null;
  readonly top: number;
  readonly pieces: Pieces;
};

export const RESAMPLE_MM = 1;
const SAME_POINT_MM = 1e-6;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function resample(points: readonly Vec2[], closed: boolean, step = RESAMPLE_MM): Vec2[] {
  const first = points[0];
  if (!first) return [];
  const ring = closed && points.length > 1 && dist(first, points[points.length - 1]!) > SAME_POINT_MM ? [...points, first] : points;
  const out: Vec2[] = [first];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!;
    const b = ring[i]!;
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

export function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1]!, points[i]!);
  return total;
}

/** The first `fraction` of a polyline by length, ending on an interpolated point. */
export function partial(points: readonly Vec2[], fraction: number): Vec2[] {
  if (fraction <= 0 || points.length === 0) return [];
  if (fraction >= 1) return [...points];
  const want = polylineLength(points) * fraction;
  const out: Vec2[] = [points[0]!];
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = dist(a, b);
    if (run + d >= want) {
      const f = d === 0 ? 0 : (want - run) / d;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      return out;
    }
    run += d;
    out.push(b);
  }
  return out;
}

/** The point at `fraction` of a polyline by length. */
export function pointAlong(points: readonly Vec2[], fraction: number): Vec2 | null {
  const part = partial(points, Math.max(fraction, 1e-9));
  return part[part.length - 1] ?? points[0] ?? null;
}

export function insidePolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function boundsOf(pointSets: readonly (readonly Vec2[])[]): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pts of pointSets)
    for (const [x, y] of pts) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  return Number.isFinite(minX) ? { min: [minX, minY], max: [maxX, maxY] } : null;
}

/** Machine order: by `order`, then the file's own order for paths without one. */
function inMachineOrder(paths: readonly InspectPath[]): InspectPath[] {
  return paths
    .map((path, index) => ({ path, index }))
    .sort((a, b) => (a.path.order ?? Infinity) - (b.path.order ?? Infinity) || a.index - b.index)
    .map(({ path }) => path);
}

function toItem(path: InspectPath, synthetic = false): DrawItem {
  const points = resample(path.points, path.closed);
  return {
    id: path.id,
    kind: path.kind,
    stroke: strokeFor(path.kind),
    closed: path.closed,
    z: path.z,
    width: path.width ?? null,
    points,
    length: polylineLength(points),
    synthetic,
  };
}

export function toDrawList(scene: InspectScene): DrawList {
  const ordered = inMachineOrder(scene.paths).filter((p) => p.points.length > 0);
  const hasTravel = ordered.some((p) => p.kind === "travel");
  const items: DrawItem[] = [];
  for (const path of ordered) {
    const item = toItem(path);
    const prev = items[items.length - 1];
    const from = prev?.points[prev.points.length - 1];
    const to = item.points[0];
    // A scene without its own travel moves still has the head move between paths; it is drawn faint so the order shows.
    if (!hasTravel && from && to && dist(from, to) > SAME_POINT_MM) {
      items.push(toItem({ id: `travel-${items.length}`, kind: "travel", layer: "travel", z: item.z, closed: false, points: [from, to] }, true));
    }
    items.push(item);
  }
  const drawn = items.filter((i) => i.stroke !== "travel").map((i) => i.points);
  const stock = scene.stock ?? null;
  const stockRect: Vec2[] = stock ? [[0, 0], [stock.size[0], stock.size[1]]] : [];
  const bounds = boundsOf(drawn) ?? boundsOf([stockRect]) ?? { min: [0, 0], max: [scene.size[0] || 1, scene.size[1] || 1] };
  const top = stock ? stock.size[2] : Math.max(0, ...scene.paths.map((p) => p.z));
  return { items, bounds, stock, top, pieces: piecesOf(scene.paths) };
}

function piecesOf(paths: readonly InspectPath[]): Pieces {
  const outlinePath = paths.find((p) => p.kind === "outline" && p.closed && p.points.length >= 3);
  if (!outlinePath) return { outline: null, inner: [] };
  const outline = outlinePath.points;
  const inner = paths
    .filter((p) => p !== outlinePath && p.kind === "cut" && p.closed && p.points.length >= 3)
    .filter((p) => p.points.every((pt) => insidePolygon(pt, outline)))
    .map((p) => ({ id: p.id, points: p.points }));
  return { outline, inner };
}

export type Place = { readonly x: number; readonly y: number; readonly radius: number; readonly source: "at" | "refs" };

/**
 * Where a finding points on the part. The finding's own `at` wins; otherwise the box around the paths it names.
 * A hidden finding never has a place: showing one would give away the sealed sample.
 */
export function placeOf(list: DrawList, finding: InspectFinding): Place | null {
  if (finding.hidden) return null;
  if (finding.at) return { x: finding.at[0], y: finding.at[1], radius: 4, source: "at" };
  const refs = new Set(finding.refs ?? []);
  if (refs.size === 0) return null;
  const named = list.items.filter((i) => !i.synthetic && refs.has(i.id));
  // The outline spans the whole part, so next to a smaller path it would only widen the mark to everything.
  const inner = named.filter((i) => i.kind !== "outline");
  const box = boundsOf((inner.length > 0 ? inner : named).map((i) => i.points));
  if (!box) return null;
  const w = box.max[0] - box.min[0];
  const h = box.max[1] - box.min[1];
  return { x: box.min[0] + w / 2, y: box.min[1] + h / 2, radius: Math.max(3, Math.hypot(w, h) / 2), source: "refs" };
}
