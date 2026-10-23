// The photo check. A photo shows one sampled layer and four fiducials fixed on the bed. The verifier finds
// the fiducials, fits the camera pose from them, maps the photo's part silhouette back onto the bed, and
// compares it with the contract section placed by the G-code's placement. The fiducials, not the part,
// set the frame, so a layer printed 2 mm off its neighbours stands out. Each photo is also fingerprinted,
// so a photo reused from another job can be recognised.

import { fillRings, gridOver, iou, translateRings, CELL_MM } from "./raster.ts";
import type { Grid, Rect, Ring } from "./raster.ts";
import type { Placement } from "./conform.ts";
import type { Box, PrintRejectReason } from "./types.ts";

export const WINDOW_MARGIN_MM = 6;
export const FIDUCIAL_CENTRE_INSET_MM = 3;
export const FIDUCIAL_SIDE_MM = 3;
export const CAMERA_IOU_MIN = 0.9;
export const REUSE_MAX_DISTANCE = 4;
/** Pixel levels. The bed reads near 80, the part near 200, a fiducial near 10, before gain and noise. */
export const PART_MIN_LEVEL = 140;
export const FIDUCIAL_MAX_LEVEL = 40;
const MIN_FIDUCIAL_PX = 100;

/** A grayscale photo on the same grid as the bed window, one pixel per cell. */
export type Photo = { readonly layer: number; readonly cols: number; readonly rows: number; readonly pixels: Uint8Array };

export type ArchivedPhoto = { readonly layer: number; readonly fingerprint: string };

type Complex = { readonly re: number; readonly im: number };
type Blob = { readonly x: number; readonly y: number; readonly size: number };

/** The bed area a photo covers, from the plate box and the placement. Camera and verifier use the same rule. */
export function windowFor(meshBox: Box, placement: Placement): Rect {
	return {
		minX: meshBox.min[0] - placement.dx - WINDOW_MARGIN_MM,
		minY: meshBox.min[1] - placement.dy - WINDOW_MARGIN_MM,
		maxX: meshBox.max[0] - placement.dx + WINDOW_MARGIN_MM,
		maxY: meshBox.max[1] - placement.dy + WINDOW_MARGIN_MM,
	};
}

/** The grid a photo of this window is taken on. */
export function photoGrid(window: Rect): Grid {
	return gridOver(window, 0);
}

/** Fiducial centres in bed mm, in the order bottom-left, bottom-right, top-right, top-left. */
export function fiducialCentres(window: Rect): [number, number][] {
	const inset = FIDUCIAL_CENTRE_INSET_MM;
	return [
		[window.minX + inset, window.minY + inset],
		[window.maxX - inset, window.minY + inset],
		[window.maxX - inset, window.maxY - inset],
		[window.minX + inset, window.maxY - inset],
	];
}

/** One photographed layer as the judge measured it. The page draws the two grids; it never measures them again. */
export type LayerMeasure = {
	readonly layer: number;
	/** Overlap of the photo's part with the contract section, on the 0.1 mm grid. 0 when the photo cannot be read. */
	readonly iou: number;
	readonly fingerprint: string;
	/** Hamming distance to the nearest archived fingerprint, or null when no photo was archived. */
	readonly distance: number | null;
	/** True when the fiducials and the grid were read, so the overlap was measured. */
	readonly readable: boolean;
	/** True when the photo's overlap is at least CAMERA_IOU_MIN and no archived photo is within REUSE_MAX_DISTANCE. */
	readonly pass: boolean;
	/** The contract section placed by the G-code's placement, on the photo grid. Cells are 1 where the part is. */
	readonly reference: Grid;
	/** The farm's photo as the judge received it. */
	readonly photo: Photo;
};

export type PhotoCheck = {
	readonly reasons: readonly PrintRejectReason[];
	readonly measured: { readonly layers: readonly LayerMeasure[] };
};

export function checkPhotos(input: {
	readonly photos: readonly Photo[];
	readonly sections: ReadonlyMap<number, readonly Ring[]>;
	readonly placement: Placement;
	readonly meshBox: Box;
	/** Fingerprints of photos from other jobs. */
	readonly archive: readonly ArchivedPhoto[];
}): PhotoCheck {
	const window = windowFor(input.meshBox, input.placement);
	const centres = fiducialCentres(window);
	const reasons: PrintRejectReason[] = [];
	const measured: LayerMeasure[] = [];

	for (const photo of input.photos) {
		const fingerprint = dHash(photo);
		const distance = input.archive.length === 0
			? null
			: Math.min(...input.archive.map(entry => hashDistance(fingerprint, entry.fingerprint)));
		const reused = distance !== null && distance <= REUSE_MAX_DISTANCE;
		if (reused) reasons.push({ kind: "PHOTO_REUSED", layer: photo.layer, distance });

		const rings = input.sections.get(photo.layer);
		if (!rings) throw new Error(`no mesh section for photographed layer ${photo.layer}`);
		const reference = photoGrid(window);
		fillRings(reference, translateRings(rings, -input.placement.dx, -input.placement.dy));
		const found = matchFiducials(fiducialBlobs(photo), centres);
		if (!found || photo.cols !== reference.cols || photo.rows !== reference.rows) {
			reasons.push({ kind: "PHOTO_UNREADABLE", layer: photo.layer });
			measured.push({ layer: photo.layer, iou: 0, fingerprint, distance, readable: false, pass: false, reference, photo });
			continue;
		}

		const fit = fitSimilarity(found.map(([x, y]) => complex(x, y)), centres.map(([x, y]) => complex(x, y)));
		const silhouette = silhouetteOnBed(photo, fit, window);
		const score = iou(silhouette, reference);
		const overlapOk = score >= CAMERA_IOU_MIN;
		if (!overlapOk) reasons.push({ kind: "GEOMETRY_MISMATCH", layer: photo.layer, iou: score });
		measured.push({ layer: photo.layer, iou: score, fingerprint, distance, readable: true, pass: overlapOk && !reused, reference, photo });
	}
	return { reasons, measured: { layers: measured } };
}

/** A 64-bit difference hash, as 16 hex digits: 9 by 8 block means, one bit per left-right step. */
export function dHash(photo: Photo): string {
	const cols = 9;
	const rows = 8;
	const means: number[] = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const x0 = Math.floor((c * photo.cols) / cols);
			const x1 = Math.floor(((c + 1) * photo.cols) / cols);
			const y0 = Math.floor((r * photo.rows) / rows);
			const y1 = Math.floor(((r + 1) * photo.rows) / rows);
			let sum = 0;
			let count = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					sum += photo.pixels[y * photo.cols + x];
					count++;
				}
			}
			means.push(count === 0 ? 0 : sum / count);
		}
	}
	let bits = 0n;
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols - 1; c++) {
			bits = (bits << 1n) | (means[r * cols + c] > means[r * cols + c + 1] ? 1n : 0n);
		}
	}
	return bits.toString(16).padStart(16, "0");
}

export function hashDistance(a: string, b: string): number {
	let differing = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
	let count = 0;
	while (differing > 0n) {
		count += Number(differing & 1n);
		differing >>= 1n;
	}
	return count;
}

/** Connected dark regions of at least MIN_FIDUCIAL_PX pixels, each as its centroid in pixel units. */
function fiducialBlobs(photo: Photo): Blob[] {
	const seen = new Uint8Array(photo.pixels.length);
	const blobs: Blob[] = [];
	const stack: number[] = [];
	const dark = (index: number): boolean => photo.pixels[index] < FIDUCIAL_MAX_LEVEL;
	for (let start = 0; start < photo.pixels.length; start++) {
		if (seen[start] === 1 || !dark(start)) continue;
		seen[start] = 1;
		stack.push(start);
		let size = 0;
		let sumX = 0;
		let sumY = 0;
		while (stack.length > 0) {
			const index = stack.pop() as number;
			const col = index % photo.cols;
			const row = (index - col) / photo.cols;
			size++;
			sumX += col + 0.5;
			sumY += row + 0.5;
			const neighbours = [
				col > 0 ? index - 1 : -1,
				col < photo.cols - 1 ? index + 1 : -1,
				row > 0 ? index - photo.cols : -1,
				row < photo.rows - 1 ? index + photo.cols : -1,
			];
			for (const next of neighbours) {
				if (next < 0 || seen[next] === 1 || !dark(next)) continue;
				seen[next] = 1;
				stack.push(next);
			}
		}
		if (size >= MIN_FIDUCIAL_PX) blobs.push({ x: sumX / size, y: sumY / size, size });
	}
	return blobs;
}

/** Pairs each expected fiducial with the blob in the same quadrant. Null unless every quadrant holds one. */
function matchFiducials(blobs: readonly Blob[], centres: readonly [number, number][]): [number, number][] | null {
	if (blobs.length !== centres.length) return null;
	const quadrant = (x: number, y: number, cx: number, cy: number): string => `${Math.sign(x - cx)},${Math.sign(y - cy)}`;
	const bedMid = mean(centres.map(([x, y]) => complex(x, y)));
	const photoMid = mean(blobs.map(blob => complex(blob.x, blob.y)));
	const pairs: [number, number][] = [];
	for (const [x, y] of centres) {
		const key = quadrant(x, y, bedMid.re, bedMid.im);
		const matches = blobs.filter(blob => quadrant(blob.x, blob.y, photoMid.re, photoMid.im) === key);
		if (matches.length !== 1) return null;
		pairs.push([matches[0].x, matches[0].y]);
	}
	return pairs;
}

/**
 * The similarity that maps photo pixels to bed mm, bed = s * pixel + t, as complex numbers. Closed form
 * over the centred point sets, so four fiducials fix rotation, scale and shift.
 */
function fitSimilarity(pixels: readonly Complex[], bed: readonly Complex[]): { s: Complex; t: Complex } {
	const pm = mean(pixels);
	const bm = mean(bed);
	let numerator = complex(0, 0);
	let denominator = 0;
	pixels.forEach((p, i) => {
		const pc = sub(p, pm);
		const bc = sub(bed[i], bm);
		numerator = add(numerator, mul(conj(pc), bc));
		denominator += pc.re * pc.re + pc.im * pc.im;
	});
	const s = complex(numerator.re / denominator, numerator.im / denominator);
	const t = sub(bm, mul(s, pm));
	return { s, t };
}

/** The part silhouette of the photo, mapped onto the bed grid through the fitted similarity. */
function silhouetteOnBed(photo: Photo, fit: { s: Complex; t: Complex }, window: Rect): Grid {
	const grid = photoGrid(window);
	const inverse = div(complex(1, 0), fit.s);
	for (let r = 0; r < grid.rows; r++) {
		for (let c = 0; c < grid.cols; c++) {
			const bed = complex(grid.x0 + (c + 0.5) * CELL_MM, grid.y0 + (r + 0.5) * CELL_MM);
			const pixel = mul(sub(bed, fit.t), inverse);
			const pc = Math.floor(pixel.re);
			const pr = Math.floor(pixel.im);
			if (pc < 0 || pr < 0 || pc >= photo.cols || pr >= photo.rows) continue;
			if (photo.pixels[pr * photo.cols + pc] >= PART_MIN_LEVEL) grid.on[r * grid.cols + c] = 1;
		}
	}
	return grid;
}

const complex = (re: number, im: number): Complex => ({ re, im });
const add = (a: Complex, b: Complex): Complex => complex(a.re + b.re, a.im + b.im);
const sub = (a: Complex, b: Complex): Complex => complex(a.re - b.re, a.im - b.im);
const mul = (a: Complex, b: Complex): Complex => complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const conj = (a: Complex): Complex => complex(a.re, -a.im);
const div = (a: Complex, b: Complex): Complex => {
	const d = b.re * b.re + b.im * b.im;
	return complex((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};

function mean(points: readonly Complex[]): Complex {
	let re = 0;
	let im = 0;
	for (const point of points) {
		re += point.re;
		im += point.im;
	}
	return complex(re / points.length, im / points.length);
}
