// One verdict for a laser-cut panel. The file is read as text and flattened to millimetres, then every rule runs.
// Findings come back in RULES order. The verdict passes only when every finding is ok. The hidden-material rule
// runs only when the verifier holds samples, so a verdict without them carries no hidden finding.

import { boundsOf, centreOf, edgeListDistance, edgesOf, heightOf, roundMm, selfCrosses, shapeKey, widthOf } from "./geometry.ts";
import type { Bounds } from "./geometry.ts";
import { finishedInnerSize, finishedPart, isMaterial, toDrawing, toPart } from "./finished.ts";
import type { FinishedPart } from "./finished.ts";
import { MAX_PAIR_TESTS } from "./limits.ts";
import { validateSpec } from "./spec.ts";
import { parseSvg } from "./svg.ts";
import { CUT_STROKE, ENGRAVE_STROKE, RULES } from "./types.ts";
import type { Finding, HiddenSample, Rule, Scene, ScenePath, Spec, SvgPath, Verdict, Vec2 } from "./types.ts";

type Outline = { readonly path: SvgPath; readonly box: Bounds };

/** A closed cut measured on the finished part: its finished size, and its centre in the part frame. */
type Candidate = { readonly path: SvgPath; readonly width: number; readonly height: number; readonly centre: Vec2 };

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
	return {
		path,
		width: finishedInnerSize(part, widthOf(own)),
		height: finishedInnerSize(part, heightOf(own)),
		centre: toPart(part, centreOf(own)),
	};
}

/** Takes the first candidate not yet claimed that fits. A duplicate drawing cannot satisfy two features. */
function claim(candidates: readonly Candidate[], used: Set<Candidate>, fits: (candidate: Candidate) => boolean): boolean {
	const hit = candidates.find(candidate => !used.has(candidate) && fits(candidate));
	if (hit === undefined) return false;
	used.add(hit);
	return true;
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

function sceneOf(paths: readonly SvgPath[], size: Scene["size"], spec: Spec): Scene {
	const scenePaths: ScenePath[] = paths.map(path => ({
		id: path.id,
		kind: path.stroke === CUT_STROKE ? "cut" : path.stroke === ENGRAVE_STROKE ? "engrave" : "outline",
		layer: path.stroke ?? "none",
		z: 0,
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

/** The hidden samples must be a list of finite [x, y] points in mm. Returns the problem, or null when they are sound. */
function sampleProblem(hidden: HiddenSample | null): string | null {
	const points: unknown = hidden?.keepMaterialMm;
	if (!Array.isArray(points)) return "the hidden samples must list keepMaterialMm points";
	return points.every(isFinitePoint) ? null : "each hidden sample must be two finite numbers in mm";
}

/**
 * The pair and point tests the rules will run. Cut against cut costs at most the square of the cut edge count; each
 * engraving point and hidden sample costs one pass over the cut edges. Counted before any of them runs.
 */
function workOf(cut: readonly SvgPath[], engrave: readonly SvgPath[], samples: number): number {
	const edges = cut.reduce((sum, path) => sum + edgesOf(path.points, path.closed).length, 0);
	const points = engrave.reduce((sum, path) => sum + path.points.length, 0);
	return edges * edges + (points + samples) * edges;
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
	if (workOf(cut, engrave, hidden?.keepMaterialMm.length ?? 0) > MAX_PAIR_TESTS) {
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

	const candidates = part === null ? [] : cut.map(path => candidateOf(path, part)).filter((c): c is Candidate => c !== null);
	const used = new Set<Candidate>();
	const holeMisses: string[] = [];
	for (const hole of spec.holes) {
		const [cx, cy] = hole.centreMm;
		const d = hole.diameterMm;
		const tol = hole.toleranceMm;
		const found = claim(
			candidates,
			used,
			c => c.path.closed && near(c.width, d, tol) && near(c.height, d, tol) && near(c.centre[0], cx, tol) && near(c.centre[1], cy, tol),
		);
		if (!found) holeMisses.push(`hole ${hole.id}`);
	}
	const cutoutMisses: string[] = [];
	for (const slot of spec.slots) {
		const [sx, sy] = slot.sizeMm;
		const tol = slot.toleranceMm;
		const found = claim(candidates, used, c => c.path.closed && near(c.width, sx, tol) && near(c.height, sy, tol));
		if (!found) cutoutMisses.push(`slot ${slot.id}`);
	}
	measured.holesMatched = spec.holes.length - holeMisses.length;
	measured.holesExpected = spec.holes.length;
	measured.cutoutsMatched = spec.slots.length - cutoutMisses.length;
	measured.cutoutsExpected = spec.slots.length;
	findings.push(
		check(
			"holes",
			holeMisses.length === 0,
			`all ${spec.holes.length} holes are cut at their spec position and diameter`,
			`not cut as specified: ${holeMisses.join(", ")}`,
		),
	);
	findings.push(
		check(
			"cutouts",
			cutoutMisses.length === 0,
			`all ${spec.slots.length} cutouts are cut at their spec size`,
			`not cut as specified: ${cutoutMisses.join(", ")}`,
		),
	);

	const stray = engrave.filter(path => part === null || !path.points.every(point => isMaterial(part, point))).map(path => path.id);
	findings.push(
		check(
			"engrave-inside",
			stray.length === 0,
			"every engraving lies inside the part and clear of the cuts",
			`${stray.length} engraving(s) lie outside the part or inside a cut`,
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
		findings.push(
			check(
				"outer-size",
				near(part.widthMm, px, spec.toleranceMm) && near(part.heightMm, py, spec.toleranceMm),
				`the finished part is ${roundMm(part.widthMm)} x ${roundMm(part.heightMm)} mm, as specified`,
				`the finished part is ${roundMm(part.widthMm)} x ${roundMm(part.heightMm)} mm; the spec part is ${px} x ${py} mm`,
				[outline.path.id],
			),
		);

		const late = cut.filter(path => path !== outline.path && path.order > outline.path.order).map(path => path.id);
		findings.push(
			check(
				"cut-order",
				late.length === 0,
				"the outer cut is the last cut",
				`${late.length} cut(s) are drawn after the outer cut`,
				late,
			),
		);
	}

	const seen = new Map<string, string>();
	const keys = new Map<SvgPath, string>();
	const duplicates: string[] = [];
	for (const path of cut) {
		const key = shapeKey(path.points);
		keys.set(path, key);
		if (seen.has(key)) duplicates.push(path.id);
		else seen.set(key, path.id);
	}
	findings.push(
		check("no-duplicates", duplicates.length === 0, "no shape is cut twice", `${duplicates.length} cut(s) repeat an earlier cut`, duplicates),
	);

	const [bedX, bedY] = spec.bedMm;
	const offBed = doc.paths
		.filter(path => path.stroke === CUT_STROKE || path.stroke === ENGRAVE_STROKE)
		.filter(path => path.points.some(([x, y]) => x < 0 || y < 0 || x > bedX || y > bedY))
		.map(path => path.id);
	findings.push(
		check("fits-bed", offBed.length === 0, `every cut and engrave lies on the ${bedX} x ${bedY} mm bed`, `${offBed.length} path(s) run off the bed`, offBed),
	);

	let minWeb = Infinity;
	const thinPairs: string[] = [];
	for (let i = 0; i < cut.length; i++) {
		for (let j = i + 1; j < cut.length; j++) {
			const a = cut[i]!;
			const b = cut[j]!;
			// Identical shapes are a duplicate, and the duplicate rule reports them, not the web rule.
			if (keys.get(a) === keys.get(b)) continue;
			// Each cut's finished edge sits kerf/2 from its drawn line, toward the web, so the web loses one kerf.
			const web = edgeListDistance(edgesOf(a.points, a.closed), edgesOf(b.points, b.closed)) - spec.kerfMm;
			if (web < minWeb) minWeb = web;
			if (web < spec.minWebMm) thinPairs.push(a.id, b.id);
		}
	}
	if (Number.isFinite(minWeb)) measured.minWebMm = roundMm(minWeb);
	findings.push(
		check(
			"min-web",
			thinPairs.length === 0,
			`every web between cuts is at least ${spec.minWebMm} mm`,
			`${thinPairs.length / 2} pair(s) of cuts leave a web under ${spec.minWebMm} mm`,
			[...new Set(thinPairs)],
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
			const lost = hidden.keepMaterialMm.filter(point => !isMaterial(part, toDrawing(part, point))).length;
			findings.push(
				check(
					"hidden-material",
					lost === 0,
					`all ${hidden.keepMaterialMm.length} hidden keep-material samples stay material`,
					`${lost} hidden keep-material sample(s) fall inside a cut or outside the finished part`,
				),
			);
		}
	}

	const size: Scene["size"] = [doc.widthMm, doc.heightMm, spec.thicknessMm];
	return verdictOf(findings, measured, sceneOf(doc.paths, size, spec));
}
