import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../src/spec.ts";
import type { HiddenSample, Spec, Verdict } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const sample = (name: string): string => readFileSync(fileURLToPath(new URL(`../samples/${name}`, import.meta.url)), "utf8");

/** The enclosure spec with some fields replaced. Fails loudly when the patch is not a valid spec. */
function specWith(patch: Record<string, unknown> = {}): Spec {
	const raw = JSON.parse(sample("enclosure-panel.spec.json")) as Record<string, unknown>;
	const result = validateSpec({ ...raw, ...patch });
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.value;
}

const honest = sample("honest.svg");
const hidden = JSON.parse(sample("enclosure-panel.hidden.json")) as HiddenSample;

/** Replaces one fragment of the honest panel. Throws when the fragment is missing, so an edit cannot silently do nothing. */
function edit(text: string, from: string, to: string): string {
	if (!text.includes(from)) throw new Error(`fixture fragment not found: ${from}`);
	return text.replace(from, to);
}

const failed = (verdict: Verdict): string[] => verdict.findings.filter(finding => !finding.ok).map(finding => finding.rule);

const OUTLINE = `<path id="outline" d="M10 10 H130.2 V90.2 H10 Z" stroke="#ff0000" fill="none"/>`;
const WINDOW = `<rect id="window" x="55.2" y="44.2" width="29.8" height="11.8" stroke="#ff0000" fill="none"/>`;
const MOUNT_A = `<circle id="mount-a" cx="16.1" cy="84.1" r="1.5" stroke="#ff0000" fill="none"/>`;

test("the corrected honest panel passes with the shapes checked", () => {
	const verdict = verify(specWith(), honest, hidden);
	assert.deepEqual(failed(verdict), []);
});

test("a chamfered outer corner fails outer-size and nothing else", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 H130.2 V85.2 L125.2 90.2 H10 Z" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["outer-size"]);
});

test("a triangle with the right bounding box fails outer-size", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 L130.2 50.2 L10 90.2 Z" stroke="#ff0000" fill="none"/>`);
	assert.ok(failed(verify(specWith(), text)).includes("outer-size"));
});

test("a zero-area outline fails outer-size", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 H130.2 H10 Z" stroke="#ff0000" fill="none"/>`);
	assert.ok(failed(verify(specWith(), text)).includes("outer-size"));
});

test("an open outline fails closed-paths and outer-size", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 H130.2 V90.2 H10" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["closed-paths", "outer-size"]);
});

test("a rounded outline passes when the spec declares its corner radius, and fails when the spec says square", () => {
	const rounded = edit(honest, OUTLINE, `<rect id="outline" x="10" y="10" width="120.2" height="80.2" rx="1.1" ry="1.1" stroke="#ff0000" fill="none"/>`);
	const declared = verify(specWith({ cornerRadiusMm: 1 }), rounded);
	assert.deepEqual(failed(declared), []);
	const square = verify(specWith({ cornerRadiusMm: 0 }), rounded);
	assert.deepEqual(failed(square), ["outer-size"]);
});

test("a hidden corner removed by a chamfer fails hidden-material", () => {
	const text = edit(honest, OUTLINE, `<path id="outline" d="M10 10 H130.2 V85.2 L125.2 90.2 H10 Z" stroke="#ff0000" fill="none"/>`);
	const probe: HiddenSample = { keepMaterialMm: [[119.2, 1]] };
	assert.deepEqual(failed(verify(specWith(), text, probe)), ["outer-size", "hidden-material"]);
});

test("a square where the round hole belongs fails holes", () => {
	const text = edit(honest, MOUNT_A, `<rect id="mount-a" x="14.6" y="82.6" width="3" height="3" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["holes"]);
});

test("a zero-area hole where the round hole belongs fails holes", () => {
	const text = edit(honest, MOUNT_A, `<path id="mount-a" d="M14.6 84.1 H17.6 Z" stroke="#ff0000" fill="none"/>`);
	assert.ok(failed(verify(specWith(), text)).includes("holes"));
});

test("a blue circle where the required hole belongs fails holes and engrave-inside", () => {
	// The engraved circle is both a missing cut and an engraving outside the label region.
	const text = edit(honest, MOUNT_A, `<circle id="mount-a" cx="16.1" cy="84.1" r="1.5" stroke="#0000ff" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["holes", "engrave-inside"]);
});

test("an extra round cut at a new position fails holes", () => {
	for (const cx of [50.1, 52.1]) {
		const extra = `<circle id="extra" cx="${cx}" cy="84.1" r="1.5" stroke="#ff0000" fill="none"/>`;
		// Drawn before the outer cut, so cut-order stays clean and only the hole rule can fail.
		const text = edit(honest, OUTLINE, `${extra}\n${OUTLINE}`);
		assert.deepEqual(failed(verify(specWith(), text)), ["holes"], `cx ${cx}`);
	}
});

test("a hole moved 1 mm fails holes", () => {
	const text = edit(honest, MOUNT_A, `<circle id="mount-a" cx="17.1" cy="84.1" r="1.5" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["holes"]);
});

test("a hole with the wrong diameter fails holes", () => {
	const text = edit(honest, MOUNT_A, `<circle id="mount-a" cx="16.1" cy="84.1" r="2" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["holes"]);
});

/** A 300 mm part with one hole of the given finished diameter at the centre, and no slots. Outline and label are the honest panel's. */
const largeHoleSpec = (diameterMm: number): Spec =>
	specWith({ partMm: [300, 300], bedMm: [400, 400], holes: [{ id: "large", centreMm: [150, 150], diameterMm }], slots: [] });

/** The large-hole panel with the given cut as its hole. */
const largeHolePanel = (hole: string): string =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="400mm" height="400mm" viewBox="0 0 400 400">${hole}` +
	`<path id="label" d="M20 300.2 H60" stroke="#0000ff" fill="none"/>` +
	`<path id="outline" d="M10 10 H310.2 V310.2 H10 Z" stroke="#ff0000" fill="none"/></svg>`;

test("a 200 mm hole drawn as a 64-sided polygon fails holes, while the same hole as a true circle passes", () => {
	// Size and centre match the spec, so only the shape can fail. Each side of the polygon lies 0.12 mm inside its
	// circle, which is more than the 0.1 mm tolerance.
	const spec = largeHoleSpec(200.2);
	const sides = Array.from({ length: 64 }, (_, i) => {
		const a = (2 * Math.PI * i) / 64;
		return `${160.1 + 100 * Math.cos(a)},${160.1 + 100 * Math.sin(a)}`;
	}).join(" ");
	assert.deepEqual(failed(verify(spec, largeHolePanel(`<polygon id="large" points="${sides}" stroke="#ff0000" fill="none"/>`))), ["holes"]);
	const circle = `<circle id="large" cx="160.1" cy="160.1" r="100" stroke="#ff0000" fill="none"/>`;
	assert.deepEqual(failed(verify(spec, largeHolePanel(circle))), []);
});

test("a thin loop that runs round only three quarters of a circle fails holes", () => {
	// Every point lies within 0.02 mm of a 10 mm circle, so the uncut quarter is the only fault.
	const steps = 120;
	const sweep = (3 * Math.PI) / 2;
	const point = (radius: number, i: number): string => {
		const a = sweep * (i / steps);
		return `${160.1 + radius * Math.cos(a)},${160.1 + radius * Math.sin(a)}`;
	};
	const outer = Array.from({ length: steps + 1 }, (_, i) => point(10.02, i));
	const inner = Array.from({ length: steps + 1 }, (_, i) => point(9.98, steps - i));
	const loop = `<polygon id="large" points="${[...outer, ...inner].join(" ")}" stroke="#ff0000" fill="none"/>`;
	assert.deepEqual(failed(verify(largeHoleSpec(20.2), largeHolePanel(loop))), ["holes"]);
});

test("a loop with a 4 mm uncut bridge in a 200 mm hole fails holes", () => {
	// The bridge is narrower than the spacing of an evenly sampled circle, so only an exact check on the cut's edges
	// finds it. Every point lies within 0.02 mm of a 100 mm circle.
	const steps = 720;
	const sweep = 2 * Math.PI - 0.04; // 0.04 rad of a 100 mm circle is the 4 mm bridge
	const point = (radius: number, i: number): string => {
		const a = sweep * (i / steps);
		return `${160.1 + radius * Math.cos(a)},${160.1 + radius * Math.sin(a)}`;
	};
	const outer = Array.from({ length: steps + 1 }, (_, i) => point(100.02, i));
	const inner = Array.from({ length: steps + 1 }, (_, i) => point(99.98, steps - i));
	const loop = `<polygon id="large" points="${[...outer, ...inner].join(" ")}" stroke="#ff0000" fill="none"/>`;
	assert.deepEqual(failed(verify(largeHoleSpec(200.2), largeHolePanel(loop))), ["holes"]);
});

test("a diamond where the window belongs fails cutouts", () => {
	const text = edit(honest, WINDOW, `<path id="window" d="M70.1 44.2 L85 50.1 L70.1 56 L55.2 50.1 Z" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["cutouts"]);
});

test("a window outside the part fails cutouts", () => {
	const text = edit(honest, WINDOW, `<rect id="window" x="170" y="44.2" width="29.8" height="11.8" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["cutouts"]);
});

test("an open window fails closed-paths and cutouts", () => {
	const text = edit(honest, WINDOW, `<path id="window" d="M55.2 44.2 H85 V56 H55.2" stroke="#ff0000" fill="none"/>`);
	assert.deepEqual(failed(verify(specWith(), text)), ["closed-paths", "cutouts"]);
});

test("a rectangle inside the window fails cutouts", () => {
	// Inside the window with every web at least 3.6 mm, and drawn before the window, so only the cutout rule can fail.
	const stray = `<rect id="stray" x="62" y="48" width="10" height="4" stroke="#ff0000" fill="none"/>`;
	const text = edit(honest, WINDOW, `${stray}\n${WINDOW}`);
	assert.deepEqual(failed(verify(specWith(), text)), ["cutouts"]);
});

/** The honest panel with its four mount circles removed, so a spec can name its own holes. */
const withoutMounts = (): string => honest.replace(/<circle[^>]*\/>/g, "");

test("a required hole cut inside the window's waste fails holes and cutouts, even drawn before the window", () => {
	// The window's waste falls out, so a circle inside it is not the hole the spec asks for.
	const central = `<circle id="central" cx="70.1" cy="50.1" r="1.5" stroke="#ff0000" fill="none"/>`;
	const spec = specWith({ holes: [{ id: "central-hole", centreMm: [60, 40], diameterMm: 3.2 }] });
	assert.deepEqual(failed(verify(spec, edit(withoutMounts(), WINDOW, `${central}\n${WINDOW}`))), ["holes", "cutouts"]);
	// Drawn after the window, the same circle also fails cut-order, which is the control.
	assert.ok(failed(verify(spec, edit(withoutMounts(), WINDOW, `${WINDOW}\n${central}`))).includes("cut-order"));
});

test("a required window cut inside a larger required window fails cutouts, drawn before the larger window", () => {
	// Two slots with no holes: the small slot sits inside the large one's waste, so it is not matched to any cutout.
	const small = `<rect id="small" x="60.1" y="48.1" width="19.8" height="3.8" stroke="#ff0000" fill="none"/>`;
	const spec = specWith({ holes: [], slots: [{ id: "window", sizeMm: [30, 12] }, { id: "small", sizeMm: [20, 4] }] });
	assert.deepEqual(failed(verify(spec, edit(withoutMounts(), WINDOW, `${small}\n${WINDOW}`))), ["cutouts"]);
	assert.ok(failed(verify(spec, edit(withoutMounts(), WINDOW, `${WINDOW}\n${small}`))).includes("cut-order"), "outer-first is the control");
});

/** A 120 x 80 mm panel with the given hole, on a 300 x 200 mm bed. The outline's right and top edges are the kerf-widened sizes. */
const smallHolePanel = (hole: string, right: number, top: number): string =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200">${hole}` +
	`<path id="label" d="M65 77 H95" stroke="#0000ff" fill="none"/>` +
	`<path id="outline" d="M10 10 H${right} V${top} H10 Z" stroke="#ff0000" fill="none"/></svg>`;

/** Points of a C: two concentric arcs joined at both ends, open by gap radians at angle zero, with steps per arc. */
function cPoints(centre: [number, number], outer: number, inner: number, gap: number, steps: number): string {
	const at = (radius: number, angle: number): string => `${centre[0] + radius * Math.cos(angle)},${centre[1] + radius * Math.sin(angle)}`;
	const sweep = 2 * Math.PI - gap;
	const outerArc = Array.from({ length: steps + 1 }, (_, i) => at(outer, gap / 2 + (sweep * i) / steps));
	const innerArc = Array.from({ length: steps + 1 }, (_, i) => at(inner, gap / 2 + sweep - (sweep * i) / steps));
	return [...outerArc, ...innerArc].join(" ");
}

test("a C-shaped loop with a small gap fails holes, while the same hole as a true circle passes", () => {
	// Every stretch of the circle is covered and every point is within tolerance, but the loop winds round the centre zero times.
	type Case = { tolerance: number; kerfMm: number; diameterMm: number; outer: number; inner: number; gap: number; centre: [number, number]; right: number; top: number };
	const cases: Case[] = [
		{ tolerance: 1, kerfMm: 0.2, diameterMm: 20.2, outer: 10, inner: 9.5, gap: 0.18, centre: [30.1, 70.1], right: 130.2, top: 90.2 },
		{ tolerance: 0.1, kerfMm: 0.05, diameterMm: 20, outer: 9.975, inner: 9.895, gap: 0.018, centre: [30.025, 70.025], right: 130.05, top: 90.05 },
	];
	for (const c of cases) {
		const spec = specWith({
			kerfMm: c.kerfMm,
			holes: [{ id: "required-hole", centreMm: [20, 20], diameterMm: c.diameterMm, toleranceMm: c.tolerance }],
			slots: [],
			labelRegionMm: { originMm: [50, 10], sizeMm: [44, 6] },
		});
		const loop = `<polygon id="required-hole" points="${cPoints(c.centre, c.outer, c.inner, c.gap, 128)}" stroke="#ff0000" fill="none"/>`;
		assert.deepEqual(failed(verify(spec, smallHolePanel(loop, c.right, c.top))), ["holes"], `tolerance ${c.tolerance}`);
		const circle = `<circle id="required-hole" cx="${c.centre[0]}" cy="${c.centre[1]}" r="${c.outer}" stroke="#ff0000" fill="none"/>`;
		assert.deepEqual(failed(verify(spec, smallHolePanel(circle, c.right, c.top))), [], `tolerance ${c.tolerance}, true circle`);
	}
});

/** Points of a rounded rectangle drawn as a polygon, with steps segments on each corner arc and vertices on the arcs. */
function roundedCornersPoints(centre: [number, number], width: number, height: number, radius: number, steps: number): string {
	const [cx, cy] = centre;
	const hw = width / 2;
	const hh = height / 2;
	const corners: [number, number, number][] = [
		[cx + hw - radius, cy - hh + radius, -Math.PI / 2],
		[cx + hw - radius, cy + hh - radius, 0],
		[cx - hw + radius, cy + hh - radius, Math.PI / 2],
		[cx - hw + radius, cy - hh + radius, Math.PI],
	];
	return corners
		.flatMap(([ox, oy, start]) =>
			Array.from({ length: steps + 1 }, (_, i) => {
				const a = start + (Math.PI / 2) * (i / steps);
				return `${ox + radius * Math.cos(a)},${oy + radius * Math.sin(a)}`;
			}),
		)
		.join(" ");
}

test("a 200 mm-radius outline drawn with 16 segments a corner fails outer-size, while the true arc passes", () => {
	// Sixteen segments per corner put each chord's midpoint 0.24 mm inside its arc, more than the 0.1 mm tolerance.
	const spec = specWith({
		partMm: [600, 600],
		bedMm: [700, 700],
		cornerRadiusMm: 200,
		labelRegionMm: { originMm: [250, 20], sizeMm: [100, 10] },
		holes: [],
		slots: [],
	});
	const panel = (outline: string): string =>
		`<svg xmlns="http://www.w3.org/2000/svg" width="700mm" height="700mm" viewBox="0 0 700 700">${outline}` +
		`<path id="label" d="M270 585 H310" stroke="#0000ff" fill="none"/></svg>`;
	const probe: HiddenSample = { keepMaterialMm: [[300, 300]] };
	const coarse = `<polygon id="outline" points="${roundedCornersPoints([310.1, 310.1], 600.2, 600.2, 200.1, 16)}" stroke="#ff0000" fill="none"/>`;
	assert.deepEqual(failed(verify(spec, panel(coarse), probe)), ["outer-size"]);
	const fine = `<polygon id="outline" points="${roundedCornersPoints([310.1, 310.1], 600.2, 600.2, 200.1, 256)}" stroke="#ff0000" fill="none"/>`;
	assert.deepEqual(failed(verify(spec, panel(fine), probe)), []);
	const arc = `<rect id="outline" x="10" y="10" width="600.2" height="600.2" rx="200.1" ry="200.1" stroke="#ff0000" fill="none"/>`;
	assert.deepEqual(failed(verify(spec, panel(arc), probe)), []);
});

test("the mount hole drawn as cubic or quadratic arcs of the true circle passes holes, and an ellipse with unequal radii fails it", () => {
	// Four cubic arcs with the standard handle, and eight quadratic arcs whose control points sit where the tangents meet.
	const [cx, cy, r] = [16.1, 84.1, 1.5];
	const k = 0.5522847498 * r;
	const cubic = `<path id="mount-a" d="M${cx + r} ${cy} C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} Z" stroke="#ff0000" fill="none"/>`;
	const step = Math.PI / 4;
	const handle = r / Math.cos(step / 2);
	const quadratic = Array.from({ length: 8 }, (_, i) => {
		const mid = (i + 0.5) * step;
		const end = (i + 1) * step;
		return `Q${cx + handle * Math.cos(mid)} ${cy + handle * Math.sin(mid)} ${cx + r * Math.cos(end)} ${cy + r * Math.sin(end)}`;
	}).join(" ");
	const quadPath = `<path id="mount-a" d="M${cx + r} ${cy} ${quadratic} Z" stroke="#ff0000" fill="none"/>`;
	const ellipse = `<ellipse id="mount-a" cx="${cx}" cy="${cy}" rx="1.5" ry="1.62" stroke="#ff0000" fill="none"/>`;
	assert.deepEqual(failed(verify(specWith(), edit(honest, MOUNT_A, cubic), hidden)), []);
	assert.deepEqual(failed(verify(specWith(), edit(honest, MOUNT_A, quadPath), hidden)), []);
	assert.deepEqual(failed(verify(specWith(), edit(honest, MOUNT_A, ellipse), hidden)), ["holes"]);
});
