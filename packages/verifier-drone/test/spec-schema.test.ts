// Step 1: the restored public schema, rule identifiers and hidden-sample schema. Rules that the later steps
// implement are not asserted here.

import assert from "node:assert/strict";
import test from "node:test";
import { HIDDEN_EXAMPLE, SPEC, buildSamples } from "../samples/build.ts";
import { HIDDEN_RULES, PUBLIC_RULES, parseHiddenSample, parseSpec } from "../src/spec.ts";
import { verify } from "../src/verify.ts";
import type { Verdict } from "../src/types.ts";

const HONEST = buildSamples()["honest.plan"]!;

function withSpec(patch: Record<string, unknown>): unknown {
	return { ...SPEC, ...patch };
}

function withCamera(patch: Record<string, unknown>): unknown {
	return { ...SPEC, camera: { ...SPEC.camera, ...patch } };
}

function refused(value: unknown): boolean {
	return typeof parseSpec(value) === "string";
}

function failed(verdict: Verdict): string[] {
	return verdict.findings.filter(item => !item.ok).map(item => item.rule);
}

test("spec parses with geographic area, zone heights and both image dimensions", () => {
	const parsed = parseSpec(SPEC);
	assert.equal(typeof parsed, "object", String(parsed));
	if (typeof parsed === "string") return;
	assert.equal(parsed.camera.imageHeightPx, 3648);
	assert.equal(parsed.camera.imageWidthPx, 5472);
	assert.equal(parsed.zones[0]!.heightM, 30);
	assert.equal(parsed.maxAltitudeM, 120);
	assert.equal(parsed.minAltitudeM, 20);
	assert.equal(parsed.geofenceMarginM, 5);
	assert.equal(parsed.enduranceS, 1800);
	assert.equal(parsed.reserveS, 300);
	for (const [lat, lon] of parsed.area) {
		assert.ok(Math.abs(lat - 51.5) < 0.01 && Math.abs(lon + 0.12) < 0.01, `${lat},${lon}`);
	}
});

test("the honest survey still passes every public and hidden rule under the restored schema", () => {
	const verdict = verify(SPEC, HONEST, HIDDEN_EXAMPLE);
	assert.equal(verdict.pass, true, JSON.stringify(failed(verdict)));
});

test("overlap fractions outside zero to one are rejected", () => {
	for (const value of [2, -1, 1.5]) {
		assert.equal(refused(withSpec({ minFrontOverlap: value })), true, `front ${value}`);
		assert.equal(refused(withSpec({ minSideOverlap: value })), true, `side ${value}`);
	}
});

test("fractional pixel dimensions are rejected", () => {
	assert.equal(refused(withCamera({ imageWidthPx: 0.5 })), true);
	assert.equal(refused(withCamera({ imageHeightPx: 0.5 })), true);
});

test("zero pixel width is rejected by schema validation, without throwing", () => {
	const spec = withCamera({ imageWidthPx: 0 });
	assert.equal(refused(spec), true);
	let verdict: Verdict | undefined;
	assert.doesNotThrow(() => {
		verdict = verify(spec, HONEST, HIDDEN_EXAMPLE);
	});
	assert.equal(verdict?.pass, false);
	assert.deepEqual(failed(verdict!), ["parse"]);
});

test("invalid spec origin is rejected before projection", () => {
	const spec = withSpec({ origin: [400, 1000] });
	assert.equal(refused(spec), true);
	const verdict = verify(spec, HONEST, HIDDEN_EXAMPLE);
	assert.equal(verdict.pass, false);
	assert.deepEqual(failed(verdict), ["parse"]);
});

test("missing spec area fails without throwing at the public boundary", () => {
	let verdict: Verdict | undefined;
	assert.doesNotThrow(() => {
		verdict = verify(withSpec({ area: undefined }), HONEST, HIDDEN_EXAMPLE);
	});
	assert.equal(verdict?.pass, false);
	assert.deepEqual(failed(verdict!), ["parse"]);
});

test("null hidden object fails without throwing", () => {
	let verdict: Verdict | undefined;
	assert.doesNotThrow(() => {
		verdict = verify(SPEC, HONEST, null);
	});
	assert.equal(verdict?.pass, false);
	assert.ok(failed(verdict!).includes("parse"));
});

test("missing hidden checkpoints fail without throwing", () => {
	let verdict: Verdict | undefined;
	assert.doesNotThrow(() => {
		verdict = verify(SPEC, HONEST, {});
	});
	assert.equal(verdict?.pass, false);
	assert.ok(failed(verdict!).includes("parse"));
});

test("null hidden checkpoints fail without throwing", () => {
	let verdict: Verdict | undefined;
	assert.doesNotThrow(() => {
		verdict = verify(SPEC, HONEST, { checkpoints: null, windMs: 0, cruiseToWindRatio: 1, minPhotos: 1 });
	});
	assert.equal(verdict?.pass, false);
	assert.ok(failed(verdict!).includes("parse"));
});

test("unsupplied hidden sample never produces a full passing verdict", () => {
	const verdict = verify(SPEC, HONEST);
	assert.equal(verdict.pass, false);
	assert.deepEqual(failed(verdict), [...HIDDEN_RULES]);
});

test("hidden minPhotos must be a whole number of at least one", () => {
	for (const minPhotos of [0, 1.5, -2, undefined, "3"]) {
		assert.equal(typeof parseHiddenSample({ ...HIDDEN_EXAMPLE, minPhotos }), "string", String(minPhotos));
	}
	assert.equal(typeof parseHiddenSample(HIDDEN_EXAMPLE), "object");
});

test("public rule identifiers are altitude-limits and ground-resolution", () => {
	assert.equal((PUBLIC_RULES as readonly string[]).includes("altitude-limits"), true);
	assert.equal((PUBLIC_RULES as readonly string[]).includes("ground-resolution"), true);
	assert.equal((PUBLIC_RULES as readonly string[]).includes("altitude-ceiling"), false);
	assert.equal((PUBLIC_RULES as readonly string[]).includes("gsd"), false);
	assert.deepEqual([...HIDDEN_RULES], ["hidden-checkpoint", "hidden-wind"]);
});

test("unknown, duplicate or incomplete rule lists are refused", () => {
	assert.equal(refused(withSpec({ rules: ["gsd"] })), true);
	assert.equal(refused(withSpec({ rules: PUBLIC_RULES.slice(1) })), true);
	assert.equal(refused(withSpec({ rules: [...PUBLIC_RULES, PUBLIC_RULES[0]] })), true);
	assert.equal(refused(withSpec({ rules: [...PUBLIC_RULES] })), false);
});

test("zone height must be a positive number", () => {
	const zone = SPEC.zones[0]!;
	assert.equal(refused(withSpec({ zones: [{ ...zone, heightM: 0 }] })), true);
	assert.equal(refused(withSpec({ zones: [{ id: zone.id, polygon: zone.polygon }] })), true);
});

test("minimum altitude must be positive and below the maximum", () => {
	assert.equal(refused(withSpec({ minAltitudeM: SPEC.maxAltitudeM })), true);
	assert.equal(refused(withSpec({ minAltitudeM: 0 })), true);
});

test("endurance reserve must be non-negative and below endurance", () => {
	assert.equal(refused(withSpec({ reserveS: SPEC.enduranceS })), true);
	assert.equal(refused(withSpec({ reserveS: -1 })), true);
	assert.equal(refused(withSpec({ enduranceS: 0 })), true);
});

test("geofence margin must be non-negative", () => {
	assert.equal(refused(withSpec({ geofenceMarginM: -1 })), true);
});

test("origin and polygon coordinates must be valid geographic values", () => {
	assert.equal(refused(withSpec({ origin: [91, 0] })), true);
	assert.equal(refused(withSpec({ area: [[51.5, -0.12], [51.5, 181], [51.6, -0.12]] })), true);
	const zone = SPEC.zones[0]!;
	assert.equal(refused(withSpec({ zones: [{ ...zone, polygon: [[NaN, 0], [51.5, 0], [51.6, 0]] }] })), true);
});

test("local metre polygons are refused where geographic points are required", () => {
	assert.equal(refused(withSpec({ area: [[0, 0], [100, 0], [100, 120], [0, 120]] })), true);
});
