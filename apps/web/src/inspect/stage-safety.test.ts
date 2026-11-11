import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { watchContextLoss } from "./stage-safety.ts";

test("a lost WebGL context is reported once, its default is prevented, and the listener comes off", () => {
  const canvas = new EventTarget();
  let calls = 0;
  const off = watchContextLoss(canvas, () => calls++);
  const e = new Event("webglcontextlost", { cancelable: true });
  canvas.dispatchEvent(e);
  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  assert.equal(calls, 1);
  assert.equal(e.defaultPrevented, true);
  off();
  const again = new EventTarget();
  let later = 0;
  const off2 = watchContextLoss(again, () => later++);
  off2();
  again.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  assert.equal(later, 0);
});

test("the inspector's columns can shrink below their content, so an open file never widens the page on a phone", () => {
  const css = readFileSync(new URL("./inspect.css", import.meta.url), "utf8");
  assert.match(css, /\.inspector \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.insp-file-cols \{[^}]*minmax\(min\(320px, 100%\), 1fr\)/);
  assert.match(css, /\.insp-file-cols > \* \{ min-width: 0; \}/);
  assert.doesNotMatch(css, /minmax\(320px, 1fr\)\)/);
});

test("the inspector stops a running playback when reduced motion turns on, and falls back flat on a lost context", () => {
  const src = readFileSync(new URL("./Inspector.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(!reduced\) return;\s*setPlaying\(false\);\s*setT\(total\);\s*\}, \[reduced, total\]\);/);
  assert.match(src, /if \(!playing \|\| reduced\) return;/);
  assert.match(src, /onContextLost: \(\) => \{\s*setContextLost\(true\);\s*setMode\("2d"\);/);
});
