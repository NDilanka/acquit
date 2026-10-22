import assert from "node:assert/strict";
import test from "node:test";
import { describePrintReason } from "../src/describe.ts";
import type { PrintRejectReason } from "../src/types.ts";
import { FRAUDS } from "../src/catalog.ts";
import { parseFarmMode } from "../src/sim/farm.ts";
import type { FarmMode } from "../src/sim/farm.ts";
import { runPrintDemo } from "../src/run.ts";
import type { PrintDemoRun } from "../src/run.ts";
import type { Instant } from "../../core/src/ids.ts";

// Every run here uses one seed, so each run's sampled layers and camera noise are the same on every CI job.
const SEED = new Uint8Array(32).fill(7);
const AT = "2026-10-23T09:00:00Z" as Instant;

function runOf(mode: FarmMode): Promise<PrintDemoRun> {
	return runPrintDemo({ mode, seed: SEED, at: AT });
}

test("an honest farm qualifies, holds a certificate, and prints one job the judge verifies", async () => {
	const run = await runOf("honest");
	assert.equal(run.farm.simulated, true);
	assert.equal(run.farm.name, "Orbit Farm");
	assert.equal(run.qualification.qualified, true);
	assert.equal(run.qualification.challenges.length, 6);
	assert.ok(run.certificate, "a qualified farm holds a certificate");
	assert.equal(run.certificate.fulfilled, 5);
	assert.equal(run.certificate.declinedTraps, 1);
	const print = run.print;
	assert.ok(print, "a qualified farm prints");
	assert.equal(print.fraud, null);
	assert.equal(print.verdict, "VERIFIED", JSON.stringify(print.reasons));
	assert.deepEqual(print.reasons, []);
	assert.equal(print.evidence.layers, 40);
	assert.equal(print.evidence.photos, 8, "one photo for each sampled layer");
	assert.ok(print.evidence.frames > 2);
	// The honest printer runs at the estimate, so its telemetry agrees with the G-code's own filament and time.
	assert.ok(Math.abs(print.evidence.telemetryFilamentMm - print.evidence.filamentMm) <= 0.05 * print.evidence.filamentMm);
	assert.ok(Math.abs(print.evidence.telemetryS - print.evidence.estimatedS) <= 0.15 * print.evidence.estimatedS);
});

test("a sloppy farm that accepts the trap does not qualify, so it prints nothing and holds no certificate", async () => {
	const run = await runOf("sloppy");
	assert.equal(run.farm.name, "Lantern Farm");
	assert.equal(run.qualification.qualified, false);
	assert.equal(run.qualification.declinedTraps, 0);
	assert.equal(run.certificate, null);
	assert.equal(run.print, null);
});

// The reason each fraud's first verdict names, for this seed. The sampled layers move with the seed, so another
// seed may name another reason; the score card pins the corpus on its own seeds.
const OBSERVED: Readonly<Record<string, string>> = {
	"skip-infill": "INFILL_BELOW_CONTRACT",
	"scale-95": "SCALE_OUT_OF_TOLERANCE",
	"reused-photo": "PHOTO_REUSED",
	"layer-shift": "OUTSIDE_MATERIAL",
	"swap-gcode": "FILE_HASH_MISMATCH",
	"coupon-from-other-job": "FOOTPRINT_MISMATCH",
	"under-extrude": "FILAMENT_MISMATCH",
	"fast-forward": "DURATION_IMPLAUSIBLE",
	"forged-signature": "TELEMETRY_SIGNATURE_INVALID",
};

for (const fraud of FRAUDS.filter(item => !item.knownGap)) {
	test(`the ${fraud.id} farm qualifies, then its print is rejected with the reason the verifier names`, async () => {
		const run = await runOf(`fraud:${fraud.id}`);
		assert.equal(run.qualification.qualified, true, "a fraud farm qualifies honestly, then cheats on the job");
		assert.equal(run.print?.fraud?.id, fraud.id);
		assert.equal(run.print?.verdict, "REJECTED");
		const kinds = run.print?.reasons.map(reason => reason.kind) ?? [];
		assert.equal(kinds[0], OBSERVED[fraud.id], kinds.join(", "));
		assert.ok(run.print?.reasons.every(reason => reason.text.length > 0));
	});
}

test("the replay farm is the known gap: its replayed print verifies, and the run says so", async () => {
	const run = await runOf("fraud:replay-same-file");
	assert.equal(run.qualification.qualified, true);
	assert.equal(run.print?.fraud?.knownGap, true);
	assert.equal(run.print?.verdict, "VERIFIED");
	assert.deepEqual(run.print?.reasons, []);
});

test("a farm mode parses only to a mode the run knows", () => {
	assert.equal(parseFarmMode("honest"), "honest");
	assert.equal(parseFarmMode("sloppy"), "sloppy");
	assert.equal(parseFarmMode("fraud:skip-infill"), "fraud:skip-infill");
	assert.equal(parseFarmMode("fraud:"), null);
	assert.equal(parseFarmMode("fraud:made-up"), null);
	assert.equal(parseFarmMode("shady"), null);
});

test("every reason has plain wording and no long dash", () => {
	const reasons: PrintRejectReason[] = [
		{ kind: "MESH_NOT_MANIFOLD" },
		{ kind: "GCODE_UNPARSEABLE", line: 4 },
		{ kind: "INFILL_BELOW_CONTRACT", layer: 3, pct: 4, contractPct: 40 },
		{ kind: "FOOTPRINT_MISMATCH", layer: 3, iou: 0.5 },
		{ kind: "OUTSIDE_MATERIAL", layer: 3, pct: 9 },
		{ kind: "BED_OUT_OF_BOUNDS", axis: "X", gcodeMm: 260, boundMm: 250 },
		{ kind: "SCALE_OUT_OF_TOLERANCE", axis: "X", gcodeMm: 13.3, meshMm: 14 },
		{ kind: "UNIT_COUNT_MISMATCH", expected: 2, found: 1 },
		{ kind: "COUPON_MISSING" },
		{ kind: "COUPON_IOU_LOW", iou: 0.4 },
		{ kind: "COUPON_MARKER_MISMATCH", expected: 3, found: 9 },
		{ kind: "PHOTO_UNREADABLE", layer: 3 },
		{ kind: "GEOMETRY_MISMATCH", layer: 3, iou: 0.5 },
		{ kind: "PHOTO_REUSED", layer: 3, distance: 1 },
		{ kind: "TELEMETRY_MISSING" },
		{ kind: "TELEMETRY_SIGNATURE_INVALID", seq: 2 },
		{ kind: "TELEMETRY_CHAIN_BROKEN", seq: 2 },
		{ kind: "FILE_HASH_MISMATCH", seq: 2 },
		{ kind: "LAYER_SEQUENCE_MISMATCH", seq: 2 },
		{ kind: "FILAMENT_MISMATCH", gcodeMm: 1000, telemetryMm: 800 },
		{ kind: "DURATION_IMPLAUSIBLE", estimateS: 1000, telemetryS: 300 },
	];
	for (const reason of reasons) {
		const text = describePrintReason(reason);
		assert.ok(text.length > 0, reason.kind);
		assert.doesNotMatch(text, /[\u2013\u2014]/, reason.kind);
	}
	assert.equal(describePrintReason({ kind: "INFILL_BELOW_CONTRACT", layer: 3, pct: 4, contractPct: 40 }), "Infill 4% on layer 3, below the contract's 40%.");
});
