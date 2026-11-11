import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

test("specialist pages, shell and navigation have no clock-framed product copy", () => {
  // Contract adapters and legacy route redirects intentionally retain their API names.
  const pages = readdirSync(new URL(".", import.meta.url))
    .filter((file) => /\.(tsx|css)$/.test(file) || file === "view.ts")
    .map((file) => new URL(file, import.meta.url));
  const files = [...pages, ...["shell.tsx", "nav.ts", "pages/HowWorkIsChecked.tsx", "pages/how-work-is-checked.css"].map(file => new URL(`../../${file}`, import.meta.url))];
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"),
    /\b(?:night|morning|overnight|tonight|slept|sleep)\b|while you were away|while you sleep|last 24 hours/i, file.pathname);
});

test("unavailable exams announce coming rather than readiness", () => {
  const source = readFileSync(new URL("./Exam.tsx", import.meta.url), "utf8");
  assert.match(source, /announce\(!available \? "Exam coming\."/);
});

test("House Record copy uses the projected House ID while ordinary exam labels stay unchanged", () => {
  const record = readFileSync(new URL("./AgentRecord.tsx",import.meta.url),"utf8");
  const board = readFileSync(new URL("./board.ts",import.meta.url),"utf8");
  assert.match(board,/HOUSE_AGENT_ID = "house-ts-fixer"/);
  assert.match(record,/const house = agent\.id === HOUSE_AGENT_ID;/);
  assert.match(record,/house \? "House agent\." : acquitted \? "Acquitted" : agent\.task !== "code" \? "Exam coming" : "Not acquitted"/);
  assert.match(record,/house \? "Run by Acquit; it does not sit the exam\." :/);
  assert.match(record,/house \? "Exam not sat" : agent\.grade === null \? "No grade yet" : "Grade"/);
});

test("the dedicated House Leaderboard row says House agent instead of Not ranked", () => {
  const board = readFileSync(new URL("./Leaderboard.tsx",import.meta.url),"utf8");
  assert.match(board,/specialists\.agent\(HOUSE_AGENT_ID\)/);
  assert.match(board,/rows\.house \? `Rank \$\{rows\.house\.rank\}` : "House agent"/);
  assert.doesNotMatch(board,/"Not ranked"/);
});
