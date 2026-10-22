import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAUDS, PASS_RULE } from "../../../packages/verifier-print/src/catalog.ts";
import type { PrintChallengeView, PrintOutcomeView } from "./api-types.ts";
import { match } from "./route.ts";
import {
  challengeStatus,
  durationWords,
  evidenceRows,
  failureWords,
  farmDoingLine,
  farmHeading,
  HONEST_LIMIT,
  MONEY_LINE,
  PRINT_INTRO,
  printRefusalWords,
  QUALIFICATION_RULE,
  REAL_AND_SIMULATED,
  TRAP_NOTE,
  tallyLine,
  verdictView,
} from "./print-view.ts";

const outcome = (over: Partial<PrintOutcomeView>): PrintOutcomeView => ({
  job: { label: "Two 14 mm cubes, 25% infill", quantity: 2, infillPct: 25 },
  fraud: null,
  evidence: { layers: 40, filamentMm: 1044.9, estimatedS: 1255, telemetryFilamentMm: 1044.9, telemetryS: 1255, frames: 62, photos: 8 },
  verdict: "VERIFIED",
  reasons: [],
  ...over,
});

const challenge = (over: Partial<PrintChallengeView>): PrintChallengeView => ({ id: "fulfil-1", label: "cube 14 mm", expect: "FULFIL", passed: true, detail: "verified", ...over });

test("the catalog holds the ten frauds the picker offers, and the replay is the only known gap", () => {
  assert.equal(FRAUDS.length, 10);
  assert.deepEqual(FRAUDS.filter(item => item.knownGap).map(item => item.id), ["replay-same-file"]);
});

test("the pass rule is five parts and one trap, and a farm is headed Simulated", () => {
  assert.deepEqual(PASS_RULE, { fulfilled: 5, declinedTraps: 1 });
  assert.equal(farmHeading("Orbit Farm"), "Orbit Farm (Simulated)");
});

test("/print opens the print demo, with or without a trailing slash", () => {
  assert.deepEqual(match("/print"), { name: "print" });
  assert.deepEqual(match("/print/"), { name: "print" });
});

test("the page copy uses no em or en dashes, and the two honest lines are the brief's exact words", () => {
  const copy = [PRINT_INTRO, QUALIFICATION_RULE, TRAP_NOTE, HONEST_LIMIT, MONEY_LINE, ...REAL_AND_SIMULATED.map(item => item.text)];
  for (const line of copy) assert.doesNotMatch(line, /[\u2013\u2014]/);
  assert.equal(HONEST_LIMIT, "Software proves the G-code and the evidence, not the atoms.");
  assert.equal(MONEY_LINE, "Money: next. Print jobs do not move money yet.");
});

test("the tally says how many challenges and traps passed, and whether the farm printed", () => {
  assert.equal(tallyLine({ fulfilled: 5, declinedTraps: 1, qualified: true, challenges: [] }), "Fulfilled 5 of 5 challenges. Declined 1 of 1 trap. Qualified.");
  assert.equal(tallyLine({ fulfilled: 5, declinedTraps: 0, qualified: false, challenges: [] }), "Fulfilled 5 of 5 challenges. Declined 0 of 1 trap. Not qualified, so it did not print.");
});

test("a challenge reads as fulfilled or not passed, and a trap as declined or accepted", () => {
  assert.equal(challengeStatus(challenge({ passed: true })), "Fulfilled");
  assert.equal(challengeStatus(challenge({ passed: false, detail: "sent no evidence" })), "Not passed");
  assert.equal(challengeStatus(challenge({ id: "trap", expect: "DECLINE", passed: true, detail: "declined: too wide" })), "Declined");
  assert.equal(challengeStatus(challenge({ id: "trap", expect: "DECLINE", passed: false, detail: "accepted a job it must decline" })), "Accepted");
});

test("a verified print says so, and the replay names itself as the known gap", () => {
  assert.deepEqual(verdictView(outcome({})), { tone: "ok", title: "Verified", sentence: "The judge accepted this print." });
  const replay = verdictView(outcome({ fraud: { id: "replay-same-file", label: "Replays an earlier print of the same file", knownGap: true } }));
  assert.equal(replay.title, "Verified");
  assert.match(replay.sentence, /This fraud is the known gap: the judge matches only the file hash/);
});

test("a rejected print is refused in plain words", () => {
  assert.deepEqual(verdictView(outcome({ verdict: "REJECTED", reasons: [] })), { tone: "alert", title: "Rejected", sentence: "The judge refused this print, for the reasons below." });
});

test("an honest print says the farm printed what it submitted, and a fraud names what it ran", () => {
  assert.equal(farmDoingLine(outcome({})), "The farm printed what it submitted.");
  assert.equal(
    farmDoingLine(outcome({ fraud: { id: "skip-infill", label: "Skips the infill", knownGap: false } })),
    "The farm ran a planted fraud: skips the infill.",
  );
});

test("the evidence rows label the telemetry and the photos as Simulated, and time reads in minutes and seconds", () => {
  const rows = evidenceRows(outcome({}).evidence);
  assert.deepEqual(rows.map(row => row.label), [
    "Layers in the G-code",
    "Filament in the G-code",
    "Filament in the telemetry (Simulated)",
    "Time estimated from the G-code",
    "Time in the telemetry (Simulated)",
    "Telemetry frames (Simulated)",
    "Camera photos (Simulated)",
  ]);
  assert.equal(rows[3]?.value, "20 min 55 s");
  assert.equal(durationWords(45), "45 s");
  assert.equal(durationWords(3600), "60 min 0 s");
});

test("a refusal of a print run is in plain words, and an unknown code is left to the caller", () => {
  assert.equal(printRefusalWords("PRINT_BUSY"), "The print demo is busy with other runs. Try again in a minute.");
  assert.equal(printRefusalWords("SOMETHING_ELSE"), null);
});

test("a run that stopped without a result says whether it timed out", () => {
  assert.equal(failureWords("TIMED_OUT"), "The run passed its time limit and stopped. Start it again.");
  assert.equal(failureWords("RUN_FAILED"), "The run failed on the server. Start it again.");
});
