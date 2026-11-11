import assert from "node:assert/strict";
import { test } from "node:test";
import { caughtOnlyBySealed, checklistOf, formatMeasured, measuredLabel } from "./checklist.ts";
import { LASER_CHECKER, LASER_DELIVERIES, LASER_SAMPLE_FILES, laserJobSummary } from "./laser-deliveries.ts";
import { checkerFor } from "./registry.ts";
import { RULES } from "../../../../packages/verifier-laser/src/index.ts";
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
  assert.deepEqual(sealedOnly.map((d) => d.title), ["Passes every public rule"]);
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

test("the featured deliveries exist and start with the honest file and the sealed-only cheat", () => {
  const ids = new Set(LASER_DELIVERIES.map((d) => d.id));
  for (const id of LASER_CHECKER.featured) assert.ok(ids.has(id), id);
  assert.deepEqual(LASER_CHECKER.featured.slice(0, 2), ["honest", "fraud-hidden-notch"]);
});

test("every public rule the checker reports has a plain name, and no hidden rule has one", () => {
  for (const delivery of LASER_DELIVERIES)
    for (const finding of delivery.run().findings) {
      if (finding.hidden) assert.equal(LASER_CHECKER.ruleNames[finding.rule], undefined, finding.rule);
      else assert.ok(LASER_CHECKER.ruleNames[finding.rule], `${finding.rule} has no plain name`);
    }
});

test("every rule the laser checker can emit has a plain name, except the sealed one", () => {
  const sealed = new Set(LASER_DELIVERIES.flatMap((d) => d.run().findings.filter((f) => f.hidden).map((f) => f.rule)));
  assert.deepEqual([...sealed], ["hidden-material"]);
  for (const rule of RULES) {
    if (sealed.has(rule)) continue;
    assert.ok(LASER_CHECKER.ruleNames[rule], `${rule} has no plain name`);
  }
  for (const rule of Object.keys(LASER_CHECKER.ruleNames)) assert.ok((RULES as readonly string[]).includes(rule), `${rule} is not a checker rule`);
});

test("every failure caption is plain words and copies its numbers from the checker's message", () => {
  for (const delivery of LASER_DELIVERIES)
    for (const finding of delivery.run().findings.filter((f) => !f.ok && !f.hidden)) {
      const caption = LASER_CHECKER.failCaption(finding);
      assert.ok(caption, `${delivery.id} ${finding.rule} has a caption`);
      for (const n of caption.match(/\d+(?:\.\d+)?/g) ?? []) assert.ok(finding.message.includes(n), `${delivery.id}: ${n} is not in "${finding.message}"`);
      assert.doesNotMatch(caption, /\(s\)/);
    }
});

test("the planned cut time reads as an estimate rounded to one decimal", () => {
  const honest = LASER_DELIVERIES[0]!.run();
  const raw = honest.measured.estimatedCutSeconds!;
  assert.deepEqual(formatMeasured("estimatedCutSeconds", raw, LASER_CHECKER.measured.estimatedCutSeconds), {
    label: "Planned cut time (estimate)",
    value: String(Number(Number(raw).toFixed(1))),
    unit: "s",
  });
  assert.deepEqual(formatMeasured("minWebMm", 4.3612), { label: "Min web", value: "4.36", unit: "mm" });
  assert.deepEqual(formatMeasured("cutPaths", 6), { label: "Cut paths", value: "6", unit: null });
});

test("the README's embedding example names a registered workflow", async () => {
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  const ids = [...readme.matchAll(/<CheckerInspector workflow="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(ids.length > 0);
  for (const id of ids) assert.notEqual(checkerFor(id), null, id);
});

test("the registry offers the laser checker by its workflow", () => {
  assert.equal(checkerFor("laser-cut"), LASER_CHECKER);
  assert.equal(checkerFor("pcb"), null);
});
