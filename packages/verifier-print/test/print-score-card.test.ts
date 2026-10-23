import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { KeyObject } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Instant, JobId } from "../../core/src/ids.ts";
import { capturePhotos } from "../src/sim/camera.ts";
import { dHash, windowFor } from "../src/camera.ts";
import type { ArchivedPhoto, Photo } from "../src/camera.ts";
import { freeze } from "../src/contract.ts";
import { coupon } from "../src/coupon.ts";
import { sha256Hex } from "../src/digest.ts";
import { parseGcode } from "../src/gcode.ts";
import { buildPlate } from "../src/plate.ts";
import type { Plate } from "../src/plate.ts";
import { prusaVersion, slicePrusa } from "../src/prusa.ts";
import { formatPrintScoreCard, KNOWN_GAP, observedPrintOutcome, PUBLISHED_PRINT_SCORE_CARD, tallyPrints, VERIFIED } from "../src/score-card.ts";
import type { CaseResult, ScoreCard } from "../src/score-card.ts";
import { meshStats } from "../src/stl.ts";
import { validateSpec } from "../src/spec.ts";
import { newPrinterKeys } from "../src/telemetry.ts";
import type { PrinterKeys, TelemetryFrame } from "../src/telemetry.ts";
import { runTwin } from "../src/sim/twin.ts";
import { measurePlacement, verifyPrint } from "../src/verify.ts";
import type { PrintVerdict } from "../src/verify.ts";
import type { Box, FrozenPrintContract, PrintRejectReason } from "../src/types.ts";
import { LAYER_MM, partStl, scaledStl, stripInfill, syntheticGcode } from "../src/sim/synthetic-gcode.ts";
import type { PartKind } from "../src/sim/synthetic-gcode.ts";

// The card has two literal tallies. The synthetic one runs on every CI job. The slicer one adds the cases
// PrusaSlicer slices, and runs only in the print-slice job, where ACQUIT_PRUSA names the binary.
const BINARY = process.env.ACQUIT_PRUSA;
const PROFILE = fileURLToPath(new URL("./fixtures/prusa-20pct.ini", import.meta.url));
const AT = "2026-10-23T09:00:00Z" as Instant;
const BED = { x: 250, y: 210 };
const SYNTHETIC_CARD: ScoreCard = { cheatsCaught: 9, cheatsTotal: 10, honestPassed: 20, honestTotal: 20, gaps: ["replay-same-file"] };

type Honest = { readonly id: string; readonly part: PartKind; readonly size: number; readonly quantity: number; readonly infillPct: number };

// Twenty honest seeds, drawn from cubes, cylinders and L-brackets, with one to three copies and 15 to 40 percent infill.
const HONEST: readonly Honest[] = [
	{ id: "cube-12-q1-i15", part: "cube", size: 12, quantity: 1, infillPct: 15 },
	{ id: "cube-12-q2-i20", part: "cube", size: 12, quantity: 2, infillPct: 20 },
	{ id: "cube-12-q3-i25", part: "cube", size: 12, quantity: 3, infillPct: 25 },
	{ id: "cube-14-q1-i30", part: "cube", size: 14, quantity: 1, infillPct: 30 },
	{ id: "cube-14-q2-i35", part: "cube", size: 14, quantity: 2, infillPct: 35 },
	{ id: "cube-14-q3-i40", part: "cube", size: 14, quantity: 3, infillPct: 40 },
	{ id: "cylinder-6-q1-i15", part: "cylinder", size: 6, quantity: 1, infillPct: 15 },
	{ id: "cylinder-6-q2-i20", part: "cylinder", size: 6, quantity: 2, infillPct: 20 },
	{ id: "cylinder-6-q3-i25", part: "cylinder", size: 6, quantity: 3, infillPct: 25 },
	{ id: "cylinder-7-q1-i30", part: "cylinder", size: 7, quantity: 1, infillPct: 30 },
	{ id: "cylinder-7-q2-i35", part: "cylinder", size: 7, quantity: 2, infillPct: 35 },
	{ id: "cylinder-7-q3-i40", part: "cylinder", size: 7, quantity: 3, infillPct: 40 },
	{ id: "l-14-q1-i20", part: "l-bracket", size: 14, quantity: 1, infillPct: 20 },
	{ id: "l-14-q2-i25", part: "l-bracket", size: 14, quantity: 2, infillPct: 25 },
	{ id: "l-14-q3-i30", part: "l-bracket", size: 14, quantity: 3, infillPct: 30 },
	{ id: "l-14-q1-i35", part: "l-bracket", size: 14, quantity: 1, infillPct: 35 },
	{ id: "l-14-q2-i40", part: "l-bracket", size: 14, quantity: 2, infillPct: 40 },
	{ id: "l-14-q3-i15", part: "l-bracket", size: 14, quantity: 3, infillPct: 15 },
	{ id: "cube-12-q1-i40", part: "cube", size: 12, quantity: 1, infillPct: 40 },
	{ id: "cylinder-6-q2-i15", part: "cylinder", size: 6, quantity: 2, infillPct: 15 },
];

/** The job seed: distinct per label, so each job has its own coupon marker and hidden sample layers. */
function seedFor(label: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(`print-score-card\0${label}`).digest());
}

type Job = {
	readonly jobId: JobId;
	readonly seed: Uint8Array;
	readonly partStl: Uint8Array;
	readonly partBox: Box;
	readonly contract: FrozenPrintContract;
	readonly quantity: number;
	readonly infillPct: number;
	/** The plate the verifier rebuilds from the contract part and this job's coupon. */
	readonly plate: Plate;
	readonly plateBox: Box;
	/** The printer registered to this job. Its public key is the one the verifier checks telemetry against. */
	readonly printer: PrinterKeys;
};

async function openJob(label: string, part: PartKind, size: number, quantity: number, infillPct: number): Promise<Job> {
	const bytes = await partStl(part, size);
	const mesh = meshStats(bytes);
	if (!mesh.ok) throw new Error(`${label}: part STL is invalid`);
	const spec = validateSpec({
		modelDigest: mesh.value.digest,
		material: "PLA",
		color: { name: "white", hex: null },
		quantity,
		toleranceMm: 0.2,
		infillPct,
		walls: 2,
		maxLayerHeightMm: LAYER_MM,
		printBy: "2026-10-30T12:00:00Z",
		deliverBy: "2026-11-02T12:00:00Z",
	});
	if (!spec.ok) throw new Error(`${label}: spec refused`);
	const jobId = `job_${label}` as JobId;
	const seed = seedFor(label);
	const frozen = freeze({ jobId, spec: spec.value, mesh: mesh.value, seed, at: AT });
	if (!frozen.ok) throw new Error(`${label}: contract refused`);
	const plate = await buildPlate({ partStl: bytes, partBox: mesh.value.bboxMm, coupon: coupon(jobId, seed), quantity });
	const plateMesh = meshStats(plate.stl);
	if (!plateMesh.ok) throw new Error(`${label}: plate STL is invalid`);
	return {
		jobId,
		seed,
		partStl: bytes,
		partBox: mesh.value.bboxMm,
		contract: frozen.value,
		quantity,
		infillPct,
		plate,
		plateBox: plateMesh.value.bboxMm,
		printer: newPrinterKeys(),
	};
}

type Printed = {
	readonly gcode: string;
	readonly frames: readonly TelemetryFrame[];
	readonly photos: readonly Photo[];
};

type Options = {
	readonly keys?: PrinterKeys;
	readonly filamentReportScale?: number;
	readonly timeScale?: number;
	readonly photoSeed?: Uint8Array;
};

/** What the printer makes from a G-code file: its telemetry, and camera photos of the sampled layers. */
async function printed(job: Job, gcode: string, options: Options = {}): Promise<Printed> {
	const parsed = parseGcode(gcode);
	if (!parsed.ok) throw new Error("printed G-code does not parse");
	const keys = options.keys ?? job.printer;
	const frames = runTwin({
		printerId: "printer-a",
		keys,
		fileHash: sha256Hex(new TextEncoder().encode(gcode)),
		gcode: parsed.value,
		filamentReportScale: options.filamentReportScale,
		timeScale: options.timeScale,
	}).frames;
	const placement = (await measurePlacement({ contract: job.contract, partStl: job.partStl, seed: job.seed, bedMm: BED, gcode })) ?? { dx: 0, dy: 0 };
	const photos = capturePhotos({
		gcode: parsed.value,
		sampleLayers: job.contract.hidden.sampleLayers,
		layerHeightMm: LAYER_MM,
		window: windowFor(job.plateBox, placement),
		seed: options.photoSeed ?? job.seed,
	});
	return { gcode, frames, photos };
}

type Submission = {
	readonly gcode: string;
	readonly frames: readonly TelemetryFrame[];
	readonly photos: readonly Photo[];
	readonly archive?: readonly ArchivedPhoto[];
	readonly publicKey?: KeyObject;
};

/** The verifier's verdict on what the seller submits. The registered printer key is the default. */
function judge(job: Job, submission: Submission): Promise<PrintVerdict> {
	return verifyPrint({
		contract: job.contract,
		partStl: job.partStl,
		seed: job.seed,
		bedMm: BED,
		archive: submission.archive ?? [],
		gcode: submission.gcode,
		telemetry: { frames: submission.frames, publicKey: submission.publicKey ?? job.printer.publicKey },
		photos: submission.photos,
	});
}

type Case = {
	readonly id: string;
	readonly kind: "cheat" | "honest";
	/** The literal first reason kind, VERIFIED for an honest print, or KNOWN_GAP for a fraud that passes. */
	readonly expected: string;
	/** A literal check on the reasons beyond the first one, for a fraud whose first reason is not the design's. */
	readonly also?: (reasons: readonly PrintRejectReason[]) => boolean;
	readonly slicer: boolean;
	readonly run: () => Promise<PrintVerdict>;
};

const cases: Case[] = [];
const results: CaseResult[] = [];

for (const honest of HONEST) {
	cases.push({
		id: `honest-${honest.id}`,
		kind: "honest",
		expected: VERIFIED,
		slicer: false,
		run: async () => {
			const job = await openJob(`honest-${honest.id}`, honest.part, honest.size, honest.quantity, honest.infillPct);
			const gcode = await syntheticGcode(job.plate.stl, { infillPct: honest.infillPct });
			return judge(job, await printed(job, gcode));
		},
	});
}

// The frauds share one base job, two copies of a 14 mm cube at 25 percent, so a layer shift can move one unit alone.
const BASE = { label: "base-cube-14-q2-i25", part: "cube" as const, size: 14, quantity: 2, infillPct: 25 };
const openBase = () => openJob(BASE.label, BASE.part, BASE.size, BASE.quantity, BASE.infillPct);

cases.push({
	id: "fraud-skip-infill",
	kind: "cheat",
	expected: "INFILL_BELOW_CONTRACT",
	slicer: false,
	run: async () => {
		const job = await openBase();
		const gcode = await syntheticGcode(job.plate.stl, { infillPct: BASE.infillPct, skipInfill: true });
		return judge(job, await printed(job, gcode));
	},
});

cases.push({
	id: "fraud-scale-95",
	kind: "cheat",
	expected: "SCALE_OUT_OF_TOLERANCE",
	slicer: false,
	run: async () => {
		const job = await openBase();
		const gcode = await syntheticGcode(await scaledStl(job.plate.stl, 0.95), { infillPct: BASE.infillPct });
		return judge(job, await printed(job, gcode));
	},
});

cases.push({
	id: "fraud-reused-photo",
	kind: "cheat",
	expected: "PHOTO_REUSED",
	slicer: false,
	run: async () => {
		const job = await openBase();
		const gcode = await syntheticGcode(job.plate.stl, { infillPct: BASE.infillPct });
		// The photos came from an earlier job of this part. The archive holds that job's fingerprints.
		const earlier = await printed(job, gcode, { photoSeed: seedFor(`${BASE.label}-earlier`) });
		const archive = earlier.photos.map((photo): ArchivedPhoto => ({ layer: photo.layer, fingerprint: dHash(photo) }));
		return judge(job, { ...earlier, archive });
	},
});

// The design names FOOTPRINT_MISMATCH. On this plate the scale check fires first, because the shifted layer
// moves the median of the sampled extents. The shifted layer is still named by OUTSIDE_MATERIAL, since the other
// unit and the coupon dilute its footprint IoU above 0.92.
let shiftedLayer = -1;
cases.push({
	id: "fraud-layer-shift",
	kind: "cheat",
	expected: "SCALE_OUT_OF_TOLERANCE",
	also: reasons => reasons.some(reason => "layer" in reason && reason.layer === shiftedLayer),
	slicer: false,
	run: async () => {
		const job = await openBase();
		const [unitTwoX] = job.plate.layout.partOrigins[1];
		shiftedLayer = job.contract.hidden.sampleLayers[0];
		const gcode = await syntheticGcode(job.plate.stl, {
			infillPct: BASE.infillPct,
			shift: { layer: shiftedLayer, mm: 2, boundaryX: unitTwoX },
		});
		return judge(job, await printed(job, gcode));
	},
});

cases.push({
	id: "fraud-swap-gcode",
	kind: "cheat",
	expected: "FILE_HASH_MISMATCH",
	slicer: false,
	run: async () => {
		const job = await openBase();
		const submitted = await syntheticGcode(job.plate.stl, { infillPct: BASE.infillPct });
		const other = await printed(job, await syntheticGcode(job.plate.stl, { infillPct: BASE.infillPct + 10 }));
		return judge(job, { ...other, gcode: submitted });
	},
});

// The coupon's raised cells set the Y extent of the cell layers, so a swapped coupon moves the sampled median
// and the scale check fires first. The coupon check then reports a low IoU and a wrong marker.
cases.push({
	id: "fraud-coupon-from-other-job",
	kind: "cheat",
	expected: "SCALE_OUT_OF_TOLERANCE",
	also: reasons => reasons.some(reason => reason.kind === "COUPON_IOU_LOW") && reasons.some(reason => reason.kind === "COUPON_MARKER_MISMATCH"),
	slicer: false,
	run: async () => {
		const job = await openBase();
		const otherCoupon = await buildPlate({
			partStl: job.partStl,
			partBox: job.partBox,
			coupon: coupon(`job_${BASE.label}-other` as JobId, job.seed),
			quantity: BASE.quantity,
		});
		const gcode = await syntheticGcode(otherCoupon.stl, { infillPct: BASE.infillPct });
		return judge(job, await printed(job, gcode));
	},
});

cases.push({
	id: "fraud-under-extrude",
	kind: "cheat",
	expected: "FILAMENT_MISMATCH",
	slicer: false,
	run: async () => {
		const job = await openBase();
		const gcode = await syntheticGcode(job.plate.stl, { infillPct: BASE.infillPct });
		return judge(job, await printed(job, gcode, { filamentReportScale: 0.8 }));
	},
});

cases.push({
	id: "fraud-fast-forward",
	kind: "cheat",
	expected: "DURATION_IMPLAUSIBLE",
	slicer: false,
	run: async () => {
		const job = await openBase();
		const gcode = await syntheticGcode(job.plate.stl, { infillPct: BASE.infillPct });
		return judge(job, await printed(job, gcode, { timeScale: 0.3 }));
	},
});

cases.push({
	id: "fraud-forged-signature",
	kind: "cheat",
	expected: "TELEMETRY_SIGNATURE_INVALID",
	slicer: false,
	run: async () => {
		const job = await openBase();
		const gcode = await syntheticGcode(job.plate.stl, { infillPct: BASE.infillPct });
		return judge(job, await printed(job, gcode, { keys: newPrinterKeys() }));
	},
});

// Known gap. An earlier print of the same file hands over its frames and photos. Frames carry no job id or
// nonce, so the verifier can only match the file hash, and the replayed evidence passes.
cases.push({
	id: "replay-same-file",
	kind: "cheat",
	expected: KNOWN_GAP,
	slicer: false,
	run: async () => {
		const job = await openBase();
		const gcode = await syntheticGcode(job.plate.stl, { infillPct: BASE.infillPct });
		return judge(job, await printed(job, gcode, { photoSeed: seedFor(`${BASE.label}-earlier`) }));
	},
});

// The slicer cases. PrusaSlicer slices the plate and the verifier judges the file it wrote.
let slicedHonest: Promise<{ job: Job; gcode: string }> | undefined;
const honestSlice = (): Promise<{ job: Job; gcode: string }> => {
	slicedHonest ??= (async () => {
		if (!BINARY) throw new Error("ACQUIT_PRUSA is not set");
		const job = await openJob("slicer-honest-a", "cube", 20, 1, 20);
		return { job, gcode: slicePrusa(BINARY, PROFILE, job.plate.stl) };
	})();
	return slicedHonest;
};

cases.push({
	id: "slicer-honest-cube-20-q1-i20-a",
	kind: "honest",
	expected: VERIFIED,
	slicer: true,
	run: async () => {
		const { job, gcode } = await honestSlice();
		return judge(job, await printed(job, gcode));
	},
});

cases.push({
	id: "slicer-honest-cube-20-q1-i20-b",
	kind: "honest",
	expected: VERIFIED,
	slicer: true,
	run: async () => {
		if (!BINARY) throw new Error("ACQUIT_PRUSA is not set");
		const job = await openJob("slicer-honest-b", "cube", 20, 1, 20);
		const gcode = slicePrusa(BINARY, PROFILE, job.plate.stl);
		return judge(job, await printed(job, gcode));
	},
});

cases.push({
	id: "slicer-fraud-skip-infill",
	kind: "cheat",
	expected: "INFILL_BELOW_CONTRACT",
	slicer: true,
	run: async () => {
		const { job, gcode } = await honestSlice();
		return judge(job, await printed(job, stripInfill(gcode)));
	},
});

cases.push({
	id: "slicer-fraud-scale-95",
	kind: "cheat",
	expected: "SCALE_OUT_OF_TOLERANCE",
	slicer: true,
	run: async () => {
		if (!BINARY) throw new Error("ACQUIT_PRUSA is not set");
		const { job } = await honestSlice();
		const gcode = slicePrusa(BINARY, PROFILE, await scaledStl(job.plate.stl, 0.95));
		return judge(job, await printed(job, gcode));
	},
});

for (const item of cases) {
	const skip = item.slicer && !BINARY ? "set ACQUIT_PRUSA to a PrusaSlicer binary to run this case" : false;
	test(item.id, { skip, timeout: 900_000 }, async t => {
		const verdict = await item.run();
		const reason = verdict.reasons[0]?.kind ?? null;
		const observed = observedPrintOutcome(item.kind, reason);
		results.push({ id: item.id, kind: item.kind, expected: item.expected, actual: observed });
		t.diagnostic(`reasons ${JSON.stringify(verdict.reasons)}`);
		assert.equal(observed, item.expected, `${item.id}: first reason`);
		if (item.also) assert.ok(item.also(verdict.reasons), `${item.id}: a reason the design names is missing`);
	});
}

test("the confusion matrix tallies to its literal card and prints the PRINT SCORE CARD line", () => {
	const card = tallyPrints(results);
	assert.deepEqual(card, BINARY ? PUBLISHED_PRINT_SCORE_CARD : SYNTHETIC_CARD);
	const slicer = BINARY ? prusaVersion(BINARY).replace("PrusaSlicer-", "PrusaSlicer ") : null;
	console.log(formatPrintScoreCard(card, slicer));
	for (const gap of card.gaps) console.log(`FINDING known gap: ${gap} passes the print verifier`);
});
