import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { passingTests } from "./verdict-grid.ts";
import { VerdictPassing } from "./verdict-passing.ts";

test("one counted attempt renders visible counts and a marker, not an invisible one-point polyline", () => {
  const passing = passingTests([{ ordinal: 1, frozen: { passed: 48, expected: 48 }, hidden: null }]);
  const html = renderToStaticMarkup(VerdictPassing({ passing }));
  assert.match(html, />48\/48<span class="verdict-single" aria-hidden="true">●<\/span>/);
  assert.doesNotMatch(html, /<svg|<polyline/);
});

test("two counted attempts retain visible counts alongside the sparkline", () => {
  const html = renderToStaticMarkup(VerdictPassing({ passing: passingTests([
    { ordinal: 2, frozen: { passed: 48, expected: 48 }, hidden: null },
    { ordinal: 1, frozen: { passed: 24, expected: 48 }, hidden: null },
  ]) }));
  assert.match(html, />48\/48<\/span>/);
  assert.match(html, /<svg[^>]*aria-label="Passing share of 2 counted attempts: 50%, 100%"/);
  assert.match(html, /<polyline points="2,9 94,2"/);
  assert.doesNotMatch(html, /verdict-single/);
});

test("zero passing tests are still visible and absent counts say so in text", () => {
  const zero = renderToStaticMarkup(VerdictPassing({ passing: passingTests([
    { ordinal: 1, frozen: { passed: 0, expected: 48 }, hidden: null },
  ]) }));
  assert.match(zero, />0\/48<span/);
  assert.equal(renderToStaticMarkup(VerdictPassing({ passing: passingTests([]) })), '<span class="muted">No counts yet</span>');
});

test("table cells and narrow cards share the tested renderer, whose counts and dot remain in the visible flow", () => {
  const dashboards = readFileSync(new URL("./studio/dashboards.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./studio/studio.css", import.meta.url), "utf8");
  assert.match(dashboards, /<VerdictPassing passing=\{passingTests\(job\.attempts\)\} \/>/);
  assert.match(dashboards, /<VerdictPassing passing=\{card\.passing\} \/>/);
  assert.match(css, /\.verdict-grid \.verdict-passing \{ display: inline-flex; flex-direction: column/);
  assert.match(css, /\.verdict-grid \.verdict-single \{ margin-left: 6px; color: var\(--green-text\); \}/);
});
