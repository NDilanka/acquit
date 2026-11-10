import assert from "node:assert/strict";
import test from "node:test";
import { buildSamples } from "../samples/build.ts";
import { pointInPolygon, segmentHitsPolygon, toLatLon, toLocal } from "../src/geo.ts";
import { acrossM, alongM, gsdCm, verify } from "../src/verify.ts";
import { parsePlan } from "../src/plan.ts";
import { parseSpec } from "../src/spec.ts";
import type { Camera, Spec } from "../src/types.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CAMERA: Camera = { sensorWidthMm: 13.2, sensorHeightMm: 8.8, focalMm: 8.8, imageWidthPx: 5472 };
const ORIGIN: [number, number] = [51.5, -0.12];
const SAMPLES = fileURLToPath(new URL("../samples/", import.meta.url));

function loadSpec(): Spec {
	const parsed = parseSpec(JSON.parse(readFileSync(`${SAMPLES}orchard-survey.spec.json`, "utf8")));
	if (typeof parsed === "string") throw new Error(parsed);
	return parsed;
}

test("local metres and latitude longitude round trip within a millimetre", () => {
	const [lat, lon] = toLatLon(ORIGIN, 75, -30);
	const [x, y] = toLocal(ORIGIN, lat, lon);
	assert.ok(Math.abs(x - 75) < 0.001);
	assert.ok(Math.abs(y + 30) < 0.001);
});

test("a point inside the zone is found and a point outside is not", () => {
	const zone = [
		[60, 38],
		[70, 38],
		[70, 42],
		[60, 42],
	] as const;
	assert.equal(pointInPolygon([65, 40], zone), true);
	assert.equal(pointInPolygon([50, 40], zone), false);
});

test("a segment that crosses a zone edge without ending inside still counts", () => {
	const zone = [
		[60, 38],
		[70, 38],
		[70, 42],
		[60, 42],
	] as const;
	assert.equal(segmentHitsPolygon([50, 40], [80, 40], zone), true);
	assert.equal(segmentHitsPolygon([120, 30], [120, 50], zone), false);
	assert.equal(segmentHitsPolygon([120, 30], [65, 40], zone), true);
});

test("a 40 m survey gives 1.0965 cm per pixel, 60 m across track and 40 m along track", () => {
	assert.ok(Math.abs(gsdCm(40, CAMERA) - 1.0965) < 0.0005);
	assert.ok(Math.abs(acrossM(40, CAMERA) - 60) < 1e-9);
	assert.ok(Math.abs(alongM(40, CAMERA) - 40) < 1e-9);
});

test("the honest plan parses to ten waypoints, a 10 m trigger and a 14 m/s cruise", () => {
	const plan = parsePlan(buildSamples()["honest.plan"]!, ORIGIN);
	assert.equal(typeof plan, "object");
	if (typeof plan === "string") return;
	assert.equal(plan.waypoints.length, 10);
	assert.equal(plan.triggerM, 10);
	assert.equal(plan.cruiseMs, 14);
	assert.ok(Math.abs(plan.waypoints[0]!.x + 20) < 0.05);
	assert.ok(Math.abs(plan.waypoints[0]!.y - 30) < 0.05);
});

test("a plan with no camera trigger is refused with the reason, not thrown", () => {
	const text = JSON.stringify({ fileType: "Plan", mission: { cruiseSpeed: 14, items: [{ type: "SimpleItem", command: 16, params: [0, 0, 0, 0, 51.5, -0.12, 40] }] } });
	const plan = parsePlan(text, ORIGIN);
	assert.equal(typeof plan, "string");
	assert.match(String(plan), /trigger distance/);
});

test("garbage input never throws and fails the parse rule only", () => {
	const spec = loadSpec();
	const inputs = ["", "null", "[]", "{", "{\"fileType\":\"Plan\"}", "{\"fileType\":\"Plan\",\"mission\":{\"cruiseSpeed\":-1,\"items\":[]}}"];
	for (const input of inputs) {
		const verdict = verify(spec, input);
		assert.equal(verdict.pass, false, input);
		assert.deepEqual(
			verdict.findings.filter(item => !item.ok).map(item => item.rule),
			["parse"],
			input,
		);
	}
});

test("a spec with a wrong rule name or a missing camera is refused", () => {
	const base = JSON.parse(readFileSync(`${SAMPLES}orchard-survey.spec.json`, "utf8")) as Record<string, unknown>;
	assert.equal(typeof parseSpec({ ...base, rules: ["made-up"] }), "string");
	assert.equal(typeof parseSpec({ ...base, camera: undefined }), "string");
});

test("the honest verdict reports the overlap and resolution it measured", () => {
	const verdict = verify(loadSpec(), buildSamples()["honest.plan"]!, { checkpoints: [], windMs: 0, cruiseToWindRatio: 1, minPhotos: 1 });
	assert.ok(Math.abs(Number(verdict.measured.frontOverlap) - 0.75) < 1e-9);
	assert.ok(Math.abs(Number(verdict.measured.sideOverlap) - 2 / 3) < 0.001);
	assert.ok(Math.abs(Number(verdict.measured.maxGsdCm) - 1.0965) < 0.0005);
	assert.equal(verdict.measured.surveyLines, 5);
	assert.equal(verdict.measured.uncoveredSamples, 0);
	assert.equal(verdict.measured.sceneUnit, "m");
});
