// One verdict for a laser-cut panel. The file is read as text and flattened to millimetres, then every rule runs.
// Findings come back in RULES order. The verdict passes only when every finding is ok. The hidden-material rule
// runs only when the verifier holds samples, so a verdict without them carries no hidden finding.

import { boundsOf, centreOf, edgeListDistance, edgesOf, heightOf, pointInPolygon, roundMm, selfCrosses, shapeKey, widthOf } from "./geometry.ts";
import type { Bounds } from "./geometry.ts";
import { parseSvg } from "./svg.ts";
import { CUT_STROKE, ENGRAVE_STROKE, RULES } from "./types.ts";
import type { Finding, HiddenSample, Rule, Scene, ScenePath, Spec, SvgPath, Verdict, Vec2 } from "./types.ts";

type Outline = { readonly path: SvgPath; readonly box: Bounds };

/** A cut path measured in the part frame: its bounding box size and centre. */
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

/** Part frame: origin at the outline's lower-left corner, y up. */
const toPart = (box: Bounds, [x, y]: Vec2): Vec2 => [x - box.minX, box.maxY - y];
const toDrawing = (box: Bounds, [px, py]: Vec2): Vec2 => [px + box.minX, box.maxY - py];

function candidateOf(path: SvgPath, box: Bounds): Candidate | null {
	const own = boundsOf(path.points);
	if (own === null) return null;
	const [cx, cy] = centreOf(own);
	return { path, width: widthOf(own), height: heightOf(own), centre: toPart(box, [cx, cy]) };
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

/** Checks a laser cut panel file against the spec. Never throws: an unreadable file fails the parse rule. */
export function verify(spec: Spec, artefact: string, hidden?: HiddenSample): Verdict {
	const parsed = parseSvg(artefact);
	if (!parsed.ok) {
		const message = parsed.errors[0]?.message ?? "the file could not be read";
		const size: Scene["size"] = [spec.partMm[0], spec.partMm[1], spec.thicknessMm];
		return verdictOf([{ rule: "parse", ok: false, hidden: false, message }], {}, sceneOf([], size, spec));
	}

	const doc = parsed.value;
	const cut = doc.paths.filter(path => path.stroke === CUT_STROKE);
	const engrave = doc.paths.filter(path => path.stroke === ENGRAVE_STROKE);
	const outline = outlineOf(cut);
	const tol = spec.toleranceMm;
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

	const candidates = outline === null ? [] : cut.map(path => candidateOf(path, outline.box)).filter((c): c is Candidate => c !== null);
	const used = new Set<Candidate>();
	const holeMisses: string[] = [];
	for (const hole of spec.holes) {
		const [cx, cy] = hole.centreMm;
		const d = hole.diameterMm;
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

	const outlineBox = outline?.box ?? null;
	const insidePart = (point: Vec2): boolean => {
		if (outline === null || outlineBox === null) return false;
		const [x, y] = point;
		if (x < outlineBox.minX || x > outlineBox.maxX || y < outlineBox.minY || y > outlineBox.maxY) return false;
		return !cut.some(path => path !== outline.path && path.closed && pointInPolygon(point, path.points));
	};
	const stray = engrave.filter(path => !path.points.every(insidePart)).map(path => path.id);
	findings.push(
		check(
			"engrave-inside",
			stray.length === 0,
			"every engraving lies inside the part and clear of the cuts",
			`${stray.length} engraving(s) lie outside the part or inside a cut`,
			stray,
		),
	);

	if (outline === null) {
		findings.push(check("outer-size", false, "", "no outer cut outline"));
		findings.push(check("cut-order", false, "", "no outer cut outline to order against"));
	} else {
		const [px, py] = spec.partMm;
		const width = widthOf(outline.box);
		const height = heightOf(outline.box);
		const expectWidth = px + spec.kerfMm;
		const expectHeight = py + spec.kerfMm;
		measured.outlineWidthMm = roundMm(width);
		measured.outlineHeightMm = roundMm(height);
		measured.kerfWidthMm = roundMm(width - px);
		measured.kerfHeightMm = roundMm(height - py);
		findings.push(
			check(
				"outer-size",
				near(width, expectWidth, tol) && near(height, expectHeight, tol),
				`the outer cut is ${roundMm(width)} x ${roundMm(height)} mm, the finished part plus kerf`,
				`the outer cut is ${roundMm(width)} x ${roundMm(height)} mm; the finished part plus kerf is ${roundMm(expectWidth)} x ${roundMm(expectHeight)} mm`,
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
			const gap = edgeListDistance(edgesOf(a.points, a.closed), edgesOf(b.points, b.closed));
			if (gap < minWeb) minWeb = gap;
			if (gap < spec.minWebMm) thinPairs.push(a.id, b.id);
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
		if (outline === null) {
			findings.push(check("hidden-material", false, "", "no outer cut to place the hidden samples against"));
		} else {
			const enclosing = cut.filter(path => path !== outline.path && path.closed);
			let cutAway = 0;
			for (const point of hidden.keepMaterialMm) {
				const drawn = toDrawing(outline.box, point);
				if (enclosing.some(path => pointInPolygon(drawn, path.points))) cutAway++;
			}
			findings.push(
				check(
					"hidden-material",
					cutAway === 0,
					`all ${hidden.keepMaterialMm.length} hidden keep-material samples stay material`,
					`${cutAway} hidden keep-material sample(s) fall inside a cut`,
				),
			);
		}
	}

	const size: Scene["size"] = [doc.widthMm, doc.heightMm, spec.thicknessMm];
	return verdictOf(findings, measured, sceneOf(doc.paths, size, spec));
}
