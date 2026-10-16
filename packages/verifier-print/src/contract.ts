// Freeze and reveal for the print contract. The job row keeps only hiddenDigest. The hidden terms stay
// in the private store until close. After close the seed is published, so anyone can rebuild the hidden
// terms and the salt from it and check them against the digest frozen at open.

import { createHash } from "node:crypto";
import type { Digest, Instant, JobId } from "../../core/src/ids.ts";
import type { Vertical } from "../../core/src/outcome.ts";
import { coupon } from "./coupon.ts";
import { digestOf, seededDraw } from "./digest.ts";
import { meshRejection } from "./stl.ts";
import type { Checked, FieldError, FrozenPrintContract, HiddenTerms, MeshStats, PrintSpec } from "./types.ts";

export const PRINT_VERTICAL = "print-fdm" as Vertical;
export const SAMPLE_LAYERS = 8;
export const MIN_SEED_BYTES = 16;

export type FreezeInput = {
	readonly jobId: JobId;
	readonly spec: PrintSpec;
	readonly mesh: MeshStats;
	readonly seed: Uint8Array;
	readonly at: Instant;
};

export type Reveal = { readonly hidden: HiddenTerms; readonly salt: string };

function saltOf(seed: Uint8Array): string {
	return createHash("sha256").update("print-salt\0").update(seed).digest("hex");
}

export function sampleLayers(seed: Uint8Array, layerCount: number): number[] {
	const draw = seededDraw(seed, "hidden:sample-layers");
	const want = Math.min(SAMPLE_LAYERS, layerCount);
	const picked = new Set<number>();
	while (picked.size < want) picked.add(1 + draw(layerCount));
	return [...picked].sort((a, b) => a - b);
}

export function hiddenDigest(hidden: HiddenTerms, salt: string): Digest {
	return digestOf({ hidden, salt });
}

export function freeze(input: FreezeInput): Checked<FrozenPrintContract> {
	const errors: FieldError[] = [];
	if (input.seed.byteLength < MIN_SEED_BYTES) errors.push({ path: "seed", message: "seed must be at least 16 bytes" });
	if (input.mesh.digest !== input.spec.modelDigest) errors.push({ path: "modelDigest", message: "mesh does not match the spec's model digest" });
	if (meshRejection(input.mesh) !== null) errors.push({ path: "model", message: "mesh is not watertight" });
	if (errors.length > 0) return { ok: false, errors };

	// Epsilon keeps an exact multiple (20 mm at 0.2 mm) from rounding up one layer.
	const layerCount = Math.ceil(input.mesh.sizeMm[2] / input.spec.maxLayerHeightMm - 1e-9);
	const marker = coupon(input.jobId, input.seed);
	const hidden: HiddenTerms = { sampleLayers: sampleLayers(input.seed, layerCount) };
	return {
		ok: true,
		value: {
			vertical: PRINT_VERTICAL,
			jobId: input.jobId,
			publicTerms: {
				spec: input.spec,
				mesh: input.mesh,
				layerHeightMm: input.spec.maxLayerHeightMm,
				layerCount,
				markerId: marker.markerId,
				couponDigest: digestOf(marker),
			},
			hidden,
			hiddenDigest: hiddenDigest(hidden, saltOf(input.seed)),
			frozenAt: input.at,
		},
	};
}

export function reveal(contract: FrozenPrintContract, seed: Uint8Array): Reveal {
	return {
		hidden: { sampleLayers: sampleLayers(seed, contract.publicTerms.layerCount) },
		salt: saltOf(seed),
	};
}

export function verifyReveal(contract: FrozenPrintContract, revealed: Reveal): boolean {
	return hiddenDigest(revealed.hidden, revealed.salt) === contract.hiddenDigest;
}
