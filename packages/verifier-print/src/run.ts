// One print demo run, end to end, in-process: a simulated farm qualifies against the suite, and a qualified farm
// prints one job that the real judge verifies. The run's job is opened here and never enters the core's job
// store, and nothing in it reaches PayPal. Every farm, twin, and camera output is simulated, and the record says so.

import { createHash } from "node:crypto";
import type { Instant, JobId } from "../../core/src/ids.ts";
import { FRAUDS } from "./catalog.ts";
import { coupon } from "./coupon.ts";
import { describePrintReason } from "./describe.ts";
import { estimateTime } from "./estimate.ts";
import { parseGcode } from "./gcode.ts";
import { openPrintJob } from "./open.ts";
import type { OpenedPrintJob } from "./open.ts";
import { certify, printQualification, qualifies } from "./qualify.ts";
import type { QualificationCertificate, QualificationResult } from "./qualify.ts";
import { simFarm } from "./sim/farm.ts";
import type { FarmMode, PrintSource } from "./sim/farm.ts";
import { FARM_BED_MM } from "./sim/farm.ts";
import { newPrinterKeys } from "./telemetry.ts";
import { partStl } from "./sim/synthetic-gcode.ts";
import { verifyPrint } from "./verify.ts";
import type { PrintVerdict } from "./verify.ts";

/** The farm each mode runs as. The name is the page's; the mode is the one the run executes. */
export const FARM_NAMES: Readonly<Record<"honest" | "sloppy" | "fraud", string>> = { honest: "Orbit Farm", sloppy: "Lantern Farm", fraud: "Shady Farm" };

export type RunChallenge = { readonly id: string; readonly label: string; readonly expect: "FULFIL" | "DECLINE"; readonly passed: boolean; readonly detail: string };

export type PrintDemoRun = {
	readonly farm: { readonly mode: FarmMode; readonly name: string; readonly simulated: true };
	readonly qualification: {
		readonly fulfilled: number;
		readonly declinedTraps: number;
		readonly qualified: boolean;
		readonly challenges: readonly RunChallenge[];
	};
	readonly certificate: QualificationCertificate | null;
	/** The one print, or null when the farm did not qualify. */
	readonly print: PrintOutcome | null;
};

export type PrintOutcome = {
	readonly job: { readonly label: string; readonly quantity: number; readonly infillPct: number };
	/** The corpus mutation the farm ran, or null for an honest print. knownGap marks the one the verifier accepts. */
	readonly fraud: { readonly id: string; readonly label: string; readonly knownGap: boolean } | null;
	/** What the G-code and the printer's telemetry say about the print. The verifier reads the same numbers. */
	readonly evidence: {
		readonly layers: number;
		readonly filamentMm: number;
		readonly estimatedS: number;
		readonly telemetryFilamentMm: number;
		readonly telemetryS: number;
		readonly frames: number;
		readonly photos: number;
	};
	readonly verdict: PrintVerdict["result"];
	readonly reasons: readonly { readonly kind: string; readonly text: string }[];
};

export type RunInput = {
	readonly mode: FarmMode;
	/** The run's seed. Every part, key, and draw in the run derives from it, so one seed replays one run. */
	readonly seed: Uint8Array;
	readonly at: Instant;
};

const JOB = { label: "Two 14 mm cubes, 25% infill", quantity: 2, infillPct: 25 } as const;

function derive(seed: Uint8Array, label: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(`print-demo\0${label}\0`).update(seed).digest());
}

function nameOf(mode: FarmMode): string {
	if (mode === "honest") return FARM_NAMES.honest;
	if (mode === "sloppy") return FARM_NAMES.sloppy;
	return FARM_NAMES.fraud;
}

export async function runPrintDemo(input: RunInput): Promise<PrintDemoRun> {
	const name = nameOf(input.mode);
	const keys = newPrinterKeys();
	const farm = simFarm({ mode: input.mode, id: `${name} printer`, keys, seed: derive(input.seed, "farm") });
	const suite = printQualification(keys.publicKey);

	const challenges = await suite.challenges(derive(input.seed, "qualify"));
	const results: QualificationResult[] = [];
	for (const challenge of challenges) {
		results.push(await suite.grade(challenge, await farm.answer(challenge.spec)));
	}
	const tally = qualifies(suite.passRule, challenges, results);
	const runChallenges: RunChallenge[] = challenges.map((challenge, i) => ({
		id: challenge.id,
		label: challenge.spec.label,
		expect: challenge.expect,
		passed: results[i].passed,
		detail: results[i].detail,
	}));
	const qualification = { fulfilled: tally.fulfilled, declinedTraps: tally.declinedTraps, qualified: tally.qualified, challenges: runChallenges };
	const farmRecord = { mode: input.mode, name, simulated: true as const };
	if (!tally.qualified) return { farm: farmRecord, qualification, certificate: null, print: null };

	const certificate = certify({ seller: `${name} (Simulated)`, fulfilled: tally.fulfilled, declinedTraps: tally.declinedTraps, issuedAt: input.at });
	const opened = await openPrintJob({
		jobId: "job_print_demo" as JobId,
		partStl: await partStl("cube", 14),
		seed: derive(input.seed, "job"),
		quantity: JOB.quantity,
		infillPct: JOB.infillPct,
		at: input.at,
	});
	if (!opened.ok) throw new Error(`the demo job did not open: ${opened.errors[0]?.message ?? "refused"}`);
	const job: OpenedPrintJob = opened.value;
	const source: PrintSource = {
		jobId: job.jobId,
		quantity: job.quantity,
		partStl: job.partStl,
		partBox: job.partBox,
		coupon: coupon(job.jobId, job.seed),
		plateStl: job.plate.stl,
		partOrigins: job.plate.layout.partOrigins,
		infillPct: job.infillPct,
		photoLayers: job.contract.hidden.sampleLayers,
	};
	const submission = await farm.print(source);
	const parsed = parseGcode(submission.gcode);
	if (!parsed.ok) throw new Error("the farm's G-code does not parse");
	const verdict = await verifyPrint({
		contract: job.contract,
		partStl: job.partStl,
		seed: job.seed,
		bedMm: FARM_BED_MM,
		archive: submission.archive ?? [],
		gcode: submission.gcode,
		telemetry: { frames: submission.frames, publicKey: keys.publicKey },
		photos: submission.photos,
	});
	const last = submission.frames[submission.frames.length - 1];
	const fraud = FRAUDS.find(item => input.mode === `fraud:${item.id}`) ?? null;
	return {
		farm: farmRecord,
		qualification,
		certificate,
		print: {
			job: { label: JOB.label, quantity: JOB.quantity, infillPct: JOB.infillPct },
			fraud,
			evidence: {
				layers: parsed.value.layers.length,
				filamentMm: round1(parsed.value.extrudedMm),
				estimatedS: Math.round(estimateTime(parsed.value).totalSeconds),
				telemetryFilamentMm: round1(last.e),
				telemetryS: Math.round(last.t / 1000),
				frames: submission.frames.length,
				photos: submission.photos.length,
			},
			verdict: verdict.result,
			reasons: verdict.reasons.map(reason => ({ kind: reason.kind, text: describePrintReason(reason) })),
		},
	};
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}
