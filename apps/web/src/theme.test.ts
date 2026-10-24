import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseChoice, resolveTheme, THEME_KEY } from "./theme.ts";

test("a stored Dark or Light is used whatever the system prefers", () => {
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("light", true), "light");
});

test("System follows the operating system: dark when it prefers dark, light otherwise", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("with nothing stored, or an unknown value, the theme is Light", () => {
  assert.equal(resolveTheme(null, true), "light");
  assert.equal(resolveTheme(null, false), "light");
  assert.equal(resolveTheme("", true), "light");
  assert.equal(resolveTheme("sepia", true), "light");
});

test("the stored choice reads back as Dark, Light, or System", () => {
  assert.equal(parseChoice("dark"), "dark");
  assert.equal(parseChoice("system"), "system");
  assert.equal(parseChoice("light"), "light");
  assert.equal(parseChoice(null), "light");
});

test("the first-paint script in index.html reads the same key and the same values", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(THEME_KEY, "acquit.theme");
  assert.match(html, /localStorage\.getItem\("acquit\.theme"\)/);
  assert.match(html, /s === "dark" \|\| \(s === "system"/);
  assert.match(html, /prefers-color-scheme: dark/);
});
