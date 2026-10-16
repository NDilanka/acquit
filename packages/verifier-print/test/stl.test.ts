import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { meshRejection, meshStats } from "../src/stl.ts";
import { cube, toAsciiStl, toBinaryStl } from "./stl-fixture.ts";

test("the 20 mm cube has volume 8000 mm3, a 20 x 20 x 20 box, and is watertight", () => {
	const result = meshStats(toBinaryStl(cube(20)));
	assert.equal(result.ok, true);
	if (!result.ok) return;
	const stats = result.value;
	assert.equal(stats.format, "binary");
	assert.equal(stats.triangles, 12);
	assert.deepEqual(stats.sizeMm, [20, 20, 20]);
	assert.deepEqual(stats.bboxMm.min, [0, 0, 0]);
	assert.deepEqual(stats.bboxMm.max, [20, 20, 20]);
	assert.ok(Math.abs(stats.volumeMm3 - 8000) / 8000 < 1e-6);
	assert.equal(stats.watertight, true);
	assert.equal(meshRejection(stats), null);
});

test("the digest is the sha256 of the file bytes", () => {
	const bytes = toBinaryStl(cube(20));
	const result = meshStats(bytes);
	assert.equal(result.ok && result.value.digest, createHash("sha256").update(bytes).digest("hex"));
});

test("the ASCII form of the same cube reads the same geometry", () => {
	const result = meshStats(toAsciiStl(cube(20)));
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.format, "ascii");
	assert.equal(result.value.triangles, 12);
	assert.deepEqual(result.value.sizeMm, [20, 20, 20]);
	assert.ok(Math.abs(result.value.volumeMm3 - 8000) / 8000 < 1e-6);
	assert.equal(result.value.watertight, true);
});

test("a cube with its top face removed is not watertight and is rejected as MESH_NOT_MANIFOLD", () => {
	const open = [...cube(20).slice(0, 2), ...cube(20).slice(4)];
	const result = meshStats(toBinaryStl(open));
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.watertight, false);
	assert.deepEqual(meshRejection(result.value), { kind: "MESH_NOT_MANIFOLD" });
});

test("bytes that are neither binary nor ASCII STL are refused at the model path", () => {
	const result = meshStats(new TextEncoder().encode("not a mesh"));
	assert.deepEqual(result, { ok: false, errors: [{ path: "model", message: "STL is neither binary nor ASCII" }] });
});

test("a binary STL that declares zero triangles is refused", () => {
	const empty = new Uint8Array(84);
	new DataView(empty.buffer).setUint32(80, 0, true);
	const result = meshStats(empty);
	assert.deepEqual(result, { ok: false, errors: [{ path: "model", message: "STL has no triangles" }] });
});
