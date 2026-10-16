import assert from "node:assert/strict";
import test from "node:test";
import type { Digest } from "../../core/src/ids.ts";
import { validateSpec } from "../src/spec.ts";

const DIGEST = "a".repeat(64) as Digest;

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		modelDigest: DIGEST,
		material: "PETG",
		color: { name: "black", hex: "#111111" },
		quantity: 4,
		toleranceMm: 0.3,
		infillPct: 20,
		walls: 3,
		maxLayerHeightMm: 0.2,
		printBy: "2026-10-30T12:00:00Z",
		deliverBy: "2026-11-02T12:00:00Z",
		...overrides,
	};
}

test("a complete spec validates and keeps its units", () => {
	const result = validateSpec(validInput());
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.material, "PETG");
	assert.equal(result.value.quantity, 4);
	assert.equal(result.value.toleranceMm, 0.3);
	assert.equal(result.value.maxLayerHeightMm, 0.2);
});

test("each refusal carries its literal reason", () => {
	const cases: [string, Record<string, unknown>, { path: string; message: string }][] = [
		["quantity 0", validInput({ quantity: 0 }), { path: "quantity", message: "quantity must be an integer from 1 to 10" }],
		["quantity 11", validInput({ quantity: 11 }), { path: "quantity", message: "quantity must be an integer from 1 to 10" }],
		["unknown material", validInput({ material: "NYLON" }), { path: "material", message: "unknown material" }],
		["inherited material name", validInput({ material: "toString" }), { path: "material", message: "unknown material" }],
		["tolerance 0", validInput({ toleranceMm: 0 }), { path: "toleranceMm", message: "tolerance must be greater than 0" }],
		["tolerance negative", validInput({ toleranceMm: -0.1 }), { path: "toleranceMm", message: "tolerance must be greater than 0" }],
		["infill -1", validInput({ infillPct: -1 }), { path: "infillPct", message: "infill must be between 0 and 100" }],
		["infill 101", validInput({ infillPct: 101 }), { path: "infillPct", message: "infill must be between 0 and 100" }],
		["missing printBy", validInput({ printBy: undefined }), { path: "printBy", message: "missing deadline" }],
		["malformed deliverBy", validInput({ deliverBy: "next week" }), { path: "deliverBy", message: "deadline must be a UTC instant" }],
	];
	for (const [name, input, expected] of cases) {
		const result = validateSpec(input);
		assert.deepEqual(result, { ok: false, errors: [expected] }, name);
	}
});

test("an unknown field is refused by name, not dropped", () => {
	const result = validateSpec(validInput({ budgetCents: 500 }));
	assert.deepEqual(result, { ok: false, errors: [{ path: "budgetCents", message: "unknown field" }] });
});

test("a non-object spec is refused at the empty path", () => {
	assert.deepEqual(validateSpec([]), { ok: false, errors: [{ path: "", message: "spec must be an object" }] });
});
