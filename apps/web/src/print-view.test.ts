import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAUDS, PASS_RULE } from "../../../packages/verifier-print/src/catalog.ts";
import type { PrintChallengeView, PrintLayerView, PrintOutcomeView, PrintReceiptView, PrintTimelineView } from "./api-types.ts";
import { match } from "./route.ts";
import {
  browserDigestWords,
  browserHiddenDigest,
  canonicalJson,
  challengeStatus,
  checkDigestInBrowser,
  distanceWords,
  durationWords,
  evidenceRows,
  failureWords,
  farmDoingLine,
  farmHeading,
  fulfilmentWords,
  HONEST_LIMIT,
  layerFlag,
  MONEY_LINE,
  overlapWords,
  PRINT_INTRO,
  printRefusalWords,
  QUALIFICATION_RULE,
  REAL_AND_SIMULATED,
  serverDigestWords,
  TRAP_NOTE,
  tallyLine,
  trapWords,
  verdictView,
} from "./print-view.ts";

// The honest run's reveal for seed 7 and the digests it commits to, checked outside the verifier (see print-record.test.ts).
const SAMPLED = [2, 18, 27, 30, 31, 32, 37, 40];
const REVEAL = { hidden: { sampleLayers: SAMPLED }, salt: "a00cc48230e123bde90b3d7a002ad38da7b6f4c74987873ad0e3ff90cc15eaf0" };
const HIDDEN_DIGEST = "537ea60d733f73891bc22e0409d7cb6bdf35cae7cbda046ce6221c42f1334bea";

const image = { cols: 1, rows: 1, png: "" };
const layer = (over: Partial<PrintLayerView>): PrintLayerView => ({ layer: 2, heightMm: 0.3, readable: true, iou: 0.998, fingerprint: "0000000000000000", distance: null, pass: true, reference: image, photo: image, ...over });
const timeline = (layers: readonly PrintLayerView[]): PrintTimelineView => ({ imageScale: 4, iouMin: 0.9, reuseMaxDistance: 4, layers });

const receipt = (over: Partial<PrintReceiptView>): PrintReceiptView => ({
  jobId: "job_print_demo",
  contractDigest: "0".repeat(64),
  hiddenDigest: HIDDEN_DIGEST,
  reveal: REVEAL,
  digestMatches: true,
  gcodeSha256: "1".repeat(64),
  telemetry: { frames: 62, chainHead: "2".repeat(64), printerKeySha256: "3".repeat(64) },
  certificateDigest: "4".repeat(64),
  verdict: "VERIFIED",
  reasonKinds: [],
  openedAt: "2026-10-23T09:00:00Z",
  ...over,
});

const outcome = (over: Partial<PrintOutcomeView>): PrintOutcomeView => ({
  job: { label: "Two 14 mm cubes, 25% infill", quantity: 2, infillPct: 25, toleranceMm: 0.2, layerHeightMm: 0.2, layerCount: 40, markerId: 14175 },
  fraud: null,
  evidence: { layers: 40, filamentMm: 1044.9, estimatedS: 1255, telemetryFilamentMm: 1044.9, telemetryS: 1255, frames: 62, photos: 8 },
  verdict: "VERIFIED",
  reasons: [],
  timeline: timeline([]),
  receipt: receipt({}),
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
  assert.equal(printRefusalWords("PRINT_BUSY"), "The print verifier is busy with other runs. Try again in a minute.");
  assert.equal(printRefusalWords("SOMETHING_ELSE"), null);
});

test("a layer that passes shows its overlap beside the mark, and a shifted or reused layer carries a plain flag", () => {
  const view = timeline([]);
  assert.equal(overlapWords(0.99767, 0.9), "Overlap 0.998 with the contract section. The pass mark is 0.900 or more.");
  assert.equal(layerFlag(layer({}), view), null);
  assert.equal(layerFlag(layer({ iou: 0.8123, pass: false }), view), "Shifted or wrong layer: the overlap is below the 0.90 pass mark.");
  assert.equal(layerFlag(layer({ distance: 2, pass: false }), view), "Matches an earlier job's photo, distance 2.");
  assert.equal(layerFlag(layer({ distance: 5 }), view), null, "a distance past the reuse limit is no flag");
  assert.equal(layerFlag(layer({ readable: false, iou: 0, pass: false }), view), "The photo cannot be read against the contract, so the judge could not measure its overlap.");
  assert.equal(distanceWords(null), "No earlier photo was sent with this print.");
  assert.equal(distanceWords(3), "Nearest earlier photo: distance 3.");
});

test("the trap reads as declined with the farm's reason, and the certificate counts the fulfilled challenges", () => {
  assert.equal(trapWords(challenge({ id: "trap", expect: "DECLINE", passed: true, detail: "declined: 300 mm is wider than the bed" })), "Declined. Reason: 300 mm is wider than the bed");
  assert.equal(trapWords(challenge({ id: "trap", expect: "DECLINE", passed: false, detail: "accepted a job it must decline" })), "Accepted. A farm must decline this job to qualify.");
  assert.equal(fulfilmentWords(5), "5 of 5 challenges fulfilled");
});

test("the browser's canonical JSON sorts keys by code unit, the same rule the server digests by", () => {
  assert.equal(canonicalJson({ salt: "s", hidden: { sampleLayers: [2, 18] } }), '{"hidden":{"sampleLayers":[2,18]},"salt":"s"}');
});

// The server's recompute of this reveal is pinned to the same literal in print-record.test.ts, so the two sides agree.
test("the browser's WebCrypto digest of the reveal equals the committed digest the server pins", async () => {
  assert.equal(await browserHiddenDigest(REVEAL), HIDDEN_DIGEST);
  assert.equal(await checkDigestInBrowser(receipt({})), "match");
});

test("a reveal with one sampled layer altered is a mismatch in the browser too", async () => {
  const altered = receipt({ reveal: { hidden: { sampleLayers: SAMPLED.map(item => (item === 40 ? 41 : item)) }, salt: REVEAL.salt } });
  assert.equal(await browserHiddenDigest(altered.reveal), "8a0674873f0c8719f4cd0e9b6aabdf88876d385bcb653767c0bd79b81c57d296");
  assert.equal(await checkDigestInBrowser(altered), "mismatch");
  assert.equal(browserDigestWords("mismatch"), "Recomputed in your browser with WebCrypto: the reveal does not match the digest committed at open.");
});

test("the digest check says when the browser cannot run it, and the server's check stands alone", () => {
  assert.equal(browserDigestWords("unavailable"), "This page has no WebCrypto here (it needs a secure origin), so only the server's check is shown.");
  assert.equal(serverDigestWords(true), "The server's check matches the digest committed at open.");
  assert.equal(browserDigestWords("pending"), "Checking the digest in your browser.");
});

test("the copy for the new blocks uses no em or en dashes", () => {
  const copy = [trapWords(challenge({ id: "trap", expect: "DECLINE", passed: true, detail: "declined: too wide" })), fulfilmentWords(5), overlapWords(0.5, 0.9), serverDigestWords(false), browserDigestWords("mismatch"), browserDigestWords("unavailable")];
  for (const line of copy) assert.doesNotMatch(line, /[\u2013\u2014]/);
});

test("a run that ended without a result says whether it timed out, and never says a timed-out run is free to restart", () => {
  const timedOut = failureWords("TIMED_OUT");
  assert.equal(timedOut, "The run passed its time limit, so the server ended it. It still counts against the server's limits until its work has stopped, so a new run may be refused for a moment.");
  assert.doesNotMatch(timedOut, /Start it again|and stopped\./);
  assert.equal(failureWords("RUN_FAILED"), "The run failed on the server. Start it again.");
});
