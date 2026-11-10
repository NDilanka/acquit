import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const files = ["styles.css", "studio/studio.css", "pages/specialists/specialists.css"];
const typeTokens = new Set(["xs", "sm", "ui", "body", "section", "heading", "display"]);
const sizes = new Set([12, 13, 14, 16, 20, 24, 32]);
// Deliberately empty: product styles no longer need legacy colour or size exceptions.
const exceptions: Readonly<Record<string, readonly string[]>> = {};

for (const file of files) {
  test(`${file} uses shared colours and the product type scale`, () => {
    const css = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const allowed = exceptions[file] ?? [];
    for (const match of css.matchAll(/#[\da-f]{3,8}\b/gi)) assert.ok(allowed.includes(match[0]), `${file}: raw colour ${match[0]}`);
    for (const match of css.matchAll(/font-size:\s*([^;{}]+)/g)) {
      const value = match[1]!.trim();
      const token = value.match(/^var\(--text-([\w]+)\)$/)?.[1];
      assert.ok((token && typeTokens.has(token)) || (/^\d+px$/.test(value) && sizes.has(Number.parseInt(value))), `${file}: off-scale font-size ${value}`);
    }
    for (const match of css.matchAll(/font:\s*([^;{}]+)/g)) {
      if (match[1]!.trim() === "inherit") continue;
      assert.match(match[1]!, /var\(--text-(xs|sm|ui|body|section|heading|display)\)/, `${file}: font shorthand must use a size token`);
    }
    for (const match of css.matchAll(/(?:width|height|padding|margin|gap|top|left|right|bottom):\s*([^;{}]+);/g)) {
      assert.doesNotMatch(match[1]!, /(?:^|\s)(?:[1-9]\d*)(?=\s|$|\))/, `${file}: nonzero length without a unit: ${match[0]}`);
    }
    for (const match of css.matchAll(/@media\s*\(([^)]+)\)/g)) {
      if (match[1]!.includes("width")) assert.match(match[1]!, /\b(640|900|1200)px\b/, `${file}: off-scale breakpoint`);
    }
  });
}

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const [light = "", dark = ""] = css.split(':root[data-theme="dark"]');
type Palette = Record<string, string>;
const parse = (s: string): Palette => Object.fromEntries(Array.from(s.matchAll(/(--[\w-]+):\s*([^;]+);/g), (m) => [m[1]!, m[2]!.trim()]));
const palettes = { light: parse(light), dark: { ...parse(light), ...parse(dark) } };
function luminance(name: string, palette: Palette): number {
  const value = palette[name];
  assert.ok(value, `Missing colour token ${name}`);
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) return luminance(ref[1]!, palette);
  assert.match(value, /^#[\da-f]{6}$/i);
  return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
}
const surfaces = ["paper", "panel", "card", "surface", "surface-2"];
for (const [theme, palette] of Object.entries(palettes)) {
  test(`${theme}: text >= 4.5:1 and control boundaries and focus >= 3:1`, () => {
    const check = (fg: string, bg: string, minimum: number) => {
      const a = luminance(`--${fg}`, palette);
      const b = luminance(`--${bg}`, palette);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      assert.ok(ratio >= minimum, `${theme} ${fg}/${bg}: ${ratio.toFixed(2)} < ${minimum}`);
    };
    for (const fg of ["ink", "ink-2", "muted", "faint"]) {
      for (const bg of [...surfaces, "green-bg", "amber-bg", "blue-bg", "red-bg"]) check(fg, bg, 4.5);
    }
    for (const status of ["green", "amber", "blue", "red"]) {
      const text = status === "green" ? "green-text" : status;
      for (const bg of [...surfaces, `${status}-bg`]) check(text, bg, 4.5);
      check(`${status}-line`, `${status}-bg`, 3);
    }
    for (const bg of surfaces) {
      check("line-2", bg, 3);
      check("focus", bg, 3);
      check("primary-line", bg, 3);
    }
    for (const bg of ["green", "green-2"]) check("white", bg, 4.5);
    check("card", "ink", 4.5);
    // Low-alpha --line/--raised-edge are decorative card rims and separators, not controls.
  });
}

test("reduced-motion wins over the toast, spinner and lazy screen rules", () => {
  const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const reduced = styles.slice(styles.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /animation:\s*none !important/);
  assert.match(reduced, /transition:\s*none !important/);
});
