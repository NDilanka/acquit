// G-code reader for the print twin's checks. It fails closed. A line it cannot read with certainty
// returns GCODE_UNPARSEABLE with that line number. Arcs are read in I/J form only, and R form is refused.
// Other M words are ignored. A layer opens at an extruding move when a ;LAYER_CHANGE or a Z change
// has happened since the last open and the Z differs from the open layer's Z. Hops that return to the
// open layer's Z therefore do not create layers.

import { mm, mmPerSecond } from "./types.ts";
import type { GcodeMove, ParsedGcode, PrintRejectReason } from "./types.ts";

export type GcodeResult =
	| { readonly ok: true; readonly value: ParsedGcode }
	| { readonly ok: false; readonly reason: PrintRejectReason };

const WORD = /^([A-Za-z])([-+]?(?:\d+(?:\.\d*)?|\.\d+))?$/;
const ARC_RADIUS_TOLERANCE_MM = 0.005;
const POSITION_EPSILON_MM = 1e-9;
const Z_COMMENT_EPSILON_MM = 1e-6;
const AXES: readonly string[] = ["X", "Y", "Z"];
const POSITION_WORDS: readonly string[] = ["X", "Y", "Z", "E"];

class GcodeError extends Error {
	readonly line: number;
	constructor(line: number) {
		super(`G-code line ${line} cannot be read`);
		this.line = line;
	}
}

function fail(line: number): never {
	throw new GcodeError(line);
}

type Pos = { x: number; y: number; z: number; e: number };
type Word = { letter: string; value: number | null };
type MutableLayer = { index: number; z: number; extrudedMm: number; pathLengthMm: number; moveCount: number };

export function parseGcode(text: string): GcodeResult {
	try {
		return { ok: true, value: read(text) };
	} catch (error) {
		if (error instanceof GcodeError) return { ok: false, reason: { kind: "GCODE_UNPARSEABLE", line: error.line } };
		throw error;
	}
}

function word(token: string, line: number): Word {
	const match = WORD.exec(token);
	if (!match) fail(line);
	return { letter: match[1].toUpperCase(), value: match[2] === undefined ? null : Number(match[2]) };
}

function parseNumber(text: string, line: number): number {
	const value = Number(text);
	if (text.trim() === "" || !Number.isFinite(value)) fail(line);
	return value;
}

function mod(value: number, modulus: number): number {
	return ((value % modulus) + modulus) % modulus;
}

function read(text: string): ParsedGcode {
	const layers: MutableLayer[] = [];
	const moves: GcodeMove[] = [];
	let pos: Pos = { x: 0, y: 0, z: 0, e: 0 };
	let absoluteXyz = true;
	let absoluteE = true;
	let feed: number | null = null;
	let feature = "";
	let layerPending = false;
	let zComment: { value: number; line: number } | null = null;

	const readFeed = (line: number, params: Map<string, number>): void => {
		const value = params.get("F");
		if (value === undefined) return;
		if (value <= 0) fail(line);
		feed = value / 60;
	};

	const endpoint = (params: Map<string, number>): Pos => {
		const axis = (letter: string, current: number): number => {
			const value = params.get(letter);
			if (value === undefined) return current;
			return absoluteXyz ? value : current + value;
		};
		const e = params.get("E");
		return {
			x: axis("X", pos.x),
			y: axis("Y", pos.y),
			z: axis("Z", pos.z),
			e: e === undefined ? pos.e : absoluteE ? e : pos.e + e,
		};
	};

	const move = (line: number, target: Pos, xyzMm: number): void => {
		const deltaE = target.e - pos.e;
		if (target.z !== pos.z) layerPending = true;
		pos = target;
		if (deltaE > 0) {
			const last = layers.at(-1);
			if (last === undefined || (layerPending && target.z !== last.z)) {
				if (zComment !== null && Math.abs(zComment.value - target.z) > Z_COMMENT_EPSILON_MM) fail(zComment.line);
				zComment = null;
				layers.push({ index: layers.length, z: target.z, extrudedMm: 0, pathLengthMm: 0, moveCount: 0 });
			}
			layerPending = false;
		}
		if (xyzMm <= 0 && deltaE === 0) return;
		const layer = layers.length - 1;
		if (layer >= 0) {
			layers[layer].moveCount += 1;
			if (deltaE > 0) {
				layers[layer].extrudedMm += deltaE;
				layers[layer].pathLengthMm += xyzMm;
			}
		}
		moves.push({
			line,
			layer,
			xyzMm: mm(xyzMm),
			distanceMm: mm(xyzMm > 0 ? xyzMm : Math.abs(deltaE)),
			feedMmPerSec: feed === null ? null : mmPerSecond(feed),
			deltaEMm: deltaE,
			feature,
		});
	};

	const linear = (line: number, params: Map<string, number>): void => {
		readFeed(line, params);
		const target = endpoint(params);
		move(line, target, Math.hypot(target.x - pos.x, target.y - pos.y, target.z - pos.z));
	};

	const arc = (line: number, params: Map<string, number>, clockwise: boolean): void => {
		readFeed(line, params);
		const i = params.get("I");
		const j = params.get("J");
		if (params.has("R") || i === undefined || j === undefined) fail(line);
		const target = endpoint(params);
		const cx = pos.x + i;
		const cy = pos.y + j;
		const radius = Math.hypot(i, j);
		if (Math.abs(Math.hypot(target.x - cx, target.y - cy) - radius) > ARC_RADIUS_TOLERANCE_MM) fail(line);
		const closed = Math.hypot(target.x - pos.x, target.y - pos.y) < POSITION_EPSILON_MM;
		const ccwTurn = closed
			? 2 * Math.PI
			: mod(Math.atan2(target.y - cy, target.x - cx) - Math.atan2(pos.y - cy, pos.x - cx), 2 * Math.PI);
		const sweep = clockwise && !closed ? 2 * Math.PI - ccwTurn : ccwTurn;
		move(line, target, Math.hypot(radius * sweep, target.z - pos.z));
	};

	const home = (line: number, params: Map<string, number>): void => {
		const named = AXES.filter(axis => params.has(axis));
		const axes = named.length > 0 ? named : AXES;
		const target: Pos = {
			x: axes.includes("X") ? 0 : pos.x,
			y: axes.includes("Y") ? 0 : pos.y,
			z: axes.includes("Z") ? 0 : pos.z,
			e: pos.e,
		};
		move(line, target, Math.hypot(target.x - pos.x, target.y - pos.y, target.z - pos.z));
	};

	const setPosition = (params: Map<string, number>): void => {
		if (!POSITION_WORDS.some(letter => params.has(letter))) {
			pos = { x: 0, y: 0, z: 0, e: 0 };
			return;
		}
		pos = {
			x: params.get("X") ?? pos.x,
			y: params.get("Y") ?? pos.y,
			z: params.get("Z") ?? pos.z,
			e: params.get("E") ?? pos.e,
		};
	};

	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = index + 1;
		const trimmed = lines[index].trim();
		if (trimmed.startsWith(";")) {
			if (trimmed === ";LAYER_CHANGE") layerPending = true;
			else if (trimmed.startsWith(";TYPE:")) feature = trimmed.slice(6).trim();
			else if (trimmed.startsWith(";Z:")) zComment = { value: parseNumber(trimmed.slice(3), line), line };
			continue;
		}
		const code = trimmed.split(";")[0].replace(/\*\d+$/, "").trim();
		if (code === "") continue;
		const [head, ...args] = code.split(/\s+/).map(token => word(token, line));
		if (head.letter === "M") {
			if (head.value === 82) absoluteE = true;
			else if (head.value === 83) absoluteE = false;
			continue;
		}
		if (head.letter !== "G" || head.value === null || !Number.isInteger(head.value)) fail(line);
		const params = new Map<string, number>();
		for (const arg of args) {
			if (arg.value === null) fail(line);
			params.set(arg.letter, arg.value);
		}
		switch (head.value) {
			case 0:
			case 1:
				linear(line, params);
				break;
			case 2:
				arc(line, params, true);
				break;
			case 3:
				arc(line, params, false);
				break;
			case 21:
				break;
			case 28:
				home(line, params);
				break;
			case 90:
				absoluteXyz = true;
				break;
			case 91:
				absoluteXyz = false;
				break;
			case 92:
				setPosition(params);
				break;
			default:
				fail(line);
		}
	}

	return {
		layers: layers.map(layer => ({
			index: layer.index,
			z: mm(layer.z),
			extrudedMm: layer.extrudedMm,
			pathLengthMm: mm(layer.pathLengthMm),
			moveCount: layer.moveCount,
		})),
		moves,
		extrudedMm: moves.reduce((sum, item) => sum + Math.max(0, item.deltaEMm), 0),
	};
}
