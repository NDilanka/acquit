// Opens a print job for the judge: the spec from the client's part, the frozen contract with its hidden
// sample layers, and the plate the seller prints, with the job's coupon on it. The seed stays with the
// verifier until close, so the seller only ever receives the plate.

import type { Instant, JobId } from "../../core/src/ids.ts";
import { freeze } from "./contract.ts";
import { coupon } from "./coupon.ts";
import { buildPlate } from "./plate.ts";
import type { Plate } from "./plate.ts";
import { meshStats } from "./stl.ts";
import { validateSpec } from "./spec.ts";
import type { Box, Checked, FrozenPrintContract } from "./types.ts";

/** The layer height the demo prints at, in mm. The contract's sample layers sit on this grid. */
export const JOB_LAYER_MM = 0.2;
const DAY_MS = 86_400_000;

export type OpenPrintInput = {
	readonly jobId: JobId;
	/** The client's part, as binary or ASCII STL bytes. */
	readonly partStl: Uint8Array;
	/** The job seed. At least 16 bytes; it rebuilds the coupon and the hidden sample layers at close. */
	readonly seed: Uint8Array;
	readonly quantity: number;
	readonly infillPct: number;
	readonly at: Instant;
};

export type OpenedPrintJob = {
	readonly jobId: JobId;
	readonly seed: Uint8Array;
	readonly partStl: Uint8Array;
	readonly partBox: Box;
	readonly contract: FrozenPrintContract;
	readonly quantity: number;
	readonly infillPct: number;
	/** What the seller prints: every unit, and the coupon, on one bed plate. */
	readonly plate: Plate;
	readonly plateBox: Box;
};

/** A UTC instant at whole seconds, the form the spec's deadline fields take. */
export function instantAt(ms: number): Instant {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") as Instant;
}

function instantAfter(at: Instant, days: number): Instant {
	return instantAt(Date.parse(at) + days * DAY_MS);
}

export async function openPrintJob(input: OpenPrintInput): Promise<Checked<OpenedPrintJob>> {
	const mesh = meshStats(input.partStl);
	if (!mesh.ok) return { ok: false, errors: [{ path: "partStl", message: "part STL is invalid" }] };
	const spec = validateSpec({
		modelDigest: mesh.value.digest,
		material: "PLA",
		color: { name: "white", hex: null },
		quantity: input.quantity,
		toleranceMm: 0.2,
		infillPct: input.infillPct,
		walls: 2,
		maxLayerHeightMm: JOB_LAYER_MM,
		printBy: instantAfter(input.at, 7),
		deliverBy: instantAfter(input.at, 14),
	});
	if (!spec.ok) return spec;
	const frozen = freeze({ jobId: input.jobId, spec: spec.value, mesh: mesh.value, seed: input.seed, at: input.at });
	if (!frozen.ok) return frozen;
	const plate = await buildPlate({ partStl: input.partStl, partBox: mesh.value.bboxMm, coupon: coupon(input.jobId, input.seed), quantity: input.quantity });
	const plateMesh = meshStats(plate.stl);
	if (!plateMesh.ok) return { ok: false, errors: [{ path: "plate", message: "plate STL is invalid" }] };
	return {
		ok: true,
		value: {
			jobId: input.jobId,
			seed: input.seed,
			partStl: input.partStl,
			partBox: mesh.value.bboxMm,
			contract: frozen.value,
			quantity: input.quantity,
			infillPct: input.infillPct,
			plate,
			plateBox: plateMesh.value.bboxMm,
		},
	};
}
