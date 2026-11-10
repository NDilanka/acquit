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
	cornerRadiusMm: 0,
	labelRegionMm: { originMm: [8, 8], sizeMm: [44, 6] },
	minEngraveLengthMm: 20,
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
	assert.equal(result.value.cornerRadiusMm, 0);
	assert.deepEqual(result.value.labelRegionMm, { originMm: [8, 8], sizeMm: [44, 6] });
	assert.equal(result.value.minEngraveLengthMm, 20);
	assert.deepEqual(result.value.holes, [{ id: "mount-a", centreMm: [6, 6], diameterMm: 3.2, toleranceMm: 0.1 }]);
	assert.deepEqual(result.value.slots, [{ id: "window", sizeMm: [30, 12], toleranceMm: 0.1 }]);
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

test("a hole must lie wholly inside the part, not only its centre", () => {
	const edge = validateSpec({ ...validSpec(), holes: [{ id: "mount-a", centreMm: [1, 6], diameterMm: 3.2 }] });
	assert.equal(edge.ok, false);
	if (!edge.ok) assert.ok(edge.errors.some(error => error.path === "holes[0].centreMm"));
	const tooWide = validateSpec({ ...validSpec(), holes: [{ id: "mount-a", centreMm: [60, 40], diameterMm: 82 }] });
	assert.equal(tooWide.ok, false);
	if (!tooWide.ok) assert.ok(tooWide.errors.some(error => error.path === "holes[0].centreMm"));
	const inside = validateSpec({ ...validSpec(), holes: [{ id: "mount-a", centreMm: [3, 6], diameterMm: 3.2 }] });
	assert.equal(inside.ok, true);
});

test("a slot must fit inside the part at its finished size", () => {
	const wide = validateSpec({ ...validSpec(), slots: [{ id: "window", sizeMm: [120, 12] }] });
	assert.equal(wide.ok, false);
	if (!wide.ok) assert.ok(wide.errors.some(error => error.path === "slots[0].sizeMm"));
	const tall = validateSpec({ ...validSpec(), slots: [{ id: "window", sizeMm: [30, 80] }] });
	assert.equal(tall.ok, false);
	if (!tall.ok) assert.ok(tall.errors.some(error => error.path === "slots[0].sizeMm"));
	const fits = validateSpec({ ...validSpec(), slots: [{ id: "window", sizeMm: [30, 12] }] });
	assert.equal(fits.ok, true);
});

test("a corner radius is required; zero means square corners", () => {
	const absent = { ...validSpec() };
	delete absent.cornerRadiusMm;
	const missing = validateSpec(absent);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.ok(missing.errors.some(error => error.path === "cornerRadiusMm"));
	const square = validateSpec({ ...validSpec(), cornerRadiusMm: 0 });
	assert.equal(square.ok, true);
	const rounded = validateSpec({ ...validSpec(), cornerRadiusMm: 39.9 });
	assert.equal(rounded.ok, true);
	for (const radius of [-1, Number.NaN, "3", 40, 45]) {
		const result = validateSpec({ ...validSpec(), cornerRadiusMm: radius });
		assert.equal(result.ok, false, String(radius));
		if (!result.ok) assert.ok(result.errors.some(error => error.path === "cornerRadiusMm"), String(radius));
	}
});

test("the engraving label region is required and must lie inside the part", () => {
	const absent = { ...validSpec() };
	delete absent.labelRegionMm;
	const missing = validateSpec(absent);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.ok(missing.errors.some(error => error.path === "labelRegionMm"));
	const cases: [string, unknown][] = [
		["outside the part", { originMm: [110, 8], sizeMm: [20, 6] }],
		["zero size", { originMm: [8, 8], sizeMm: [0, 6] }],
		["negative origin", { originMm: [-1, 8], sizeMm: [44, 6] }],
		["not a rectangle", [8, 8, 44, 6]],
		["unknown field", { originMm: [8, 8], sizeMm: [44, 6], colour: "blue" }],
	];
	for (const [name, region] of cases) {
		const result = validateSpec({ ...validSpec(), labelRegionMm: region });
		assert.equal(result.ok, false, name);
		if (!result.ok) assert.ok(result.errors.some(error => error.path.startsWith("labelRegionMm")), name);
	}
});

test("the minimum engraved length is required and must be greater than 0 mm", () => {
	const absent = { ...validSpec() };
	delete absent.minEngraveLengthMm;
	const missing = validateSpec(absent);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.ok(missing.errors.some(error => error.path === "minEngraveLengthMm"));
	for (const length of [0, -5, Number.NaN, "20"]) {
		const result = validateSpec({ ...validSpec(), minEngraveLengthMm: length });
		assert.equal(result.ok, false, String(length));
		if (!result.ok) assert.ok(result.errors.some(error => error.path === "minEngraveLengthMm"), String(length));
	}
});

test("a hole or a slot may set its own tolerance, falling back to the global one", () => {
	const result = validateSpec({
		...validSpec(),
		holes: [
			{ id: "mount-a", centreMm: [6, 6], diameterMm: 3.2, toleranceMm: 0.05 },
			{ id: "mount-b", centreMm: [114, 6], diameterMm: 3.2 },
		],
		slots: [{ id: "window", sizeMm: [30, 12], toleranceMm: 0.3 }],
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.holes[0]?.toleranceMm, 0.05);
	assert.equal(result.value.holes[1]?.toleranceMm, 0.1);
	assert.equal(result.value.slots[0]?.toleranceMm, 0.3);
});

test("a feature tolerance that is not positive is refused", () => {
	const hole = validateSpec({ ...validSpec(), holes: [{ id: "mount-a", centreMm: [6, 6], diameterMm: 3.2, toleranceMm: 0 }] });
	assert.equal(hole.ok, false);
	if (!hole.ok) assert.ok(hole.errors.some(error => error.path === "holes[0].toleranceMm"));
	const slot = validateSpec({ ...validSpec(), slots: [{ id: "window", sizeMm: [30, 12], toleranceMm: -0.1 }] });
	assert.equal(slot.ok, false);
	if (!slot.ok) assert.ok(slot.errors.some(error => error.path === "slots[0].toleranceMm"));
});

test("a tolerance under 0.04 mm, twice the flattening error, is refused and never raised to a floor", () => {
	const global = validateSpec({ ...validSpec(), toleranceMm: 0.039 });
	assert.equal(global.ok, false);
	if (!global.ok) assert.ok(global.errors.some(error => error.path === "toleranceMm"));
	const hole = validateSpec({ ...validSpec(), holes: [{ id: "mount-a", centreMm: [6, 6], diameterMm: 3.2, toleranceMm: 0.001 }] });
	assert.equal(hole.ok, false);
	if (!hole.ok) assert.ok(hole.errors.some(error => error.path === "holes[0].toleranceMm"));
	const slot = validateSpec({ ...validSpec(), slots: [{ id: "window", sizeMm: [30, 12], toleranceMm: 0.039 }] });
	assert.equal(slot.ok, false);
	if (!slot.ok) assert.ok(slot.errors.some(error => error.path === "slots[0].toleranceMm"));
	const atMinimum = validateSpec({ ...validSpec(), toleranceMm: 0.04 });
	assert.equal(atMinimum.ok, true);
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
