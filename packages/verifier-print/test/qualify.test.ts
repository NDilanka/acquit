import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PASS_RULE } from "../src/catalog.ts";
import { certify, printQualification, qualifies } from "../src/qualify.ts";
import type { QualificationResult } from "../src/qualify.ts";
import { FARM_BED_MM, simFarm } from "../src/sim/farm.ts";
import { meshStats } from "../src/stl.ts";
import { newPrinterKeys } from "../src/telemetry.ts";
import type { Instant } from "../../core/src/ids.ts";

const SEED = new Uint8Array(createHash("sha256").update("qualify-test").digest());
const AT = "2026-10-23T09:00:00Z" as Instant;

test("the suite issues five hidden parts to fulfil and one trap to decline, the same for the same seed", async () => {
	const keys = newPrinterKeys();
	const first = await printQualification(keys.publicKey).challenges(SEED);
	const again = await printQualification(keys.publicKey).challenges(SEED);
	assert.deepEqual(first.map(challenge => challenge.expect), ["FULFIL", "FULFIL", "FULFIL", "FULFIL", "FULFIL", "DECLINE"]);
	assert.deepEqual(first.map(challenge => challenge.spec.label), again.map(challenge => challenge.spec.label));
	const trap = first[5];
	assert.equal(trap.id, "trap");
	const trapBox = meshStats(trap.spec.partStl);
	assert.ok(trapBox.ok && trapBox.value.sizeMm[0] > FARM_BED_MM.x, "the trap is wider than the bed");
});

test("an honest farm qualifies: its five parts verify and its trap is declined with a reason", async () => {
	const keys = newPrinterKeys();
	const suite = printQualification(keys.publicKey);
	const challenges = await suite.challenges(SEED);
	const farm = simFarm({ mode: "honest", id: "test printer", keys, seed: SEED });
	const results: QualificationResult[] = [];
	for (const challenge of challenges) results.push(await suite.grade(challenge, await farm.answer(challenge.spec)));
	assert.deepEqual(results.map(result => result.passed), [true, true, true, true, true, true], JSON.stringify(results));
	assert.equal(results[5].detail.startsWith("declined: "), true);
	const tally = qualifies(suite.passRule, challenges, results);
	assert.deepEqual(tally, { fulfilled: 5, declinedTraps: 1, qualified: true });
});

test("a sloppy farm that accepts the trap does not qualify, though it fulfils all five parts", async () => {
	const keys = newPrinterKeys();
	const suite = printQualification(keys.publicKey);
	const challenges = await suite.challenges(SEED);
	const farm = simFarm({ mode: "sloppy", id: "test printer", keys, seed: SEED });
	const results: QualificationResult[] = [];
	for (const challenge of challenges) results.push(await suite.grade(challenge, await farm.answer(challenge.spec)));
	assert.equal(results[5].passed, false);
	assert.equal(results[5].detail, "accepted a job it must decline");
	assert.deepEqual(qualifies(suite.passRule, challenges, results), { fulfilled: 5, declinedTraps: 0, qualified: false });
});

test("a trap passes only when the farm declines it with a reason", async () => {
	const suite = printQualification(newPrinterKeys().publicKey);
	const trap = (await suite.challenges(SEED))[5];
	assert.equal((await suite.grade(trap, [])).passed, false, "accepting with no evidence is not a decline");
	assert.equal((await suite.grade(trap, { declined: "   " })).passed, false, "a blank decline has no reason");
	assert.deepEqual(await suite.grade(trap, { declined: "too wide for the bed" }), { challenge: "trap", passed: true, detail: "declined: too wide for the bed" });
});

test("a fulfilled part fails when its farm declines it or sends no evidence", async () => {
	const suite = printQualification(newPrinterKeys().publicKey);
	const part = (await suite.challenges(SEED))[0];
	assert.equal((await suite.grade(part, { declined: "no bed" })).passed, false);
	assert.equal((await suite.grade(part, [])).passed, false);
});

test("the pass rule needs all five parts and the trap, and nothing less", async () => {
	const challenges = await printQualification(newPrinterKeys().publicKey).challenges(SEED);
	const passing = (id: string, passed: boolean): QualificationResult => ({ challenge: id, passed, detail: "" });
	const allPass = challenges.map(challenge => passing(challenge.id, true));
	assert.equal(qualifies(PASS_RULE, challenges, allPass).qualified, true);
	const fourParts = allPass.map(result => (result.challenge === "fulfil-1" ? passing("fulfil-1", false) : result));
	assert.equal(qualifies(PASS_RULE, challenges, fourParts).qualified, false);
	const noTrap = allPass.map(result => (result.challenge === "trap" ? passing("trap", false) : result));
	assert.deepEqual(qualifies(PASS_RULE, challenges, noTrap), { fulfilled: 5, declinedTraps: 0, qualified: false });
});

test("the certificate digests the same for the same inputs, and lapses 90 days after it is issued", () => {
	const one = certify({ seller: "Orbit Farm (Simulated)", fulfilled: 5, declinedTraps: 1, issuedAt: AT });
	const two = certify({ seller: "Orbit Farm (Simulated)", fulfilled: 5, declinedTraps: 1, issuedAt: AT });
	assert.equal(one.digest, two.digest);
	assert.equal(one.simulated, true);
	assert.equal(one.expiresAt, "2027-01-21T09:00:00Z");
	const other = certify({ seller: "Shady Farm (Simulated)", fulfilled: 5, declinedTraps: 1, issuedAt: AT });
	assert.notEqual(one.digest, other.digest);
});
