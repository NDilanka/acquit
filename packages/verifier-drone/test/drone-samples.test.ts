import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSamples, FRAUDS } from "../samples/build.ts";
import { HIDDEN_RULES, PUBLIC_RULES, parseSpec } from "../src/spec.ts";
import { verify } from "../src/verify.ts";
import { formatDroneScoreCard, tallyDrones } from "../src/score-card.ts";
import type { CaseResult } from "../src/score-card.ts";
import type { HiddenSample, Spec } from "../src/types.ts";

const SAMPLES = fileURLToPath(new URL("../samples/", import.meta.url));

function read(name: string): string {
	return readFileSync(`${SAMPLES}${name}`, "utf8");
}

function loadSpec(): Spec {
	const parsed = parseSpec(JSON.parse(read("orchard-survey.spec.json")));
	if (typeof parsed === "string") throw new Error(parsed);
	return parsed;
}

function loadHidden(): HiddenSample {
	return JSON.parse(read("orchard-survey.hidden.example.json")) as HiddenSample;
}

function failingRules(text: string, hidden: HiddenSample | undefined): string[] {
	return verify(loadSpec(), text, hidden)
		.findings.filter(item => !item.ok)
		.map(item => item.rule);
}

test("the shipped sample files are exactly what samples/build.ts generates", () => {
	for (const [name, text] of Object.entries(buildSamples())) assert.equal(read(name), text, name);
});

test("the honest survey passes every public rule and the hidden example", () => {
	const verdict = verify(loadSpec(), read("honest.plan"), loadHidden());
	assert.equal(verdict.pass, true, JSON.stringify(verdict.findings.filter(item => !item.ok)));
	assert.equal(verdict.workflow, "drone-survey");
	assert.equal(verdict.scene.units, "m");
});

test("without the hidden sample the hidden rules fail, so an unsupplied sample never passes", () => {
	const failed = failingRules(read("honest.plan"), undefined);
	for (const rule of HIDDEN_RULES) assert.ok(failed.includes(rule), `${rule} must fail without the hidden sample`);
	assert.equal(verify(loadSpec(), read("honest.plan"), undefined).pass, false);
});

test("each fraud fails exactly the one rule it is built to break, and the honest survey passes", () => {
	const hidden = loadHidden();
	const cheats: CaseResult[] = FRAUDS.map((fraud): CaseResult => ({
		id: fraud.file,
		kind: "cheat",
		intendedRule: fraud.rule,
		failedRules: failingRules(read(fraud.file), hidden),
	}));
	for (const cheat of cheats) assert.deepEqual(cheat.failedRules, [cheat.intendedRule], cheat.id);
	const honest: CaseResult = { id: "honest.plan", kind: "honest", intendedRule: null, failedRules: failingRules(read("honest.plan"), hidden) };
	const card = tallyDrones([...cheats, honest]);
	assert.deepEqual(card, { cheatsCaught: FRAUDS.length, cheatsTotal: FRAUDS.length, honestPassed: 1, honestTotal: 1 });
	assert.equal(
		formatDroneScoreCard(card),
		`DRONE SCORE CARD caught ${FRAUDS.length} of ${FRAUDS.length} known frauds, passed 1 of 1 honest surveys; the file is verified and the flight is Simulated`,
	);
});

test("score card counts only exact single-rule fraud catches", () => {
	const hidden = loadHidden();
	const exact: CaseResult[] = FRAUDS.map((fraud): CaseResult => ({
		id: fraud.file,
		kind: "cheat",
		intendedRule: fraud.rule,
		failedRules: failingRules(read(fraud.file), hidden),
	}));
	// A deliberate multi-rule control: the front-overlap fraud with a 1000-photograph hidden requirement also fails
	// hidden-checkpoint, so it is not an exact catch and the card must not count it as one.
	const control: CaseResult = {
		id: "control-multi-rule.plan",
		kind: "cheat",
		intendedRule: "front-overlap",
		failedRules: failingRules(read("fraud-trigger.plan"), { ...hidden, minPhotos: 1000 }),
	};
	assert.deepEqual(control.failedRules, ["front-overlap", "hidden-checkpoint"]);
	const honest: CaseResult = { id: "honest.plan", kind: "honest", intendedRule: null, failedRules: failingRules(read("honest.plan"), hidden) };
	const card = tallyDrones([...exact, control, honest]);
	assert.deepEqual(card, { cheatsCaught: FRAUDS.length, cheatsTotal: FRAUDS.length + 1, honestPassed: 1, honestTotal: 1 });
});

test("the hidden-checkpoint fraud passes every public rule, so only the hidden sample catches it", () => {
	const failed = failingRules(read("fraud-hidden-checkpoint.plan"), loadHidden());
	assert.deepEqual(
		failed.filter(rule => !(HIDDEN_RULES as readonly string[]).includes(rule)),
		[],
	);
	assert.deepEqual(failed, ["hidden-checkpoint"]);
	assert.equal((PUBLIC_RULES as readonly string[]).includes("hidden-checkpoint"), false);
});
