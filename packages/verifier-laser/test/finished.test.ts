import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../src/spec.ts";
import type { Finding, HiddenSample, Spec } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const sample = (name: string): string => readFileSync(fileURLToPath(new URL(`../samples/${name}`, import.meta.url)), "utf8");

const specResult = validateSpec(JSON.parse(sample("enclosure-panel.spec.json")));
if (!specResult.ok) throw new Error(JSON.stringify(specResult.errors));
const spec: Spec = specResult.value;

// The finished part is the outer cut shrunk by kerf/2 and each inner void grown by kerf/2 from its drawn cut.
// So the outer cut is 120.2 x 80.2 for a 120 x 80 part, and each hole is drawn 3.0 mm for a 3.2 mm finished hole.
const COMPENSATED = `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200">
  <circle id="mount-a" cx="16.1" cy="84.1" r="1.5" stroke="#ff0000" fill="none"/>
  <circle id="mount-b" cx="124.1" cy="84.1" r="1.5" stroke="#ff0000" fill="none"/>
  <circle id="mount-c" cx="16.1" cy="16.1" r="1.5" stroke="#ff0000" fill="none"/>
  <circle id="mount-d" cx="124.1" cy="16.1" r="1.5" stroke="#ff0000" fill="none"/>
  <rect id="window" x="55.2" y="44.2" width="29.8" height="11.8" stroke="#ff0000" fill="none"/>
  <path id="label" d="M20 80.2 H60" stroke="#0000ff" fill="none"/>
  <path id="outline" d="M10 10 H130.2 V90.2 H10 Z" stroke="#ff0000" fill="none"/>
</svg>`;

// The drawing with finished sizes, as the first version of the sample had it: no kerf allowance on inner cuts.
const UNCOMPENSATED = `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200">
  <circle id="mount-a" cx="16" cy="84.2" r="1.6" stroke="#ff0000" fill="none"/>
  <circle id="mount-b" cx="124" cy="84.2" r="1.6" stroke="#ff0000" fill="none"/>
  <circle id="mount-c" cx="16" cy="16.2" r="1.6" stroke="#ff0000" fill="none"/>
  <circle id="mount-d" cx="124" cy="16.2" r="1.6" stroke="#ff0000" fill="none"/>
  <rect id="window" x="55" y="44.2" width="30" height="12" stroke="#ff0000" fill="none"/>
  <path id="label" d="M20 80.2 H60" stroke="#0000ff" fill="none"/>
  <path id="outline" d="M10 10 H130.2 V90.2 H10 Z" stroke="#ff0000" fill="none"/>
</svg>`;

const hidden = (...points: [number, number][]): HiddenSample => ({ keepMaterialMm: points });
const finding = (drawing: string, rule: string, sample?: HiddenSample): Finding | undefined =>
	verify(spec, drawing, sample).findings.find(item => item.rule === rule);

test("a panel drawn at finished sizes fails holes and cutouts, because kerf widens every inner void", () => {
	assert.equal(finding(UNCOMPENSATED, "holes")?.ok, false);
	assert.equal(finding(UNCOMPENSATED, "cutouts")?.ok, false);
});

test("the compensated panel passes holes, cutouts and outer-size measured on finished geometry", () => {
	const verdict = verify(spec, COMPENSATED, hidden([30, 20]));
	assert.equal(finding(COMPENSATED, "holes")?.ok, true);
	assert.equal(finding(COMPENSATED, "cutouts")?.ok, true);
	assert.equal(finding(COMPENSATED, "outer-size")?.ok, true);
	assert.equal(verdict.measured.finishedWidthMm, 120);
	assert.equal(verdict.measured.finishedHeightMm, 80);
	assert.equal(verdict.measured.holesMatched, 4);
});

test("an outer cut drawn at the part size, or 0.2 mm wider than part plus kerf, fails outer-size", () => {
	const atPartSize = COMPENSATED.replace("M10 10 H130.2 V90.2 H10 Z", "M10 10 H130 V90 H10 Z");
	const overCompensated = COMPENSATED.replace("M10 10 H130.2 V90.2 H10 Z", "M10 10 H130.4 V90.4 H10 Z");
	assert.equal(finding(atPartSize, "outer-size")?.ok, false);
	assert.equal(finding(overCompensated, "outer-size")?.ok, false);
});

test("a keep-material sample inside the kerf strip of the window fails hidden-material; 0.4 mm away it passes", () => {
	// The window's finished left edge is at part x 45.0, so x 45.05 is inside the kerf strip the beam removes.
	const inStrip = verify(spec, COMPENSATED, hidden([45.05, 40]));
	assert.equal(inStrip.findings.find(item => item.rule === "hidden-material")?.ok, false);
	const clear = verify(spec, COMPENSATED, hidden([44.6, 40]));
	assert.equal(clear.findings.find(item => item.rule === "hidden-material")?.ok, true);
});

test("a keep-material sample exactly on a finished edge fails hidden-material, on the outer edge and on a void edge", () => {
	// Part x 0 is the finished outer left edge (drawn x 10.1); part x 45.0 is the finished window left edge (drawn x 55.1).
	const onOuter = verify(spec, COMPENSATED, hidden([0, 40]));
	const onVoid = verify(spec, COMPENSATED, hidden([45, 40]));
	assert.equal(onOuter.findings.find(item => item.rule === "hidden-material")?.ok, false);
	assert.equal(onVoid.findings.find(item => item.rule === "hidden-material")?.ok, false);
});

test("a cut 3.1 mm from the outer drawing leaves 2.9 mm of finished web and fails min-web", () => {
	const withCircle = COMPENSATED.replace("</svg>", '  <circle id="web" cx="126.1" cy="40" r="1" stroke="#ff0000" fill="none"/>\n</svg>');
	const verdict = verify(spec, withCircle);
	assert.equal(verdict.findings.find(item => item.rule === "min-web")?.ok, false);
	assert.equal(verdict.measured.minWebMm, 2.9);
});
