import assert from "node:assert/strict";
import test from "node:test";
import { formatPcbScoreCard, runPcbScoreCard } from "../src/score-card.ts";

// Each fraud breaks one named rule. A fraud is caught only when that rule fails and no other public rule does.
const FRAUD_CASES: readonly { id: string; rule: string }[] = [
	{ id: "fraud-01-unrouted-net", rule: "connected" },
	{ id: "fraud-02-shorted-nets", rule: "no-shorts" },
	{ id: "fraud-03-power-thin", rule: "power-width" },
	{ id: "fraud-04-clearance-0.1", rule: "clearance" },
	{ id: "fraud-05-via-drill", rule: "via-rules" },
	{ id: "fraud-06-outside-edge", rule: "inside-board" },
	{ id: "fraud-07-pad-moved", rule: "parts-placed" },
	{ id: "fraud-08-track-misses-pad", rule: "connected" },
	{ id: "fraud-09-wrong-pad-net", rule: "pad-nets" },
	{ id: "fraud-10-hidden-clearance", rule: "hidden-clearance" },
	{ id: "fraud-11-hidden-probe", rule: "hidden-probe" },
];

const card = runPcbScoreCard();

test("the honest status-light board passes every rule", () => {
	const honest = card.cases.find(c => c.kind === "honest");
	assert.ok(honest, "honest case present");
	assert.equal(honest.passed, true);
	assert.deepEqual(honest.failingPublic, []);
	assert.deepEqual(honest.failingHidden, []);
});

test("the score card covers exactly the bundled frauds", () => {
	const ids = card.cases.filter(c => c.kind === "fraud").map(c => c.id).sort();
	assert.deepEqual(ids, FRAUD_CASES.map(f => f.id).sort());
});

for (const item of FRAUD_CASES) {
	test(item.id, () => {
		const c = card.cases.find(x => x.id === item.id);
		assert.ok(c, "case present");
		assert.equal(c.intendedRule, item.rule);
		assert.ok(
			[...c.failingPublic, ...c.failingHidden].includes(item.rule),
			`${item.id} must fail ${item.rule}, failed ${[...c.failingPublic, ...c.failingHidden].join(", ")}`,
		);
		assert.equal(c.caught, true, `${item.id} must be caught only by ${item.rule}`);
	});
}

test("PCB score card tally", () => {
	const line = formatPcbScoreCard(card);
	console.log(line);
	assert.equal(card.honestPassed, card.honest);
	assert.equal(card.fraudsCaught, card.frauds);
	assert.equal(card.frauds, FRAUD_CASES.length);
	assert.ok(line.startsWith("PCB SCORE CARD caught "));
});
