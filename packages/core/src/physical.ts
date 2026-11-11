// The physical verticals' fixed contracts. A physical job is judged against the public spec the agent reads and a
// sealed check set the judge keeps in a private directory. A contract names no visitor: OpenJob names the repository.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommitSha, Digest } from "./ids.ts";
import { LASER_MANIFEST, LASER_VERTICAL } from "./code-manifest.ts";
import type { PluginManifest, Vertical } from "./code-manifest.ts";
import type { DefinitionOfDone } from "./verifier.ts";

export type PhysicalWorkflow = {
	readonly vertical: Vertical;
	readonly manifest: PluginManifest;
	/** The job's title, and the label of the job's issue. Plain words: the job page shows them. */
	readonly title: string;
	/** The one file the agent delivers, repository-relative, on its work branch. */
	readonly deliveryPath: string;
	/** The commit the job freezes. A code starter freezes one the same way, and it exists in every visitor fork. */
	readonly frozenAt: CommitSha;
	/** The spec the agent reads. Its canonical JSON digest is the definition's specDigest. */
	readonly publicSpec: unknown;
};

/** The label number a physical job's issue carries. It names no GitHub issue: nothing reads or writes one. */
const LABEL_ISSUE_NUMBER = 1;

export const LASER_CUT_WORKFLOW: PhysicalWorkflow = { vertical: LASER_VERTICAL, manifest: LASER_MANIFEST,
	title: "Cut the enclosure panel to spec", deliveryPath: "delivery/part.svg",
	frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha,
	publicSpec: { material: "acrylic", thicknessMm: 3, bedMm: [300, 200], partMm: [120, 80], kerfMm: 0.2, toleranceMm: 0.1, minWebMm: 3,
		cornerRadiusMm: 0, labelRegionMm: { originMm: [8, 8], sizeMm: [44, 6] }, minEngraveLengthMm: 20,
		holes: [
			{ id: "mount-a", centreMm: [6, 6], diameterMm: 3.2 },
			{ id: "mount-b", centreMm: [114, 6], diameterMm: 3.2 },
			{ id: "mount-c", centreMm: [6, 74], diameterMm: 3.2 },
			{ id: "mount-d", centreMm: [114, 74], diameterMm: 3.2 },
		],
		slots: [{ id: "window", sizeMm: [30, 12] }] },
};

const WORKFLOWS: readonly PhysicalWorkflow[] = [LASER_CUT_WORKFLOW];

/**
 * The public rules the laser checker reports by name, in the checker's own order. The judge counts a reply against this list,
 * so a checker that drops or renames a rule is a malformed reply, never a pass.
 */
export const LASER_PUBLIC_RULES: readonly string[] = ["parse", "units-mm", "colours", "closed-paths", "no-duplicates", "fits-bed",
	"outer-size", "holes", "cutouts", "engrave-inside", "min-web", "cut-order", "no-self-intersection"];

/** The physical workflow a vertical names, or null for a vertical this build does not open physically. */
export function physicalWorkflowOf(vertical: string): PhysicalWorkflow | null {
	return WORKFLOWS.find(workflow => workflow.vertical === vertical) ?? null;
}

/**
 * The definition a physical job freezes at OpenJob, for the repository it opens on. Its code-only fields are
 * empty: no test suite is frozen or hidden, so the code judge's matching never applies to it.
 */
export function physicalDefinitionOf(workflow: PhysicalWorkflow, repository: string, specDigest: Digest): DefinitionOfDone {
	return { issue: { repository, number: LABEL_ISSUE_NUMBER, title: workflow.title }, frozenAt: workflow.frozenAt,
		frozenTestPath: "", frozenTests: [], hiddenTests: [], hiddenManifest: specDigest, protectedPaths: [],
		physical: { workflow: "laser-cut", deliveryPath: workflow.deliveryPath, publicSpec: workflow.publicSpec, specDigest } };
}

/** A point in a drawing's millimetres. */
export type SealedPoint = readonly [number, number];

/**
 * The sealed checks a physical job is judged by. Only the deployment's private directory holds this file: it is read to
 * open a job and to judge a delivery, and it never reaches the browser, the agent, or the repository.
 */
export type SealedCheckSet = {
	/** Each point must stay solid material. */
	readonly keepMaterialMm: readonly SealedPoint[];
	/** Each point must be cut away. */
	readonly voidMm: readonly SealedPoint[];
	/** The tolerance a kept point is checked with. Absent, the checker's own default applies. */
	readonly clearanceMm?: number;
};

/** One check the checker runs alone: a single kept or cut-away point, so every sealed point is counted on its own. */
export type SealedCheck = { readonly keepMaterialMm: readonly SealedPoint[]; readonly voidMm?: readonly SealedPoint[]; readonly clearanceMm?: number };

const MAX_SEALED_POINTS = 256;

/** The private file a vertical's sealed checks are kept in, under the deployment's sealed directory. */
export function sealedFileName(vertical: Vertical): string {
	return `${vertical}.sealed.json`;
}

/**
 * A file's parsed JSON as a sealed check set, or null for any other shape. A bad file fails closed: it is never guessed
 * at, so a job is never opened or judged on partly-read checks.
 */
export function parseSealedChecks(value: unknown): SealedCheckSet | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as { readonly keepMaterialMm?: unknown; readonly voidMm?: unknown; readonly clearanceMm?: unknown };
	const keep = pointsOf(record.keepMaterialMm);
	const voids = record.voidMm === undefined ? [] : pointsOf(record.voidMm);
	if (keep === null || voids === null || keep.length + voids.length === 0) return null;
	if (record.clearanceMm !== undefined && (typeof record.clearanceMm !== "number" || !Number.isFinite(record.clearanceMm) || record.clearanceMm < 0)) return null;
	return { keepMaterialMm: keep, voidMm: voids, ...(record.clearanceMm === undefined ? {} : { clearanceMm: record.clearanceMm }) };
}

function pointsOf(value: unknown): readonly SealedPoint[] | null {
	if (!Array.isArray(value) || value.length > MAX_SEALED_POINTS) return null;
	const points: SealedPoint[] = [];
	for (const point of value) {
		if (!Array.isArray(point) || point.length !== 2 || !point.every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate))) return null;
		points.push([point[0], point[1]]);
	}
	return points;
}

/**
 * A vertical's sealed checks, read from the deployment's private directory on each call. A missing, unreadable, or malformed
 * file is null: the caller fails closed by name, and nothing is guessed at from a partial read.
 */
export function sealedChecksIn(dir: string, vertical: Vertical): SealedCheckSet | null {
	if (dir === "") return null;
	try {
		return parseSealedChecks(JSON.parse(readFileSync(join(dir, sealedFileName(vertical)), "utf8")) as unknown);
	} catch {
		return null;
	}
}

/** The checks a sealed set runs, one per point, in order: the kept points first, then the cut-away ones. */
export function independentChecksOf(sealed: SealedCheckSet): readonly SealedCheck[] {
	return [
		...sealed.keepMaterialMm.map(point => ({ keepMaterialMm: [point], ...(sealed.clearanceMm === undefined ? {} : { clearanceMm: sealed.clearanceMm }) })),
		...sealed.voidMm.map(point => ({ keepMaterialMm: [], voidMm: [point] })),
	];
}
