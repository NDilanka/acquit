// Camera framing as plain maths, so it can be tested without a browser. World axes: x right, y up, z toward the viewer.

export type V3 = readonly [number, number, number];

export type Orbit = { readonly azimuth: number; readonly polar: number; readonly distance: number; readonly target: V3 };

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The unit vector from the target toward the camera. */
export function orbitDirection(azimuth: number, polar: number): V3 {
  return [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth)];
}

export function orbitPosition(o: Orbit): V3 {
  const d = orbitDirection(o.azimuth, o.polar);
  return [o.target[0] + d[0] * o.distance, o.target[1] + d[1] * o.distance, o.target[2] + d[2] * o.distance];
}

/**
 * The least distance at which every point lies inside the view, looking at `target` from the given angles.
 * `margin` is the share of the half-width and half-height the points may use, or a [sideways, upward] pair. Exact for a
 * pinhole camera: a point's sideways and upward offsets do not change with distance, only its depth does.
 */
export type Margin = number | readonly [number, number];

export function fitDistance(points: readonly V3[], target: V3, azimuth: number, polar: number, vfovDeg: number, aspect: number, margin: Margin = 0.88): number {
  const [mx, my] = typeof margin === "number" ? [margin, margin] : margin;
  const back = orbitDirection(azimuth, polar);
  const forward: V3 = [-back[0], -back[1], -back[2]];
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const tv = Math.tan((vfovDeg * Math.PI) / 360) * my;
  const th = Math.tan((vfovDeg * Math.PI) / 360) * mx * aspect;
  let need = 0;
  for (const p of points) {
    const q = sub(p, target);
    const x = Math.abs(dot(q, right));
    const y = Math.abs(dot(q, up));
    need = Math.max(need, x / th - dot(q, forward), y / tv - dot(q, forward));
  }
  return need;
}

/**
 * A target, on the plane y = start's y, from which the fitted view puts the points' bounds in the middle of the view.
 * Aiming at a point that is not the middle of the points leaves room unused on one side, so the fit is looser.
 */
export function centredTarget(points: readonly V3[], start: V3, azimuth: number, polar: number, vfovDeg: number, aspect: number, margin: Margin = 0.88): V3 {
  const back = orbitDirection(azimuth, polar);
  const forward: V3 = [-back[0], -back[1], -back[2]];
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const ground = norm([up[0], 0, up[2]]);
  const along = dot(ground, up) || 1;
  const tv = Math.tan((vfovDeg * Math.PI) / 360);
  let t: V3 = start;
  for (let i = 0; i < 12; i++) {
    const distance = fitDistance(points, t, azimuth, polar, vfovDeg, aspect, margin);
    const o: Orbit = { azimuth, polar, distance, target: t };
    const ps = points.map((p) => project(p, o, vfovDeg, aspect));
    const cx = (Math.min(...ps.map((p) => p[0])) + Math.max(...ps.map((p) => p[0]))) / 2;
    const cy = (Math.min(...ps.map((p) => p[1])) + Math.max(...ps.map((p) => p[1]))) / 2;
    if (Math.abs(cx) < 1e-4 && Math.abs(cy) < 1e-4) break;
    const sx = cx * distance * tv * aspect;
    const sy = (cy * distance * tv) / along;
    t = [t[0] + right[0] * sx + ground[0] * sy, t[1], t[2] + right[2] * sx + ground[2] * sy];
  }
  return t;
}
/** Projects a point to normalised view coordinates, -1..1 across the view, for tests. */
export function project(p: V3, o: Orbit, vfovDeg: number, aspect: number): readonly [number, number] {
  const back = orbitDirection(o.azimuth, o.polar);
  const forward: V3 = [-back[0], -back[1], -back[2]];
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const q = sub(p, orbitPosition(o));
  const z = dot(q, forward);
  const tv = Math.tan((vfovDeg * Math.PI) / 360);
  return [dot(q, right) / (z * tv * aspect), dot(q, up) / (z * tv)];
}

/** The eight corners of a box. */
export function boxCorners(min: V3, max: V3): V3[] {
  const out: V3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}
