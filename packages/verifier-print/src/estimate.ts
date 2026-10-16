// Trapezoid time estimate. Each move starts and ends at rest, so the time of a move never depends on the
// moves around it. That is an upper bound on the same moves under any junction planner with the same
// acceleration and feedrate limits, and never below the cruise-only time (distance over capped feedrate).

import { mmPerSecond, mmPerSecondSquared, seconds } from "./types.ts";
import type { ParsedGcode, PrinterLimits, TimeEstimate } from "./types.ts";

// Placeholder defaults until a printer profile reaches the spec (P3). They are not measured on any printer.
export const DEFAULT_LIMITS: PrinterLimits = {
	accelMmPerSec2: mmPerSecondSquared(1000),
	maxFeedMmPerSec: mmPerSecond(200),
};

export function trapezoidSeconds(distanceMm: number, feedMmPerSec: number, accelMmPerSec2: number): number {
	if (distanceMm <= 0) return 0;
	const accelDistance = (feedMmPerSec * feedMmPerSec) / (2 * accelMmPerSec2);
	if (2 * accelDistance >= distanceMm) return 2 * Math.sqrt(distanceMm / accelMmPerSec2);
	return (2 * feedMmPerSec) / accelMmPerSec2 + (distanceMm - 2 * accelDistance) / feedMmPerSec;
}

export function estimateTime(parsed: ParsedGcode, limits: PrinterLimits = DEFAULT_LIMITS): TimeEstimate {
	const perLayer = parsed.layers.map(layer => ({ index: layer.index, z: layer.z, seconds: 0 }));
	let total = 0;
	for (const move of parsed.moves) {
		const feed = move.feedMmPerSec === null
			? limits.maxFeedMmPerSec
			: Math.min(move.feedMmPerSec, limits.maxFeedMmPerSec);
		const time = trapezoidSeconds(move.distanceMm, feed, limits.accelMmPerSec2);
		total += time;
		if (move.layer >= 0) perLayer[move.layer].seconds += time;
	}
	return {
		totalSeconds: seconds(total),
		layers: perLayer.map(layer => ({ index: layer.index, z: layer.z, seconds: seconds(layer.seconds) })),
	};
}
