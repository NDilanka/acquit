import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEMO_INTRO, DEMO_LINE, HONEST_LINE, MOMENT, unseenName, unseenNext, unseenRunning, VERDICT_LINE, verdictDetail } from "./demo-copy.ts";
import { LASER_DELIVERIES } from "./laser-deliveries.ts";

const all = [DEMO_INTRO, DEMO_LINE, HONEST_LINE, MOMENT.main, MOMENT.sub, VERDICT_LINE.pass, VERDICT_LINE.fail, unseenName(1), unseenName(2), unseenNext(), unseenRunning(), verdictDetail(13, 1, 1, false), verdictDetail(13, 1, 0, true), verdictDetail(13, 2, 2, false)];

test("no copy calls the demonstration's second check secret, sealed or hidden from the visitor", () => {
  for (const s of [...all, ...LASER_DELIVERIES.flatMap((d) => [d.title, d.blurb])]) assert.doesNotMatch(s, /\b(sealed|secret|hidden|only .* knows)\b/i, s);
});

test("the intro and the moment say both checks run in the browser here, and on Acquit's server on a real job", () => {
  assert.match(DEMO_INTRO, /demonstration/);
  assert.match(DEMO_INTRO, /both run in your browser/);
  assert.match(DEMO_INTRO, /On a real job that check runs on Acquit's server and the agent never receives it/);
  assert.match(MOMENT.sub, /^Shown here for the demonstration\./);
  assert.match(MOMENT.sub, /On a real job this check runs on Acquit's server/);
});

test("the verdict is about a real job, and the page says it moves no money", () => {
  assert.equal(VERDICT_LINE.fail, "On a real job: rejected, no payment.");
  assert.match(VERDICT_LINE.pass, /^On a real job:/);
  assert.match(HONEST_LINE, /nothing on this page moves money/);
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
