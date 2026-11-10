import assert from "node:assert/strict";
import test from "node:test";
import { boundsOf } from "../src/geometry.ts";
import { FLATTEN_TOL_MM, parseSvg } from "../src/svg.ts";
import type { SvgDoc } from "../src/types.ts";

const root = (body: string, attrs = 'width="300mm" height="200mm" viewBox="0 0 300 200"'): string =>
	`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

function parsed(text: string): SvgDoc {
	const result = parseSvg(text);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.value;
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

test("DOCTYPE, hidden geometry, rounded rectangles, and unknown elements are refused", () => {
	const cases: [string, string][] = [
		["DOCTYPE", `<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200"></svg>`],
		["display none", root('<rect id="r" x="0" y="0" width="2" height="2" display="none" stroke="#ff0000"/>')],
		["visibility hidden", root('<rect id="r" x="0" y="0" width="2" height="2" style="visibility:hidden" stroke="#ff0000"/>')],
		["rounded rect", root('<rect id="r" x="0" y="0" width="2" height="2" rx="0.5" stroke="#ff0000"/>')],
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
