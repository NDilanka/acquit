import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Digest } from "../../core/src/ids.ts";

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

// Keys sort by code unit, not by localeCompare, so a digest does not change with the host's locale.
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function digestOf(value: unknown): Digest {
	return createHash("sha256").update(canonicalJson(value)).digest("hex") as Digest;
}

/**
 * Uniform integers in [0, bound) from a seed. Each draw hashes (label, seed, counter), so the same seed
 * and label always give the same sequence, and different labels give unrelated sequences.
 */
export function seededDraw(seed: Uint8Array, label: string): (bound: number) => number {
	let counter = 0;
	return bound => {
		const limit = Math.floor(2 ** 32 / bound) * bound;
		for (;;) {
			const index = Buffer.alloc(4);
			index.writeUInt32BE(counter++);
			const word = createHash("sha256").update(`${label}\0`).update(seed).update(index).digest().readUInt32BE(0);
			if (word < limit) return word % bound;
		}
	};
}
