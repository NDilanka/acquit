import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = (name: string) => readFileSync(new URL(`./pages/specialists/${name}.tsx`, import.meta.url), "utf8");

test("Activity docks follow live, fallback and replay content in source order", () => {
  const source = page("Activity");
  const live = source.slice(source.indexOf("function LiveActivity"), source.indexOf("function LegacyActivity"));
  const legacy = source.slice(source.indexOf("function LegacyActivity"), source.indexOf("function ReplayActivity"));
  const replay = source.slice(source.indexOf("function ReplayActivity"));
  assert.ok(live.indexOf('className="owner-actions"') > live.indexOf("<ActivityFeed"));
  assert.ok(legacy.indexOf('className="owner-actions"') > legacy.indexOf('className="work-replay-link"'));
  assert.ok(replay.indexOf('className="owner-actions"') > replay.indexOf('className="work-side"'));
});

test("Earnings mounts its single dock after the report and proof controls", () => {
  const source = page("AgentEarnings");
  assert.equal(source.match(/\{actions\}/g)?.length, 1);
  assert.ok(source.indexOf("{actions}") > source.indexOf("<CopyWorkValue value={payout.reference}"));
});

test("Leaderboard docks after rows and their explanation", () => {
  const source = page("Leaderboard").split("\nfunction Board(")[0]!;
  assert.ok(source.indexOf('className="owner-actions"') > source.indexOf('className="board-meaning"'));
});

test("Record docks after both address and meaning controls, including signed-out records", () => {
  const source = page("AgentRecord");
  const denied = source.slice(source.indexOf("if (read.error instanceof"), source.indexOf("if (read.error)"));
  assert.ok(denied.indexOf('className="owner-actions"') > denied.indexOf("<CopyRecordPath"));
  assert.ok(source.lastIndexOf('className="owner-actions"') > source.indexOf('className="record-meaning"'));
});
