import assert from "node:assert/strict";
import test from "node:test";
import { boundsOf } from "../src/geometry.ts";
import { FLATTEN_TOL_MM, parseSvg } from "../src/svg.ts";
import type { SvgDoc, Vec2 } from "../src/types.ts";

const DEFAULT_ROOT = 'width="300mm" height="200mm" viewBox="0 0 300 200"';
const root = (body: string, attrs = DEFAULT_ROOT): string =>
	`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const RECT = '<rect id="r" x="0" y="0" width="2" height="2" stroke="#ff0000"/>';
const shape = (extra: string): string => `<rect id="r" x="0" y="0" width="2" height="2" stroke="#ff0000" ${extra}/>`;

function parsed(text: string): SvgDoc {
	const result = parseSvg(text);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.value;
}

/** The area of a closed polygon, from the shoelace formula. */
function areaOf(points: readonly Vec2[]): number {
	let twice = 0;
	for (let i = 0; i < points.length; i++) {
		const [ax, ay] = points[i]!;
		const [bx, by] = points[(i + 1) % points.length]!;
		twice += ax * by - bx * ay;
	}
	return Math.abs(twice) / 2;
}

/** Perimeter of an ellipse with semi-axes a and b (Ramanujan's approximation, accurate to well under 0.01%). */
function ellipsePerimeter(a: number, b: number): number {
	return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/**
 * For each chord that joins two points of one corner arc, how far its midpoint falls short of the arc. The chord
 * count shows the arcs were really drawn, not replaced by a corner.
 */
function worstChordError(points: readonly Vec2[], corners: readonly Vec2[], radius: number): { worst: number; chords: number } {
	let worst = 0;
	let chords = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i]!;
		const b = points[(i + 1) % points.length]!;
		const corner = corners.find(c => Math.abs(Math.hypot(a[0] - c[0], a[1] - c[1]) - radius) < 1e-6 && Math.abs(Math.hypot(b[0] - c[0], b[1] - c[1]) - radius) < 1e-6);
		if (corner === undefined) continue;
		chords++;
		const mid = Math.hypot((a[0] + b[0]) / 2 - corner[0], (a[1] + b[1]) / 2 - corner[1]);
		worst = Math.max(worst, radius - mid);
	}
	return { worst, chords };
}

function assertBox(points: readonly Vec2[], want: { minX: number; minY: number; maxX: number; maxY: number }): void {
	const box = boundsOf(points);
	assert.ok(box !== null);
	for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
		assert.ok(Math.abs(box[key] - want[key]) < 1e-9, `${key} is ${box[key]}, want ${want[key]}`);
	}
}

test("the honest sample reads into mm paths with their ids and colours", () => {
	const doc = parsed(root(`
		<circle id="mount-a" cx="16" cy="84.2" r="1.6" stroke="#ff0000"/>
		<rect id="window" x="55" y="44.2" width="30" height="12" stroke="#ff0000"/>
		<path id="label" d="M20 80.2 H60" stroke="#0000ff"/>
	`));
	assert.equal(doc.unit, "mm");
	assert.equal(doc.widthMm, 300);
	assert.equal(doc.heightMm, 200);
	assert.deepEqual(doc.paths.map(path => path.id), ["mount-a", "window", "label"]);
	assert.deepEqual(doc.paths.map(path => path.stroke), ["#ff0000", "#ff0000", "#0000ff"]);
	assert.equal(doc.paths[1]?.closed, true);
	assert.equal(doc.paths[2]?.closed, false);
});

test("relative and absolute path commands land on the same points", () => {
	const doc = parsed(root('<path id="p" d="m 10 10 l 10 0 l 0 10 z" stroke="#ff0000"/>'));
	assert.deepEqual(doc.paths[0]?.points, [[10, 10], [20, 10], [20, 20]]);
	assert.equal(doc.paths[0]?.closed, true);
});

test("an arc is flattened so no chord strays more than the stated tolerance from the circle", () => {
	const doc = parsed(root('<path id="a" d="M0 0 A5 5 0 0 1 10 0" stroke="#ff0000"/>'));
	const points = doc.paths[0]?.points ?? [];
	assert.ok(points.length > 2, "an arc is more than its two ends");
	for (const [x, y] of points) assert.ok(Math.abs(Math.hypot(x - 5, y) - 5) < 1e-6, "every vertex is on the circle");
	for (let i = 1; i < points.length; i++) {
		const [ax, ay] = points[i - 1]!;
		const [bx, by] = points[i]!;
		const mid = Math.hypot((ax + bx) / 2 - 5, (ay + by) / 2);
		assert.ok(5 - mid <= FLATTEN_TOL_MM + 1e-9, "a chord midpoint is within the flatten tolerance of the arc");
	}
});

test("a translate and a one-argument rotate apply to the geometry", () => {
	const moved = parsed(root('<g transform="translate(10 5)"><rect id="r" x="0" y="0" width="2" height="2" stroke="#ff0000"/></g>'));
	assert.deepEqual(boundsOf(moved.paths[0]!.points), { minX: 10, minY: 5, maxX: 12, maxY: 7 });
	const turned = parsed(root('<g transform="rotate(90)"><rect id="r" x="0" y="0" width="2" height="2" stroke="#ff0000"/></g>'));
	const box = boundsOf(turned.paths[0]!.points);
	assert.ok(box !== null);
	assert.ok(Math.abs(box.minX + 2) < 1e-9 && Math.abs(box.maxX) < 1e-9, "a quarter turn moves the rectangle to x -2..0");
	assert.ok(Math.abs(box.minY) < 1e-9 && Math.abs(box.maxY - 2) < 1e-9, "and y 0..2");
});

test("a rotate with two numbers is refused, not read as a broken transform", () => {
	const result = parseSvg(root('<g transform="rotate(90 0)"><rect id="r" x="0" y="0" width="2" height="2" stroke="#ff0000"/></g>'));
	assert.equal(result.ok, false);
});

test("a stroke is read from the attribute or the style, and inherited from a group", () => {
	const doc = parsed(root(`
		<path id="p" d="M0 0 L1 0" style="stroke:#ff0000"/>
		<g stroke="#0000ff"><path id="q" d="M0 0 L1 0"/></g>
		<path id="r" d="M0 0 L1 0" stroke="none"/>
	`));
	assert.deepEqual(doc.paths.map(path => path.stroke), ["#ff0000", "#0000ff", null]);
});

test("a path with two subpaths gives two paths with distinct ids", () => {
	const doc = parsed(root('<path id="two" d="M0 0 L1 0 L1 1 Z M5 5 L6 5 L6 6 Z" stroke="#ff0000"/>'));
	assert.equal(doc.paths.length, 2);
	assert.notEqual(doc.paths[0]?.id, doc.paths[1]?.id);
	assert.ok(doc.paths.every(path => path.closed));
});

test("a pixel root is read in mm at 96 dpi", () => {
	const doc = parsed(root('<rect id="r" x="0" y="0" width="10" height="10" stroke="#ff0000"/>', 'width="1134px" height="756px" viewBox="0 0 1134 756"'));
	assert.equal(doc.unit, "px");
	assert.ok(Math.abs(doc.widthMm - (1134 * 25.4) / 96) < 1e-6);
	assert.ok(Math.abs(doc.heightMm - (756 * 25.4) / 96) < 1e-6);
});

test("DOCTYPE, display and visibility, and unknown elements are refused", () => {
	const cases: [string, string][] = [
		["DOCTYPE", `<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200"></svg>`],
		["display none", root('<rect id="r" x="0" y="0" width="2" height="2" display="none" stroke="#ff0000"/>')],
		["visibility hidden", root('<rect id="r" x="0" y="0" width="2" height="2" style="visibility:hidden" stroke="#ff0000"/>')],
		["unknown element", root('<text x="0" y="0">hi</text>')],
		["bad number", root('<rect id="r" x="abc" y="0" width="2" height="2" stroke="#ff0000"/>')],
	];
	for (const [name, text] of cases) {
		const result = parseSvg(text);
		assert.equal(result.ok, false, name);
	}
});

test("a file with no usable root is refused with a message", () => {
	const cases: [string, string][] = [
		["no width", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"></svg>`],
		["not an svg root", `<html></html>`],
		["unclosed tag", `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200"><rect id="r"`],
		["empty text", ""],
	];
	for (const [name, text] of cases) {
		const result = parseSvg(text);
		assert.equal(result.ok, false, name);
		if (!result.ok) assert.ok(result.errors.length > 0 && result.errors[0]!.message.length > 0, name);
	}
});

test("garbage input never throws", () => {
	for (const text of ["\u0000\u0001 not xml", "<<<>>>", "<svg", "<svg>>", "&&&"]) {
		assert.doesNotThrow(() => parseSvg(text));
		assert.equal(parseSvg(text).ok, false);
	}
});

test("invisible variants of the root, a group or a shape are refused", () => {
	const cases: [string, string][] = [
		["root display none", root(RECT, `${DEFAULT_ROOT} display="none"`)],
		["root visibility hidden", root(RECT, `${DEFAULT_ROOT} visibility="hidden"`)],
		["root style display none", root(RECT, `${DEFAULT_ROOT} style="display:none"`)],
		["root opacity zero", root(RECT, `${DEFAULT_ROOT} opacity="0"`)],
		["root stroke width zero", root(RECT, `${DEFAULT_ROOT} stroke-width="0"`)],
		["group visibility collapse", root(`<g visibility="collapse">${RECT}</g>`)],
		["group opacity zero", root(`<g opacity="0">${RECT}</g>`)],
		["group opacity one half", root(`<g opacity="0.5">${RECT}</g>`)],
		["group style opacity zero", root(`<g style="opacity:0">${RECT}</g>`)],
		["group stroke width zero", root(`<g stroke-width="0">${RECT}</g>`)],
		["shape stroke opacity zero", root(shape('stroke-opacity="0"'))],
		["shape stroke width zero in style", root(shape('style="stroke-width:0"'))],
		["shape display none in style", root(shape('style="display:none"'))],
		["shape visibility hidden in style", root(shape('style="stroke: #ff0000; visibility: hidden"'))],
	];
	for (const [name, text] of cases) assert.equal(parseSvg(text).ok, false, name);
});

test("a visible drawing with full opacity and positive stroke widths is read", () => {
	const doc = parsed(root(`<g opacity="1" visibility="visible" stroke-width="0.2">${shape('style="stroke-width:0.1; opacity:1"')}</g>`));
	assert.deepEqual(doc.paths.map(path => path.id), ["r"]);
});

test("the cap, join and miter properties laser tools write by default are read, and bad values are refused", () => {
	const inkscape = `fill:none;stroke:#ff0000;stroke-width:0.264583;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1`;
	assert.deepEqual(parsed(root(shape(`style="${inkscape}"`))).paths.map(path => path.stroke), ["#ff0000"]);
	assert.equal(parseSvg(root(shape('stroke-linecap="square" stroke-linejoin="round"'))).ok, true);
	for (const extra of ['style="stroke-linejoin:arcs"', 'style="stroke-linecap:bogus"', 'style="stroke-miterlimit:0.5"', 'stroke-linejoin="miter-clip"']) {
		assert.equal(parseSvg(root(shape(extra))).ok, false, extra);
	}
});

test("a path held in defs is refused rather than skipped", () => {
	assert.equal(parseSvg(root(`<defs><path id="p" d="M0 0 L1 0" stroke="#ff0000"/></defs>${RECT}`)).ok, false);
});

test("unsupported CSS, class styling and rendering effects are refused", () => {
	const cases: [string, string][] = [
		["style element", root(`<style>*{stroke:none !important}</style>${RECT}`)],
		["style element inside defs", root(`<defs><style>.ghost{display:none}</style></defs>${RECT}`)],
		["class attribute", root(`<g class="ghost">${RECT}</g>`)],
		["stylesheet processing instruction", `<?xml-stylesheet href="cut.css" type="text/css"?>${root(RECT)}`],
		["mask style property", root(shape('style="mask:url(#m)"'))],
		["filter style property", root(shape('style="filter:blur(1px)"'))],
		["dash style property", root(shape('style="stroke-dasharray:2 2"'))],
		["style declaration with no value", root(shape('style="stroke"'))],
		["style property set twice", root(shape('style="stroke:#ff0000;stroke:none"'))],
		["clip-path attribute", root(shape('clip-path="url(#c)"'))],
		["mask attribute", root(shape('mask="url(#m)"'))],
		["filter attribute", root(shape('filter="url(#f)"'))],
		["dash array attribute", root(shape('stroke-dasharray="2 2"'))],
		["marker attribute", root('<path id="p" d="M0 0 L1 0" stroke="#ff0000" marker-end="url(#m)"/>')],
	];
	for (const [name, text] of cases) assert.equal(parseSvg(text).ok, false, name);
});

test("shape children other than titles are refused, and so are unsupported drawing elements", () => {
	const cases: [string, string][] = [
		["animate inside a rect", root('<rect id="r" x="0" y="0" width="2" height="2" stroke="#ff0000"><animate attributeName="stroke" to="none"/></rect>')],
		["set inside a path", root('<path id="p" d="M0 0 L1 0" stroke="#ff0000"><set attributeName="display" to="none"/></path>')],
		["use inside a circle", root('<circle id="c" cx="1" cy="1" r="1" stroke="#ff0000"><use href="#x"/></circle>')],
		["use", root('<use href="#r"/>')],
		["clipPath in the drawing", root(`<clipPath id="c">${RECT}</clipPath>`)],
		["image", root('<image href="cut.png" width="2" height="2"/>')],
		["anchor", root(`<a href="#x">${RECT}</a>`)],
		["switch", root(`<switch>${RECT}</switch>`)],
		["foreignObject", root(`<foreignObject>${RECT}</foreignObject>`)],
		["nested svg", root(`<svg x="0" y="0" width="2" height="2">${RECT}</svg>`)],
		["marker", root('<marker id="m"/>')],
	];
	for (const [name, text] of cases) assert.equal(parseSvg(text).ok, false, name);
});

test("a title inside a shape is allowed", () => {
	const doc = parsed(root('<path id="p" d="M0 0 L1 0" stroke="#ff0000"><title>label</title></path>'));
	assert.deepEqual(doc.paths.map(path => path.id), ["p"]);
});

test("malformed markup is refused", () => {
	const cases: [string, string][] = [
		["duplicate attribute", root('<rect id="r" x="0" x="1" y="0" width="2" height="2" stroke="#ff0000"/>')],
		["duplicate stroke attribute", root('<rect id="r" x="0" y="0" width="2" height="2" stroke="#ff0000" stroke="#0000ff"/>')],
		["unquoted value", root('<rect id="r" x=0 y="0" width="2" height="2" stroke="#ff0000"/>')],
		["attribute with no value", root('<rect id="r" x="0" y="0" width="2" height="2" disabled stroke="#ff0000"/>')],
		["no space between attributes", root('<rect id="r"x="0" y="0" width="2" height="2" stroke="#ff0000"/>')],
		["stray text between attributes", root('<rect id="r" ! x="0" y="0" width="2" height="2" stroke="#ff0000"/>')],
		["less-than sign in a value", root('<rect id="a<b" x="0" y="0" width="2" height="2" stroke="#ff0000"/>')],
		["unclosed value", root('<rect id="r" x="0 y="0" width="2" height="2" stroke="#ff0000"/>')],
		["unknown entity in a value", root('<path id="p" d="M0 0 L1 0" stroke="&bogus;"/>')],
		["bare ampersand in a value", root('<path id="a&b" d="M0 0 L1 0" stroke="#ff0000"/>')],
		["unknown entity in text", root(`<title>a &bogus; b</title>${RECT}`)],
		["mismatched closing tag", root(`<g>${RECT}</h>`)],
		["DTD with an entity", `<!DOCTYPE svg [<!ENTITY x "y">]>${root(RECT)}`],
		["CDATA", root(`<title><![CDATA[x]]></title>${RECT}`)],
	];
	for (const [name, text] of cases) assert.equal(parseSvg(text).ok, false, name);
});

test("the XML declaration and comments are accepted, and entities decode in values", () => {
	const doc = parsed(`<?xml version="1.0" encoding="UTF-8"?><!-- cut file -->${root('<path id="a&amp;b" d="M0 0 L1 0" stroke="&#x23;ff0000"/>')}`);
	assert.deepEqual(doc.paths.map(path => [path.id, path.stroke]), [["a&b", "#ff0000"]]);
});

test("colour forms that name the same colour read to one canonical value", () => {
	const red = [
		'stroke="#ff0000"', 'stroke="#F00"', 'stroke="red"', 'stroke="RED"', 'stroke="rgb(255,0,0)"', 'stroke="rgb(100%, 0%, 0%)"',
		'stroke="&#35;ff0000"', 'stroke="&#x23;FF0000"', 'stroke=" #ff0000 "', 'style="stroke:#f00"', 'style="stroke: red"',
	];
	for (const form of red) {
		const doc = parsed(root(`<rect id="r" x="0" y="0" width="2" height="2" ${form}/>`));
		assert.equal(doc.paths[0]?.stroke, "#ff0000", form);
	}
	const blue = ['stroke="blue"', 'stroke="#00f"', 'stroke="rgb(0,0,255)"', 'style="stroke:#0000FF"'];
	for (const form of blue) {
		const doc = parsed(root(`<path id="p" d="M0 0 L1 0" ${form}/>`));
		assert.equal(doc.paths[0]?.stroke, "#0000ff", form);
	}
});

test("colours that cannot be read exactly are refused", () => {
	const forms = [
		'stroke="#ff000080"', 'stroke="rgba(255,0,0,1)"', 'stroke="url(#g)"', 'stroke="currentColor"',
		'stroke="hsl(0 100% 50%)"', 'stroke="rgb(300,0,0)"', 'stroke="transparent"', 'stroke=""',
	];
	for (const form of forms) assert.equal(parseSvg(root(`<rect id="r" x="0" y="0" width="2" height="2" ${form}/>`)).ok, false, form);
});

test("a rounded rectangle is read with its corners rounded to the stated radii", () => {
	const both = parsed(root('<rect id="r" x="0" y="0" width="20" height="10" rx="2" ry="2" stroke="#ff0000"/>')).paths[0]!;
	const oneRadius = parsed(root('<rect id="r" x="0" y="0" width="20" height="10" rx="2" stroke="#ff0000"/>')).paths[0]!;
	const otherRadius = parsed(root('<rect id="r" x="0" y="0" width="20" height="10" ry="2" stroke="#ff0000"/>')).paths[0]!;
	assert.deepEqual(oneRadius.points, both.points, "rx alone sets ry too");
	assert.deepEqual(otherRadius.points, both.points, "ry alone sets rx too");
	assert.equal(both.closed, true);
	assertBox(both.points, { minX: 0, minY: 0, maxX: 20, maxY: 10 });
	// Chords inside the arcs remove a little area too: at most the flattening tolerance times the arc length.
	const cornerArcs = 2 * Math.PI * 2;
	assert.ok(Math.abs(areaOf(both.points) - (200 - (4 - Math.PI) * 4)) < FLATTEN_TOL_MM * cornerArcs, "each corner loses r squared times (1 - pi/4)");
	const { worst, chords } = worstChordError(both.points, [[2, 2], [18, 2], [18, 8], [2, 8]], 2);
	assert.ok(chords >= 4, "every corner is drawn as an arc");
	assert.ok(worst <= FLATTEN_TOL_MM + 1e-9, `every chord stays within the flattening tolerance of its corner arc, worst ${worst}`);
	assert.ok(!both.points.some(([x, y]) => x === 0 && y === 0), "the sharp corner is gone");
});

test("oversized radii are clamped to half the sides, and a zero radius leaves a square corner", () => {
	const oversized = parsed(root('<rect id="r" x="0" y="0" width="20" height="10" rx="50" ry="50" stroke="#ff0000"/>')).paths[0]!;
	assertBox(oversized.points, { minX: 0, minY: 0, maxX: 20, maxY: 10 });
	const cornerArcsClamped = ellipsePerimeter(10, 5);
	assert.ok(Math.abs(areaOf(oversized.points) - (200 - (4 - Math.PI) * 10 * 5)) < FLATTEN_TOL_MM * cornerArcsClamped, "rx is clamped to 10 and ry to 5");
	const square = parsed(root('<rect id="r" x="0" y="0" width="20" height="10" rx="0" ry="2" stroke="#ff0000"/>')).paths[0]!;
	assert.equal(square.points.length, 4);
});

test("a rounded rectangle under a transform keeps its flattening tolerance in mm", () => {
	const points = parsed(root('<g transform="scale(2)"><rect id="r" x="0" y="0" width="10" height="5" rx="1" stroke="#ff0000"/></g>')).paths[0]!.points;
	assertBox(points, { minX: 0, minY: 0, maxX: 20, maxY: 10 });
	assert.ok(Math.abs(areaOf(points) - (200 - (4 - Math.PI) * 4)) < FLATTEN_TOL_MM * 2 * Math.PI * 2, "the transformed corners keep the same area in mm");
	const { worst, chords } = worstChordError(points, [[2, 2], [18, 2], [18, 8], [2, 8]], 2);
	assert.ok(chords >= 4 && worst <= FLATTEN_TOL_MM + 1e-9, `worst ${worst} over ${chords} chords`);
});

test("a rounded rectangle with a negative or percentage radius is refused", () => {
	for (const attr of ['rx="-1"', 'rx="50%"', 'ry="-2"']) {
		assert.equal(parseSvg(root(`<rect id="r" x="0" y="0" width="20" height="10" ${attr} stroke="#ff0000"/>`)).ok, false, attr);
	}
});

test("the root viewBox maps onto the page with the default preserveAspectRatio, letterboxed", () => {
	const body = '<g transform="scale(2 1)"><rect id="p" x="0" y="0" width="120.2" height="80.2" stroke="#ff0000"/></g>';
	const wide = 'width="300mm" height="200mm" viewBox="0 0 600 200"';
	for (const attrs of [wide, `${wide} preserveAspectRatio="xMidYMid meet"`]) {
		assertBox(parsed(root(body, attrs)).paths[0]!.points, { minX: 0, minY: 50, maxX: 120.2, maxY: 90.1 });
	}
});

test("a viewBox that is offset or narrower than the page is centred on it", () => {
	const offset = parsed(root('<rect id="r" x="100" y="50" width="10" height="10" stroke="#ff0000"/>', 'width="300mm" height="200mm" viewBox="100 50 300 200"'));
	assertBox(offset.paths[0]!.points, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
	const tall = parsed(root('<rect id="r" x="0" y="0" width="300" height="200" stroke="#ff0000"/>', 'width="300mm" height="100mm" viewBox="0 0 300 200"'));
	assertBox(tall.paths[0]!.points, { minX: 75, minY: 0, maxX: 225, maxY: 100 });
});

test("a preserveAspectRatio other than the default is refused", () => {
	for (const value of ["none", "xMinYMin meet", "xMidYMid slice"]) {
		assert.equal(parseSvg(root(RECT, `${DEFAULT_ROOT} preserveAspectRatio="${value}"`)).ok, false, value);
	}
});

test("a root without a viewBox or outside the SVG namespace is refused", () => {
	const cases: [string, string][] = [
		["no viewBox", root(RECT, 'width="300mm" height="200mm"')],
		["no namespace", `<svg width="300mm" height="200mm" viewBox="0 0 300 200">${RECT}</svg>`],
		["xhtml namespace", `<svg xmlns="http://www.w3.org/1999/xhtml" width="300mm" height="200mm" viewBox="0 0 300 200">${RECT}</svg>`],
		["prefixed root", `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200">${RECT}</svg:svg>`],
	];
	for (const [name, text] of cases) assert.equal(parseSvg(text).ok, false, name);
});

test("foreign elements are inert, but SVG shapes inside them, undeclared prefixes and namespace changes are refused", () => {
	const decls = 'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"';
	const doc = parsed(root(`<sodipodi:namedview id="n" pagecolor="#ffffff" inkscape:document-units="mm"/>${RECT.replace('id="r"', 'id="r" inkscape:label="cut"')}`, `${DEFAULT_ROOT} ${decls}`));
	assert.deepEqual(doc.paths.map(path => path.id), ["r"]);
	const cases: [string, string][] = [
		["undeclared prefix", root('<x:rect id="r" x="0" y="0" width="2" height="2" stroke="#ff0000"/>')],
		["svg shape inside a foreign element", root(`<x:box xmlns:x="urn:example">${RECT}</x:box>`)],
		["default namespace changed", root(`<g xmlns="http://www.w3.org/1999/xhtml">${RECT}</g>`)],
		["SVG namespace redeclared on a child", root(`<g xmlns:s="http://www.w3.org/2000/svg"><s:rect id="r" x="0" y="0" width="2" height="2" stroke="#ff0000"/></g>`)],
	];
	for (const [name, text] of cases) assert.equal(parseSvg(text).ok, false, name);
});
