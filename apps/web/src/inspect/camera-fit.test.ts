import assert from "node:assert/strict";
import { test } from "node:test";
import { boxCorners, centredTarget, fitDistance, project, type Orbit } from "./camera-fit.ts";

const sheet = boxCorners([-150, 0, -100], [150, 3, 100]);

for (const aspect of [16 / 9, 1, 390 / 330, 0.6]) {
  test(`the fitted distance keeps every corner in view at aspect ${aspect.toFixed(2)}`, () => {
    const target = [-40, 3, -20] as const;
    const distance = fitDistance(sheet, target, -0.55, 0.92, 38, aspect, 0.9);
    const orbit: Orbit = { azimuth: -0.55, polar: 0.92, distance, target };
    const xs = sheet.map((p) => project(p, orbit, 38, aspect));
    for (const [x, y] of xs) {
      assert.ok(Math.abs(x) <= 0.9 + 1e-9, `x ${x}`);
      assert.ok(Math.abs(y) <= 0.9 + 1e-9, `y ${y}`);
    }
    // Tight: some corner touches the margin, so the fit is not wastefully far.
    assert.ok(xs.some(([x, y]) => Math.abs(Math.abs(x) - 0.9) < 1e-6 || Math.abs(Math.abs(y) - 0.9) < 1e-6));
  });
}

test("a narrower stage needs a farther camera", () => {
  const wide = fitDistance(sheet, [0, 3, 0], -0.55, 0.92, 38, 16 / 9);
  const tall = fitDistance(sheet, [0, 3, 0], -0.55, 0.92, 38, 0.7);
  assert.ok(tall > wide);
});

test("the centred target puts the sheet's bounds in the middle of the view and fits closer", () => {
  for (const aspect of [16 / 9, 2.2, 1.25, 0.7]) {
    const start = [-45, 3, -30] as const;
    const t = centredTarget(sheet, start, -0.4, 0.95, 38, aspect, 0.9);
    const distance = fitDistance(sheet, t, -0.4, 0.95, 38, aspect, 0.9);
    const ps = sheet.map((p) => project(p, { azimuth: -0.4, polar: 0.95, distance, target: t }, 38, aspect));
    const mid = (k: 0 | 1) => (Math.min(...ps.map((p) => p[k])) + Math.max(...ps.map((p) => p[k]))) / 2;
    assert.ok(Math.abs(mid(0)) < 0.02 && Math.abs(mid(1)) < 0.02, `aspect ${aspect}: ${mid(0)}, ${mid(1)}`);
    assert.ok(distance <= fitDistance(sheet, start, -0.4, 0.95, 38, aspect, 0.9));
    assert.equal(t[1], 3);
  }
});
