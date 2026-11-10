import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../src/spec.ts";
import type { HiddenSample, Spec } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const sample = (name: string): string => readFileSync(fileURLToPath(new URL(`../samples/${name}`, import.meta.url)), "utf8");

function loadSpec(): Spec {
	const result = validateSpec(JSON.parse(sample("enclosure-panel.spec.json")));
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.value;
}

const spec = loadSpec();
const hidden = JSON.parse(sample("enclosure-panel.hidden.json")) as HiddenSample;
const honest = sample("honest.svg");

function numberAt(measured: Readonly<Record<string, number | string>>, key: string): number {
	const value = measured[key];
	assert.equal(typeof value, "number", `${key} is a number`);
	return value as number;
}

test("every scene path sits at the top of the stock", () => {
	const verdict = verify(spec, honest, hidden);
	assert.ok(verdict.scene.paths.length > 0);
	for (const path of verdict.scene.paths) assert.equal(path.z, spec.thicknessMm, path.id);
});

test("the outer cut is an outline, the other red cuts are cuts, and the label is an engrave", () => {
	const kinds = Object.fromEntries(verify(spec, honest, hidden).scene.paths.map(path => [path.id, path.kind]));
	assert.deepEqual(kinds, {
		"mount-a": "cut",
		"mount-b": "cut",
		"mount-c": "cut",
		"mount-d": "cut",
		window: "cut",
		label: "engrave",
		outline: "outline",
	});
});

test("a path with no laser colour is a travel path, not a cut", () => {
	const text = honest.replace('<path id="outline"', `<path id="guide" d="M30 30 H40" stroke="#00aa00" fill="none"/>\n  <path id="outline"`);
	const guide = verify(spec, text, hidden).scene.paths.find(path => path.id === "guide");
	assert.equal(guide?.kind, "travel");
});

test("every scene path has its own order", () => {
	const orders = verify(spec, honest, hidden).scene.paths.map(path => path.order);
	assert.ok(orders.every(order => order !== undefined));
	assert.equal(new Set(orders).size, orders.length);
});

test("the two subpaths of one compound element each get a scene path and an order", () => {
	const before = verify(spec, honest, hidden).scene.paths.length;
	const text = honest.replace(/<rect id="window"[^>]*\/>/, '<path id="pair" d="M55.2 44.2 H85 V56 H55.2 Z M60 46 H80 V54 H60 Z" stroke="#ff0000" fill="none"/>');
	const paths = verify(spec, text, hidden).scene.paths;
	assert.equal(paths.length, before + 1);
	assert.equal(new Set(paths.map(path => path.order)).size, paths.length);
});

test("the honest panel reports cut length, engrave length, hole count and an estimated time", () => {
	const measured = verify(spec, honest, hidden).measured;
	// Four holes, the window and the outline: about 521.7 mm of cut. The label is 40 mm of engraving.
	assert.ok(Math.abs(numberAt(measured, "cutLengthMm") - 521.7) < 0.5, `cut ${measured.cutLengthMm}`);
	assert.equal(numberAt(measured, "engraveLengthMm"), 40);
	assert.equal(numberAt(measured, "holeCount"), 4);
	// 52.17 s cutting at 10 mm/s, 0.4 s engraving at 100 mm/s, and 0.5 s to start each of the six cut paths.
	assert.ok(Math.abs(numberAt(measured, "estimatedCutSeconds") - 55.57) < 0.2, `time ${measured.estimatedCutSeconds}`);
});

test("an extra round cut counts as a hole in the hole count", () => {
	const text = honest.replace('<path id="outline"', `<circle id="extra" cx="50.1" cy="84.1" r="1.5" stroke="#ff0000" fill="none"/>\n  <path id="outline"`);
	assert.equal(numberAt(verify(spec, text, hidden).measured, "holeCount"), 5);
});

test("the scene and every measurement are finite, and a refused drawing keeps the stock thickness", () => {
	for (const text of [honest, "<svg"]) {
		const verdict = verify(spec, text, hidden);
		assert.ok(verdict.scene.size.every(Number.isFinite));
		assert.equal(verdict.scene.stock?.size[2], spec.thicknessMm);
		for (const path of verdict.scene.paths) {
			assert.ok(Number.isFinite(path.z), path.id);
			for (const [x, y] of path.points) assert.ok(Number.isFinite(x) && Number.isFinite(y), path.id);
		}
		for (const value of Object.values(verdict.measured)) {
			if (typeof value === "number") assert.ok(Number.isFinite(value));
		}
	}
});
