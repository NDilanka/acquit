import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { NATIVE_WIDGETS, type DashboardState, type NativeWidgetSpec } from "./dashboard-widgets.ts";
import { nativeWidgetRecord, parseSaved } from "./studio-data.ts";

type Track = { xTrack: number; yTrack: number; xSpan: number; ySpan: number };

const ROUND4_LAYOUT: Record<string, Track> = {
  "acquit-released": { xTrack: 3, yTrack: 0, xSpan: 3, ySpan: 2 },
  "acquit-refunded": { xTrack: 6, yTrack: 0, xSpan: 3, ySpan: 2 },
  "acquit-fees": { xTrack: 9, yTrack: 0, xSpan: 3, ySpan: 2 },
  "acquit-pass-rate": { xTrack: 0, yTrack: 2, xSpan: 4, ySpan: 2 },
  "acquit-reject-rate": { xTrack: 4, yTrack: 2, xSpan: 4, ySpan: 2 },
  "acquit-tamper-caught": { xTrack: 8, yTrack: 2, xSpan: 4, ySpan: 2 },
  "acquit-conserves": { xTrack: 0, yTrack: 4, xSpan: 12, ySpan: 4 },
};

const clash = (a: Track, b: Track) =>
  a.xTrack < b.xTrack + b.xSpan && b.xTrack < a.xTrack + a.xSpan && a.yTrack < b.yTrack + b.ySpan && b.yTrack < a.yTrack + a.ySpan;

const clashingPairs = (layout: Partial<Record<string, Track>>) => {
  const entries = Object.entries(layout).filter((e): e is [string, Track] => e[1] !== undefined);
  return entries.flatMap(([a, ta], i) => entries.slice(i + 1).filter(([, tb]) => clash(ta, tb)).map(([b]) => `${a} x ${b}`));
};

const saved = (widgets: Record<string, string>, widgetLayout: Record<string, Track>) =>
  JSON.stringify({
    selectedPageId: "main",
    pages: [
      {
        id: "main",
        layout: { columns: 12, rowHeight: 60 },
        widgets: Object.fromEntries(Object.entries(widgets).map(([id, type]) => [id, { type, dataMapping: {} }])),
        widgetLayout,
      },
    ],
  });

const mainPage = (state: DashboardState | null) => {
  const page = state?.pages[0];
  assert.ok(page, "the saved layout loads with its page");
  return { widgets: page.widgets ?? {}, layout: (page.widgetLayout ?? {}) as Partial<Record<string, Track>> };
};

test("a saved layout that leaves a widget without a placement loads with a free one", () => {
  const widgets = { ...Object.fromEntries(Object.keys(ROUND4_LAYOUT).map((id) => [id, id])), "held-escrow-main": "acquit-held" };
  const { widgets: loaded, layout } = mainPage(parseSaved(saved(widgets, ROUND4_LAYOUT), "escrow"));
  for (const id of Object.keys(loaded)) assert.ok(layout[id], `${id} has a placement`);
  assert.deepEqual(clashingPairs(layout), [], "no two widgets share a cell");
  const held = layout["held-escrow-main"];
  assert.ok(held && held.xTrack >= 0 && held.xTrack + held.xSpan <= 12, `the unplaced widget got a placement inside the grid (got ${JSON.stringify(held)})`);
  assert.deepEqual(layout["acquit-released"], { xTrack: 3, yTrack: 0, xSpan: 3, ySpan: 2 }, "a sound placement is left as saved");
  assert.deepEqual(layout["acquit-conserves"], { xTrack: 0, yTrack: 4, xSpan: 12, ySpan: 4 }, "a sound placement is left as saved");
});

test("a saved layout with two widgets over one cell loads with them apart", () => {
  const corner = { xTrack: 0, yTrack: 0, xSpan: 3, ySpan: 2 };
  const json = saved(
    { "acquit-held": "acquit-held", "acquit-released": "acquit-released" },
    { "acquit-held": { ...corner }, "acquit-released": { ...corner } },
  );
  const { layout } = mainPage(parseSaved(json, "escrow"));
  const held = layout["acquit-held"];
  const released = layout["acquit-released"];
  assert.ok(held && released, "both widgets keep a placement");
  assert.deepEqual(clashingPairs(layout), [], "the two widgets no longer share a cell");
  const kept = [held, released].filter((t) => isDeepStrictEqual(t, corner));
  assert.equal(kept.length, 1, "exactly one widget keeps the contested corner");
});

test("a layout that is not Studio state still loads as nothing", () => {
  assert.equal(parseSaved(null, "escrow"), null);
  assert.equal(parseSaved("not json", "escrow"), null);
  assert.equal(parseSaved("{}", "escrow"), null);
});

const savedFunnel = (funnelFields: Record<string, unknown>) =>
  JSON.stringify({
    selectedPageId: "main",
    pages: [
      {
        id: "main",
        layout: { columns: 12, rowHeight: 60 },
        widgets: {
          "escrow-funnel": { type: "funnel-chart", dataMapping: { categoryKey: [{ id: "jobs.stage" }] }, ...funnelFields },
          "acquit-held": { type: "acquit-held", dataMapping: {} },
        },
        widgetLayout: {
          "escrow-funnel": { xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 5 },
          "acquit-held": { xTrack: 4, yTrack: 0, xSpan: 3, ySpan: 2 },
        },
      },
    ],
  });

test("the escrow funnel's spec sorts its stages ascending by stage", () => {
  const specs: readonly NativeWidgetSpec[] = NATIVE_WIDGETS.escrow.flat();
  assert.deepEqual(specs.find((spec) => spec.id === "escrow-funnel")?.sort, [{ field: { id: "jobs.stage" }, direction: "asc" }]);
});

test("a fresh escrow funnel record carries the spec's ascending stage sort", () => {
  const funnel = NATIVE_WIDGETS.escrow.flat().find((spec) => spec.id === "escrow-funnel");
  assert.ok(funnel, "the escrow dashboard seeds a funnel");
  assert.deepEqual(nativeWidgetRecord(funnel).sort, [{ field: { id: "jobs.stage" }, direction: "asc" }]);
});

test("a saved escrow funnel with no sort loads with the spec's ascending stage sort", () => {
  const { widgets } = mainPage(parseSaved(savedFunnel({}), "escrow"));
  assert.deepEqual(widgets["escrow-funnel"]?.sort, [{ field: { id: "jobs.stage" }, direction: "asc" }]);
});

test("a saved escrow funnel keeps the descending sort the viewer chose", () => {
  const { widgets } = mainPage(parseSaved(savedFunnel({ sort: [{ field: { id: "jobs.stage" }, direction: "desc" }] }), "escrow"));
  assert.deepEqual(widgets["escrow-funnel"]?.sort, [{ field: { id: "jobs.stage" }, direction: "desc" }]);
});

test("a saved custom widget loads with no sort added", () => {
  const { widgets } = mainPage(parseSaved(savedFunnel({}), "escrow"));
  assert.deepEqual(widgets["acquit-held"], { type: "acquit-held", dataMapping: {} });
});
