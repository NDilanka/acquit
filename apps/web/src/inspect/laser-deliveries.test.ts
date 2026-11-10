import assert from "node:assert/strict";
import { test } from "node:test";
import { caughtOnlyBySealed, checklistOf, measuredLabel } from "./checklist.ts";
import { LASER_DELIVERIES, LASER_SAMPLE_FILES, laserJobSummary } from "./laser-deliveries.ts";
import { placeOf, toDrawList } from "./scene-draw.ts";

test("the picker offers every laser sample exactly once", () => {
  assert.deepEqual(LASER_DELIVERIES.map((d) => d.fileName).sort(), [...LASER_SAMPLE_FILES].sort());
  assert.equal(new Set(LASER_DELIVERIES.map((d) => d.title)).size, LASER_DELIVERIES.length);
  assert.equal(LASER_DELIVERIES[0]!.title, "Honest delivery");
});

test("the honest delivery passes and every cheat fails exactly one rule, as the checker reports", () => {
  for (const delivery of LASER_DELIVERIES) {
    const verdict = delivery.run();
    const failed = verdict.findings.filter((f) => !f.ok);
    if (!delivery.cheat) {
      assert.equal(verdict.pass, true, delivery.id);
      assert.equal(failed.length, 0, delivery.id);
      continue;
    }
    assert.equal(verdict.pass, false, delivery.id);
    assert.equal(failed.length, 1, `${delivery.id} fails ${failed.map((f) => f.rule).join(", ")}`);
  }
});

test("exactly one cheat passes every public rule and is caught only by a sealed check", () => {
  const sealedOnly = LASER_DELIVERIES.filter((d) => caughtOnlyBySealed(checklistOf(d.run())));
  assert.deepEqual(sealedOnly.map((d) => d.title), ["Passes every public rule, fails a hidden one"]);
});

test("every public failure the checker names a path for can be marked on the part", () => {
  for (const delivery of LASER_DELIVERIES) {
    const verdict = delivery.run();
    const list = toDrawList(verdict.scene);
    for (const finding of verdict.findings.filter((f) => !f.ok && !f.hidden && (f.refs?.length ?? 0) > 0))
      assert.notEqual(placeOf(list, finding), null, `${delivery.id} ${finding.rule}`);
  }
});

test("the honest panel has its outline and its five inner cuts as pieces", () => {
  const honest = LASER_DELIVERIES[0]!.run();
  const list = toDrawList(honest.scene);
  assert.notEqual(list.pieces.outline, null);
  assert.equal(list.pieces.inner.length, 5);
  assert.ok(list.items.some((i) => i.stroke === "engrave"));
});

test("the job summary reads from the spec", () => {
  assert.match(laserJobSummary(), /^A 120 x 80 mm acrylic panel, 3 mm thick, with 4 mounting holes, a window and an engraved label\.$/);
});

test("measured keys read as labels with their unit", () => {
  assert.deepEqual(measuredLabel("cutLengthMm"), { label: "Cut length", unit: "mm" });
  assert.deepEqual(measuredLabel("holesMatched"), { label: "Holes matched", unit: null });
  assert.deepEqual(measuredLabel("estimatedCutSeconds"), { label: "Estimated cut", unit: "s" });
});
