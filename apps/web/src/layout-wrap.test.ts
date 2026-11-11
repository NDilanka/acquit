import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// No DOM in this suite, so the class wiring is the seam: the stylesheet must enable wrapping, and the page must apply it.
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const timeline = readFileSync(new URL("./pages/job/Timeline.tsx", import.meta.url), "utf8");

const oneLineRule = (selector: string): string =>
  css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";

test("the job clock's action row wraps its buttons inside the card at desktop widths", () => {
  assert.match(oneLineRule(".act"), /flex-wrap:\s*wrap/);
});

test("the PAID job's timeline text and payout ids wrap instead of widening a 390px page", () => {
  assert.match(oneLineRule(".tl-body"), /overflow-wrap:\s*anywhere/);
  assert.match(oneLineRule(".tl-ids"), /flex-wrap:\s*wrap/);
  assert.match(timeline, /className="tl-ids"/);
});

test("the shell's single title wraps and mobile navigation contains background interaction", () => {
  const shell = readFileSync(new URL("./shell.tsx", import.meta.url), "utf8");
  const router = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
  // Legacy shell supplies its title; the owner entry supplies its own, never both in one branch.
  assert.equal((shell.match(/<h1\b/g) ?? []).length, 2);
  assert.match(shell, /function LegacyShell/);
  assert.match(shell, /function OwnerShell/);
  assert.match(css, /\.topbar-h \{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(shell, /el\.inert = true/);
  assert.match(shell, /el\.inert = previous\[i\]/);
  assert.match(shell, /menuButton\.current\.focus\(\)/);
  // A visibility transition leaves the opening sheet hidden when its effect focuses Close.
  assert.doesNotMatch(css, /transition:[^;{}]*\bvisibility\b/);
  assert.match(router, /document\.title =/);
  assert.match(router, /heading\.focus\(\{ preventScroll: true \}\)/);
});

test("a fieldset can be the form primitive without retaining its native frame", () => {
  const rule = oneLineRule(".form fieldset, fieldset.form");
  assert.match(rule, /border:\s*0/);
  assert.match(rule, /padding:\s*0/);
  assert.match(rule, /margin:\s*0/);
  assert.match(rule, /min-width:\s*0/);
});

test("sample tile labels retain a gap from Explain even in narrow desktop columns", () => {
  const studio = readFileSync(new URL("./studio/studio.css",import.meta.url),"utf8");
  const lines = studio.split("\n");
  const grid = lines.find(line => line.startsWith(".studio-widget:has(> .explain-open) {")) ?? "";
  const label = lines.find(line => line.startsWith(".studio-widget > .eyebrow {")) ?? "";
  assert.match(grid,/grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(grid,/column-gap: var\(--space-4\)/);
  assert.match(label,/min-width: 0/);
  assert.match(label,/white-space: normal/);
  assert.match(label,/overflow-wrap: normal/);
  assert.match(label,/hyphens: none/);
  assert.match(label,/overflow: hidden; text-overflow: ellipsis/);
  const labelRules = lines.filter(line => line.includes(".studio-widget") && line.includes("> .eyebrow"));
  for (const rule of labelRules) assert.doesNotMatch(rule,/overflow-wrap:\s*(anywhere|break-word)|word-break:/);
  assert.match(studio,/\.studio-widget:has\(> \.explain-open\) > \.explain-open \{ grid-column: 2; grid-row: 1;/);
});

test("compact viewing wraps 240px tiles by canvas width, including when Ask narrows it", () => {
  const studio = readFileSync(new URL("./studio/studio.css",import.meta.url),"utf8");
  const page = readFileSync(new URL("./studio/StudioPage.tsx",import.meta.url),"utf8");
  const widgets = readFileSync(new URL("./studio/dashboards.tsx",import.meta.url),"utf8");
  assert.match(studio,/\.studio-host \.ag-studio-root-canvas \{ container: studio-canvas \/ inline-size; \}/);
  assert.match(studio,/@container studio-canvas \(max-width: 860px\)/);
  assert.match(studio,/\.studio-flow \.ag-studio-layout-canvas \{ height: auto !important; min-height: 0 !important; \}/);
  assert.match(studio,/\.studio-flow \.ag-studio-layout-content-container:has\(> \.ag-studio-layout-widget\) \{ position: relative; inset: auto; display: flex; flex-wrap: wrap; \}/);
  assert.match(studio,/\.studio-flow \.ag-studio-layout-widget \{[^}]*position: static;[^}]*width: auto !important;[^}]*min-width: 0;[^}]*min-height: 160px;[^}]*flex: 1 1 240px;/);
  assert.match(studio,/\.studio-flow \.ag-studio-layout-widget:not\(:has\(\[data-widget-kind="stat"\]\)\) \{ flex-basis: 100%; \}/);
  assert.match(page,/className=\{`studio-host\$\{mode === "view" \? " studio-flow" : ""\}`\}/);
  assert.match(widgets,/function labelled\(\{ id, comp: Body, label, kind \}: Spec\)/);
  assert.match(widgets,/data-widget-kind=\{kind\}/);
});

test("filming-sized canvases keep their designed tracks while the 858px canvas can reflow", () => {
  const studio = readFileSync(new URL("./studio/studio.css",import.meta.url),"utf8");
  const cutoff = Number(studio.match(/@container studio-canvas \(max-width: (\d+)px\)/)?.[1]);
  assert.ok(Number.isFinite(cutoff));
  for (const width of [880,888,1048]) assert.equal(width <= cutoff,false,`${width}px must keep Studio's designed layout`);
  for (const width of [858,860]) assert.equal(width <= cutoff,true,`${width}px may use compact reflow`);
  assert.equal(861 <= cutoff,false,"the compact range ends at 860px");
});

test("compact stat runs fill their last row without a stat-count or column-count special case", () => {
  const studio = readFileSync(new URL("./studio/studio.css",import.meta.url),"utf8");
  const compact = studio.match(/@container studio-canvas \(max-width: 860px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  // Positive growth shares each line's remaining width; a following full-width tile starts a new line.
  assert.match(compact,/\.ag-studio-layout-widget \{[^}]*flex: 1 1 240px;/);
  assert.match(compact,/\.ag-studio-layout-widget:not\(:has\(\[data-widget-kind="stat"\]\)\) \{ flex-basis: 100%; \}/);
  assert.doesNotMatch(compact,/grid-template-columns|grid-column|nth-(?:child|last-child|of-type)|:last-child/);
});

test("compact custom tiles grow from in-flow content instead of fixed height or block-size containment", () => {
  const studio = readFileSync(new URL("./studio/studio.css",import.meta.url),"utf8");
  const compact = studio.match(/@container studio-canvas \(max-width: 860px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const rule = (selector: string) => compact.split("\n").find(line => line.trim().startsWith(`${selector} {`)) ?? "";
  const tile = rule(".studio-flow .ag-studio-layout-widget");
  assert.match(tile,/height: auto !important/);
  assert.match(tile,/container-type: inline-size/);
  assert.match(tile,/min-height: 160px/);
  assert.match(rule(".studio-flow .ag-studio-layout-widget-content:has(.studio-widget)"),/position: relative; inset: auto/);
  assert.match(rule(".studio-flow .studio-widget"),/height: auto; min-height: 0; overflow: visible/);
  assert.match(rule(".studio-flow .studio-value"),/min-width: 0; white-space: normal; overflow-wrap: anywhere/);
  for (const [, , value] of compact.matchAll(/(?:^|[;{])\s*((?:max-)?height):\s*([^;}]+)/g)) {
    assert.match(value ?? "",/^(?:auto|none)(?:\s*!important)?\s*$/,"compact tiles must not acquire a fixed or maximum height");
  }
});

test("compact verdict headers wrap at words and Grid measures their height without collapsing its scrollport", () => {
  const studio = readFileSync(new URL("./studio/studio.css",import.meta.url),"utf8");
  const widgets = readFileSync(new URL("./studio/dashboards.tsx",import.meta.url),"utf8");
  const compact = studio.match(/@container studio-canvas \(max-width: 860px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(compact,/\.studio-flow \.verdict-grid \.ag-root-wrapper \{ min-height: 240px; \}/);
  assert.match(compact,/\.studio-flow \.changes-grid \.ag-root-wrapper \{ min-height: 180px; \}/);
  assert.match(compact,/\.studio-flow \.verdict-grid \.ag-header-cell-text \{ white-space: normal; overflow-wrap: normal; \}/);
  assert.match(widgets,/const VERDICT_DEFAULTS:[^\n]*autoHeaderHeight: true/);
});
