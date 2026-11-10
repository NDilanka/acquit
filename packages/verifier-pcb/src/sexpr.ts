// A small S-expression reader for KiCad files. Atoms and quoted strings both come back as strings; the reader
// never throws, and malformed input comes back as an error value.

export type SExpr = string | readonly SExpr[];
export type ParseResult = { readonly ok: true; readonly value: readonly SExpr[] } | { readonly ok: false; readonly error: string };

export function parseSexprs(text: string): ParseResult {
	const stack: SExpr[][] = [[]];
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i] as string;
		if (c === "(") {
			const list: SExpr[] = [];
			(stack[stack.length - 1] as SExpr[]).push(list);
			stack.push(list);
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
			(stack[stack.length - 1] as SExpr[]).push(s);
		} else {
			let s = "";
			while (i < n) {
				const d = text[i] as string;
				if (d === "(" || d === ")" || d === '"' || d === " " || d === "\t" || d === "\n" || d === "\r") break;
				s += d;
				i++;
			}
			(stack[stack.length - 1] as SExpr[]).push(s);
		}
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
