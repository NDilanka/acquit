import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

test("specialist pages, shell and navigation have no clock-framed product copy", () => {
  // Contract adapters and legacy route redirects intentionally retain their API names.
  const pages = readdirSync(new URL(".", import.meta.url))
    .filter((file) => /\.(tsx|css)$/.test(file) || file === "view.ts")
    .map((file) => new URL(file, import.meta.url));
  const files = [...pages, new URL("../../shell.tsx", import.meta.url), new URL("../../nav.ts", import.meta.url)];
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"),
    /\b(?:night|morning|overnight|tonight|slept|sleep)\b|while you were away|last 24 hours/i, file.pathname);
});
