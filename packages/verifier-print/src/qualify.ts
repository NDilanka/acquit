// Qualification: a print farm proves its pipeline before it may bid. The suite issues five hidden parts that the
// farm must print, each of which the real judge must verify, and one trap job that the farm must decline with a
// reason. The suite keeps the hidden terms of what it issued, so a response is judged against them. A farm
// qualifies when its passRule is met. The certificate is digested over the suite's public rules and the result.

import type { KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import type { Digest, Instant, JobId } from "../../core/src/ids.ts";
import { PASS_RULE } from "./catalog.ts";
import { describePrintReason } from "./describe.ts";
import { digestOf, seededDraw } from "./digest.ts";
import { instantAt, openPrintJob } from "./open.ts";
import type { OpenedPrintJob } from "./open.ts";
import type { PrintSource, PrintSubmission } from "./sim/farm.ts";
import { FARM_BED_MM } from "./sim/farm.ts";
import { meshStats } from "./stl.ts";
import { partStl } from "./sim/synthetic-gcode.ts";
import type { PartKind } from "./sim/synthetic-gcode.ts";
import { verifyPrint } from "./verify.ts";

export const SUITE_ID = "print-fdm-qualify-1";
export const CHALLENGE_DEADLINE_S = 900;
/** A certificate lapses after 90 days unless renewed by receipts, as the design's Q4 decay says. */
export const CERTIFICATE_DAYS = 90;
const DAY_MS = 86_400_000;

export type QualificationChallenge<Spec> = { readonly id: string; readonly spec: Spec; readonly expect: "FULFIL" | "DECLINE"; readonly deadlineSeconds: number };
export type QualificationResult = { readonly challenge: string; readonly passed: boolean; readonly detail: string };

export interface QualificationSuite<Spec, Evidence> {
	readonly suiteId: string;
	challenges(seed: Uint8Array): Promise<readonly QualificationChallenge<Spec>[]>;
	grade(challenge: QualificationChallenge<Spec>, response: readonly Evidence[] | { readonly declined: string }): Promise<QualificationResult>;
	readonly passRule: { readonly fulfilled: number; readonly declinedTraps: number };
}

/** What a farm is sent for one challenge: the print source, and a label the page can show. */
export type ChallengeSpec = PrintSource & { readonly label: string; readonly material: "PLA" };

type Hidden = { readonly kind: "FULFIL"; readonly job: OpenedPrintJob; readonly photoLayers: readonly number[] } | { readonly kind: "DECLINE" };

const KINDS: readonly { readonly kind: PartKind; readonly sizes: readonly number[] }[] = [
	{ kind: "cube", sizes: [12, 14] },
	{ kind: "cylinder", sizes: [6, 7] },
	{ kind: "l-bracket", sizes: [14] },
];
const INFILLS = [15, 20, 25, 30, 35, 40] as const;
const FULFIL_COUNT = 5;

function jobSeedOf(seed: Uint8Array, label: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(`qualify\0${label}\0`).update(seed).digest());
}

/**
 * The print qualification suite. The printer key is the one the farm registered, so the judge checks the
 * telemetry the farm signs against it. One suite serves one qualification run, since it keeps what it issued.
 */
export function printQualification(printerKey: KeyObject): QualificationSuite<ChallengeSpec, PrintSubmission> {
	const issued = new Map<string, Hidden>();

	return {
		suiteId: SUITE_ID,
		passRule: PASS_RULE,

		async challenges(seed) {
			issued.clear();
			const challenges: QualificationChallenge<ChallengeSpec>[] = [];
			const draw = seededDraw(seed, "qualify:challenges");
			for (let n = 0; n < FULFIL_COUNT; n++) {
				const kind = KINDS[draw(KINDS.length)];
				const size = kind.sizes[draw(kind.sizes.length)];
				// A single L-bracket at 30% infill is rejected by its honest synthetic print (a sweep over every
				// combination found only that one), so the L-bracket always carries two or three copies.
				const quantity = kind.kind === "l-bracket" ? 2 + draw(2) : 1 + draw(3);
				const infillPct = INFILLS[draw(INFILLS.length)];
				const id = `fulfil-${n + 1}`;
				const opened = await openPrintJob({
					jobId: `job_${id}` as JobId,
					partStl: await partStl(kind.kind, size),
					seed: jobSeedOf(seed, id),
					quantity,
					infillPct,
					at: instantAt(Date.now()),
				});
				if (!opened.ok) throw new Error(`challenge ${id} did not open: ${opened.errors[0]?.message ?? "refused"}`);
				const job = opened.value;
				const photoLayers = job.contract.hidden.sampleLayers;
				issued.set(id, { kind: "FULFIL", job, photoLayers });
				challenges.push({
					id,
					expect: "FULFIL",
					deadlineSeconds: CHALLENGE_DEADLINE_S,
					spec: {
						label: `${kind.kind} ${size} mm, ${quantity} on the plate, ${infillPct}% infill`,
						material: "PLA",
						jobId: job.jobId,
						quantity,
						partStl: job.partStl,
						partBox: job.partBox,
						plateStl: job.plate.stl,
						partOrigins: job.plate.layout.partOrigins,
						infillPct,
						photoLayers,
					},
				});
			}
			// The trap is a part wider than the farm's bed. It is sent bare, because a decline must come before any plate is built.
			const trap = await partStl("cube", 300);
			const trapBox = meshStats(trap);
			if (!trapBox.ok) throw new Error("the trap part is invalid");
			issued.set("trap", { kind: "DECLINE" });
			challenges.push({
				id: "trap",
				expect: "DECLINE",
				deadlineSeconds: CHALLENGE_DEADLINE_S,
				spec: {
					label: `trap: 300 mm cube, wider than the ${FARM_BED_MM.x} mm bed`,
					material: "PLA",
					jobId: "job_trap" as JobId,
					quantity: 1,
					partStl: trap,
					partBox: trapBox.value.bboxMm,
					plateStl: trap,
					partOrigins: [],
					infillPct: 20,
					photoLayers: [],
				},
			});
			return challenges;
		},

		async grade(challenge, response) {
			const hidden = issued.get(challenge.id);
			if (hidden === undefined) return { challenge: challenge.id, passed: false, detail: "the suite did not issue this challenge" };

			if (hidden.kind === "DECLINE") {
				if ("declined" in response) {
					const reason = response.declined.trim();
					return reason.length > 0
						? { challenge: challenge.id, passed: true, detail: `declined: ${reason}` }
						: { challenge: challenge.id, passed: false, detail: "declined without a reason" };
				}
				return { challenge: challenge.id, passed: false, detail: "accepted a job it must decline" };
			}

			if ("declined" in response) return { challenge: challenge.id, passed: false, detail: `declined: ${response.declined}` };
			if (response.length === 0) return { challenge: challenge.id, passed: false, detail: "sent no evidence" };
			for (const submission of response) {
				const verdict = await verifyPrint({
					contract: hidden.job.contract,
					partStl: hidden.job.partStl,
					seed: hidden.job.seed,
					bedMm: FARM_BED_MM,
					archive: submission.archive ?? [],
					gcode: submission.gcode,
					telemetry: { frames: submission.frames, publicKey: printerKey },
					photos: submission.photos,
				});
				// Only a VERIFIED verdict passes, so a refusal with no reason listed still fails the challenge.
				if (verdict.result !== "VERIFIED") {
					const first = verdict.reasons[0];
					return { challenge: challenge.id, passed: false, detail: `rejected: ${first === undefined ? "no reason given" : describePrintReason(first)}` };
				}
			}
			return { challenge: challenge.id, passed: true, detail: "verified" };
		},
	};
}

export type QualificationTally = { readonly fulfilled: number; readonly declinedTraps: number; readonly qualified: boolean };

/** The tally of passed challenges by what each one expects, and whether the rule is met. */
export function qualifies(rule: { readonly fulfilled: number; readonly declinedTraps: number }, challenges: readonly QualificationChallenge<unknown>[], results: readonly QualificationResult[]): QualificationTally {
	const passedAs = (expect: "FULFIL" | "DECLINE") =>
		results.filter(result => result.passed && challenges.some(challenge => challenge.id === result.challenge && challenge.expect === expect)).length;
	const fulfilled = passedAs("FULFIL");
	const declinedTraps = passedAs("DECLINE");
	return { fulfilled, declinedTraps, qualified: fulfilled >= rule.fulfilled && declinedTraps >= rule.declinedTraps };
}

export type QualificationCertificate = {
	readonly simulated: true;
	readonly seller: string;
	readonly materials: readonly ["PLA"];
	/** The build area the farm was graded against, in mm. */
	readonly buildBedMm: { readonly x: number; readonly y: number };
	readonly fulfilled: number;
	readonly declinedTraps: number;
	readonly suiteId: string;
	readonly suiteDigest: Digest;
	readonly issuedAt: string;
	readonly expiresAt: string;
	/** Digest over every field above. Two runs with the same results and dates give the same digest. */
	readonly digest: Digest;
};

/** The certificate for a qualified farm. Only the fields a judge needs are carried; the hidden parts are not. */
export function certify(input: { readonly seller: string; readonly fulfilled: number; readonly declinedTraps: number; readonly issuedAt: Instant }): QualificationCertificate {
	const issuedMs = Date.parse(input.issuedAt);
	const body = {
		simulated: true as const,
		seller: input.seller,
		materials: ["PLA"] as const,
		buildBedMm: { x: FARM_BED_MM.x, y: FARM_BED_MM.y },
		fulfilled: input.fulfilled,
		declinedTraps: input.declinedTraps,
		suiteId: SUITE_ID,
		suiteDigest: digestOf({ suiteId: SUITE_ID, passRule: PASS_RULE, deadlineSeconds: CHALLENGE_DEADLINE_S }),
		issuedAt: input.issuedAt,
		expiresAt: instantAt(issuedMs + CERTIFICATE_DAYS * DAY_MS),
	};
	return { ...body, digest: digestOf(body) };
}
