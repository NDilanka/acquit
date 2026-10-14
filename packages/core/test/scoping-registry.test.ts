// The registry fields AI scoping reads: each fixture's trusted fix commit (filter 3's second
// phase) and its per-currency-family coverage gate. Optional fields: a registry without them
// parses exactly as before, and a malformed one refuses by field name.

import assert from "node:assert/strict";
import test from "node:test";
import { parseFixtureRegistry } from "../src/fixtures.ts";

const base = {
	repository: "maya-client/invoice-app",
	issue: { number: 12, title: "Totals round wrong for 3-decimal currencies" },
	frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4",
	frozenTestPath: "tests/totals.test.ts",
	visible: 48,
	hidden: 6,
	hiddenIdPrefix: "hidden",
	protectedPaths: ["tests/**"],
	hiddenCases: "hidden-cases.example.json",
	frozenExtractor: "invoice-totals",
};

const registryWith = (entry: Record<string, unknown>): string => JSON.stringify({ version: 1, fixtures: [{ ...base, ...entry }] });

test("a registry without the scoping fields parses exactly as before", () => {
	const entries = parseFixtureRegistry(JSON.stringify({ version: 1, fixtures: [base] }), "registry.json");
	assert.equal(entries.length, 1);
	assert.equal(entries[0].trustedFix, undefined);
	assert.equal(entries[0].coverageFamilies, undefined);
});

test("a fixture may name its trusted fix commit and its currency families", () => {
	const entries = parseFixtureRegistry(registryWith({
		trustedFix: "5cccb66515313caed72e4af329a62fc011139426",
		coverageFamilies: [
			{ name: "zero-decimal", currencies: ["JPY", "KRW"] },
			{ name: "three-decimal", currencies: ["BHD", "KWD", "TND"] },
		],
	}), "registry.json");
	assert.equal(entries[0].trustedFix, "5cccb66515313caed72e4af329a62fc011139426");
	assert.deepEqual(entries[0].coverageFamilies, [
		{ name: "zero-decimal", currencies: ["JPY", "KRW"] },
		{ name: "three-decimal", currencies: ["BHD", "KWD", "TND"] },
	]);
});

test("a malformed trusted fix or coverage family refuses by name", () => {
	assert.throws(() => parseFixtureRegistry(registryWith({ trustedFix: "not-a-commit" }), "registry.json"), /trustedFix/);
	assert.throws(() => parseFixtureRegistry(registryWith({ coverageFamilies: [{ name: "zero-decimal", currencies: [] }] }), "registry.json"), /currencies/);
	assert.throws(() => parseFixtureRegistry(registryWith({ coverageFamilies: [{ currencies: ["JPY"] }] }), "registry.json"), /name/);
});
