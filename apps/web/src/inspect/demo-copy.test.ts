import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEMO_INTRO, DEMO_LINE, HONEST_LINE, MOMENT, unseenName, unseenNext, unseenRunning, VERDICT_LINE, verdictDetail } from "./demo-copy.ts";
import { LASER_DELIVERIES } from "./laser-deliveries.ts";

const all = [DEMO_INTRO, DEMO_LINE, HONEST_LINE, MOMENT.main, MOMENT.sub, VERDICT_LINE.pass, VERDICT_LINE.fail, unseenName(1), unseenName(2), unseenNext(), unseenRunning(), verdictDetail(13, 1, 1, false), verdictDetail(13, 1, 0, true), verdictDetail(13, 2, 2, false)];
const copy = [...all, ...LASER_DELIVERIES.flatMap((d) => [d.title, d.blurb])];
const sentences = copy.flatMap((s) => s.split(/(?<=\.)\s+/));

test("no copy calls the demonstration's second check secret, sealed or hidden from the visitor", () => {
  for (const s of copy) assert.doesNotMatch(s, /\b(sealed|secret|only .* knows)\b|\bhidden\b(?! tests)/i, s);
});

test("hidden tests are only ever mentioned as part of paid code jobs", () => {
  for (const s of sentences.filter((s) => /\bhidden tests\b/i.test(s))) assert.match(s, /code jobs/, s);
});

test("no copy claims a laser check runs on a server or that this is a real job", () => {
  // Laser jobs are not paid work yet and no server runs the laser checker; only code jobs run checks on the server.
  for (const s of sentences) {
    assert.doesNotMatch(s, /On a real job|that check runs|this check runs|laser[^.]*server|server[^.]*laser/i, s);
    if (/\bserver\b/i.test(s)) assert.match(s, /code jobs/, s);
  }
});

test("the intro says both checks run in the browser and laser jobs are not paid work yet", () => {
  assert.match(DEMO_INTRO, /demonstration/);
  assert.match(DEMO_INTRO, /Both checks run in your browser/);
  assert.match(DEMO_INTRO, /Laser jobs are not paid work on Acquit yet/);
  assert.match(MOMENT.sub, /^Shown here for the demonstration\./);
});

test("the verdict says what would happen to this file, and the page says it moves no money", () => {
  assert.equal(VERDICT_LINE.pass, "This file would pass.");
  assert.equal(VERDICT_LINE.fail, "This file would be rejected. No payment would be released.");
  assert.match(HONEST_LINE, /The machine run is simulated, and nothing on this page moves money\./);
});

test("the inspector and the page take their words about the second check from this module", () => {
  const inspector = readFileSync(new URL("./Inspector.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("./InspectPage.tsx", import.meta.url), "utf8");
  // "sealed" alone is the timeline's phase name, never shown.
  const strings = [...inspector.matchAll(/"[^"\n]*\b[Ss]ealed\b[^"\n]*"/g)].map((m) => m[0]).filter((s) => s !== '"sealed"');
  assert.deepEqual(strings, [], "no user-facing string in Inspector.tsx says sealed");
  assert.match(inspector, /MOMENT\.sub/);
  assert.match(page, /DEMO_INTRO/);
});
