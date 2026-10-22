// SIMULATED seller farm. It is one print pipeline in one process: it reads the plate it is sent, slices it with
// the synthetic G-code generator, runs the twin and the camera, and answers. An honest farm prints what it is
// sent and declines a job it cannot print. A fraud farm qualifies honestly, then prints the mutation it names.
// A sloppy farm accepts the trap job too. Every answer carries simulated: true, so nothing here can be shown
// as a measurement.

import { createHash } from "node:crypto";
import type { JobId } from "../../../core/src/ids.ts";
import { dHash, windowFor } from "../camera.ts";
import type { ArchivedPhoto, Photo } from "../camera.ts";
import { FRAUDS } from "../catalog.ts";
import type { FraudId } from "../catalog.ts";
import { coupon } from "../coupon.ts";
import { sha256Hex } from "../digest.ts";
import { parseGcode } from "../gcode.ts";
import { JOB_LAYER_MM } from "../open.ts";
import { buildPlate } from "../plate.ts";
import { meshStats } from "../stl.ts";
import { newPrinterKeys } from "../telemetry.ts";
import type { PrinterKeys, TelemetryFrame } from "../telemetry.ts";
import type { Box, Coupon } from "../types.ts";
import { capturePhotos } from "./camera.ts";
import { scaledStl, syntheticGcode } from "./synthetic-gcode.ts";
import { runTwin } from "./twin.ts";

/** The bed the simulated printer has, in mm. A plate that does not fit is declined. */
export const FARM_BED_MM = { x: 250, y: 210 } as const;

/** What a farm is sent for one job: the plate it prints, and the layers the camera must photograph. */
export type PrintSource = {
	readonly jobId: JobId;
	readonly quantity: number;
	/** The client's part, as the verifier holds it. A farm reads it to rebuild a plate for a coupon of its own. */
	readonly partStl: Uint8Array;
	readonly partBox: Box;
	/** The witness coupon on this plate, or null for a bare part. A fraud that prints another job's coupon must differ from it. */
	readonly coupon: Coupon | null;
	/** The plate to print: the parts and the coupon on one bed. A trap job sends the bare part. */
	readonly plateStl: Uint8Array;
	/** Min corner of each part copy on the plate, in plate coordinates. */
	readonly partOrigins: readonly (readonly [number, number])[];
	readonly infillPct: number;
	/** The layers the verifier asks the camera to photograph during the print. Asked live, so they are not known in advance. */
	readonly photoLayers: readonly number[];
};

/** What a farm returns for one print: its G-code, the telemetry the printer signed, and the photos it took. */
export type PrintSubmission = {
	readonly simulated: true;
	readonly gcode: string;
	readonly frames: readonly TelemetryFrame[];
	readonly photos: readonly Photo[];
	/** Fingerprints of photos from earlier jobs, handed over with the print. A reused photo matches one of these. */
	readonly archive?: readonly ArchivedPhoto[];
};

/** A farm's mode: honest, sloppy (it accepts the trap), or one fraud from the corpus. */
export type FarmMode = "honest" | "sloppy" | `fraud:${FraudId}`;

export function parseFarmMode(text: string): FarmMode | null {
	if (text === "honest" || text === "sloppy") return text;
	const fraud = text.startsWith("fraud:") ? text.slice("fraud:".length) : null;
	return FRAUDS.some(item => item.id === fraud) ? (text as FarmMode) : null;
}

export type Farm = {
	readonly mode: FarmMode;
	/** The farm's answer to a qualification job: its prints, or the reason it declines. */
	answer(source: PrintSource): Promise<readonly PrintSubmission[] | { readonly declined: string }>;
	/** The farm's print of an opened job. A fraud farm prints its mutation here. */
	print(source: PrintSource): Promise<PrintSubmission>;
};

export type FarmOptions = {
	readonly mode: FarmMode;
	readonly id: string;
	/** The printer's key pair. The verifier checks telemetry against the public half, registered before the job. */
	readonly keys: PrinterKeys;
	/** Seeds the camera's noise and the other coupon a swap fraud prints. Chosen by the farm, never by the verifier. */
	readonly seed: Uint8Array;
};

/** Why the farm declines a job, or null when it can print it: an open part mesh, or a plate wider than the bed. */
function declineReason(source: PrintSource): string | null {
	const part = meshStats(source.partStl);
	if (!part.ok) return "The file cannot be read as a part.";
	if (!part.value.watertight) return "The mesh is not closed, so it cannot be printed as one solid.";
	const plate = meshStats(source.plateStl);
	if (!plate.ok) return "The plate cannot be read.";
	const [sx, sy] = plate.value.sizeMm;
	if (sx > FARM_BED_MM.x || sy > FARM_BED_MM.y) {
		return `The part is ${Math.round(sx)} mm by ${Math.round(sy)} mm, larger than this farm's ${FARM_BED_MM.x} mm by ${FARM_BED_MM.y} mm bed.`;
	}
	return null;
}

/** The seed of the other job's coupon, the draw-th one from the farm's seed. */
function otherSeedOf(seed: Uint8Array, draw: number): Uint8Array {
	return new Uint8Array(createHash("sha256").update("sim-farm-other-coupon\0").update(seed).update(`\0${draw}`).digest());
}

/** The raised cells of a coupon as one string, so two coupons compare by their geometry as well as their marker. */
function cellsOf(witness: Coupon): string {
	return witness.markerCells.map(row => row.map(raised => (raised ? "1" : "0")).join("")).join("/");
}

const OTHER_COUPON_DRAWS = 64;

/**
 * Another job's coupon for the plate a fraud prints. The draws come from the farm's seed in order, and the first
 * one whose marker and cells both differ from the plate's own is taken, so one seed always plants the same fraud.
 * Without the check a draw can repeat the plate's marker, and the plate would then carry the coupon it should not.
 */
function otherCouponOf(jobId: JobId, seed: Uint8Array, plate: Coupon | null): Coupon {
	if (plate === null) throw new Error("the plate has no coupon for another job's coupon to differ from");
	for (let draw = 0; draw < OTHER_COUPON_DRAWS; draw++) {
		const candidate = coupon(`${jobId}-other` as JobId, otherSeedOf(seed, draw));
		if (candidate.markerId !== plate.markerId && cellsOf(candidate) !== cellsOf(plate)) return candidate;
	}
	throw new Error("no other coupon differs from the plate's within the draws");
}

export function simFarm(options: FarmOptions): Farm {
	const { keys, seed } = options;

	/** One print of a G-code file: the twin's frames and the camera's photos of the requested layers. */
	const printed = async (source: PrintSource, gcode: string, extra: { readonly keys?: PrinterKeys; readonly photoSeed?: Uint8Array; readonly filamentReportScale?: number; readonly timeScale?: number } = {}): Promise<PrintSubmission> => {
		const parsed = parseGcode(gcode);
		if (!parsed.ok) throw new Error("the farm's G-code does not parse");
		const frames = runTwin({
			printerId: options.id,
			keys: extra.keys ?? keys,
			fileHash: sha256Hex(new TextEncoder().encode(gcode)),
			gcode: parsed.value,
			filamentReportScale: extra.filamentReportScale,
			timeScale: extra.timeScale,
		}).frames;
		const plateBox = meshStats(source.plateStl);
		if (!plateBox.ok) throw new Error("the farm's plate is invalid");
		const photos = capturePhotos({
			gcode: parsed.value,
			sampleLayers: source.photoLayers,
			layerHeightMm: JOB_LAYER_MM,
			window: windowFor(plateBox.value.bboxMm, { dx: 0, dy: 0 }),
			seed: extra.photoSeed ?? seed,
		});
		return { simulated: true, gcode, frames, photos };
	};

	const honestPrint = async (source: PrintSource): Promise<PrintSubmission> =>
		printed(source, await syntheticGcode(source.plateStl, { infillPct: source.infillPct }));

	/** The plate of another job, printed with a coupon of the farm's own making. */
	const otherCouponPlate = async (source: PrintSource): Promise<Uint8Array> => {
		const plate = await buildPlate({
			partStl: source.partStl,
			partBox: source.partBox,
			coupon: otherCouponOf(source.jobId, seed, source.coupon),
			quantity: source.quantity,
		});
		return plate.stl;
	};

	const fraudPrint = async (mode: FraudId, source: PrintSource): Promise<PrintSubmission> => {
		const gcodeOf = (stl: Uint8Array, infillPct: number) => syntheticGcode(stl, { infillPct });
		switch (mode) {
			case "skip-infill":
				return printed(source, await syntheticGcode(source.plateStl, { infillPct: source.infillPct, skipInfill: true }));
			case "scale-95":
				return printed(source, await gcodeOf(await scaledStl(source.plateStl, 0.95), source.infillPct));
			case "reused-photo": {
				// The photos came from an earlier print of this part. The archive holds their fingerprints.
				const earlier = await printed(source, await gcodeOf(source.plateStl, source.infillPct), { photoSeed: createHash("sha256").update("earlier\0").update(seed).digest() });
				return { ...earlier, archive: earlier.photos.map((photo): ArchivedPhoto => ({ layer: photo.layer, fingerprint: dHash(photo) })) };
			}
			case "layer-shift": {
				const [unitTwoX] = source.partOrigins[1] ?? source.partOrigins[0];
				const gcode = await syntheticGcode(source.plateStl, {
					infillPct: source.infillPct,
					shift: { layer: source.photoLayers[0], mm: 2, boundaryX: unitTwoX },
				});
				return printed(source, gcode);
			}
			case "swap-gcode": {
				const submitted = await gcodeOf(source.plateStl, source.infillPct);
				const other = await printed(source, await gcodeOf(source.plateStl, source.infillPct + 10));
				return { ...other, gcode: submitted };
			}
			case "coupon-from-other-job":
				return printed(source, await gcodeOf(await otherCouponPlate(source), source.infillPct));
			case "under-extrude":
				return printed(source, await gcodeOf(source.plateStl, source.infillPct), { filamentReportScale: 0.8 });
			case "fast-forward":
				return printed(source, await gcodeOf(source.plateStl, source.infillPct), { timeScale: 0.3 });
			case "forged-signature":
				return printed(source, await gcodeOf(source.plateStl, source.infillPct), { keys: newPrinterKeys() });
			case "replay-same-file":
				// An earlier print of the same file hands over its frames and photos. The verifier matches the file hash only.
				return printed(source, await gcodeOf(source.plateStl, source.infillPct), { photoSeed: createHash("sha256").update("earlier\0").update(seed).digest() });
		}
	};

	const answer = async (source: PrintSource): Promise<readonly PrintSubmission[] | { readonly declined: string }> => {
		const reason = declineReason(source);
		if (reason === null) return [await honestPrint(source)];
		// A sloppy farm takes the job and sends no evidence for it, which a decline cannot satisfy.
		if (options.mode === "sloppy") return [];
		return { declined: reason };
	};

	const print = async (source: PrintSource): Promise<PrintSubmission> => {
		if (options.mode.startsWith("fraud:")) return fraudPrint(options.mode.slice("fraud:".length) as FraudId, source);
		return honestPrint(source);
	};

	return { mode: options.mode, answer, print };
}
