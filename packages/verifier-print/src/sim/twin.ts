// SIMULATED printer host. It walks the G-code moves in virtual time with the estimator's trapezoid model,
// and emits signed, chained telemetry frames. A real host would report the same fields. Every output
// carries simulated: true, so nothing here can be shown as a measurement.

import { DEFAULT_LIMITS, trapezoidSeconds } from "../estimate.ts";
import { frameDigest, signBody } from "../telemetry.ts";
import type { FrameBody, PrinterKeys, TelemetryFrame } from "../telemetry.ts";
import type { ParsedGcode, PrinterLimits } from "../types.ts";

/** A frame every 30 virtual seconds, plus one at each layer change and at the end. */
export const TWIN_INTERVAL_S = 30;

export type TwinOptions = {
	readonly printerId: string;
	readonly keys: PrinterKeys;
	readonly fileHash: string;
	readonly gcode: ParsedGcode;
	/** 1 reports the extrusion the G-code asks for. 0.8 is a host that reports 20% less. */
	readonly filamentReportScale?: number;
	/** 1 runs the moves at the estimated speed. 0.3 is a print that finishes in 30% of its estimate. */
	readonly timeScale?: number;
	readonly limits?: PrinterLimits;
};

export type TwinRun = {
	readonly simulated: true;
	readonly printerId: string;
	readonly frames: readonly TelemetryFrame[];
};

export function runTwin(options: TwinOptions): TwinRun {
	const limits = options.limits ?? DEFAULT_LIMITS;
	const scale = options.filamentReportScale ?? 1;
	const timeScale = options.timeScale ?? 1;
	const frames: TelemetryFrame[] = [];
	let clockS = 0;
	let extrudedMm = 0;
	let layer = -1;
	let lastEmitS = -Infinity;

	const emit = (): void => {
		const seq = frames.length;
		const body: FrameBody = {
			printerId: options.printerId,
			seq,
			t: Math.round(clockS * 1000),
			layer,
			z: layer < 0 ? 0 : options.gcode.layers[layer].z,
			e: extrudedMm * scale,
			hotendC: 215 + 0.4 * Math.sin(seq),
			bedC: 60 + 0.2 * Math.cos(seq),
			fileHash: options.fileHash,
			prevHash: seq === 0 ? null : frameDigest(frames[seq - 1]),
		};
		frames.push(signBody(body, options.keys.privateKey));
		lastEmitS = clockS;
	};

	emit();
	for (const move of options.gcode.moves) {
		if (move.layer !== layer) {
			layer = move.layer;
			emit();
		} else if (clockS - lastEmitS >= TWIN_INTERVAL_S) {
			emit();
		}
		const feed = move.feedMmPerSec === null
			? limits.maxFeedMmPerSec
			: Math.min(move.feedMmPerSec, limits.maxFeedMmPerSec);
		clockS += timeScale * trapezoidSeconds(move.distanceMm, feed, limits.accelMmPerSec2);
		extrudedMm += Math.max(0, move.deltaEMm);
	}
	emit();
	return { simulated: true, printerId: options.printerId, frames };
}
