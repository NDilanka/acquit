import assert from "node:assert/strict";
import { test } from "node:test";
import type { InspectScene } from "./contract.ts";
import { partial, placeOf, polylineLength, resample, strokeFor, toDrawList } from "./scene-draw.ts";

const square = (x: number, y: number, s: number) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]] as const;

const scene: InspectScene = {
  units: "mm",
  size: [100, 100, 3],
  stock: { size: [100, 100, 3], material: "acrylic" },
  paths: [
    { id: "outline", kind: "outline", layer: "cut", z: 3, closed: true, order: 2, points: square(10, 10, 50) },
    { id: "hole", kind: "cut", layer: "cut", z: 3, closed: true, order: 0, points: square(20, 20, 10) },
    { id: "label", kind: "engrave", layer: "engrave", z: 3, closed: false, order: 1, points: [[40, 40], [50, 40]] },
  ],
};

test("paths come out in machine order with travel moves between them", () => {
  const list = toDrawList(scene);
  assert.deepEqual(list.items.map((i) => i.id), ["hole", "travel-1", "label", "travel-3", "outline"]);
  assert.deepEqual(list.items.map((i) => i.stroke), ["cut", "travel", "engrave", "travel", "cut"]);
  assert.equal(list.items[1]!.synthetic, true);
  assert.deepEqual(list.items[1]!.points[0], [20, 20]);
  assert.deepEqual(list.items[1]!.points.at(-1), [40, 40]);
});

test("a scene that carries its own travel gets no extra travel", () => {
  const withTravel: InspectScene = {
    ...scene,
    paths: [...scene.paths, { id: "t", kind: "travel", layer: "travel", z: 3, closed: false, order: 1.5, points: [[50, 40], [10, 10]] }],
  };
  assert.deepEqual(toDrawList(withTravel).items.map((i) => i.id), ["hole", "label", "t", "outline"]);
});

test("closed paths are resampled back to their start, with the true length", () => {
  const pts = resample(square(0, 0, 10), true);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts.at(-1), [0, 0]);
  assert.equal(pts.length, 41);
  assert.equal(polylineLength(pts), 40);
});

test("partial stops part way along a segment", () => {
  assert.deepEqual(partial([[0, 0], [10, 0]], 0.25), [[0, 0], [2.5, 0]]);
  assert.deepEqual(partial([[0, 0], [10, 0]], 0), []);
});

test("the outline and the closed cuts inside it are the pieces", () => {
  const list = toDrawList(scene);
  assert.equal(list.pieces.outline?.length, 4);
  assert.deepEqual(list.pieces.inner.map((p) => p.id), ["hole"]);
  assert.deepEqual(list.bounds, { min: [10, 10], max: [60, 60] });
  assert.equal(list.top, 3);
});

test("a finding is placed by at, then by its refs, and a hidden one never", () => {
  const list = toDrawList(scene);
  assert.deepEqual(placeOf(list, { rule: "r", ok: false, hidden: false, message: "", at: [5, 6, 3] }), { x: 5, y: 6, radius: 4, source: "at" });
  const byRefs = placeOf(list, { rule: "r", ok: false, hidden: false, message: "", refs: ["hole"] });
  assert.equal(byRefs?.x, 25);
  assert.equal(byRefs?.y, 25);
  assert.equal(byRefs?.source, "refs");
  assert.equal(placeOf(list, { rule: "r", ok: false, hidden: false, message: "" }), null);
  const withOutline = placeOf(list, { rule: "r", ok: false, hidden: false, message: "", refs: ["hole", "outline"] });
  assert.equal(withOutline?.x, 25, "the outline does not widen the mark when a smaller path is named");
  assert.equal(placeOf(list, { rule: "r", ok: false, hidden: false, message: "", refs: ["outline"] })?.x, 35);
  assert.equal(placeOf(list, { rule: "r", ok: false, hidden: true, message: "", at: [1, 1, 1], refs: ["hole"] }), null);
});

test("an unknown kind from a newer checker still draws", () => {
  assert.equal(strokeFor("flight"), "route");
  assert.equal(strokeFor("something-new"), "other");
});
