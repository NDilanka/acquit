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
