// Grid rasterizer for layer footprints and mesh sections. A cell is in a shape when its centre is, so two
// shapes that differ by less than a cell share most cells, and IoU is a cell-count ratio at CELL_MM.

export const CELL_MM = 0.1;

export type Segment = readonly [number, number, number, number];
export type Ring = readonly (readonly [number, number])[];
export type Rect = { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };

export type Grid = {
	readonly x0: number;
	readonly y0: number;
	readonly cols: number;
	readonly rows: number;
	readonly on: Uint8Array;
};

/** An empty grid that covers rect with marginMm to spare on every side. */
export function gridOver(rect: Rect, marginMm: number): Grid {
	const cols = Math.ceil((rect.maxX - rect.minX + 2 * marginMm) / CELL_MM);
	const rows = Math.ceil((rect.maxY - rect.minY + 2 * marginMm) / CELL_MM);
	return { x0: rect.minX - marginMm, y0: rect.minY - marginMm, cols, rows, on: new Uint8Array(cols * rows) };
}

const cellX = (grid: Grid, col: number): number => grid.x0 + (col + 0.5) * CELL_MM;
const cellY = (grid: Grid, row: number): number => grid.y0 + (row + 0.5) * CELL_MM;

/** Marks every cell whose centre is within radius of the segment. This is the extrusion's footprint. */
export function stampSegment(grid: Grid, [ax, ay, bx, by]: Segment, radius: number): void {
	const minCol = Math.max(0, Math.floor((Math.min(ax, bx) - radius - grid.x0) / CELL_MM));
	const maxCol = Math.min(grid.cols - 1, Math.ceil((Math.max(ax, bx) + radius - grid.x0) / CELL_MM));
	const minRow = Math.max(0, Math.floor((Math.min(ay, by) - radius - grid.y0) / CELL_MM));
	const maxRow = Math.min(grid.rows - 1, Math.ceil((Math.max(ay, by) + radius - grid.y0) / CELL_MM));
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSq = dx * dx + dy * dy;
	const radiusSq = radius * radius;
	for (let row = minRow; row <= maxRow; row++) {
		const py = cellY(grid, row);
		for (let col = minCol; col <= maxCol; col++) {
			const px = cellX(grid, col);
			const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
			const ex = px - (ax + t * dx);
			const ey = py - (ay + t * dy);
			if (ex * ex + ey * ey <= radiusSq) grid.on[row * grid.cols + col] = 1;
		}
	}
}

/**
 * Marks every cell whose centre has a non-zero winding number around the edges. Edges of closed loops
 * are summed, so a ring and a hole cancel, and a single loop fills its interior whatever its direction.
 */
export function fillEdges(grid: Grid, edges: readonly Segment[]): void {
	const crossings: [number, number][] = [];
	for (let row = 0; row < grid.rows; row++) {
		const y = cellY(grid, row);
		crossings.length = 0;
		for (const [ax, ay, bx, by] of edges) {
			if ((ay <= y) === (by <= y)) continue;
			const x = ax + ((y - ay) * (bx - ax)) / (by - ay);
			crossings.push([x, by > ay ? 1 : -1]);
		}
		crossings.sort((p, q) => p[0] - q[0]);
		let winding = 0;
		let next = 0;
		for (let col = 0; col < grid.cols; col++) {
			const x = cellX(grid, col);
			while (next < crossings.length && crossings[next][0] <= x) winding += crossings[next++][1];
			if (winding !== 0) grid.on[row * grid.cols + col] = 1;
		}
	}
}

export function ringEdges(ring: Ring): Segment[] {
	return ring.map((point, i) => {
		const next = ring[(i + 1) % ring.length];
		return [point[0], point[1], next[0], next[1]] as const;
	});
}

export function cellCount(grid: Grid): number {
	let count = 0;
	for (const value of grid.on) count += value;
	return count;
}

export function areaMm2(grid: Grid): number {
	return cellCount(grid) * CELL_MM * CELL_MM;
}

/** Intersection over union of two grids that cover the same area. Two empty grids give 0. */
export function iou(a: Grid, b: Grid): number {
	let shared = 0;
	let either = 0;
	for (let i = 0; i < a.on.length; i++) {
		shared += a.on[i] & b.on[i];
		either += a.on[i] | b.on[i];
	}
	return either === 0 ? 0 : shared / either;
}

/** Four-connected components of set cells that hold at least minAreaMm2. */
export function countUnits(grid: Grid, minAreaMm2: number): number {
	const minCells = Math.ceil(minAreaMm2 / (CELL_MM * CELL_MM));
	const seen = new Uint8Array(grid.on.length);
	const stack: number[] = [];
	let units = 0;
	for (let start = 0; start < grid.on.length; start++) {
		if (grid.on[start] === 0 || seen[start] === 1) continue;
		let size = 0;
		seen[start] = 1;
		stack.push(start);
		while (stack.length > 0) {
			const index = stack.pop() as number;
			size++;
			const col = index % grid.cols;
			const row = (index - col) / grid.cols;
			const neighbours = [
				col > 0 ? index - 1 : -1,
				col < grid.cols - 1 ? index + 1 : -1,
				row > 0 ? index - grid.cols : -1,
				row < grid.rows - 1 ? index + grid.cols : -1,
			];
			for (const next of neighbours) {
				if (next < 0 || grid.on[next] === 0 || seen[next] === 1) continue;
				seen[next] = 1;
				stack.push(next);
			}
		}
		if (size >= minCells) units++;
	}
	return units;
}
