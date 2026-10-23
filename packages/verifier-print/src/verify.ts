// One verdict for a print. The verifier rebuilds the plate from the contract part, the coupon from the job
// seed, and the sampled layers from the frozen hidden terms. It then runs four check groups in order:
// conformance, coupon, telemetry, photos. The verdict is VERIFIED only when every group is empty.

import type { KeyObject } from "node:crypto";
import { checkPhotos } from "./camera.ts";
import type { ArchivedPhoto, Photo } from "./camera.ts";
import { coupon as witnessCoupon } from "./coupon.ts";
import { conform, MIN_UNIT_AREA_MM2, NOZZLE_WIDTH_MM } from "./conform.ts";
import type { Conformance, Placement } from "./conform.ts";
import { sha256Hex } from "./digest.ts";
import { estimateTime } from "./estimate.ts";
import { parseGcode } from "./gcode.ts";
import type { Ring } from "./raster.ts";
import { buildPlate } from "./plate.ts";
import type { Plate } from "./plate.ts";
import { interiorRings, sectionRings } from "./section.ts";
import { meshStats } from "./stl.ts";
import { checkTelemetry } from "./telemetry.ts";
import type { TelemetryFrame } from "./telemetry.ts";
import { checkCoupon } from "./witness.ts";
import type { Box, FrozenPrintContract, ParsedGcode, PrintRejectReason } from "./types.ts";

export type PrintEvidence = {
	readonly contract: FrozenPrintContract;
	/** The part's STL bytes. The contract's spec binds their digest. */
	readonly partStl: Uint8Array;
	/** The job seed. It stays in the private store until close, and it rebuilds the coupon. */
	readonly seed: Uint8Array;
	readonly bedMm: { readonly x: number; readonly y: number };
	/** Fingerprints of photos from other jobs. */
	readonly archive: readonly ArchivedPhoto[];
	/** The G-code the seller submits. */
	readonly gcode: string;
	readonly telemetry: { readonly frames: readonly TelemetryFrame[]; readonly publicKey: KeyObject };
	readonly photos: readonly Photo[];
};

export type PrintVerdict = {
	readonly result: "VERIFIED" | "REJECTED";
	readonly reasons: readonly PrintRejectReason[];
	readonly placement: Placement | null;
};

type Expectation = {
	readonly plate: Plate;
	readonly plateBox: Box;
	readonly sections: ReadonlyMap<number, readonly Ring[]>;
	readonly interiors: ReadonlyMap<number, readonly Ring[]>;
};

/** The plate the contract expects, and the mesh sections at each sampled layer's mid height. */
async function expectationFor(input: Pick<PrintEvidence, "contract" | "partStl" | "seed">): Promise<Expectation> {
	const { contract } = input;
	const spec = contract.publicTerms.spec;
	const part = meshStats(input.partStl);
	if (!part.ok) throw new Error("contract part STL is invalid");
	const plate = await buildPlate({
		partStl: input.partStl,
		partBox: part.value.bboxMm,
		coupon: witnessCoupon(contract.jobId, input.seed),
		quantity: spec.quantity,
	});
	const plateStats = meshStats(plate.stl);
	if (!plateStats.ok) throw new Error("expected plate is invalid");
	const layerHeight = contract.publicTerms.layerHeightMm;
	const sections = new Map<number, readonly Ring[]>();
	const interiors = new Map<number, readonly Ring[]>();
	for (const layer of contract.hidden.sampleLayers) {
		const z = (layer - 0.5) * layerHeight;
		sections.set(layer, await sectionRings(plate.stl, z));
		interiors.set(layer, await interiorRings(plate.stl, z, spec.walls * NOZZLE_WIDTH_MM));
	}
	return { plate, plateBox: plateStats.value.bboxMm, sections, interiors };
}

/** The part count the first sampled layer shows on the contract section, coupon islands included. */
function islandCount(rings: readonly Ring[]): number {
	return rings.filter(ring => {
		const area = signedArea(ring);
		return area > 0 && area >= MIN_UNIT_AREA_MM2;
	}).length;
}

function signedArea(ring: Ring): number {
	let twice = 0;
	for (let i = 0; i < ring.length; i++) {
		const [ax, ay] = ring[i];
		const [bx, by] = ring[(i + 1) % ring.length];
		twice += ax * by - bx * ay;
	}
	return twice / 2;
}

function conformanceOf(input: Pick<PrintEvidence, "contract" | "bedMm">, expectation: Expectation, gcode: ParsedGcode): Conformance {
	const spec = input.contract.publicTerms.spec;
	const sampled = input.contract.hidden.sampleLayers;
	return conform({
		gcode,
		meshBox: expectation.plateBox,
		layerHeightMm: input.contract.publicTerms.layerHeightMm,
		sampleLayers: sampled,
		sections: expectation.sections,
		interiors: expectation.interiors,
		infillPct: spec.infillPct,
		toleranceMm: spec.toleranceMm,
		expectedUnits: islandCount(expectation.sections.get(sampled[0]) ?? []),
		bedMm: input.bedMm,
	});
}

/** The offset between the G-code and the mesh frame. The camera window is set from it. Null when the G-code does not parse. */
export async function measurePlacement(input: Pick<PrintEvidence, "contract" | "partStl" | "seed" | "bedMm" | "gcode">): Promise<Placement | null> {
	const parsed = parseGcode(input.gcode);
	if (!parsed.ok) return null;
	return conformanceOf(input, await expectationFor(input), parsed.value).measured.placement;
}

export async function verifyPrint(input: PrintEvidence): Promise<PrintVerdict> {
	const parsed = parseGcode(input.gcode);
	if (!parsed.ok) return { result: "REJECTED", reasons: [parsed.reason], placement: null };

	const expectation = await expectationFor(input);
	const layerHeight = input.contract.publicTerms.layerHeightMm;
	const conformance = conformanceOf(input, expectation, parsed.value);
	const placement = conformance.measured.placement;

	const coupon = checkCoupon({
		gcode: parsed.value,
		layerHeightMm: layerHeight,
		coupon: witnessCoupon(input.contract.jobId, input.seed),
		origin: expectation.plate.layout.couponOrigin,
		placement,
	});

	const telemetry = checkTelemetry({
		frames: input.telemetry.frames,
		publicKey: input.telemetry.publicKey,
		gcodeSha256: sha256Hex(new TextEncoder().encode(input.gcode)),
		gcode: parsed.value,
		estimateSeconds: estimateTime(parsed.value).totalSeconds,
	});

	// A photo of a layer the contract did not sample has no section to compare with, so it cannot pass.
	const unsampled: PrintRejectReason[] = input.photos
		.filter(photo => !expectation.sections.has(photo.layer))
		.map(photo => ({ kind: "PHOTO_UNREADABLE", layer: photo.layer }));
	const sampled = input.photos.filter(photo => expectation.sections.has(photo.layer));
	const photos = checkPhotos({
		photos: sampled,
		sections: expectation.sections,
		placement,
		meshBox: expectation.plateBox,
		archive: input.archive,
	});
	// Every layer the contract samples needs its own photo. A print with a layer's photo left out fails like one
	// with a wrong photo, so no caller can pass a print by sending less evidence.
	const shot = new Set(input.photos.map(photo => photo.layer));
	const missing: PrintRejectReason[] = input.contract.hidden.sampleLayers
		.filter(layer => !shot.has(layer))
		.map(layer => ({ kind: "PHOTO_MISSING", layer }));

	const reasons: PrintRejectReason[] = [...conformance.reasons, ...coupon.reasons, ...telemetry, ...unsampled, ...missing, ...photos.reasons];
	return { result: reasons.length === 0 ? "VERIFIED" : "REJECTED", reasons, placement };
}
