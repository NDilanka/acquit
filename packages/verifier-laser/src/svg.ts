// The SVG reader. It takes the laser cut file as text and returns every drawn path in millimetres, flattened,
// with the stroke colour it carries. It reads the subset a laser cut file uses and refuses whatever it cannot
// place exactly (text, images, clip paths, hidden elements), so no cut can hide in something the checker skipped.

import { MAX_CHORDS, MAX_DEPTH, MAX_ELEMENTS, MAX_POINTS, MAX_SUBPATHS, MAX_TEXT_CHARS } from "./limits.ts";
import type { Checked, SvgDoc, SvgPath, Vec2 } from "./types.ts";

/** Curves are flattened to chords within this distance of the true curve, in mm. The contract allows 0.05. */
export const FLATTEN_TOL_MM = 0.02;

/** Millimetres per unit. Unitless and px follow the SVG convention of 96 px to the inch. */
const MM_PER_UNIT: Readonly<Record<string, number>> = { "": 25.4 / 96, px: 25.4 / 96, mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 };

const SKIPPED = new Set(["defs", "metadata", "title", "desc", "style"]);
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";
const PLAIN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)$/;
const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NUMBER_TOKEN = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const SEPARATOR = /[\s,]*/y;
const TRANSFORM = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/y;

/** Affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

class SvgError extends Error {}

type Element = { readonly name: string; readonly attrs: Readonly<Record<string, string>>; readonly children: Element[] };
type Subpath = { readonly points: readonly Vec2[]; readonly closed: boolean };

/** What the file has drawn so far against the limits in limits.ts. Each point and subpath is charged before it is made. */
type Budget = { points: number; subpaths: number };
type State = { order: number; readonly paths: SvgPath[]; readonly budget: Budget };

/** Charges points to the file's allowance. Called before the points are allocated. */
function spend(budget: Budget, points: number): void {
	budget.points += points;
	if (!(budget.points <= MAX_POINTS)) throw new SvgError("the drawing has too many points to read");
}

/** Charges one curve's chords. A curve over the per-curve limit fails before any chord is made. */
function curveSpend(budget: Budget, chords: number): void {
	if (!(chords <= MAX_CHORDS)) throw new SvgError("a curve needs too many segments to flatten");
	spend(budget, chords);
}

function subpathSpend(budget: Budget): void {
	budget.subpaths++;
	if (budget.subpaths > MAX_SUBPATHS) throw new SvgError("the drawing has too many subpaths to read");
}

const localName = (name: string): string => name.slice(name.lastIndexOf(":") + 1);

function tagEnd(text: string, start: number): number {
	let quote = "";
	for (let i = start + 1; i < text.length; i++) {
		const c = text[i];
		if (quote !== "") {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'") quote = c;
		else if (c === ">") return i;
	}
	throw new SvgError("a tag is never closed");
}

function parseAttributes(text: string): Readonly<Record<string, string>> {
	const pairs: [string, string][] = [];
	for (const match of text.matchAll(ATTRIBUTE)) pairs.push([match[1]!, match[2] ?? match[3] ?? ""]);
	return Object.fromEntries(pairs);
}

function parseXml(text: string): Element {
	const stack: Element[] = [];
	let root: Element | null = null;
	let elements = 0;
	let pos = 0;
	while (pos < text.length) {
		const lt = text.indexOf("<", pos);
		const stop = lt < 0 ? text.length : lt;
		if (stack.length === 0 && text.slice(pos, stop).trim() !== "") throw new SvgError("text outside the root element");
		if (lt < 0) break;
		if (text.startsWith("<!--", lt)) {
			const end = text.indexOf("-->", lt + 4);
			if (end < 0) throw new SvgError("a comment is never closed");
			pos = end + 3;
			continue;
		}
		if (text.startsWith("<?", lt)) {
			const end = text.indexOf("?>", lt + 2);
			if (end < 0) throw new SvgError("a processing instruction is never closed");
			pos = end + 2;
			continue;
		}
		if (text.startsWith("<!", lt)) throw new SvgError("DOCTYPE and CDATA are not accepted");
		const end = tagEnd(text, lt);
		const body = text.slice(lt + 1, end);
		if (body.startsWith("/")) {
			const name = body.slice(1).trim();
			const top = stack.pop();
			if (top === undefined || top.name !== name) throw new SvgError(`</${name}> does not close an open element`);
		} else {
			const selfClosing = body.endsWith("/");
			const inner = (selfClosing ? body.slice(0, -1) : body).trimStart();
			const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(inner);
			if (nameMatch === null) throw new SvgError("a tag has no name");
			elements++;
			if (elements > MAX_ELEMENTS) throw new SvgError("the file has too many elements");
			if (stack.length + 1 > MAX_DEPTH) throw new SvgError("the file nests its elements too deeply");
			const element: Element = { name: nameMatch[0], attrs: parseAttributes(inner.slice(nameMatch[0].length)), children: [] };
			const parent = stack[stack.length - 1];
			if (parent !== undefined) parent.children.push(element);
			else if (root === null) root = element;
			else throw new SvgError("more than one root element");
			if (!selfClosing) stack.push(element);
		}
		pos = end + 1;
	}
	const open = stack[stack.length - 1];
	if (open !== undefined) throw new SvgError(`<${open.name}> is never closed`);
	if (root === null) throw new SvgError("no root element");
	return root;
}

const multiply = (m: Matrix, n: Matrix): Matrix => [
	m[0] * n[0] + m[2] * n[1],
	m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3],
	m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4],
	m[1] * n[4] + m[3] * n[5] + m[5],
];

const apply = (m: Matrix, [x, y]: Vec2): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** A point placed on the page. A transform large enough to overflow is refused rather than drawn as Infinity. */
function placed(m: Matrix, point: Vec2): Vec2 {
	const out = apply(m, point);
	if (!Number.isFinite(out[0]) || !Number.isFinite(out[1])) throw new SvgError("a coordinate is too large to place");
	return out;
}

/** An upper bound on how far the matrix can stretch a length. Flattening in user units divides the tolerance by it. */
const stretch = (m: Matrix): number => Math.hypot(m[0], m[1], m[2], m[3]);

/** A plain decimal number that is finite. 1e309 parses to Infinity, which the reader refuses. */
function finiteNumber(text: string, what: string): number {
	const value = Number(text);
	if (!PLAIN.test(text) || !Number.isFinite(value)) throw new SvgError(`${what} must be a finite plain number`);
	return value;
}

function transformOf(name: string, args: readonly number[]): Matrix {
	const count = (min: number, max: number) => {
		if (args.length < min || args.length > max) throw new SvgError(`${name} takes ${min} to ${max} numbers`);
	};
	switch (name) {
		case "matrix":
			count(6, 6);
			return [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
		case "translate":
			count(1, 2);
			return [1, 0, 0, 1, args[0]!, args[1] ?? 0];
		case "scale":
			count(1, 2);
			return [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
		case "rotate": {
			if (args.length !== 1 && args.length !== 3) throw new SvgError(`${name} takes 1 or 3 numbers`);
			const angle = (args[0]! * Math.PI) / 180;
			const rotation: Matrix = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
			if (args.length === 1) return rotation;
			const cx = args[1]!;
			const cy = args[2]!;
			return multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]);
		}
		case "skewX":
			count(1, 1);
			return [1, 0, Math.tan((args[0]! * Math.PI) / 180), 1, 0, 0];
		default:
			count(1, 1);
			return [1, Math.tan((args[0]! * Math.PI) / 180), 0, 1, 0, 0];
	}
}

function parseTransform(value: string): Matrix {
	let result: Matrix = IDENTITY;
	let i = 0;
	while (i < value.length) {
		TRANSFORM.lastIndex = i;
		const hit = TRANSFORM.exec(value);
		if (hit === null) {
			if (value.slice(i).trim() === "") break;
			throw new SvgError("a transform is not understood");
		}
		i = TRANSFORM.lastIndex;
		const args = hit[2]!.trim() === "" ? [] : hit[2]!.trim().split(/[\s,]+/).map(text => finiteNumber(text, "a transform number"));
		result = multiply(result, transformOf(hit[1]!, args));
	}
	return result;
}

function numberAttribute(attrs: Readonly<Record<string, string>>, name: string, fallback: number): number {
	const value = attrs[name];
	if (value === undefined) return fallback;
	return finiteNumber(value.trim(), name);
}

function refuseHidden(element: Element): void {
	const style = element.attrs.style ?? "";
	if (element.attrs.display === "none" || /display\s*:\s*none/.test(style)) throw new SvgError(`<${element.name}> is hidden (display none)`);
	if (element.attrs.visibility === "hidden" || /visibility\s*:\s*hidden/.test(style)) throw new SvgError(`<${element.name}> is hidden (visibility hidden)`);
}

/** The stroke colour in effect: the element's own, or the one it inherits. null means no stroke. */
function strokeOf(element: Element, inherited: string | null): string | null {
	const fromStyle = /(?:^|;)\s*stroke\s*:\s*([^;]+)/.exec(element.attrs.style ?? "")?.[1];
	const value = (fromStyle ?? element.attrs.stroke)?.trim().toLowerCase();
	if (value === undefined || value === "inherit") return inherited;
	return value === "none" ? null : value;
}

/**
 * Points on a circular or elliptical arc, excluding the start. The step is the largest angle whose chord stays within
 * tol of the arc: the sagitta r(1 - cos(step/2)) equals tol when sin(step/4)^2 = tol / (2r).
 */
function arcSamples(cx: number, cy: number, rx: number, ry: number, phi: number, theta1: number, dtheta: number, tol: number, budget: Budget, end?: Vec2): Vec2[] {
	const rMax = Math.max(rx, ry);
	const step = Math.min(Math.PI / 2, 4 * Math.asin(Math.min(1, Math.sqrt(tol / (2 * rMax)))));
	const n = Math.max(1, Math.ceil(Math.abs(dtheta) / step));
	curveSpend(budget, n);
	const cosPhi = Math.cos(phi);
	const sinPhi = Math.sin(phi);
	const out: Vec2[] = [];
	for (let k = 1; k <= n; k++) {
		if (k === n && end !== undefined) {
			out.push(end);
			break;
		}
		const t = theta1 + (dtheta * k) / n;
		out.push([cx + rx * cosPhi * Math.cos(t) - ry * sinPhi * Math.sin(t), cy + rx * sinPhi * Math.cos(t) + ry * cosPhi * Math.sin(t)]);
	}
	return out;
}

/** SVG's endpoint-to-centre arc conversion (implementation notes F.6.5), then sampling. */
function arcPoints(x1: number, y1: number, rxIn: number, ryIn: number, angleDeg: number, largeArc: boolean, sweep: boolean, x2: number, y2: number, tol: number, budget: Budget): Vec2[] {
	if (x1 === x2 && y1 === y2) return [];
	let rx = Math.abs(rxIn);
	let ry = Math.abs(ryIn);
	if (rx === 0 || ry === 0) {
		spend(budget, 1);
		return [[x2, y2]];
	}
	const phi = (angleDeg * Math.PI) / 180;
	const cosPhi = Math.cos(phi);
	const sinPhi = Math.sin(phi);
	const dx = (x1 - x2) / 2;
	const dy = (y1 - y2) / 2;
	const x1p = cosPhi * dx + sinPhi * dy;
	const y1p = -sinPhi * dx + cosPhi * dy;
	const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lambda > 1) {
		rx *= Math.sqrt(lambda);
		ry *= Math.sqrt(lambda);
	}
	const rx2 = rx * rx;
	const ry2 = ry * ry;
	const numerator = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
	const denominator = rx2 * y1p * y1p + ry2 * x1p * x1p;
	let coefficient = Math.sqrt(Math.max(0, numerator / denominator));
	if (largeArc === sweep) coefficient = -coefficient;
	const cxp = (coefficient * rx * y1p) / ry;
	const cyp = (-coefficient * ry * x1p) / rx;
	const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
	const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
	const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
	const theta2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
	let dtheta = theta2 - theta1;
	if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
	else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
	return arcSamples(cx, cy, rx, ry, phi, theta1, dtheta, tol, budget, [x2, y2]);
}

/** Distance of the middle control point from the chord, which bounds the cubic's second derivative. */
const bend = (a: Vec2, b: Vec2, c: Vec2): number => Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]);

function cubicPoints(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tol: number, budget: Budget): Vec2[] {
	const n = Math.max(1, Math.ceil(Math.sqrt((0.75 * Math.max(bend(p0, p1, p2), bend(p1, p2, p3))) / tol)));
	curveSpend(budget, n);
	const out: Vec2[] = [];
	for (let k = 1; k <= n; k++) {
		const t = k / n;
		const u = 1 - t;
		const a = u * u * u;
		const b = 3 * u * u * t;
		const c = 3 * u * t * t;
		const d = t * t * t;
		out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
	}
	return out;
}

function quadPoints(p0: Vec2, p1: Vec2, p2: Vec2, tol: number, budget: Budget): Vec2[] {
	const n = Math.max(1, Math.ceil(Math.sqrt(bend(p0, p1, p2) / (4 * tol))));
	curveSpend(budget, n);
	const out: Vec2[] = [];
	for (let k = 1; k <= n; k++) {
		const t = k / n;
		const u = 1 - t;
		out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
	}
	return out;
}

/** Walks path data into subpaths in user units. Curves are flattened in user units with the tolerance already scaled. */
function parsePathData(d: string, tol: number, budget: Budget): Subpath[] {
	const out: Subpath[] = [];
	const cursor = { i: 0, x: 0, y: 0, startX: 0, startY: 0, cur: null as Vec2[] | null, started: false };
	let cmd = "";
	let lastCtrl: Vec2 | null = null;
	let lastQuadCtrl: Vec2 | null = null;

	const skip = () => {
		SEPARATOR.lastIndex = cursor.i;
		SEPARATOR.exec(d);
		cursor.i = SEPARATOR.lastIndex;
	};
	const number = (): number => {
		NUMBER_TOKEN.lastIndex = cursor.i;
		const hit = NUMBER_TOKEN.exec(d);
		if (hit === null) throw new SvgError("path data has a bad number");
		cursor.i = NUMBER_TOKEN.lastIndex;
		skip();
		return finiteNumber(hit[0], "path data");
	};
	const flag = (): boolean => {
		const c = d[cursor.i];
		if (c !== "0" && c !== "1") throw new SvgError("an arc flag must be 0 or 1");
		cursor.i++;
		skip();
		return c === "1";
	};
	const flush = (closed: boolean) => {
		const cur = cursor.cur;
		cursor.cur = null;
		if (cur === null) return;
		if (closed && cur.length > 1 && cur[0]![0] === cur[cur.length - 1]![0] && cur[0]![1] === cur[cur.length - 1]![1]) cur.pop();
		if (cur.length >= 2) {
			subpathSpend(budget);
			out.push({ points: cur, closed });
		}
	};
	const ensure = (): Vec2[] => {
		if (cursor.cur === null) cursor.cur = [[cursor.x, cursor.y]];
		return cursor.cur;
	};
	/** A point drawn by a straight command. Curves charge their own chords before they make them. */
	const line = (point: Vec2) => {
		spend(budget, 1);
		ensure().push(point);
	};

	skip();
	while (cursor.i < d.length) {
		const ch = d[cursor.i]!;
		if (COMMANDS.includes(ch)) {
			cmd = ch;
			cursor.i++;
			skip();
		} else if (cmd === "" || cmd === "Z" || cmd === "z") {
			throw new SvgError("path data needs a command before its numbers");
		}
		const rel = cmd === cmd.toLowerCase();
		const upper = cmd.toUpperCase();
		if (!cursor.started && upper !== "M") throw new SvgError("path data must start with a moveto");
		cursor.started = true;
		const ox = rel ? cursor.x : 0;
		const oy = rel ? cursor.y : 0;

		switch (upper) {
			case "M": {
				const x = ox + number();
				const y = oy + number();
				flush(false);
				cursor.x = x;
				cursor.y = y;
				cursor.startX = x;
				cursor.startY = y;
				cursor.cur = [[x, y]];
				cmd = rel ? "l" : "L";
				break;
			}
			case "L": {
				const x = ox + number();
				const y = oy + number();
				line([x, y]);
				cursor.x = x;
				cursor.y = y;
				break;
			}
			case "H": {
				const x = (rel ? cursor.x : 0) + number();
				line([x, cursor.y]);
				cursor.x = x;
				break;
			}
			case "V": {
				const y = (rel ? cursor.y : 0) + number();
				line([cursor.x, y]);
				cursor.y = y;
				break;
			}
			case "C": {
				const c1: Vec2 = [ox + number(), oy + number()];
				const c2: Vec2 = [ox + number(), oy + number()];
				const end: Vec2 = [ox + number(), oy + number()];
				const start: Vec2 = [cursor.x, cursor.y];
				for (const point of cubicPoints(start, c1, c2, end, tol, budget)) ensure().push(point);
				cursor.x = end[0];
				cursor.y = end[1];
				lastCtrl = c2;
				break;
			}
			case "S": {
				const c1: Vec2 = lastCtrl === null ? [cursor.x, cursor.y] : [2 * cursor.x - lastCtrl[0], 2 * cursor.y - lastCtrl[1]];
				const c2: Vec2 = [ox + number(), oy + number()];
				const end: Vec2 = [ox + number(), oy + number()];
				for (const point of cubicPoints([cursor.x, cursor.y], c1, c2, end, tol, budget)) ensure().push(point);
				cursor.x = end[0];
				cursor.y = end[1];
				lastCtrl = c2;
				break;
			}
			case "Q": {
				const ctrl: Vec2 = [ox + number(), oy + number()];
				const end: Vec2 = [ox + number(), oy + number()];
				for (const point of quadPoints([cursor.x, cursor.y], ctrl, end, tol, budget)) ensure().push(point);
				cursor.x = end[0];
				cursor.y = end[1];
				lastQuadCtrl = ctrl;
				break;
			}
			case "T": {
				const ctrl: Vec2 = lastQuadCtrl === null ? [cursor.x, cursor.y] : [2 * cursor.x - lastQuadCtrl[0], 2 * cursor.y - lastQuadCtrl[1]];
				const end: Vec2 = [ox + number(), oy + number()];
				for (const point of quadPoints([cursor.x, cursor.y], ctrl, end, tol, budget)) ensure().push(point);
				cursor.x = end[0];
				cursor.y = end[1];
				lastQuadCtrl = ctrl;
				break;
			}
			case "A": {
				const rx = number();
				const ry = number();
				const angle = number();
				const largeArc = flag();
				const sweep = flag();
				const end: Vec2 = [ox + number(), oy + number()];
				for (const point of arcPoints(cursor.x, cursor.y, rx, ry, angle, largeArc, sweep, end[0], end[1], tol, budget)) ensure().push(point);
				cursor.x = end[0];
				cursor.y = end[1];
				break;
			}
			default: {
				// Z closes the open subpath and returns the pen to where it started.
				flush(true);
				cursor.x = cursor.startX;
				cursor.y = cursor.startY;
			}
		}
		if (upper !== "C" && upper !== "S") lastCtrl = null;
		if (upper !== "Q" && upper !== "T") lastQuadCtrl = null;
	}
	flush(false);
	return out;
}

function shapeSubpaths(local: string, attrs: Readonly<Record<string, string>>, tol: number, budget: Budget): Subpath[] {
	switch (local) {
		case "path":
			return parsePathData(attrs.d ?? "", tol, budget);
		case "rect": {
			if (numberAttribute(attrs, "rx", 0) !== 0 || numberAttribute(attrs, "ry", 0) !== 0) throw new SvgError("rounded rectangles are not supported");
			const x = numberAttribute(attrs, "x", 0);
			const y = numberAttribute(attrs, "y", 0);
			const width = numberAttribute(attrs, "width", 0);
			const height = numberAttribute(attrs, "height", 0);
			if (width <= 0 || height <= 0) return [];
			subpathSpend(budget);
			spend(budget, 4);
			return [{ points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]], closed: true }];
		}
		case "circle":
		case "ellipse": {
			const cx = numberAttribute(attrs, "cx", 0);
			const cy = numberAttribute(attrs, "cy", 0);
			const rx = local === "circle" ? numberAttribute(attrs, "r", 0) : numberAttribute(attrs, "rx", 0);
			const ry = local === "circle" ? rx : numberAttribute(attrs, "ry", 0);
			if (rx <= 0 || ry <= 0) return [];
			const samples = arcSamples(cx, cy, rx, ry, 0, 0, 2 * Math.PI, tol, budget);
			subpathSpend(budget);
			return [{ points: [[cx + rx, cy], ...samples.slice(0, -1)], closed: true }];
		}
		case "line": {
			const points: Vec2[] = [[numberAttribute(attrs, "x1", 0), numberAttribute(attrs, "y1", 0)], [numberAttribute(attrs, "x2", 0), numberAttribute(attrs, "y2", 0)]];
			subpathSpend(budget);
			spend(budget, 2);
			return [{ points, closed: false }];
		}
		default: {
			const values = (attrs.points ?? "").trim().split(/[\s,]+/).filter(text => text !== "").map(text => finiteNumber(text, "points"));
			if (values.length % 2 !== 0 || values.length < 4) return [];
			subpathSpend(budget);
			spend(budget, values.length / 2);
			const points: Vec2[] = [];
			for (let i = 0; i < values.length; i += 2) points.push([values[i]!, values[i + 1]!]);
			return [{ points, closed: local === "polygon" }];
		}
	}
}

function visit(element: Element, parentCtm: Matrix, inherited: string | null, state: State): void {
	const local = localName(element.name);
	if (SKIPPED.has(local)) return;
	if (local !== "g" && !SHAPES.has(local)) throw new SvgError(`<${element.name}> is not supported in a laser cut file`);
	refuseHidden(element);
	const ctm = element.attrs.transform === undefined ? parentCtm : multiply(parentCtm, parseTransform(element.attrs.transform));
	if (!ctm.every(Number.isFinite)) throw new SvgError("a transform is too large");
	const stroke = strokeOf(element, inherited);
	if (local === "g") {
		for (const child of element.children) visit(child, ctm, stroke, state);
		return;
	}
	const subpaths = shapeSubpaths(local, element.attrs, FLATTEN_TOL_MM / stretch(ctm), state.budget);
	const order = state.order++;
	const id = element.attrs.id ?? `${local}-${order}`;
	subpaths.forEach((subpath, k) => {
		state.paths.push({
			id: subpaths.length > 1 ? `${id}.${k}` : id,
			stroke,
			closed: subpath.closed,
			order,
			points: subpath.points.map(point => placed(ctm, point)),
		});
	});
}

/** The root's size in mm, and the matrix that maps its viewBox onto that size. */
function rootFrame(root: Element): { unit: string; widthMm: number; heightMm: number; ctm: Matrix } {
	const length = (name: string) => {
		const text = root.attrs[name];
		if (text === undefined) throw new SvgError(`the root svg needs a ${name}`);
		const match = LENGTH.exec(text.trim());
		if (match === null) throw new SvgError(`the root ${name} is not a length`);
		const unit = match[2]!.toLowerCase();
		if (!Object.hasOwn(MM_PER_UNIT, unit)) throw new SvgError(`the root ${name} uses an unsupported unit`);
		const value = finiteNumber(match[1]!, `the root ${name}`);
		if (!(value > 0)) throw new SvgError(`the root ${name} must be greater than 0`);
		return { unit, value, mm: value * MM_PER_UNIT[unit]! };
	};
	const width = length("width");
	const height = length("height");
	let view: [number, number, number, number] = [0, 0, width.value, height.value];
	if (root.attrs.viewBox !== undefined) {
		const parts = root.attrs.viewBox.trim().split(/[\s,]+/).map(Number);
		if (parts.length !== 4 || parts.some(value => !Number.isFinite(value)) || !(parts[2]! > 0) || !(parts[3]! > 0)) throw new SvgError("the viewBox is not four numbers with a positive size");
		view = [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
	}
	const sx = width.mm / view[2];
	const sy = height.mm / view[3];
	let ctm: Matrix = [sx, 0, 0, sy, -view[0] * sx, -view[1] * sy];
	if (root.attrs.transform !== undefined) ctm = multiply(ctm, parseTransform(root.attrs.transform));
	if (!ctm.every(Number.isFinite)) throw new SvgError("the root size is too large");
	return { unit: width.unit === height.unit ? width.unit : `${width.unit}/${height.unit}`, widthMm: width.mm, heightMm: height.mm, ctm };
}

/** Reads a laser cut SVG. Never throws: an unreadable file comes back as ok: false with one error. */
export function parseSvg(text: string): Checked<SvgDoc> {
	try {
		if (typeof text !== "string") throw new SvgError("the file must be SVG text");
		if (text.length > MAX_TEXT_CHARS) throw new SvgError("the file is larger than the reader accepts");
		const root = parseXml(text);
		if (localName(root.name) !== "svg") throw new SvgError("the root element must be svg");
		const frame = rootFrame(root);
		const state: State = { order: 0, paths: [], budget: { points: 0, subpaths: 0 } };
		const rootStroke = strokeOf(root, null);
		for (const child of root.children) visit(child, frame.ctm, rootStroke, state);
		return { ok: true, value: { unit: frame.unit, widthMm: frame.widthMm, heightMm: frame.heightMm, paths: state.paths } };
	} catch (error) {
		const message = error instanceof SvgError ? error.message : "the file could not be read";
		return { ok: false, errors: [{ path: "", message }] };
	}
}
