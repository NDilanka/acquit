import assert from "node:assert/strict";
import { test } from "node:test";
import { match } from "./route.ts";
import { milestoneLine, PAGE_INTRO, scoreLines, VERIFIER_ROWS, type VerifierRow } from "./verifiers-view.ts";

function rowTitled(title: string): VerifierRow {
  const found = VERIFIER_ROWS.find((row) => row.title === title);
  assert.ok(found, `a row titled ${title}`);
  return found;
}

function linesOf(row: VerifierRow): readonly string[] {
  assert.ok(row.scoreCard && row.scoreWords, `${row.title} has a score card`);
  return scoreLines(row.scoreCard, row.scoreWords);
}

test("the registry lists every verifier in display order", () => {
  assert.deepEqual(VERIFIER_ROWS.map((row) => row.title), [
    "Code",
    "3D printing (FDM)",
    "Rendering",
    "Video captions",
    "Translation",
    "Data labeling",
  ]);
});

test("the code row is Live and reads 11 of 11 cheats and 20 of 20 honest submissions", () => {
  const code = rowTitled("Code");
  assert.equal(code.status, "Live");
  assert.equal(code.version, "1.0.0");
  assert.deepEqual(code.scoreCard, { cheatsCaught: 11, cheatsTotal: 11, honestPassed: 20, honestTotal: 20, gaps: [] });
  assert.deepEqual(linesOf(code), [
    "Caught 11 of 11 known cheats. Passed 20 of 20 honest submissions.",
    "No known gaps.",
  ]);
  assert.deepEqual(code.milestones.map(milestoneLine), ["Verified pull request releases 100% of the price."]);
  assert.equal(code.simulatedNote, null);
});

test("the print row reads 11 of 12 frauds and 22 of 22 honest prints, names replay-same-file, and is not Live", () => {
  const print = rowTitled("3D printing (FDM)");
  assert.equal(print.status, "Judge built, not open for jobs");
  assert.notEqual(print.status, "Live");
  assert.deepEqual(print.scoreCard, { cheatsCaught: 11, cheatsTotal: 12, honestPassed: 22, honestTotal: 22, gaps: ["replay-same-file"] });
  assert.deepEqual(linesOf(print), [
    "Caught 11 of 12 known frauds. Passed 22 of 22 honest prints.",
    "Known gaps: replay-same-file.",
  ]);
  assert.equal(print.simulatedNote, "Telemetry and photos are Simulated. Software proves the G-code and the evidence, not the atoms.");
});

test("every Next row names its hidden check and carries no score card", () => {
  const next = VERIFIER_ROWS.filter((row) => row.status === "Next");
  assert.deepEqual(next.map((row) => [row.title, row.hiddenCheck]), [
    ["Rendering", "A hidden frame is re-rendered and compared with the seller's frame."],
    ["Video captions", "Caption-sync probes run at hidden timestamps."],
    ["Translation", "Back-translation probes run on hidden sentences."],
    ["Data labeling", "Hidden gold items are mixed into the batch."],
  ]);
  for (const row of next) assert.equal(row.scoreCard, null, row.title);
});

test("the page copy uses no em or en dashes and says each score card comes from a CI run", () => {
  const copy = [PAGE_INTRO, ...VERIFIER_ROWS.flatMap((row) => [row.scoreNote, row.simulatedNote, row.hiddenCheck])];
  for (const line of copy) {
    if (line !== null) assert.doesNotMatch(line, /[\u2013\u2014]/);
  }
  assert.match(PAGE_INTRO, /Each score card below comes from a CI test run\./);
});

test("/verifiers opens the registry, with or without a trailing slash", () => {
  assert.deepEqual(match("/verifiers"), { name: "verifiers" });
  assert.deepEqual(match("/verifiers/"), { name: "verifiers" });
});
