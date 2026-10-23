import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { inflateSync } from "node:zlib";
import type { LayerMeasure, Photo } from "../src/camera.ts";
import { IMAGE_SCALE, grayPng, sectionPixels, timelineOf } from "../src/timeline.ts";
import type { Grid } from "../src/raster.ts";

/** Reads a PNG back: its size and bit depth from IHDR, and the scanlines inflated from IDAT. */
function decodePng(png: string) {
	const bytes = Buffer.from(png, "base64");
	assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const chunks: { type: string; data: Buffer }[] = [];
	for (let at = 8; at < bytes.length;) {
		const length = bytes.readUInt32BE(at);
		chunks.push({ type: bytes.toString("latin1", at + 4, at + 8), data: bytes.subarray(at + 8, at + 8 + length) });
		at += 12 + length;
	}
	const ihdr = chunks.find(item => item.type === "IHDR")?.data;
	const idat = Buffer.concat(chunks.filter(item => item.type === "IDAT").map(item => item.data));
	assert.ok(ihdr, "the PNG has an IHDR");
	return {
		types: chunks.map(item => item.type),
		width: ihdr.readUInt32BE(0),
		height: ihdr.readUInt32BE(4),
		bitDepth: ihdr[8],
		colorType: ihdr[9],
		raw: [...inflateSync(idat)],
	};
}

function gridOf(cols: number, rows: number, on: readonly number[]): Grid {
	return { x0: 0, y0: 0, cols, rows, on: Uint8Array.from(on) };
}

test("a grayscale PNG built in code decodes to its size and to the exact levels written", () => {
	const png = grayPng({ cols: 3, rows: 2, pixels: Uint8Array.from([0, 128, 255, 10, 20, 30]) });
	assert.equal(png.cols, 3);
	assert.equal(png.rows, 2);
	const decoded = decodePng(png.png);
	assert.deepEqual(decoded.types, ["IHDR", "IDAT", "IEND"]);
	assert.deepEqual([decoded.width, decoded.height, decoded.bitDepth, decoded.colorType], [3, 2, 8, 0]);
	// Each scanline starts with its filter byte, which is 0 for every row.
	assert.deepEqual(decoded.raw, [0, 0, 128, 255, 0, 10, 20, 30]);
});

test("the section picture is the block mean of IMAGE_SCALE cells, so a full block is 255 and half a block is 128", () => {
	assert.equal(IMAGE_SCALE, 4);
	const on = [
		1, 1, 1, 1, 1, 1, 1, 1,
		1, 1, 1, 1, 1, 1, 1, 1,
		1, 1, 1, 1, 0, 0, 0, 0,
		1, 1, 1, 1, 0, 0, 0, 0,
	];
	const picture = sectionPixels(gridOf(8, 4, on));
	assert.equal(picture.cols, 2);
	assert.equal(picture.rows, 1);
	assert.deepEqual([...picture.pixels], [255, 128]);
});

test("a timeline holds one row per layer in layer order, at the mid height of each layer", () => {
	const photo = (layer: number): Photo => ({ layer, cols: 4, rows: 4, pixels: new Uint8Array(16).fill(80) });
	const measure = (layer: number, pass: boolean): LayerMeasure => ({
		layer,
		iou: 0.95,
		fingerprint: "0000000000000000",
		distance: null,
		readable: true,
		pass,
		reference: gridOf(4, 4, new Array(16).fill(1)),
		photo: photo(layer),
	});
	const timeline = timelineOf([measure(12, true), measure(2, false)], 0.2);
	assert.equal(timeline.iouMin, 0.9);
	assert.equal(timeline.reuseMaxDistance, 4);
	assert.equal(timeline.imageScale, 4);
	assert.deepEqual(timeline.layers.map(row => [row.layer, row.heightMm, row.pass]), [[2, 0.3, false], [12, 2.3, true]]);
	assert.deepEqual([timeline.layers[0].reference.cols, timeline.layers[0].reference.rows], [1, 1]);
	assert.deepEqual(decodePng(timeline.layers[1].reference.png).raw, [0, 255]);
});
