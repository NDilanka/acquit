// A small S-expression reader for KiCad files. Atoms and quoted strings both come back as strings; the reader
// never throws, and malformed input comes back as an error value. Input size, nesting, and element count are
// checked as the text is read, so an oversized file stops early and never builds the full tree.

import { MAX_ELEMENTS, MAX_INPUT_CHARS, MAX_NESTING } from "./limits.ts";

export type SExpr = string | readonly SExpr[];
export type ParseResult = { readonly ok: true; readonly value: readonly SExpr[] } | { readonly ok: false; readonly error: string };

// The indices of the quoted atoms in each list. The tree keeps a quoted atom and a bare atom alike as a string, so a
// reader that must tell `(net 4)` from `(net "4")` asks isQuoted.
const quotedAt = new WeakMap<readonly SExpr[], Set<number>>();

function quotedIn(list: readonly SExpr[]): Set<number> {
	let set = quotedAt.get(list);
	if (!set) {
		set = new Set<number>();
		quotedAt.set(list, set);
	}
	return set;
}

/** True when the atom at `index` of `list` was written in double quotes. */
export function isQuoted(list: readonly SExpr[] | undefined, index: number): boolean {
	return list !== undefined && quotedAt.get(list)?.has(index) === true;
}

export function parseSexprs(text: string): ParseResult {
	if (text.length > MAX_INPUT_CHARS) return { ok: false, error: `input longer than ${MAX_INPUT_CHARS} characters` };
	const stack: SExpr[][] = [[]];
	let elements = 0;
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i] as string;
		if (c === "(") {
			if (stack.length > MAX_NESTING) return { ok: false, error: `nesting deeper than ${MAX_NESTING} levels` };
			const list: SExpr[] = [];
			(stack[stack.length - 1] as SExpr[]).push(list);
			stack.push(list);
			elements++;
			i++;
		} else if (c === ")") {
			if (stack.length === 1) return { ok: false, error: `unexpected ")" at offset ${i}` };
			stack.pop();
			i++;
		} else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
		} else if (c === '"') {
			let s = "";
			i++;
			let closed = false;
			while (i < n) {
				const d = text[i] as string;
				if (d === "\\" && i + 1 < n) {
					s += text[i + 1] as string;
					i += 2;
				} else if (d === '"') {
					closed = true;
					i++;
					break;
				} else {
					s += d;
					i++;
				}
			}
			if (!closed) return { ok: false, error: "unterminated string" };
			const parent = stack[stack.length - 1] as SExpr[];
			quotedIn(parent).add(parent.length);
			parent.push(s);
			elements++;
		} else {
			let s = "";
			while (i < n) {
				const d = text[i] as string;
				if (d === "(" || d === ")" || d === '"' || d === " " || d === "\t" || d === "\n" || d === "\r") break;
				s += d;
				i++;
			}
			(stack[stack.length - 1] as SExpr[]).push(s);
			elements++;
		}
		if (elements > MAX_ELEMENTS) return { ok: false, error: `more than ${MAX_ELEMENTS} elements` };
	}
	if (stack.length !== 1) return { ok: false, error: "unclosed \"(\"" };
	return { ok: true, value: stack[0] as SExpr[] };
}

/** The first child list whose head is `name`, or undefined. */
export function child(list: readonly SExpr[], name: string): readonly SExpr[] | undefined {
	for (const item of list) {
		if (Array.isArray(item) && item[0] === name) return item as readonly SExpr[];
	}
	return undefined;
}

/** All child lists whose head is `name`, in file order. */
export function children(list: readonly SExpr[], name: string): readonly (readonly SExpr[])[] {
	const out: (readonly SExpr[])[] = [];
	for (const item of list) {
		if (Array.isArray(item) && item[0] === name) out.push(item as readonly SExpr[]);
	}
	return out;
}

/** A numeric atom at `index` within a list, or undefined. */
export function num(list: readonly SExpr[] | undefined, index: number): number | undefined {
	if (!list) return undefined;
	const v = list[index];
	if (typeof v !== "string") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}
