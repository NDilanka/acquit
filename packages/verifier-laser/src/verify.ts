// One verdict for a laser-cut panel. The file is read as text and flattened to millimetres, then every rule runs.
// Findings come back in RULES order. The verdict passes only when every finding is ok. The hidden-material rule
// runs only when the verifier holds samples, so a verdict without them carries no hidden finding.

import { boundsOf, centreOf, edgeListDistance, edgeListsOverlap, edgesOf, heightOf, lengthOfEdges, pointInPolygon, roundMm, selfCrosses, selfOverlaps, widthOf } from "./geometry.ts";
import type { Bounds } from "./geometry.ts";
import { finishedInnerSize, finishedPart, isMaterial, isMaterialSegment, isVoidPoint, keepsClearance, toDrawing, toPart } from "./finished.ts";
import type { FinishedPart } from "./finished.ts";
import { MAX_PAIR_TESTS } from "./limits.ts";
import { validateSpec } from "./spec.ts";
import { FLATTEN_TOL_MM, parseSvg } from "./svg.ts";
import { fitTolerance, fitsRectangle, fitsRing, isRoundCut, RING_POINTS_MAX, roundedRectRing } from "./shapes.ts";
import { CUT_STROKE, ENGRAVE_STROKE, RULES } from "./types.ts";
import type { Finding, HiddenSample, Rule, Scene, ScenePath, Spec, SpecRect, SvgPath, Verdict, Vec2 } from "./types.ts";

type Outline = { readonly path: SvgPath; readonly box: Bounds };

type Edges = readonly (readonly [Vec2, Vec2])[];

/**
 * Speeds behind the time estimate. The spec does not set them, so the estimate is a planning figure only: cutting at
 * 10 mm/s, engraving at 100 mm/s, and 0.5 s to start each cut path.
 */
const CUT_MM_PER_S = 10;
const ENGRAVE_MM_PER_S = 100;
const PIERCE_S = 0.5;

/**
 * A cut measured on the finished part: its finished size, its centre in the part frame, and whether its finished
 * extent lies wholly inside the part.
 */
type Candidate = {
	readonly path: SvgPath;
	readonly width: number;
	readonly height: number;
	readonly centre: Vec2;
	readonly inside: boolean;
};

function check(rule: Rule, ok: boolean, passed: string, failed: string, refs: readonly string[] = []): Finding {
	return {
		rule,
		ok,
		hidden: rule === "hidden-material",
		message: ok ? passed : failed,
		...(refs.length > 0 ? { refs } : {}),
	};
}

/** The outer cut is the cut path with the largest bounding box. Ties go to the first one drawn. */
function outlineOf(cut: readonly SvgPath[]): Outline | null {
	let best: Outline | null = null;
	let bestArea = -1;
	for (const path of cut) {
		const box = boundsOf(path.points);
		if (box === null) continue;
		const area = widthOf(box) * heightOf(box);
		if (area > bestArea) {
			best = { path, box };
			bestArea = area;
		}
	}
	return best;
}

function candidateOf(path: SvgPath, part: FinishedPart): Candidate | null {
	const own = boundsOf(path.points);
	if (own === null) return null;
	const width = finishedInnerSize(part, widthOf(own));
	const height = finishedInnerSize(part, heightOf(own));
	const centre = toPart(part, centreOf(own));
	const [cx, cy] = centre;
	const inside = cx - width / 2 >= 0 && cx + width / 2 <= part.widthMm && cy - height / 2 >= 0 && cy + height / 2 <= part.heightMm;
	return { path, width, height, centre, inside };
}

/**
 * The drawn corner radius of an outer corner. A sharp finished corner is drawn sharp. A rounded one is drawn kerf/2
 * larger, because the cut runs kerf/2 outside the finished edge.
 */
const drawnCornerMm = (spec: Spec): number => (spec.cornerRadiusMm > 0 ? spec.cornerRadiusMm + spec.kerfMm / 2 : 0);

/** The message for a feature rule: spec features not cut, and cuts that match no spec feature. */
function missesText(misses: readonly string[], extras: readonly string[], extraWhat: string): string {
	const parts: string[] = [];
	if (misses.length > 0) parts.push(`not cut as specified: ${misses.join(", ")}`);
	if (extras.length > 0) parts.push(`${extras.length} extra cut(s) ${extraWhat}`);
	return parts.join("; ");
}

/** Takes the first candidate not yet claimed that fits. A duplicate drawing cannot satisfy two features. */
function claim(candidates: readonly Candidate[], used: Set<Candidate>, fits: (candidate: Candidate) => boolean): boolean {
	const hit = candidates.find(candidate => !used.has(candidate) && fits(candidate));
	if (hit === undefined) return false;
	used.add(hit);
	return true;
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/** True when every vertex of the inner closed cut lies inside the outer one. */
const encloses = (outer: SvgPath, inner: SvgPath): boolean => inner.points.every(point => pointInPolygon(point, outer.points));

/**
 * A cut is a repeat when it doubles back on itself or shares a stretch with a cut drawn before it. The first drawing of
 * a stretch is the cut; each later drawing is a repeat.
 */
function repeatsOf(cut: readonly SvgPath[], edges: readonly Edges[]): Set<SvgPath> {
	const repeats = new Set<SvgPath>();
	cut.forEach((path, k) => {
		const sharesStretch = edges.slice(0, k).some(earlier => edgeListsOverlap(edges[k]!, earlier));
		if (sharesStretch || selfOverlaps(path.points, path.closed)) repeats.add(path);
	});
	return repeats;
}

type PairChecks = {
	readonly minWebMm: number;
	readonly thin: readonly string[];
	readonly misordered: ReadonlySet<SvgPath>;
	readonly wasted: ReadonlySet<SvgPath>;
};

/**
 * Each pair of cuts that do not share a stretch, checked once: the finished web between them, any closed cut lying
 * inside another that is drawn after it, and any closed cut lying inside another closed cut. The last sits in that
 * cut's waste, so no feature may claim it. A pair that shares a stretch is a repeat, which no-duplicates reports.
 */
function pairChecks(cut: readonly SvgPath[], edges: readonly Edges[], spec: Spec, outline: SvgPath | undefined): PairChecks {
	let minWeb = Infinity;
	const thin: string[] = [];
	const misordered = new Set<SvgPath>();
	const wasted = new Set<SvgPath>();
	for (let i = 0; i < cut.length; i++) {
		for (let j = i + 1; j < cut.length; j++) {
			const a = cut[i]!;
			const b = cut[j]!;
			if (edgeListsOverlap(edges[i]!, edges[j]!)) continue;
			// Each finished edge sits kerf/2 from its drawn line, toward the web, so the web loses one kerf. Flattening can
			// move each drawn line by up to FLATTEN_TOL_MM, so the web allows that on both sides.
			const web = edgeListDistance(edges[i]!, edges[j]!) - spec.kerfMm - 2 * FLATTEN_TOL_MM;
			if (web < minWeb) minWeb = web;
			if (web < spec.minWebMm) thin.push(a.id, b.id);
			if (!a.closed || !b.closed) continue;
			const aEncloses = encloses(a, b);
			const bEncloses = encloses(b, a);
			if (aEncloses && b.order > a.order) misordered.add(b);
			if (bEncloses && a.order > b.order) misordered.add(a);
			// The outline encloses every feature by design, so only a cut inside another inner cut counts as waste.
			if (aEncloses && a !== outline) wasted.add(b);
			if (bEncloses && b !== outline) wasted.add(a);
		}
	}
	return { minWebMm: minWeb, thin, misordered, wasted };
}

/**
 * The scene the machine reads: every path at the top of the stock, the outer cut as the outline, and a path with no
 * laser colour as travel, since the laser neither cuts nor engraves along it.
 */
function sceneOf(paths: readonly SvgPath[], size: Scene["size"], spec: Spec): Scene {
	const outer = outlineOf(paths.filter(path => path.stroke === CUT_STROKE))?.path;
	const scenePaths: ScenePath[] = paths.map(path => ({
		id: path.id,
		kind:
			path === outer ? "outline" : path.stroke === CUT_STROKE ? "cut" : path.stroke === ENGRAVE_STROKE ? "engrave" : "travel",
		layer: path.stroke ?? "none",
		z: spec.thicknessMm,
		closed: path.closed,
		order: path.order,
		points: path.points,
	}));
	return {
		units: "mm",
		size,
		stock: { size: [spec.bedMm[0], spec.bedMm[1], spec.thicknessMm], material: spec.material },
		paths: scenePaths,
	};
}

function verdictOf(findings: readonly Finding[], measured: Verdict["measured"], scene: Scene): Verdict {
	const order: readonly string[] = RULES;
	const ordered = [...findings].sort((a, b) => order.indexOf(a.rule) - order.indexOf(b.rule));
	return { workflow: "laser-cut", pass: ordered.every(finding => finding.ok), findings: ordered, measured, scene };
}

/** A verdict that fails the parse rule alone. Used when the file, the spec or the samples cannot be checked at all. */
function refused(message: string, scene: Scene): Verdict {
	return verdictOf([{ rule: "parse", ok: false, hidden: false, message }], {}, scene);
}

const emptyScene = (): Scene => ({ units: "mm", size: [0, 0, 0], paths: [] });

const isFinitePoint = (value: unknown): boolean => {
	if (!Array.isArray(value) || value.length !== 2) return false;
	const [x, y] = value as readonly unknown[];
	return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y);
};

/**
 * The hidden samples must be finite points in mm, and the clearance a finite, non-negative distance. Returns the
 * problem, or null when they are sound.
 */
function sampleProblem(hidden: HiddenSample | null): string | null {
	const points: unknown = hidden?.keepMaterialMm;
	if (!Array.isArray(points)) return "the hidden samples must list keepMaterialMm points";
	if (!points.every(isFinitePoint)) return "each hidden sample must be two finite numbers in mm";
	const voids: unknown = hidden?.voidMm;
	if (voids !== undefined && (!Array.isArray(voids) || !voids.every(isFinitePoint))) return "each expected-void sample must be two finite numbers in mm";
	const clearance: unknown = hidden?.clearanceMm;
	if (clearance !== undefined && (typeof clearance !== "number" || !Number.isFinite(clearance) || clearance < 0)) {
		return "the hidden clearance must be a finite, non-negative number of mm";
	}
	return null;
}

/** Tolerance on the label region's edges, so a label drawn exactly on its boundary is not refused by float noise. */
const REGION_EPS = 1e-6;

const inRegion = (part: FinishedPart, region: SpecRect, point: Vec2): boolean => {
	const [px, py] = toPart(part, point);
	const [ox, oy] = region.originMm;
	const [sx, sy] = region.sizeMm;
	return px >= ox - REGION_EPS && px <= ox + sx + REGION_EPS && py >= oy - REGION_EPS && py <= oy + sy + REGION_EPS;
};

/**
 * An engraving holds when every point and every whole segment lies in the label region and in finished material.
 * Segments are checked, not only their ends: a segment can leave the material between two ends that are both inside.
 */
function engravingHolds(part: FinishedPart, region: SpecRect, path: SvgPath): boolean {
	const inside = (point: Vec2): boolean => inRegion(part, region, point) && isMaterial(part, point);
	if (!path.points.every(inside)) return false;
	return edgesOf(path.points, path.closed).every(([a, b]) => inRegion(part, region, a) && inRegion(part, region, b) && isMaterialSegment(part, a, b));
}

/**
 * The pair and point tests the rules will run. Cut against cut costs about three times the square of the cut edge
 * count: the repeat, web and enclosure tests each visit the pairs of cut edges. Each engraving point and hidden sample
 * costs one pass over the cut edges. Each spec feature, the outline and the extra cuts are fitted against an ideal
 * shape of at most RING_POINTS_MAX points, one pass over the cut edges each. Counted before any of them runs.
 */
function workOf(cut: readonly SvgPath[], engrave: readonly SvgPath[], samples: number, features: number): number {
	const edges = cut.reduce((sum, path) => sum + edgesOf(path.points, path.closed).length, 0);
	const points = engrave.reduce((sum, path) => sum + path.points.length, 0);
	return 3 * edges * edges + (points + samples) * edges + (features + 2) * edges * RING_POINTS_MAX * 2;
}

/**
 * Checks a laser cut panel file against the spec. Never throws: an input that cannot be checked fails the parse rule
 * with a plain message, and so does a drawing over the limits in limits.ts.
 */
export function verify(spec: Spec, artefact: string, hidden?: HiddenSample): Verdict {
	try {
		return checkPanel(spec, artefact, hidden);
	} catch {
		return refused("the drawing could not be checked", emptyScene());
	}
}

function checkPanel(input: Spec, artefact: string, hidden: HiddenSample | undefined): Verdict {
	const checked = validateSpec(input);
	if (!checked.ok) return refused(`the spec is not valid: ${checked.errors[0]?.message ?? "unreadable"}`, emptyScene());
	const spec = checked.value;
	if (hidden !== undefined) {
		const problem = sampleProblem(hidden);
		if (problem !== null) return refused(problem, sceneOf([], [spec.partMm[0], spec.partMm[1], spec.thicknessMm], spec));
	}

	const parsed = parseSvg(artefact);
	if (!parsed.ok) {
		const message = parsed.errors[0]?.message ?? "the file could not be read";
		const size: Scene["size"] = [spec.partMm[0], spec.partMm[1], spec.thicknessMm];
		return refused(message, sceneOf([], size, spec));
	}

	const doc = parsed.value;
	const cut = doc.paths.filter(path => path.stroke === CUT_STROKE);
	const engrave = doc.paths.filter(path => path.stroke === ENGRAVE_STROKE);
	const probes = (hidden?.keepMaterialMm.length ?? 0) + (hidden?.voidMm?.length ?? 0);
	if (workOf(cut, engrave, probes, spec.holes.length + spec.slots.length) > MAX_PAIR_TESTS) {
		const size: Scene["size"] = [doc.widthMm, doc.heightMm, spec.thicknessMm];
		return refused("the drawing has too many segments to check in one pass", sceneOf(doc.paths, size, spec));
	}
	const outline = outlineOf(cut);
	const inner = cut.filter(path => path !== outline?.path && path.closed).map(path => path.points);
	const part = outline === null ? null : finishedPart(outline.path.points, inner, spec.kerfMm);
	const findings: Finding[] = [];
	const measured: Record<string, number | string> = {
		unit: doc.unit,
		pageWidthMm: roundMm(doc.widthMm),
		pageHeightMm: roundMm(doc.heightMm),
		cutPaths: cut.length,
		engravePaths: engrave.length,
	};

	findings.push({ rule: "parse", ok: true, hidden: false, message: "the file reads as an SVG drawing" });

	findings.push(
		check(
			"units-mm",
			doc.unit === "mm",
			"the drawing's width and height are in mm",
			`the drawing's width and height must be in mm, found "${doc.unit === "" ? "no unit" : doc.unit}"`,
		),
	);

	const misdrawn = doc.paths.filter(path => path.stroke !== CUT_STROKE && path.stroke !== ENGRAVE_STROKE).map(path => path.id);
	findings.push(
		check(
			"colours",
			misdrawn.length === 0,
			"every drawn path is cut red or engrave blue",
			`${misdrawn.length} path(s) carry no laser colour`,
			misdrawn,
		),
	);

	const open = cut.filter(path => !path.closed).map(path => path.id);
	findings.push(check("closed-paths", open.length === 0, "every cut path is closed", `${open.length} cut path(s) are open`, open));

	const cutEdges = cut.map(path => edgesOf(path.points, path.closed));
	const cutLengthMm = cutEdges.reduce((sum, edges) => sum + lengthOfEdges(edges), 0);
	const engraveLengthMm = engrave.reduce((sum, path) => sum + lengthOfEdges(edgesOf(path.points, path.closed)), 0);
	measured.cutLengthMm = roundMm(cutLengthMm);
	measured.engraveLengthMm = roundMm(engraveLengthMm);
	measured.estimatedCutSeconds = roundMm(cutLengthMm / CUT_MM_PER_S + engraveLengthMm / ENGRAVE_MM_PER_S + cut.length * PIERCE_S);
	const repeats = repeatsOf(cut, cutEdges);
	const duplicates = cut.filter(path => repeats.has(path)).map(path => path.id);
	const pairs = pairChecks(cut, cutEdges, spec, outline?.path);

	// The outline is the part's edge, not a feature, so it is never a candidate for a hole or cutout. A cut inside
	// another cut's waste is not a feature either: that material falls out, so it cannot be the hole or cutout asked for.
	const candidates =
		part === null
			? []
			: cut
					.filter(path => path !== outline?.path)
					.map(path => candidateOf(path, part))
					.filter((c): c is Candidate => c !== null);
	const features = candidates.filter(c => !pairs.wasted.has(c.path));
	const used = new Set<Candidate>();
	const holeMisses: string[] = [];
	for (const hole of spec.holes) {
		const [cx, cy] = hole.centreMm;
		const d = hole.diameterMm;
		const tol = hole.toleranceMm;
		const found = claim(
			features,
			used,
			c =>
				c.inside &&
				c.path.closed &&
				near(c.width, d, tol) &&
				near(c.height, d, tol) &&
				near(c.centre[0], cx, tol) &&
				near(c.centre[1], cy, tol) &&
				isRoundCut(c.path.points, c.path.closed, fitTolerance(tol)),
		);
		if (!found) holeMisses.push(`hole ${hole.id}`);
	}
	const cutoutMisses: string[] = [];
	for (const slot of spec.slots) {
		const [sx, sy] = slot.sizeMm;
		const tol = slot.toleranceMm;
		const found = claim(
			features,
			used,
			c =>
				c.inside &&
				c.path.closed &&
				near(c.width, sx, tol) &&
				near(c.height, sy, tol) &&
				fitsRectangle(c.path.points, c.path.closed, fitTolerance(tol)),
		);
		if (!found) cutoutMisses.push(`slot ${slot.id}`);
	}
	// A cut no feature claims is extra. A round one, or one where a hole belongs, is a hole fault; any other is a
	// cutout fault. A cut inside another cut's waste is a cutout fault whatever its shape. A repeat is left to
	// no-duplicates and an open cut to closed-paths, so neither is counted again here.
	const extraHoles: string[] = [];
	const extraCutouts: string[] = [];
	const wastedCuts: string[] = [];
	for (const c of candidates) {
		if (used.has(c) || repeats.has(c.path) || !c.path.closed) continue;
		if (pairs.wasted.has(c.path)) {
			wastedCuts.push(c.path.id);
			continue;
		}
		const atHole = spec.holes.some(
			hole => Math.hypot(c.centre[0] - hole.centreMm[0], c.centre[1] - hole.centreMm[1]) <= hole.diameterMm / 2 + hole.toleranceMm,
		);
		if (atHole || isRoundCut(c.path.points, c.path.closed, fitTolerance(spec.toleranceMm))) extraHoles.push(c.path.id);
		else extraCutouts.push(c.path.id);
	}
	measured.holesMatched = spec.holes.length - holeMisses.length;
	measured.holesExpected = spec.holes.length;
	measured.holeCount = spec.holes.length - holeMisses.length + extraHoles.length;
	measured.cutoutsMatched = spec.slots.length - cutoutMisses.length;
	measured.cutoutsExpected = spec.slots.length;
	findings.push(
		check(
			"holes",
			holeMisses.length === 0 && extraHoles.length === 0,
			`all ${spec.holes.length} holes are cut at their spec position and diameter`,
			missesText(holeMisses, extraHoles, "where no hole is specified"),
			extraHoles,
		),
	);
	const wasteText = wastedCuts.length > 0 ? `${wastedCuts.length} cut(s) inside removed material` : "";
	findings.push(
		check(
			"cutouts",
			cutoutMisses.length === 0 && extraCutouts.length === 0 && wastedCuts.length === 0,
			`all ${spec.slots.length} cutouts are cut at their spec size`,
			[missesText(cutoutMisses, extraCutouts, "where no cutout is specified"), wasteText].filter(text => text !== "").join("; "),
			[...extraCutouts, ...wastedCuts],
		),
	);

	// The label is required, so an empty drawing fails. Each engraving must hold along its whole length.
	const stray = engrave.filter(path => part === null || !engravingHolds(part, spec.labelRegionMm, path)).map(path => path.id);
	findings.push(
		check(
			"engrave-inside",
			engrave.length > 0 && stray.length === 0,
			"the label is engraved in its region, inside the finished material and clear of the cuts",
			engrave.length === 0
				? "no label is engraved in the label region"
				: `${stray.length} engraving(s) leave the label region, leave the finished material, or cross a cut`,
			stray,
		),
	);

	if (outline === null || part === null) {
		findings.push(check("outer-size", false, "", "no outer cut outline"));
		findings.push(check("cut-order", false, "", "no outer cut outline to order against"));
	} else {
		const [px, py] = spec.partMm;
		measured.outlineWidthMm = roundMm(widthOf(outline.box));
		measured.outlineHeightMm = roundMm(heightOf(outline.box));
		measured.finishedWidthMm = roundMm(part.widthMm);
		measured.finishedHeightMm = roundMm(part.heightMm);
		const sized = near(part.widthMm, px, spec.toleranceMm) && near(part.heightMm, py, spec.toleranceMm);
		// The drawn outline must be the declared rectangle: every edge straight, every corner at the declared radius.
		// A chamfer or a triangle keeps the box, so the size check alone would pass it.
		const ideal = roundedRectRing(centreOf(outline.box), widthOf(outline.box), heightOf(outline.box), drawnCornerMm(spec));
		const shaped = fitsRing(outline.path.points, outline.path.closed, ideal, fitTolerance(spec.toleranceMm));
		const corners = spec.cornerRadiusMm > 0 ? `${spec.cornerRadiusMm} mm corners` : "square corners";
		findings.push(
			check(
				"outer-size",
				sized && shaped,
				`the finished part is ${roundMm(part.widthMm)} x ${roundMm(part.heightMm)} mm with ${corners}, as specified`,
				sized
					? `the outer cut is not a ${px} x ${py} mm outline with ${corners}`
					: `the finished part is ${roundMm(part.widthMm)} x ${roundMm(part.heightMm)} mm; the spec part is ${px} x ${py} mm`,
				[outline.path.id],
			),
		);

		// The outer cut is drawn last, and every cut is drawn before any cut that encloses it.
		const outOfOrder = cut
			.filter(path => path !== outline.path && (path.order > outline.path.order || pairs.misordered.has(path)))
			.map(path => path.id);
		findings.push(
			check(
				"cut-order",
				outOfOrder.length === 0,
				"the outer cut is the last cut, and every cut is drawn before the cut that encloses it",
				`${outOfOrder.length} cut(s) are drawn after the outer cut or after a cut that encloses them`,
				outOfOrder,
			),
		);
	}

	findings.push(
		check(
			"no-duplicates",
			duplicates.length === 0,
			"no stretch is cut twice",
			`${duplicates.length} cut(s) cut a stretch that is already cut, or double back on themselves`,
			duplicates,
		),
	);

	const [bedX, bedY] = spec.bedMm;
	const offBed = doc.paths
		.filter(path => path.stroke === CUT_STROKE || path.stroke === ENGRAVE_STROKE)
		.filter(path => path.points.some(([x, y]) => x < 0 || y < 0 || x > bedX || y > bedY))
		.map(path => path.id);
	findings.push(
		check("fits-bed", offBed.length === 0, `every cut and engrave lies on the ${bedX} x ${bedY} mm bed`, `${offBed.length} path(s) run off the bed`, offBed),
	);

	if (Number.isFinite(pairs.minWebMm)) measured.minWebMm = roundMm(pairs.minWebMm);
	findings.push(
		check(
			"min-web",
			pairs.thin.length === 0,
			`every web between cuts is at least ${spec.minWebMm} mm`,
			`${pairs.thin.length / 2} pair(s) of cuts leave a web under ${spec.minWebMm} mm`,
			[...new Set(pairs.thin)],
		),
	);

	const crossing = cut.filter(path => selfCrosses(path.points, path.closed)).map(path => path.id);
	findings.push(
		check(
			"no-self-intersection",
			crossing.length === 0,
			"no cut crosses itself",
			`${crossing.length} cut(s) cross themselves`,
			crossing,
		),
	);

	if (hidden !== undefined) {
		measured.hiddenSamples = hidden.keepMaterialMm.length;
		if (part === null) {
			findings.push(check("hidden-material", false, "", "no outer cut to place the hidden samples against"));
		} else {
			// Counts only: a finding never carries the hidden coordinates.
			const clearance = hidden.clearanceMm ?? 0;
			const voids = hidden.voidMm ?? [];
			const lost = hidden.keepMaterialMm.filter(point => !keepsClearance(part, toDrawing(part, point), clearance)).length;
			const unvoided = voids.filter(point => !isVoidPoint(part, toDrawing(part, point))).length;
			const problems: string[] = [];
			if (lost > 0) {
				problems.push(`${lost} hidden keep-material sample(s) fall inside a cut, outside the finished part, or within ${clearance} mm of a finished edge`);
			}
			if (unvoided > 0) problems.push(`${unvoided} hidden expected-void sample(s) fall in material`);
			const clearText = clearance > 0 ? ` and at least ${clearance} mm from every finished edge` : "";
			const voidText = voids.length > 0 ? `; all ${voids.length} expected void(s) are cut` : "";
			findings.push(
				check(
					"hidden-material",
					problems.length === 0,
					`all ${hidden.keepMaterialMm.length} hidden keep-material samples stay material${clearText}${voidText}`,
					problems.join("; "),
				),
			);
		}
	}

	const size: Scene["size"] = [doc.widthMm, doc.heightMm, spec.thicknessMm];
	return verdictOf(findings, measured, sceneOf(doc.paths, size, spec));
}
