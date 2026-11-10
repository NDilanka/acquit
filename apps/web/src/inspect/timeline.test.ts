import assert from "node:assert/strict";
import { test } from "node:test";
import { checklistOf } from "./checklist.ts";
import type { InspectVerdict } from "./contract.ts";
import { toDrawList } from "./scene-draw.ts";
import { buildTimeline, frameAt } from "./timeline.ts";

const verdict = (failPublic: boolean, failSealed: boolean): InspectVerdict => ({
  workflow: "laser-cut",
  pass: !failPublic && !failSealed,
  measured: {},
  findings: [
    { rule: "a", ok: true, hidden: false, message: "a holds" },
    { rule: "b", ok: !failPublic, hidden: false, message: "b holds", refs: ["hole"] },
    { rule: "c", ok: !failSealed, hidden: true, message: "secret text" },
  ],
  scene: {
    units: "mm",
    size: [100, 100, 3],
    stock: { size: [100, 100, 3], material: "acrylic" },
    paths: [
      { id: "hole", kind: "cut", layer: "cut", z: 3, closed: true, order: 0, points: [[20, 20], [30, 20], [30, 30], [20, 30]] },
      { id: "outline", kind: "outline", layer: "cut", z: 3, closed: true, order: 1, points: [[10, 10], [60, 10], [60, 60], [10, 60]] },
    ],
  },
});

function setup(failPublic: boolean, failSealed: boolean) {
  const v = verdict(failPublic, failSealed);
  const list = toDrawList(v.scene);
  const checks = checklistOf(v);
  return { list, checks, tl: buildTimeline(list, checks) };
}

test("the phases follow each other: trace, drop, public rules, sealed checks, verdict", () => {
  const { tl } = setup(false, false);
  assert.ok(tl.traceEnd >= 4 && tl.traceEnd <= 9);
  assert.ok(tl.dropEnd > tl.traceEnd);
  assert.ok(tl.publicAt[0]! > tl.dropEnd);
  assert.ok(tl.publicAt[1]! > tl.publicAt[0]!);
  assert.ok(tl.sealedIntroAt > tl.publicAt[1]!);
  assert.ok(tl.sealedAt[0]!.start > tl.sealedIntroAt);
  assert.ok(tl.verdictAt >= tl.sealedAt[0]!.end);
  assert.ok(tl.total > tl.verdictAt);
  for (let i = 1; i < tl.trace.length; i++) assert.equal(tl.trace[i]!.start, tl.trace[i - 1]!.end);
});

test("the head cuts the first path at the start and parks after the trace", () => {
  const { list, checks, tl } = setup(false, false);
  const start = frameAt(list, checks, tl, 0.01);
  assert.equal(start.phase, "trace");
  assert.equal(start.headItem, 0);
  assert.equal(start.cutting, true);
  assert.equal(start.publicShown, 0);
  const travel = frameAt(list, checks, tl, (tl.trace[1]!.start + tl.trace[1]!.end) / 2);
  assert.equal(list.items[travel.headItem]!.stroke, "travel");
  assert.equal(travel.cutting, false);
  const after = frameAt(list, checks, tl, tl.traceEnd + 0.01);
  assert.deepEqual(after.progress, list.items.map(() => 1));
  assert.equal(after.cutting, false);
  assert.ok(after.drop > 0 && after.drop < 1);
});

test("a failing public rule takes the focus when it appears and holds it", () => {
  const { list, checks, tl } = setup(true, false);
  assert.equal(frameAt(list, checks, tl, tl.publicAt[1]! - 0.01).focus, null);
  assert.equal(frameAt(list, checks, tl, tl.publicAt[1]!).focus, 1);
  assert.equal(frameAt(list, checks, tl, tl.total).focus, 1);
  assert.ok(tl.publicAt[1]! - tl.publicAt[0]! < tl.sealedIntroAt - tl.publicAt[1]!, "the failing row is held longer");
});

test("the sealed check is checked for a while before it shows its result", () => {
  const { list, checks, tl } = setup(false, true);
  const during = frameAt(list, checks, tl, tl.sealedAt[0]!.start + 0.1);
  assert.equal(during.phase, "sealed");
  assert.equal(during.publicShown, 2);
  assert.equal(during.sealedChecking, 0);
  assert.equal(during.sealedShown, 0);
  assert.equal(during.focus, null);
  const done = frameAt(list, checks, tl, tl.total);
  assert.equal(done.sealedShown, 1);
  assert.equal(done.sealedChecking, null);
  assert.equal(done.verdict, true);
  assert.equal(done.phase, "verdict");
});

test("time outside the timeline clamps to its ends", () => {
  const { list, checks, tl } = setup(false, false);
  assert.equal(frameAt(list, checks, tl, -5).t, 0);
  assert.equal(frameAt(list, checks, tl, tl.total + 5).t, tl.total);
});

test("the checklist carries no hidden rule name or message", () => {
  const checks = checklistOf(verdict(false, true));
  assert.deepEqual(checks.sealed, [false]);
  assert.equal(JSON.stringify(checks).includes("secret text"), false);
  assert.equal(checks.publicRows.some((r) => r.rule === "c"), false);
  assert.equal(checks.publicRows[0]!.message, "A holds.");
});
