import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Instant, JobId } from "../../core/src/ids.ts";
import { conform } from "../src/conform.ts";
import type { Conformance } from "../src/conform.ts";
import { freeze } from "../src/contract.ts";
import { parseGcode } from "../src/gcode.ts";
import { prusaVersion, slicePrusa } from "../src/prusa.ts";
import { sectionRings } from "../src/section.ts";
import { validateSpec } from "../src/spec.ts";
import { meshStats } from "../src/stl.ts";
import type { PrintSpec } from "../src/types.ts";
import { vec3 } from "../src/types.ts";
import type { Point, Triangle } from "./stl-fixture.ts";
import { cube, toBinaryStl } from "./stl-fixture.ts";

// Runs only when ACQUIT_PRUSA names a PrusaSlicer binary. Once it is set, a binary that will not run fails
// the test instead of skipping it, so the print-slice job cannot pass without the slicer.
const BINARY = process.env.ACQUIT_PRUSA;
const SKIP = BINARY ? false : "set ACQUIT_PRUSA to a PrusaSlicer binary to run the slicer tests";
const PROFILE = fileURLToPath(new URL("./fixtures/prusa-20pct.ini", import.meta.url));
const LAYER_HEIGHT_MM = 0.2;
const JOB = "job_slicer01" as JobId;
const AT = "2026-10-23T09:00:00Z" as Instant;
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff);

const at = (p: Point, factor: number): Point => [p[0] * factor, p[1] * factor, p[2] * factor];
const scaled = (triangles: readonly Triangle[], factor: number): Triangle[] =>
	triangles.map(([a, b, c]): Triangle => [at(a, factor), at(b, factor), at(c, factor)]);

// The contract's part is the honest 20 mm cube. Submitted G-code can come from a different STL, and the
// check compares it against the contract's section and bounds.
const CONTRACT_STL = toBinaryStl(cube(20));
const SCALED_STL = toBinaryStl(scaled(cube(20), 0.95));

// Infill is stripped by removing the E word from every G1 inside an infill block. Retractions and
// extrusions both lose it, so the infill moves become travels and the walls and absolute E stay as sliced.
function stripInfill(gcode: string): string {
	let feature = "";
	return gcode
		.split("\n")
		.map(line => {
			const trimmed = line.trim();
			if (trimmed.startsWith(";TYPE:")) feature = trimmed.slice(6).trim();
			if (/infill/i.test(feature) && /^G1\b/.test(trimmed)) return line.replace(/ E-?\d*\.?\d+/, "");
			return line;
		})
		.join("\n");
}

function featureNames(gcode: string): string[] {
	return [...new Set(gcode.split("\n").filter(line => line.startsWith(";TYPE:")).map(line => line.slice(6).trim()))];
}

type Loaded = {
	readonly honest: string;
	readonly scaled: string;
	readonly contract: { sampleLayers: readonly number[]; spec: PrintSpec };
	readonly sections: Map<number, Awaited<ReturnType<typeof sectionRings>>>;
	readonly version: string;
};

let loaded: Promise<Loaded> | undefined;

function load(): Promise<Loaded> {
	loaded ??= (async () => {
		if (!BINARY) throw new Error("ACQUIT_PRUSA is not set");
		const version = prusaVersion(BINARY);
		const mesh = meshStats(CONTRACT_STL);
		if (!mesh.ok) throw new Error("contract STL is invalid");
		const spec = validateSpec({
			modelDigest: mesh.value.digest,
			material: "PLA",
			color: { name: "white", hex: null },
			quantity: 1,
			toleranceMm: 0.2,
			infillPct: 20,
			walls: 2,
			maxLayerHeightMm: LAYER_HEIGHT_MM,
			printBy: "2026-10-30T12:00:00Z",
			deliverBy: "2026-11-02T12:00:00Z",
		});
		if (!spec.ok) throw new Error("slicer spec is invalid");
		const frozen = freeze({ jobId: JOB, spec: spec.value, mesh: mesh.value, seed: SEED, at: AT });
		if (!frozen.ok) throw new Error("contract freeze refused");
		const sections = new Map<number, Awaited<ReturnType<typeof sectionRings>>>();
		for (const layer of frozen.value.hidden.sampleLayers) {
			sections.set(layer, await sectionRings(CONTRACT_STL, (layer - 0.5) * LAYER_HEIGHT_MM));
		}
		return {
			honest: slicePrusa(BINARY, PROFILE, CONTRACT_STL),
			scaled: slicePrusa(BINARY, PROFILE, SCALED_STL),
			contract: { sampleLayers: frozen.value.hidden.sampleLayers, spec: spec.value },
			sections,
			version,
		};
	})();
	return loaded;
}

function check(gcode: string, fixture: Loaded): Conformance {
	const parsed = parseGcode(gcode);
	if (!parsed.ok) throw new Error(`G-code does not parse: ${JSON.stringify(parsed.reason)}`);
	return conform({
		gcode: parsed.value,
		meshBox: { min: vec3(0, 0, 0), max: vec3(20, 20, 20) },
		layerHeightMm: LAYER_HEIGHT_MM,
		sampleLayers: fixture.contract.sampleLayers,
		sections: fixture.sections,
		infillPct: fixture.contract.spec.infillPct,
		toleranceMm: fixture.contract.spec.toleranceMm,
		expectedUnits: fixture.contract.spec.quantity,
	});
}

const SLOW = { skip: SKIP, timeout: 600_000 };
const kinds = (result: Conformance) => [...new Set(result.reasons.map(reason => reason.kind))];

test("the honest 20 mm cube at 20% infill passes conformance", SLOW, async t => {
	const fixture = await load();
	t.diagnostic(`PrusaSlicer ${fixture.version}`);
	t.diagnostic(`feature names: ${JSON.stringify(featureNames(fixture.honest))}`);
	const result = check(fixture.honest, fixture);
	t.diagnostic(`measured: ${JSON.stringify(result.measured)}`);
	assert.deepEqual(result.reasons, []);
});

test("the honest G-code with infill stripped is rejected with INFILL_BELOW_CONTRACT", SLOW, async t => {
	const fixture = await load();
	const result = check(stripInfill(fixture.honest), fixture);
	t.diagnostic(`measured: ${JSON.stringify(result.measured.layers)}`);
	assert.deepEqual(kinds(result), ["INFILL_BELOW_CONTRACT"]);
});

test("a 95% scaled slice is rejected with SCALE_OUT_OF_TOLERANCE and FOOTPRINT_MISMATCH", SLOW, async t => {
	const fixture = await load();
	const result = check(fixture.scaled, fixture);
	t.diagnostic(`measured scale: ${JSON.stringify(result.measured.scale)}`);
	assert.ok(kinds(result).includes("SCALE_OUT_OF_TOLERANCE"));
	assert.ok(kinds(result).includes("FOOTPRINT_MISMATCH"));
});
