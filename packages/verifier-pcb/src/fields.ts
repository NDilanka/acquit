// The record layer of a board file. Board.ts reaches every record and field through fieldOf and recordsOf, and
// recordProblem checks the whole record tree before any reader runs. A record holds each single-valued field once,
// holds another record only where the file places it, and carries a point field only where its kind allows one.
// Any other arrangement fails the parse, so no reader has to choose between two copies of a field.

import { children, type SExpr } from "./sexpr.ts";

/** The records the board reads. A list headed by one of these is a record wherever it sits. */
const RECORD_HEADS = new Set([
	"segment",
	"arc",
	"via",
	"footprint",
	"pad",
	"gr_line",
	"gr_rect",
	"gr_arc",
	"gr_circle",
	"gr_text",
	"gr_poly",
	"gr_curve",
	"fp_line",
	"fp_rect",
	"fp_arc",
	"fp_circle",
	"fp_poly",
	"fp_curve",
	"fp_text",
]);

/** The containers that may hold records. Any other record found inside a record is nested and fails the parse. */
const CONTAINERS = new Set(["kicad_pcb", "footprint"]);

/** The records each container holds in any number. Every other direct field of a record occurs at most once. */
const REPEATABLE = new Map<string, ReadonlySet<string>>([
	[
		"kicad_pcb",
		new Set([
			"net",
			"footprint",
			"segment",
			"arc",
			"via",
			"gr_line",
			"gr_rect",
			"gr_arc",
			"gr_circle",
			"gr_text",
			"gr_poly",
			"gr_curve",
		]),
	],
	["footprint", new Set(["pad", "fp_line", "fp_rect", "fp_arc", "fp_circle", "fp_poly", "fp_curve", "model"])],
]);

/** The point fields each record may carry. A point field on any other record is misplaced. */
const POINT_FIELDS = new Map<string, readonly string[]>([
	["segment", ["start", "end"]],
	["arc", ["start", "mid", "end"]],
	["via", ["at"]],
	["footprint", ["at"]],
	["pad", ["at"]],
	["gr_line", ["start", "end"]],
	["gr_rect", ["start", "end"]],
	["gr_arc", ["start", "mid", "end"]],
	["gr_circle", ["center", "end"]],
	["gr_text", ["at"]],
	["gr_poly", []],
	["gr_curve", []],
	["fp_line", ["start", "end"]],
	["fp_rect", ["start", "end"]],
	["fp_arc", ["start", "mid", "end"]],
	["fp_circle", ["center", "end"]],
	["fp_text", ["at"]],
	["fp_poly", []],
	["fp_curve", []],
]);
const POINT_HEADS = new Set(["start", "mid", "end", "center", "at"]);

export function listOf(item: SExpr | undefined): readonly SExpr[] | undefined {
	return Array.isArray(item) ? (item as readonly SExpr[]) : undefined;
}

/**
 * The list of a single-valued field directly inside a record, or undefined when it is absent. A field held twice
 * reads as absent, so no copy is ever chosen; recordProblem refuses the record before any reader gets here.
 */
export function fieldOf(record: readonly SExpr[] | undefined, name: string): readonly SExpr[] | undefined {
	if (!record) return undefined;
	const found = children(record, name);
	return found.length === 1 ? found[0] : undefined;
}

/** Every list headed by `name` directly inside a container, in file order. */
export function recordsOf(container: readonly SExpr[], name: string): readonly (readonly SExpr[])[] {
	return children(container, name);
}

/** The first field held twice in one record, named for the error, or undefined. */
function repeatProblem(record: readonly SExpr[], owner: string): string | undefined {
	const repeatable = REPEATABLE.get(owner);
	const seen = new Set<string>();
	for (const item of record.slice(1)) {
		const list = listOf(item);
		const head = list?.[0];
		if (!list || typeof head !== "string" || head === "zone") continue;
		let key = head;
		let label = `(${head})`;
		if (owner === "footprint" && head === "property") {
			key = `property ${String(list[1])}`;
			label = `"${String(list[1])}"`;
		} else if (owner === "footprint" && head === "fp_text") {
			if (list[1] === "user") continue; // a footprint may carry any number of user texts
			key = `fp_text ${String(list[1])}`;
			label = `(fp_text ${String(list[1])})`;
		} else if (repeatable?.has(head)) {
			continue;
		}
		if (seen.has(key)) return `${label} repeated in (${owner})`;
		seen.add(key);
	}
	return undefined;
}

/** The first point field on a record that does not allow it, or undefined. */
function placementProblem(record: readonly SExpr[], owner: string): string | undefined {
	const allowed = POINT_FIELDS.get(owner);
	if (!allowed) return undefined;
	for (const item of record.slice(1)) {
		const head = listOf(item)?.[0];
		if (typeof head === "string" && POINT_HEADS.has(head) && !allowed.includes(head)) {
			return `(${head}) is not a geometry field of (${owner})`;
		}
	}
	return undefined;
}

/** True when a record head appears anywhere inside `list`, outside any zone. */
function holdsRecord(list: readonly SExpr[]): boolean {
	const stack: (readonly SExpr[])[] = [list];
	while (stack.length > 0) {
		const node = stack.pop() as readonly SExpr[];
		const head = node[0];
		if (head === "zone") continue;
		if (typeof head === "string" && RECORD_HEADS.has(head)) return true;
		for (const item of node) {
			const sub = listOf(item);
			if (sub) stack.push(sub);
		}
	}
	return false;
}

/**
 * The first record problem in the board: a field held twice, a point field on the wrong record, a record nested
 * where the file does not place one, or a record hidden inside a field. Zones are skipped, as everywhere else.
 * Returns the error text, or undefined when every record is sound.
 */
export function recordProblem(root: readonly SExpr[]): string | undefined {
	const stack: (readonly SExpr[])[] = [root];
	while (stack.length > 0) {
		const record = stack.pop() as readonly SExpr[];
		const owner = String(record[0]);
		const problem = repeatProblem(record, owner) ?? placementProblem(record, owner);
		if (problem) return problem;
		for (const item of record.slice(1)) {
			const list = listOf(item);
			const head = list?.[0];
			if (!list || typeof head !== "string" || head === "zone") continue;
			if (RECORD_HEADS.has(head)) {
				if (!CONTAINERS.has(owner)) return `(${head}) nested in (${owner})`;
				stack.push(list);
			} else if (holdsRecord(list)) {
				return `(${head}) in (${owner}) holds a nested record`;
			}
		}
	}
	return undefined;
}
