import assert from "node:assert/strict";
import test from "node:test";
import { validateSpec } from "../src/spec.ts";

const validSpec = (): Record<string, unknown> => ({
	material: "acrylic",
	thicknessMm: 3,
	bedMm: [300, 200],
	partMm: [120, 80],
	kerfMm: 0.2,
	toleranceMm: 0.1,
	minWebMm: 3,
	holes: [{ id: "mount-a", centreMm: [6, 6], diameterMm: 3.2 }],
	slots: [{ id: "window", sizeMm: [30, 12] }],
});

test("a complete spec reads into typed mm values", () => {
	const result = validateSpec(validSpec());
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.value.partMm, [120, 80]);
	assert.deepEqual(result.value.bedMm, [300, 200]);
	assert.equal(result.value.kerfMm, 0.2);
	assert.deepEqual(result.value.holes, [{ id: "mount-a", centreMm: [6, 6], diameterMm: 3.2 }]);
	assert.deepEqual(result.value.slots, [{ id: "window", sizeMm: [30, 12] }]);
});

test("a spec with no holes or slots is valid", () => {
	const result = validateSpec({ ...validSpec(), holes: [], slots: [] });
	assert.equal(result.ok, true);
});

test("a value that is not an object is refused at the root", () => {
	for (const input of [null, [], "spec", 3, undefined]) {
		const result = validateSpec(input);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.errors[0]?.path, "");
	}
});

test("an unknown field is refused, so a typo cannot silently drop a rule", () => {
	const result = validateSpec({ ...validSpec(), kerfMM: 0.2 });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.deepEqual(result.errors, [{ path: "kerfMM", message: "unknown field" }]);
});

test("an unknown field on a hole or a slot is refused", () => {
	const holes = validateSpec({ ...validSpec(), holes: [{ id: "mount-a", centreMm: [6, 6], diameterMm: 3.2, depth: 1 }] });
	assert.equal(holes.ok, false);
	if (!holes.ok) assert.ok(holes.errors.some(error => error.path === "holes[0].depth"));
	const slots = validateSpec({ ...validSpec(), slots: [{ id: "window", sizeMm: [30, 12], angle: 90 }] });
	assert.equal(slots.ok, false);
	if (!slots.ok) assert.ok(slots.errors.some(error => error.path === "slots[0].angle"));
});

test("each bad numeric or text field is refused at its own path", () => {
	const cases: [string, Record<string, unknown>, string][] = [
		["thicknessMm", { thicknessMm: 0 }, "thicknessMm"],
		["bedMm", { bedMm: [300] }, "bedMm"],
		["bedMm negative", { bedMm: [300, -1] }, "bedMm"],
		["partMm", { partMm: [0, 80] }, "partMm"],
		["kerfMm at 1", { kerfMm: 1 }, "kerfMm"],
		["kerfMm negative", { kerfMm: -0.1 }, "kerfMm"],
		["toleranceMm", { toleranceMm: 0 }, "toleranceMm"],
		["minWebMm", { minWebMm: Number.NaN }, "minWebMm"],
		["material", { material: " " }, "material"],
	];
	for (const [name, override, path] of cases) {
		const result = validateSpec({ ...validSpec(), ...override });
		assert.equal(result.ok, false, name);
		if (!result.ok) assert.ok(result.errors.some(error => error.path === path), name);
	}
});

test("a hole outside the part is refused", () => {
	const result = validateSpec({ ...validSpec(), holes: [{ id: "mount-a", centreMm: [121, 6], diameterMm: 3.2 }] });
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.errors.some(error => error.path === "holes[0].centreMm"));
});

test("an id used by a hole and a slot is refused", () => {
	const result = validateSpec({ ...validSpec(), slots: [{ id: "mount-a", sizeMm: [30, 12] }] });
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.errors.some(error => error.path === "slots[0].id"));
});

test("a hole with no diameter and a slot with no size are refused", () => {
	const hole = validateSpec({ ...validSpec(), holes: [{ id: "mount-a", centreMm: [6, 6], diameterMm: 0 }] });
	assert.equal(hole.ok, false);
	if (!hole.ok) assert.ok(hole.errors.some(error => error.path === "holes[0].diameterMm"));
	const slot = validateSpec({ ...validSpec(), slots: [{ id: "window", sizeMm: [0, 12] }] });
	assert.equal(slot.ok, false);
	if (!slot.ok) assert.ok(slot.errors.some(error => error.path === "slots[0].sizeMm"));
});

test("holes and slots must be lists", () => {
	const result = validateSpec({ ...validSpec(), holes: "mount-a", slots: {} });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.ok(result.errors.some(error => error.path === "holes"));
	assert.ok(result.errors.some(error => error.path === "slots"));
});

test("every error is reported, not only the first", () => {
	const result = validateSpec({ ...validSpec(), thicknessMm: 0, kerfMm: 2, toleranceMm: -1 });
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.errors.length >= 3);
});
