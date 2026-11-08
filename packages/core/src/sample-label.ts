// The check that a sample answer already shows its label, shared by the sample route and the sample page. Pure, with no
// runtime import: the browser runs this file too.

/** A line that opens or closes a code fence, after any indent, quote, or list marker. Over-matching only adds a label, never hides one. */
const FENCE = /^[\s>*+\-\d.)]*(`{3,}|~{3,})(.*)$/;

/**
 * Whether an answer already ends with `label` as its own plain paragraph: the last non-blank line is the label at column 0,
 * a blank line comes before it (or it opens the answer), and no code fence is open above it. A label inside a fence's
 * info string or code block is not shown as text, so it does not count.
 */
export function answerEndsWithLabel(message: string, label: string): boolean {
	const lines = message.split("\n");
	let last = lines.length - 1;
	while (last >= 0 && lines[last]!.trim() === "") last -= 1;
	if (last < 0 || lines[last]!.trimEnd() !== label) return false;
	if (last > 0 && lines[last - 1]!.trim() !== "") return false;
	let open: string | null = null;
	for (const line of lines.slice(0, last)) {
		const fence = FENCE.exec(line);
		if (open === null) {
			if (fence) open = fence[1]!;
		} else if (fence && fence[1]![0] === open[0] && fence[1]!.length >= open.length && fence[2]!.trim() === "") {
			open = null;
		}
	}
	return open === null;
}
