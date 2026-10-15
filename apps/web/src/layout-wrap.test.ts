import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// No DOM in this suite, so the class wiring is the seam: the stylesheet must enable wrapping, and the page must apply it.
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const jobPage = readFileSync(new URL("./pages/JobPage.tsx", import.meta.url), "utf8");

const oneLineRule = (selector: string): string =>
  css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";

test("the job clock's action row wraps its buttons inside the card at desktop widths", () => {
  assert.match(oneLineRule(".act"), /flex-wrap:\s*wrap/);
});

test("the PAID job's merged-PR badge wraps instead of widening a 390px page", () => {
  assert.match(oneLineRule(".merge-note"), /white-space:\s*normal/);
  assert.match(jobPage, /merge-note/);
});
