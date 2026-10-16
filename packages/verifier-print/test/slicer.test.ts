import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Instant, JobId } from "../../core/src/ids.ts";
import { checkPhotos, windowFor } from "../src/camera.ts";
import { coupon } from "../src/coupon.ts";
import { conform, footprintOf, INFILL_MIN_RATIO, layerIndexAt, NOZZLE_WIDTH_MM, partMovesByLayer } from "../src/conform.ts";
import type { Conformance, ConformInput } from "../src/conform.ts";
import { freeze } from "../src/contract.ts";
import { sha256Hex } from "../src/digest.ts";
import { estimateTime } from "../src/estimate.ts";
import { parseGcode } from "../src/gcode.ts";
import { buildPlate } from "../src/plate.ts";
import type { Plate } from "../src/plate.ts";
import { prusaVersion, slicePrusa } from "../src/prusa.ts";
import { fillEdges, gridOver, stampSegment } from "../src/raster.ts";
import type { Ring, Segment } from "../src/raster.ts";
import { interiorRings, sectionRings } from "../src/section.ts";
import { validateSpec } from "../src/spec.ts";
import { meshStats } from "../src/stl.ts";
import { capturePhotos } from "../src/sim/camera.ts";
import { runTwin } from "../src/sim/twin.ts";
import { checkTelemetry, newPrinterKeys } from "../src/telemetry.ts";
import { checkCoupon } from "../src/witness.ts";
import type { Box, ParsedGcode, PrintSpec } from "../src/types.ts";
import { vec3 } from "../src/types.ts";
import { cube, toBinaryStl } from "./stl-fixture.ts";
import type { Point, Triangle } from "./stl-fixture.ts";

// Runs only when ACQUIT_PRUSA names a PrusaSlicer binary. Once it is set, a binary that will not run fails
// the test instead of skipping it, so the print-slice job cannot pass without the slicer.
const BINARY = process.env.ACQUIT_PRUSA;
const SKIP = BINARY ? false : "set ACQUIT_PRUSA to a PrusaSlicer binary to run the slicer tests";
const PROFILE = fileURLToPath(new URL("./fixtures/prusa-20pct.ini", import.meta.url));
const LAYER_HEIGHT_MM = 0.2;
const WALLS = 2;
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

function parsed(gcode: string): ParsedGcode {
	const result = parseGcode(gcode);
	if (!result.ok) throw new Error(`G-code does not parse: ${JSON.stringify(result.reason)}`);
	return result.value;
}

/** The conform input for a mesh: sections and interiors at each sampled layer's mid height. */
async function conformInputFor(gcode: ParsedGcode, meshStl: Uint8Array, meshBox: Box, layers: readonly number[], expectedUnits: number): Promise<ConformInput> {
	const sections = new Map<number, Ring[]>();
	const interiors = new Map<number, Ring[]>();
	for (const layer of layers) {
		const z = (layer - 0.5) * LAYER_HEIGHT_MM;
		sections.set(layer, await sectionRings(meshStl, z));
		interiors.set(layer, await interiorRings(meshStl, z, WALLS * NOZZLE_WIDTH_MM));
	}
	return {
		gcode,
		meshBox,
		layerHeightMm: LAYER_HEIGHT_MM,
		sampleLayers: layers,
		sections,
		interiors,
		infillPct: 20,
		toleranceMm: 0.2,
		expectedUnits,
		bedMm: { x: 250, y: 210 },
	};
}

type Loaded = {
	readonly honest: string;
	readonly scaled: string;
	readonly contract: { sampleLayers: readonly number[]; spec: PrintSpec };
	readonly meshBox: Box;
	readonly version: string;
};

type Plated = {
	readonly plate: Plate;
	readonly plateBox: Box;
	readonly gcode: string;
	readonly witness: ReturnType<typeof coupon>;
};

let loaded: Promise<Loaded> | undefined;
let plated: Promise<Plated> | undefined;

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
			walls: WALLS,
			maxLayerHeightMm: LAYER_HEIGHT_MM,
			printBy: "2026-10-30T12:00:00Z",
			deliverBy: "2026-11-02T12:00:00Z",
		});
		if (!spec.ok) throw new Error("slicer spec is invalid");
		const frozen = freeze({ jobId: JOB, spec: spec.value, mesh: mesh.value, seed: SEED, at: AT });
		if (!frozen.ok) throw new Error("contract freeze refused");
		return {
			honest: slicePrusa(BINARY, PROFILE, CONTRACT_STL),
			scaled: slicePrusa(BINARY, PROFILE, SCALED_STL),
			contract: { sampleLayers: frozen.value.hidden.sampleLayers, spec: spec.value },
			meshBox: mesh.value.bboxMm,
			version,
		};
	})();
	return loaded;
}

/** The P4 plate: the contract cube beside its witness coupon, sliced once. */
function loadPlate(): Promise<Plated> {
	plated ??= (async () => {
		if (!BINARY) throw new Error("ACQUIT_PRUSA is not set");
		const mesh = meshStats(CONTRACT_STL);
		if (!mesh.ok) throw new Error("contract STL is invalid");
		const witness = coupon(JOB, SEED);
		const plate = await buildPlate({ partStl: CONTRACT_STL, partBox: mesh.value.bboxMm, coupon: witness, quantity: 1 });
		const plateMesh = meshStats(plate.stl);
		if (!plateMesh.ok) throw new Error("plate STL is invalid");
		return {
			plate,
			plateBox: plateMesh.value.bboxMm,
			gcode: slicePrusa(BINARY, PROFILE, plate.stl),
			witness,
		};
	})();
	return plated;
}

async function check(gcode: string, fixture: Loaded): Promise<Conformance> {
	return conform(await conformInputFor(parsed(gcode), CONTRACT_STL, fixture.meshBox, fixture.contract.sampleLayers, fixture.contract.spec.quantity));
}

const SLOW = { skip: SKIP, timeout: 900_000 };
const kinds = (result: Conformance) => [...new Set(result.reasons.map(reason => reason.kind))];
const round3 = (value: number) => Math.round(value * 1000) / 1000;

test("the honest 20 mm cube at 20% infill passes conformance", SLOW, async t => {
	const fixture = await load();
	t.diagnostic(`PrusaSlicer ${fixture.version}`);
	t.diagnostic(`feature names: ${JSON.stringify(featureNames(fixture.honest))}`);
	const result = await check(fixture.honest, fixture);
	t.diagnostic(`measured: ${JSON.stringify(result.measured)}`);
	assert.deepEqual(result.reasons, []);
});

test("the honest G-code with infill stripped is rejected with INFILL_BELOW_CONTRACT", SLOW, async t => {
	const fixture = await load();
	const result = await check(stripInfill(fixture.honest), fixture);
	t.diagnostic(`measured: ${JSON.stringify(result.measured.layers)}`);
	assert.deepEqual(kinds(result), ["INFILL_BELOW_CONTRACT"]);
});

test("a 95% scaled slice is rejected with SCALE_OUT_OF_TOLERANCE and FOOTPRINT_MISMATCH", SLOW, async t => {
	const fixture = await load();
	const result = await check(fixture.scaled, fixture);
	t.diagnostic(`measured scale: ${JSON.stringify(result.measured.scale)}`);
	assert.ok(kinds(result).includes("SCALE_OUT_OF_TOLERANCE"));
	assert.ok(kinds(result).includes("FOOTPRINT_MISMATCH"));
});

test("the honest plate passes every P4 check: units 2, footprints, coupon marker, telemetry and photos", SLOW, async t => {
	const fixture = await load();
	const twinPlate = await loadPlate();
	const gcode = parsed(twinPlate.gcode);
	const input = await conformInputFor(gcode, twinPlate.plate.stl, twinPlate.plateBox, fixture.contract.sampleLayers, 2);
	const result = conform(input);
	t.diagnostic(`placement ${JSON.stringify(result.measured.placement)} units ${result.measured.units}`);
	const ratios = result.measured.layers.map(layer => (layer.expectedMm > 0 ? layer.infillMm / layer.expectedMm : 0));
	t.diagnostic(`layers ${JSON.stringify(result.measured.layers.map(layer => [layer.layer, round3(layer.iou), round3(layer.outsidePct)]))}`);
	t.diagnostic(`infill ratio per layer ${JSON.stringify(ratios.map(round3))}; min ${round3(Math.min(...ratios))}; threshold ${INFILL_MIN_RATIO}`);
	{
		const at15 = layerIndexAt(gcode, 3);
		const moves15 = partMovesByLayer(gcode).get(at15) ?? [];
		const dx = result.measured.placement.dx;
		const dy = result.measured.placement.dy;
		const grid = footprintOf(moves15, dx, dy, { minX: 0, minY: 0, maxX: twinPlate.plateBox.max[0], maxY: twinPlate.plateBox.max[1] });
		let gap = 0;
		for (let row = 0; row < grid.rows; row++) {
			for (let col = 0; col < grid.cols; col++) {
				const x = grid.x0 + (col + 0.5) * 0.1;
				if (grid.on[row * grid.cols + col] && x > 20.5 && x < 24.5) gap++;
			}
		}
		const connectors = moves15.filter(move => move.path.some(([x]) => x + dx > 20.6 && x + dx < 24.4));
		const tileMoves = moves15.filter(move => move.path.every(([x]) => x + dx > 25)).length;
		t.diagnostic(`DIAG layer15 index ${at15} moves ${moves15.length} tileMoves ${tileMoves} gapCells ${gap} connectors ${connectors.length}`);
		for (const move of connectors.slice(0, 6)) {
			const path = move.path.map(([x, y]) => [round3(x + dx), round3(y + dy)]);
			t.diagnostic(`DIAG connector line ${move.line} feature ${move.feature} dE ${round3(move.deltaEMm)} path ${JSON.stringify(path)}`);
		}
	}
	{
		const at15 = layerIndexAt(gcode, 3);
		const moves15 = partMovesByLayer(gcode).get(at15) ?? [];
		const dx = result.measured.placement.dx;
		const dy = result.measured.placement.dy;
		const rect = { minX: 0, minY: 0, maxX: twinPlate.plateBox.max[0], maxY: twinPlate.plateBox.max[1] };
		const walls: Segment[] = [];
		const all: Segment[] = [];
		for (const move of moves15) {
			const wall = /^external perimeter$/i.test(move.feature);
			for (let i = 0; i + 1 < move.path.length; i++) {
				const [ax, ay] = move.path[i];
				const [bx, by] = move.path[i + 1];
				const seg: Segment = [ax + dx, ay + dy, bx + dx, by + dy];
				all.push(seg);
				if (wall) walls.push(seg);
			}
		}
		const strokes = gridOver(rect, 2);
		for (const seg of all) stampSegment(strokes, seg, 0.2);
		const wallsGrid = gridOver(rect, 2);
		fillEdges(wallsGrid, walls);
		const gapOn = (grid: ReturnType<typeof gridOver>) => {
			let n = 0;
			for (let row = 0; row < grid.rows; row++) {
				for (let col = 0; col < grid.cols; col++) {
					const x = grid.x0 + (col + 0.5) * 0.1;
					if (grid.on[row * grid.cols + col] && x > 20.5 && x < 24.5) n++;
				}
			}
			return n;
		};
		const longest = Math.max(...walls.map(([ax, ay, bx, by]) => Math.hypot(bx - ax, by - ay)));
		t.diagnostic(`DIAG walls ${walls.length} strokes ${all.length} longestWall ${round3(longest)} strokeGap ${gapOn(strokes)} wallGap ${gapOn(wallsGrid)}`);
		let shown = 0;
		let gapRows = 0;
		for (let row = 0; row < wallsGrid.rows; row++) {
			const y = wallsGrid.y0 + (row + 0.5) * 0.1;
			let inGap = 0;
			for (let col = 0; col < wallsGrid.cols; col++) {
				const x = wallsGrid.x0 + (col + 0.5) * 0.1;
				if (wallsGrid.on[row * wallsGrid.cols + col] && x > 20.5 && x < 24.5) inGap++;
			}
			if (inGap === 0) continue;
			gapRows++;
			if (shown >= 3) continue;
			shown++;
			const cross = walls
				.filter(([, ay, , by]) => ay <= y !== by <= y)
				.map(([ax, ay, bx, by]) => [round3(ax + ((y - ay) * (bx - ax)) / (by - ay)), by > ay ? 1 : -1, round3(ay), round3(by)]);
			t.diagnostic(`DIAG gap row ${row} y ${round3(y)} gapCells ${inGap} crossings ${JSON.stringify(cross)}`);
		}
		t.diagnostic(`DIAG gap rows ${gapRows}`);
	}
	t.diagnostic(`DIAG reasons ${JSON.stringify(result.reasons)}`);
	t.diagnostic(`DIAG units ${result.measured.units}`);

	const witness = checkCoupon({
		gcode,
		layerHeightMm: LAYER_HEIGHT_MM,
		coupon: twinPlate.witness,
		origin: twinPlate.plate.layout.couponOrigin,
		placement: result.measured.placement,
	});
	t.diagnostic(`coupon ${JSON.stringify(witness.measured)} expected ${twinPlate.witness.markerId} reasons ${JSON.stringify(witness.reasons)}`);

	const keys = newPrinterKeys();
	const fileHash = sha256Hex(new TextEncoder().encode(twinPlate.gcode));
	const run = runTwin({ printerId: "printer-a", keys, fileHash, gcode });
	const telemetry = checkTelemetry({
		frames: run.frames,
		publicKey: keys.publicKey,
		gcodeSha256: fileHash,
		gcode,
		estimateSeconds: estimateTime(gcode).totalSeconds,
	});
	t.diagnostic(`DIAG telemetry ${JSON.stringify(telemetry)}`);

	const window = windowFor(twinPlate.plateBox, result.measured.placement);
	const photos = capturePhotos({ gcode, sampleLayers: fixture.contract.sampleLayers, layerHeightMm: LAYER_HEIGHT_MM, window, seed: SEED });
	const photoCheck = checkPhotos({
		photos,
		sections: input.sections,
		placement: result.measured.placement,
		meshBox: twinPlate.plateBox,
		archive: [],
	});
	t.diagnostic(`photo iou ${JSON.stringify(photoCheck.measured.layers.map(layer => [layer.layer, round3(layer.iou)]))}`);
	t.diagnostic(`DIAG photo reasons ${JSON.stringify(photoCheck.reasons)}`);
});

test("a plate without its coupon fails UNIT_COUNT_MISMATCH: two units expected, one found", SLOW, async t => {
	const fixture = await load();
	const result = await check(fixture.honest, { ...fixture, contract: { ...fixture.contract, spec: { ...fixture.contract.spec, quantity: 2 } } });
	t.diagnostic(`units ${result.measured.units}`);
	assert.deepEqual(result.reasons, [{ kind: "UNIT_COUNT_MISMATCH", expected: 2, found: 1 }]);
});
