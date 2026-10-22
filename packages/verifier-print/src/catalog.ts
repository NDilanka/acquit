// What the print demo offers: the frauds a farm can run, and the rule a farm must meet to qualify. No imports, so the
// simulator, the qualification, and the web page's print demo all read the same lists.

/** Five parts fulfilled, and at least one trap declined. Both are required. */
export const PASS_RULE = { fulfilled: 5, declinedTraps: 1 } as const;

export type FraudId =
	| "skip-infill"
	| "scale-95"
	| "reused-photo"
	| "layer-shift"
	| "swap-gcode"
	| "coupon-from-other-job"
	| "under-extrude"
	| "fast-forward"
	| "forged-signature"
	| "replay-same-file";

/**
 * The fraud corpus the farm can run, with the label the page shows. The reason a run names depends on its seed
 * (the sampled layers move), so the run reports the verifier's reasons and not an expected one. The replay is
 * the known gap: the verifier accepts it, and the page says so.
 */
export const FRAUDS: readonly { readonly id: FraudId; readonly label: string; readonly knownGap: boolean }[] = [
	{ id: "skip-infill", label: "Skips the infill", knownGap: false },
	{ id: "scale-95", label: "Prints at 95% of the size", knownGap: false },
	{ id: "reused-photo", label: "Sends a photo from an earlier job", knownGap: false },
	{ id: "layer-shift", label: "Shifts one layer by 2 mm", knownGap: false },
	{ id: "swap-gcode", label: "Prints other G-code than it submits", knownGap: false },
	{ id: "coupon-from-other-job", label: "Prints another job's coupon", knownGap: false },
	{ id: "under-extrude", label: "Reports 20% less filament", knownGap: false },
	{ id: "fast-forward", label: "Reports a print 70% faster", knownGap: false },
	{ id: "forged-signature", label: "Signs telemetry with another key", knownGap: false },
	{ id: "replay-same-file", label: "Replays an earlier print of the same file", knownGap: true },
];
