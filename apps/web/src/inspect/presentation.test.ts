import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("measurements are an initially closed disclosure and honesty stays available verbatim", () => {
  const inspector = readFileSync(new URL("./Inspector.tsx",import.meta.url),"utf8");
  const page = readFileSync(new URL("./InspectPage.tsx",import.meta.url),"utf8");
  assert.match(inspector,/<details className="insp-measured">\s*<summary>Show measurements<\/summary>/);
  assert.match(inspector,/\{HONEST_LINE\}/);
  assert.match(inspector,/MOMENT\.sub/);
  assert.match(page,/<h1>Try to cheat the checker<\/h1>/);
  assert.match(page,/<summary>About this demonstration<\/summary><p>\{DEMO_INTRO\}<\/p>/);
});

test("inspector uses token text sizes, 400/500 weight and grid-aligned spacing", () => {
  const css = readFileSync(new URL("./inspect.css",import.meta.url),"utf8");
  assert.doesNotMatch(css,/11px|font-weight:\s*600/);
  for (const match of css.matchAll(/(?:padding|margin|gap)(?:-[\w-]+)?:\s*([^;{}]+)/g)) {
    for (const px of match[1]!.matchAll(/(-?\d+)px/g)) assert.equal(Math.abs(Number(px[1]))%4,0,match[0]);
  }
  assert.match(css,/\.insp-chip:focus-visible/);
});
