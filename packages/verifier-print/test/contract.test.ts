import assert from "node:assert/strict";
import test from "node:test";
import type { Instant, JobId } from "../../core/src/ids.ts";
import { freeze, hiddenDigest, reveal, sampleLayers, verifyReveal } from "../src/contract.ts";
import { meshStats } from "../src/stl.ts";
import { validateSpec } from "../src/spec.ts";
import { cube, toBinaryStl } from "./stl-fixture.ts";

const JOB = "job_contract01" as JobId;
const AT = "2026-10-23T09:00:00Z" as Instant;
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 0xff);

function cubeSpec(modelDigest: string) {
	const spec = validateSpec({
		modelDigest,
		material: "PLA",
		color: { name: "red", hex: null },
		quantity: 1,
		toleranceMm: 0.3,
		infillPct: 15,
		walls: 2,
		maxLayerHeightMm: 0.2,
		printBy: "2026-10-30T12:00:00Z",
		deliverBy: "2026-11-02T12:00:00Z",
	});
	if (!spec.ok) throw new Error("fixture spec is invalid");
	return spec.value;
}

function cubeMesh() {
	const mesh = meshStats(toBinaryStl(cube(20)));
	if (!mesh.ok) throw new Error("fixture mesh is invalid");
	return mesh.value;
}

function frozenCube(seed: Uint8Array = SEED) {
	const mesh = cubeMesh();
	const result = freeze({ jobId: JOB, spec: cubeSpec(mesh.digest), mesh, seed, at: AT });
	if (!result.ok) throw new Error("fixture freeze refused");
	return result.value;
}

test("a 20 mm cube at 0.2 mm has 100 layers, and eight distinct sampled layers inside them", () => {
	const frozen = frozenCube();
	assert.equal(frozen.publicTerms.layerCount, 100);
	const layers = frozen.hidden.sampleLayers;
	assert.equal(layers.length, 8);
	assert.deepEqual(layers, [...new Set(layers)].sort((a, b) => a - b));
	assert.ok(layers.every(layer => layer >= 1 && layer <= 100));
});

test("the same seed gives the same hidden terms and the same digest", () => {
	const first = frozenCube();
	const second = frozenCube();
	assert.deepEqual(first.hidden, second.hidden);
	assert.equal(first.hiddenDigest, second.hiddenDigest);
	assert.match(first.hiddenDigest, /^[0-9a-f]{64}$/);
});

test("a different seed gives different hidden terms", () => {
	assert.notEqual(frozenCube().hiddenDigest, frozenCube(OTHER_SEED).hiddenDigest);
});

test("reveal with the seed rebuilds the frozen terms and verifies against the digest", () => {
	const frozen = frozenCube();
	const revealed = reveal(frozen, SEED);
	assert.deepEqual(revealed.hidden, frozen.hidden);
	assert.equal(verifyReveal(frozen, revealed), true);
});

test("tampered revealed terms fail verify", () => {
	const frozen = frozenCube();
	const layers = frozen.hidden.sampleLayers;
	const tampered = layers.map((layer, i) => (i === 0 ? (layer === 100 ? 99 : layer + 1) : layer));
	assert.equal(verifyReveal(frozen, { hidden: { sampleLayers: tampered }, salt: reveal(frozen, SEED).salt }), false);
});

test("a different salt changes the digest, and a wrong salt fails verify", () => {
	const frozen = frozenCube();
	const revealed = reveal(frozen, SEED);
	assert.notEqual(hiddenDigest(frozen.hidden, revealed.salt), hiddenDigest(frozen.hidden, "0".repeat(64)));
	assert.equal(verifyReveal(frozen, { hidden: frozen.hidden, salt: "0".repeat(64) }), false);
});

test("sampled layers are capped at the layer count", () => {
	assert.deepEqual(sampleLayers(SEED, 3), [1, 2, 3]);
});

test("freeze refuses a short seed, a mesh that is not the spec's model, and an open mesh", () => {
	const mesh = cubeMesh();
	const shortSeed = freeze({ jobId: JOB, spec: cubeSpec(mesh.digest), mesh, seed: new Uint8Array(8), at: AT });
	assert.deepEqual(shortSeed, { ok: false, errors: [{ path: "seed", message: "seed must be at least 16 bytes" }] });

	const wrongModel = freeze({ jobId: JOB, spec: cubeSpec("b".repeat(64)), mesh, seed: SEED, at: AT });
	assert.deepEqual(wrongModel, { ok: false, errors: [{ path: "modelDigest", message: "mesh does not match the spec's model digest" }] });

	const open = meshStats(toBinaryStl([...cube(20).slice(0, 2), ...cube(20).slice(4)]));
	if (!open.ok) throw new Error("fixture mesh is invalid");
	const openFreeze = freeze({ jobId: JOB, spec: cubeSpec(open.value.digest), mesh: open.value, seed: SEED, at: AT });
	assert.deepEqual(openFreeze, { ok: false, errors: [{ path: "model", message: "mesh is not watertight" }] });
});
