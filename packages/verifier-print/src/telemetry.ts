// Printer telemetry. One Ed25519 key per printer. Each frame is signed over its canonical JSON, and it
// carries the hash of the frame before it, so a dropped, reordered or edited frame breaks the chain. Every
// check reads the frames and the G-code. The seller's own summary is never read.

import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalJson } from "./digest.ts";
import type { ParsedGcode, PrintRejectReason } from "./types.ts";

/** Filament may differ from the G-code's extrusion by this fraction. A 20% shortfall fails. */
export const FILAMENT_TOLERANCE = 0.05;
/** The printed duration may differ from the estimate by this fraction. */
export const DURATION_TOLERANCE = 0.15;
const LAYER_Z_EPSILON_MM = 1e-3;

export type TelemetryFrame = {
	readonly printerId: string;
	readonly seq: number;
	/** Milliseconds since the start of the print, on the printer host's clock. */
	readonly t: number;
	/** Index into the G-code layers, or -1 before the first layer. */
	readonly layer: number;
	readonly z: number;
	/** Cumulative positive filament length, in mm, as the host reports it. */
	readonly e: number;
	readonly hotendC: number;
	readonly bedC: number;
	/** Hex SHA-256 of the G-code bytes the printer is running. */
	readonly fileHash: string;
	/** Hex digest of the previous frame, sig included. Null on the first frame. */
	readonly prevHash: string | null;
	/** Base64 Ed25519 signature over the canonical JSON of the frame without sig. */
	readonly sig: string;
};

export type FrameBody = Omit<TelemetryFrame, "sig">;

export type PrinterKeys = { readonly publicKey: KeyObject; readonly privateKey: KeyObject };

export function newPrinterKeys(): PrinterKeys {
	const pair = generateKeyPairSync("ed25519");
	return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export function frameDigest(frame: TelemetryFrame): string {
	return createHash("sha256").update(canonicalJson(frame)).digest("hex");
}

export function signBody(body: FrameBody, privateKey: KeyObject): TelemetryFrame {
	const sig = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64");
	return { ...body, sig };
}

export function signatureValid(frame: TelemetryFrame, publicKey: KeyObject): boolean {
	const { sig, ...body } = frame;
	try {
		return verify(null, Buffer.from(canonicalJson(body)), publicKey, Buffer.from(sig, "base64"));
	} catch {
		return false;
	}
}

export type TelemetryInput = {
	readonly frames: readonly TelemetryFrame[];
	readonly publicKey: KeyObject;
	readonly gcodeSha256: string;
	readonly gcode: ParsedGcode;
	readonly estimateSeconds: number;
};

/** The first failure of each kind. A broken frame usually breaks the chain after it too. */
export function checkTelemetry(input: TelemetryInput): PrintRejectReason[] {
	const { frames, gcode } = input;
	if (frames.length === 0) return [{ kind: "TELEMETRY_MISSING" }];
	const reasons: PrintRejectReason[] = [];

	const unsigned = frames.find(frame => !signatureValid(frame, input.publicKey));
	if (unsigned) reasons.push({ kind: "TELEMETRY_SIGNATURE_INVALID", seq: unsigned.seq });

	const broken = frames.findIndex((frame, i) => frame.seq !== i || frame.prevHash !== (i === 0 ? null : frameDigest(frames[i - 1])));
	if (broken >= 0) reasons.push({ kind: "TELEMETRY_CHAIN_BROKEN", seq: frames[broken].seq });

	const otherFile = frames.find(frame => frame.fileHash !== input.gcodeSha256);
	if (otherFile) reasons.push({ kind: "FILE_HASH_MISMATCH", seq: otherFile.seq });

	const outOfOrder = frames.findIndex((frame, i) => {
		if (!layerMatches(frame, gcode)) return true;
		if (i === 0) return false;
		const prev = frames[i - 1];
		return frame.layer < prev.layer || frame.t < prev.t || frame.e < prev.e;
	});
	if (outOfOrder >= 0) reasons.push({ kind: "LAYER_SEQUENCE_MISMATCH", seq: frames[outOfOrder].seq });

	const last = frames[frames.length - 1];
	const gcodeMm = gcode.extrudedMm;
	if (Math.abs(last.e - gcodeMm) > FILAMENT_TOLERANCE * gcodeMm) {
		reasons.push({ kind: "FILAMENT_MISMATCH", gcodeMm: round2(gcodeMm), telemetryMm: round2(last.e) });
	}

	const telemetryS = last.t / 1000;
	if (input.estimateSeconds > 0 && Math.abs(telemetryS / input.estimateSeconds - 1) > DURATION_TOLERANCE) {
		reasons.push({ kind: "DURATION_IMPLAUSIBLE", estimateS: round2(input.estimateSeconds), telemetryS: round2(telemetryS) });
	}
	return reasons;
}

function layerMatches(frame: TelemetryFrame, gcode: ParsedGcode): boolean {
	if (frame.layer === -1) return Math.abs(frame.z) < LAYER_Z_EPSILON_MM;
	const layer = gcode.layers[frame.layer];
	return layer !== undefined && Math.abs(layer.z - frame.z) < LAYER_Z_EPSILON_MM;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
