// The layer timeline the print page draws: for each photographed layer, the contract section beside the farm's photo,
// and the judge's own numbers for that layer. The judge measures every 0.1 mm cell; the two pictures are reduced to
// IMAGE_SCALE cells a pixel, because a full-size photo of the demo plate is about 266 KB, too big for one run record.
// The reduction is a block mean, so the pictures show the same content at a coarser scale.

import { Buffer } from "node:buffer";
import { crc32, deflateSync } from "node:zlib";
import { CAMERA_IOU_MIN, REUSE_MAX_DISTANCE } from "./camera.ts";
import type { LayerMeasure } from "./camera.ts";
import type { Grid } from "./raster.ts";

/** Cells per picture pixel, on each side. The demo plate's photo (740 by 360 cells) becomes 185 by 90 pixels. */
export const IMAGE_SCALE = 4;

/** A grayscale picture as a PNG, base64 encoded, with its size in pixels. */
export type TimelineImage = { readonly cols: number; readonly rows: number; readonly png: string };

export type TimelineLayer = {
	readonly layer: number;
	/** The height the contract section is cut at, the middle of the layer, in mm. */
	readonly heightMm: number;
	readonly readable: boolean;
	readonly iou: number;
	readonly fingerprint: string;
	readonly distance: number | null;
	readonly pass: boolean;
	readonly reference: TimelineImage;
	readonly photo: TimelineImage;
};

export type Timeline = {
	readonly imageScale: number;
	readonly iouMin: number;
	readonly reuseMaxDistance: number;
	readonly layers: readonly TimelineLayer[];
};

type Pixels = { readonly cols: number; readonly rows: number; readonly pixels: Uint8Array };

/** Block mean of each IMAGE_SCALE by IMAGE_SCALE block of cells, rounded to a level from 0 to 255. */
function reduce(values: ArrayLike<number>, cols: number, rows: number): Pixels {
	const outCols = Math.ceil(cols / IMAGE_SCALE);
	const outRows = Math.ceil(rows / IMAGE_SCALE);
	const pixels = new Uint8Array(outCols * outRows);
	for (let r = 0; r < outRows; r++) {
		for (let c = 0; c < outCols; c++) {
			let sum = 0;
			let count = 0;
			for (let y = r * IMAGE_SCALE; y < Math.min(rows, (r + 1) * IMAGE_SCALE); y++) {
				for (let x = c * IMAGE_SCALE; x < Math.min(cols, (c + 1) * IMAGE_SCALE); x++) {
					sum += values[y * cols + x];
					count++;
				}
			}
			pixels[r * outCols + c] = Math.round(sum / count);
		}
	}
	return { cols: outCols, rows: outRows, pixels };
}

/** A contract section's cells as levels: 255 where the part is, 0 where it is not. */
export function sectionPixels(grid: Grid): Pixels {
	return reduce(Uint8Array.from(grid.on, value => value * 255), grid.cols, grid.rows);
}

/** A photo's pixels at the picture scale. */
export function photoPixels(cols: number, rows: number, pixels: Uint8Array): Pixels {
	return reduce(pixels, cols, rows);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const sum = Buffer.alloc(4);
	sum.writeUInt32BE(crc32(body) >>> 0);
	return Buffer.concat([length, body, sum]);
}

/** An 8-bit grayscale PNG, built with node:zlib. Every scanline uses filter 0, so the file is the levels as written. */
export function grayPng(image: Pixels): TimelineImage {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(image.cols, 0);
	header.writeUInt32BE(image.rows, 4);
	header[8] = 8;
	const raw = Buffer.alloc((image.cols + 1) * image.rows);
	for (let r = 0; r < image.rows; r++) {
		raw[r * (image.cols + 1)] = 0;
		raw.set(image.pixels.subarray(r * image.cols, (r + 1) * image.cols), r * (image.cols + 1) + 1);
	}
	const png = Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
	return { cols: image.cols, rows: image.rows, png: png.toString("base64") };
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

/** The timeline of the judge's per-layer measurements, in layer order. Each row keeps the judge's own numbers. */
export function timelineOf(layers: readonly LayerMeasure[], layerHeightMm: number): Timeline {
	const rows = [...layers].sort((a, b) => a.layer - b.layer).map((item): TimelineLayer => ({
		layer: item.layer,
		heightMm: round2((item.layer - 0.5) * layerHeightMm),
		readable: item.readable,
		iou: item.iou,
		fingerprint: item.fingerprint,
		distance: item.distance,
		pass: item.pass,
		reference: grayPng(sectionPixels(item.reference)),
		photo: grayPng(photoPixels(item.photo.cols, item.photo.rows, item.photo.pixels)),
	}));
	return { imageScale: IMAGE_SCALE, iouMin: CAMERA_IOU_MIN, reuseMaxDistance: REUSE_MAX_DISTANCE, layers: rows };
}
