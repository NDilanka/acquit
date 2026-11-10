// The SVG reader. It takes the laser cut file as text and returns every drawn path in millimetres, flattened, with
// the stroke colour it carries. It reads the subset a laser cut file uses and refuses whatever it cannot place exactly
// (text, images, clip paths, hidden or partly transparent elements, styles it does not model), so no cut can hide in
// something the checker skipped.

import { MAX_CHORDS, MAX_DEPTH, MAX_ELEMENTS, MAX_POINTS, MAX_SUBPATHS, MAX_TEXT_CHARS } from "./limits.ts";
import type { Checked, SvgDoc, SvgPath, Vec2 } from "./types.ts";

/** Curves are flattened to chords within this distance of the true curve, in mm. The contract allows 0.05. */
export const FLATTEN_TOL_MM = 0.02;

const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** Millimetres per unit. Unitless and px follow the SVG convention of 96 px to the inch. */
const MM_PER_UNIT: Readonly<Record<string, number>> = { "": 25.4 / 96, px: 25.4 / 96, mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 };

const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
/** Unprefixed attributes a drawn element or the root may carry. Prefixed attributes are foreign metadata and are inert. */
const DRAWN_ATTRIBUTES = new Set([
	"id", "style", "transform", "stroke", "stroke-width", "stroke-opacity", "opacity", "fill", "display", "visibility",
	"stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
	"version", "width", "height", "viewBox", "preserveAspectRatio", "x", "y", "d", "cx", "cy", "r", "rx", "ry",
	"x1", "y1", "x2", "y2", "points",
]);
/**
 * The presentation properties. Each may be set as an attribute or in style, and each has one accepted range. The
 * caps, joins and miter limit only shape the ends and corners of a stroke, so laser tools write them by default and
 * they are read as well. A dash pattern would cut a path into pieces, so only "none" is accepted.
 */
const PRESENTATION = [
	"stroke", "stroke-width", "stroke-opacity", "opacity", "fill", "display", "visibility",
	"stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
];
const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";
const PLAIN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)$/;
const START = /<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const END_TAG = /<\/([A-Za-z_][\w.:-]*)\s*>/y;
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g;
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"]]);
/** The only colour names read. Any other keyword is refused, so every accepted colour is one a reader can compare exactly. */
const NAMED_COLOURS: ReadonlyMap<string, string> = new Map([["red", "#ff0000"], ["blue", "#0000ff"]]);
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/;
const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const RGB_PERCENT = /^rgb\(\s*(\d{1,3}(?:\.\d+)?)%\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*\)$/;
const NUMBER_TOKEN = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const SEPARATOR = /[\s,]*/y;
const TRANSFORM = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/y;

/** Affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

class SvgError extends Error {}

/** A parsed element. uri is its namespace, "" when the root declares none. */
type Element = {
	readonly name: string;
	readonly local: string;
	readonly uri: string;
	readonly attrs: ReadonlyMap<string, string>;
	readonly children: Element[];
};
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

const localOf = (name: string): string => name.slice(name.indexOf(":") + 1);
const prefixOf = (name: string): string => (name.includes(":") ? name.slice(0, name.indexOf(":")) : "");

/**
 * Decodes the predefined and numeric entities. A bare ampersand, an unknown name, or a code point that is not a
 * character is refused. Text is checked the same way even where it is not read.
 */
function decodeEntities(raw: string): string {
	if (!raw.includes("&")) return raw;
	if (raw.replace(ENTITY, "").includes("&")) throw new SvgError("a bare & must be written as &amp;");
	return raw.replace(ENTITY, (whole: string) => {
		const body = whole.slice(1, -1);
		if (body.startsWith("#")) {
			const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
			if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) throw new SvgError("a numeric entity is not a character");
			return String.fromCodePoint(code);
		}
		const named = NAMED_ENTITIES.get(body);
		if (named === undefined) throw new SvgError(`the entity &${body}; is not supported`);
		return named;
	});
}

function parseAttributes(text: string): Map<string, string> {
	const attrs = new Map<string, string>();
	for (const match of text.matchAll(ATTRIBUTE)) {
		const name = match[1]!;
		if (attrs.has(name)) throw new SvgError(`the attribute ${name} is given twice`);
		attrs.set(name, decodeEntities(match[2] ?? match[3] ?? ""));
	}
	return attrs;
}

/**
 * Parses the markup into one element tree. Only the XML declaration may open a file, so stylesheets and other
 * instructions are refused. DOCTYPE and CDATA are refused. Namespace declarations are only accepted on the root.
 */
function parseXml(text: string): Element {
	const stack: Element[] = [];
	let root: Element | null = null;
	const scope = new Map<string, string>([["xml", XML_NS]]);
	let elements = 0;
	let pos = 0;
	for (;;) {
		const lt = text.indexOf("<", pos);
		const chunk = text.slice(pos, lt < 0 ? text.length : lt);
		decodeEntities(chunk);
		if (stack.length === 0 && chunk.trim() !== "") throw new SvgError("text outside the root element");
		if (lt < 0) break;
		if (text.startsWith("<!--", lt)) {
			const end = text.indexOf("-->", lt + 4);
			if (end < 0) throw new SvgError("a comment is never closed");
			pos = end + 3;
		} else if (text.startsWith("<?", lt)) {
			const end = text.indexOf("?>", lt + 2);
			if (end < 0) throw new SvgError("a processing instruction is never closed");
			if (lt !== 0 || !/^<\?xml\s/.test(text.slice(lt, end + 2))) throw new SvgError("processing instructions are not accepted");
			pos = end + 2;
		} else if (text.startsWith("<!", lt)) {
			throw new SvgError("DOCTYPE and CDATA are not accepted");
		} else if (text.startsWith("</", lt)) {
			END_TAG.lastIndex = lt;
			const match = END_TAG.exec(text);
			if (match === null) throw new SvgError("a closing tag is malformed");
			const top = stack.pop();
			if (top === undefined || top.name !== match[1]) throw new SvgError(`</${match[1]}> does not close an open element`);
			pos = END_TAG.lastIndex;
		} else {
			START.lastIndex = lt;
			const match = START.exec(text);
			if (match === null) throw new SvgError("a tag is malformed or never closed");
			const name = match[1]!;
			const attrs = parseAttributes(match[2] ?? "");
			elements++;
			if (elements > MAX_ELEMENTS) throw new SvgError("the file has too many elements");
			if (stack.length + 1 > MAX_DEPTH) throw new SvgError("the file nests its elements too deeply");
			if (root === null) {
				for (const [key, value] of attrs) {
					if (key === "xmlns") scope.set("", value);
					else if (key.startsWith("xmlns:")) scope.set(key.slice(6), value);
				}
			} else {
				if (stack.length === 0) throw new SvgError("more than one root element");
				for (const key of attrs.keys()) {
					if (key === "xmlns" || key.startsWith("xmlns:")) throw new SvgError("namespace declarations are only accepted on the root element");
				}
			}
			for (const key of attrs.keys()) {
				const prefix = prefixOf(key);
				if (prefix !== "" && prefix !== "xmlns" && !scope.has(prefix)) throw new SvgError(`the prefix ${prefix} is not declared`);
			}
			const prefix = prefixOf(name);
			const uri = scope.get(prefix) ?? (prefix === "" ? "" : undefined);
			if (uri === undefined) throw new SvgError(`the prefix ${prefix} is not declared`);
			const element: Element = { name, local: localOf(name), uri, attrs, children: [] };
			if (root === null) root = element;
			else stack[stack.length - 1]!.children.push(element);
			if (!match[3]) stack.push(element);
			pos = START.lastIndex;
		}
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

function attrNumber(attrs: ReadonlyMap<string, string>, name: string, fallback: number): number {
	const value = attrs.get(name);
	return value === undefined ? fallback : finiteNumber(value.trim(), name);
}

/** A value a presentation property may take. Anything else is refused, so no drawn element can be hidden or faded. */
function checkPresentation(name: string, raw: string): void {
	const value = raw.trim();
	switch (name) {
		case "stroke":
			if (value.toLowerCase() !== "inherit") strokeValue(value);
			return;
		case "stroke-width":
			if (!(finiteNumber(value, "stroke-width") > 0)) throw new SvgError("stroke-width must be greater than 0");
			return;
		case "stroke-opacity":
		case "opacity":
			if (finiteNumber(value, name) !== 1) throw new SvgError(`${name} must be 1: partly transparent paths are not supported`);
			return;
		case "fill":
			if (value !== "none") throw new SvgError("fill must be none: filled shapes are not supported");
			return;
		case "stroke-linecap":
			if (!["butt", "round", "square"].includes(value)) throw new SvgError(`stroke-linecap ${value} is not supported`);
			return;
		case "stroke-linejoin":
			if (!["miter", "round", "bevel"].includes(value)) throw new SvgError(`stroke-linejoin ${value} is not supported`);
			return;
		case "stroke-miterlimit":
			if (!(finiteNumber(value, name) >= 1)) throw new SvgError("stroke-miterlimit must be at least 1");
			return;
		case "stroke-dasharray":
			if (value !== "none") throw new SvgError("stroke-dasharray must be none: dashed cuts are not supported");
			return;
		case "display":
			if (value !== "inline") throw new SvgError("display must be inline: hidden elements are not supported");
			return;
		default:
			if (value !== "visible") throw new SvgError("visibility must be visible: hidden elements are not supported");
	}
}

/** The declarations of a style attribute. Only presentation properties are read; an unknown, empty or repeated one is refused. */
function parseStyle(text: string): Map<string, string> {
	const declarations = new Map<string, string>();
	for (const part of text.split(";")) {
		if (part.trim() === "") continue;
		const colon = part.indexOf(":");
		if (colon < 0) throw new SvgError(`the style declaration ${part.trim()} has no value`);
		const name = part.slice(0, colon).trim().toLowerCase();
		const value = part.slice(colon + 1).trim();
		if (!PRESENTATION.includes(name)) throw new SvgError(`the style property ${name} is not supported`);
		if (value === "") throw new SvgError(`the style property ${name} has no value`);
		if (declarations.has(name)) throw new SvgError(`the style property ${name} is set twice`);
		declarations.set(name, value);
	}
	return declarations;
}

function rgbHex(parts: readonly number[]): string {
	return `#${parts
		.map(part => {
			if (!(part >= 0 && part <= 255)) throw new SvgError("an rgb() channel is out of range");
			return Math.round(part).toString(16).padStart(2, "0");
		})
		.join("")}`;
}

/** The lower-case hex of a colour written as #rgb, #rrggbb, rgb(), or one of the two named colours. null means no stroke. */
function strokeValue(raw: string): string | null {
	const value = raw.trim().toLowerCase();
	if (value === "none") return null;
	const named = NAMED_COLOURS.get(value);
	if (named !== undefined) return named;
	const hex = HEX.exec(value);
	if (hex !== null) {
		const digits = hex[1]!;
		return digits.length === 3 ? `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}` : `#${digits}`;
	}
	const rgb = RGB.exec(value);
	if (rgb !== null) return rgbHex(rgb.slice(1).map(Number));
	const percent = RGB_PERCENT.exec(value);
	if (percent !== null) {
		const parts = percent.slice(1).map(Number);
		if (parts.some(part => part > 100)) throw new SvgError("an rgb() percentage is out of range");
		return rgbHex(parts.map(part => (part * 255) / 100));
	}
	throw new SvgError(`the colour ${raw.trim()} is not supported; write it as #rrggbb, rgb(), red or blue`);
}

/**
 * The presentation values an element sets, from its attributes and its style. Style wins over the attribute, as in
 * CSS. Every value is checked, and an attribute or property outside the supported set is refused.
 */
function presentationOf(element: Element): Map<string, string> {
	for (const name of element.attrs.keys()) {
		if (name === "xmlns" || name.includes(":")) continue;
		if (!DRAWN_ATTRIBUTES.has(name)) throw new SvgError(`<${element.local}> attribute ${name} is not supported`);
	}
	const values = new Map<string, string>();
	for (const name of PRESENTATION) {
		const value = element.attrs.get(name);
		if (value !== undefined) {
			checkPresentation(name, value);
			values.set(name, value);
		}
	}
	for (const [name, value] of parseStyle(element.attrs.get("style") ?? "")) {
		checkPresentation(name, value);
		values.set(name, value);
	}
	return values;
}

/** The stroke an element draws with: its own value, the inherited one, or null for none. */
function strokeFrom(values: ReadonlyMap<string, string>, inherited: string | null): string | null {
	const value = values.get("stroke");
	if (value === undefined || value.trim().toLowerCase() === "inherit") return inherited;
	return strokeValue(value);
}

/** Title and description text is inert. An element inside one, or inside a defs, is refused. */
function refuseChildren(element: Element): void {
	if (element.children.length > 0) throw new SvgError(`<${element.local}> cannot hold elements in a laser cut file`);
}

/** Foreign elements are inert, but an SVG element inside one or inside metadata is refused, since a reader may draw it. */
function refuseSvgWithin(element: Element): void {
	for (const child of element.children) {
		if (child.uri === SVG_NS) throw new SvgError(`<${child.name}> is an SVG element inside a non-SVG element`);
		refuseSvgWithin(child);
	}
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

/**
 * A rounded rect, clockwise on the page, with each corner drawn as the quarter arc its radii name. The arcs start and
 * end on the straight edges, so the outline has no sharp corner left.
 */
function roundedRect(x: number, y: number, width: number, height: number, rx: number, ry: number, tol: number, budget: Budget): Vec2[] {
	const right = x + width;
	const bottom = y + height;
	spend(budget, 4);
	return [
		[right - rx, y],
		...arcSamples(right - rx, y + ry, rx, ry, 0, -Math.PI / 2, Math.PI / 2, tol, budget, [right, y + ry]),
		[right, bottom - ry],
		...arcSamples(right - rx, bottom - ry, rx, ry, 0, 0, Math.PI / 2, tol, budget, [right - rx, bottom]),
		[x + rx, bottom],
		...arcSamples(x + rx, bottom - ry, rx, ry, 0, Math.PI / 2, Math.PI / 2, tol, budget, [x, bottom - ry]),
		[x, y + ry],
		...arcSamples(x + rx, y + ry, rx, ry, 0, Math.PI, Math.PI / 2, tol, budget, [x + rx, y]),
	];
}

/**
 * A rect's radii: a missing rx takes ry and a missing ry takes rx, as in SVG, then each is clamped to half the side.
 * A radius of zero leaves the corner square.
 */
function rectSubpaths(attrs: ReadonlyMap<string, string>, tol: number, budget: Budget): Subpath[] {
	const x = attrNumber(attrs, "x", 0);
	const y = attrNumber(attrs, "y", 0);
	const width = attrNumber(attrs, "width", 0);
	const height = attrNumber(attrs, "height", 0);
	if (width < 0 || height < 0) throw new SvgError("a rect has a negative size");
	if (width === 0 || height === 0) return [];
	const rxGiven = attrs.has("rx") ? attrNumber(attrs, "rx", 0) : undefined;
	const ryGiven = attrs.has("ry") ? attrNumber(attrs, "ry", 0) : undefined;
	if ((rxGiven ?? 0) < 0 || (ryGiven ?? 0) < 0) throw new SvgError("a rect radius must not be negative");
	const rx = Math.min(rxGiven ?? ryGiven ?? 0, width / 2);
	const ry = Math.min(ryGiven ?? rxGiven ?? 0, height / 2);
	subpathSpend(budget);
	if (rx === 0 || ry === 0) {
		spend(budget, 4);
		return [{ points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]], closed: true }];
	}
	return [{ points: roundedRect(x, y, width, height, rx, ry, tol, budget), closed: true }];
}

function shapeSubpaths(local: string, attrs: ReadonlyMap<string, string>, tol: number, budget: Budget): Subpath[] {
	switch (local) {
		case "path":
			return parsePathData(attrs.get("d") ?? "", tol, budget);
		case "rect":
			return rectSubpaths(attrs, tol, budget);
		case "circle":
		case "ellipse": {
			const cx = attrNumber(attrs, "cx", 0);
			const cy = attrNumber(attrs, "cy", 0);
			const rx = local === "circle" ? attrNumber(attrs, "r", 0) : attrNumber(attrs, "rx", 0);
			const ry = local === "circle" ? rx : attrNumber(attrs, "ry", 0);
			if (rx < 0 || ry < 0) throw new SvgError(`<${local}> has a negative radius`);
			if (rx === 0 || ry === 0) return [];
			const samples = arcSamples(cx, cy, rx, ry, 0, 0, 2 * Math.PI, tol, budget);
			subpathSpend(budget);
			return [{ points: [[cx + rx, cy], ...samples.slice(0, -1)], closed: true }];
		}
		case "line": {
			const points: Vec2[] = [[attrNumber(attrs, "x1", 0), attrNumber(attrs, "y1", 0)], [attrNumber(attrs, "x2", 0), attrNumber(attrs, "y2", 0)]];
			subpathSpend(budget);
			spend(budget, 2);
			return [{ points, closed: false }];
		}
		default: {
			const values = (attrs.get("points") ?? "").trim().split(/[\s,]+/).filter(text => text !== "").map(text => finiteNumber(text, "points"));
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
	if (element.uri !== SVG_NS) {
		refuseSvgWithin(element);
		return;
	}
	const local = element.local;
	if (local === "title" || local === "desc" || local === "defs") {
		refuseChildren(element);
		return;
	}
	if (local === "metadata") {
		refuseSvgWithin(element);
		return;
	}
	if (local !== "g" && !SHAPES.has(local)) throw new SvgError(`<${element.name}> is not supported in a laser cut file`);
	const values = presentationOf(element);
	const transform = element.attrs.get("transform");
	const ctm = transform === undefined ? parentCtm : multiply(parentCtm, parseTransform(transform));
	if (!ctm.every(Number.isFinite)) throw new SvgError("a transform is too large");
	const stroke = strokeFrom(values, inherited);
	if (local === "g") {
		for (const child of element.children) visit(child, ctm, stroke, state);
		return;
	}
	for (const child of element.children) {
		if (child.uri !== SVG_NS || child.local !== "title") throw new SvgError(`<${local}> may only contain a title`);
		refuseChildren(child);
	}
	const subpaths = shapeSubpaths(local, element.attrs, FLATTEN_TOL_MM / stretch(ctm), state.budget);
	const order = state.order++;
	const id = element.attrs.get("id") ?? `${local}-${order}`;
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

/**
 * The root's size in mm, and the matrix that maps its viewBox onto that size. The viewBox is required, and the only
 * aspect handling is the SVG default, xMidYMid meet: uniform scale, centred, letterboxed.
 */
function rootFrame(root: Element): { unit: string; widthMm: number; heightMm: number; ctm: Matrix } {
	const length = (name: string) => {
		const text = root.attrs.get(name);
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
	const viewBox = root.attrs.get("viewBox");
	if (viewBox === undefined) throw new SvgError("the root svg needs a viewBox");
	const parts = viewBox.trim().split(/[\s,]+/).map(text => finiteNumber(text, "the viewBox"));
	if (parts.length !== 4 || !(parts[2]! > 0) || !(parts[3]! > 0)) throw new SvgError("the viewBox needs four numbers and a positive size");
	const aspect = (root.attrs.get("preserveAspectRatio") ?? "xMidYMid meet").trim().split(/\s+/).join(" ");
	if (aspect !== "xMidYMid meet") throw new SvgError("only the default preserveAspectRatio, xMidYMid meet, is supported");
	const [vx, vy, vw, vh] = parts;
	const scale = Math.min(width.mm / vw!, height.mm / vh!);
	let ctm: Matrix = [scale, 0, 0, scale, (width.mm - vw! * scale) / 2 - vx! * scale, (height.mm - vh! * scale) / 2 - vy! * scale];
	const transform = root.attrs.get("transform");
	if (transform !== undefined) ctm = multiply(ctm, parseTransform(transform));
	if (!ctm.every(Number.isFinite)) throw new SvgError("the root size is too large");
	return { unit: width.unit === height.unit ? width.unit : `${width.unit}/${height.unit}`, widthMm: width.mm, heightMm: height.mm, ctm };
}

/** Reads a laser cut SVG. Never throws: an unreadable file comes back as ok: false with one error. */
export function parseSvg(text: string): Checked<SvgDoc> {
	try {
		if (typeof text !== "string") throw new SvgError("the file must be SVG text");
		if (text.length > MAX_TEXT_CHARS) throw new SvgError("the file is larger than the reader accepts");
		const root = parseXml(text.replace(/^\uFEFF/, ""));
		if (root.name !== "svg" || root.uri !== SVG_NS) throw new SvgError("the root element must be an svg element in the SVG namespace");
		const frame = rootFrame(root);
		const rootStroke = strokeFrom(presentationOf(root), null);
		const state: State = { order: 0, paths: [], budget: { points: 0, subpaths: 0 } };
		for (const child of root.children) visit(child, frame.ctm, rootStroke, state);
		return { ok: true, value: { unit: frame.unit, widthMm: frame.widthMm, heightMm: frame.heightMm, paths: state.paths } };
	} catch (error) {
		const message = error instanceof SvgError ? error.message : "the file could not be read";
		return { ok: false, errors: [{ path: "", message }] };
	}
}
