// The frozen-case extractors. The frozen suite becomes judge data too, so a submitted test runner
// or config cannot change it. Each extraction is literal on purpose: it names the one exported
// target its fixture's frozen test file exercises, and the count guard refuses a tree whose frozen
// suite no longer matches the contract. A registry entry names its extractor by id.

import type { TestId } from "../core/src/ids.ts";
import type { HiddenCase } from "../core/src/verifier.ts";

/** The demo fixture: the invoice's one exported target, 48 cases in `tests/totals.test.ts`. */
export function invoiceFixtureFrozenCases(source: string): readonly HiddenCase[] {
	const matches = [...source.matchAll(/it\('([^']+)', \(\) => \{\s*expect\(formatTotal\((\[[^\n]+?\]), '([^']+)'\)\)\.toBe\('([^']+)'\);/g)];
	if (matches.length !== 48) throw new Error(`Frozen case extraction collected ${matches.length}, not 48.`);
	return matches.map((match, index) => ({ id: `frozen:${index + 1}` as TestId,
		target: { module: "src/money.ts", export: "formatTotal" },
		args: [JSON.parse(match[2].replaceAll("amount:", '"amount":')), match[3]], expected: match[4] }));
}

/** The second fixture: the splitter's one exported target, 12 cases in `tests/split.test.ts`. */
export function splitterFixtureFrozenCases(source: string): readonly HiddenCase[] {
	const matches = [...source.matchAll(/it\('([^']+)', \(\) => \{\s*expect\(splitTotal\((\[[^\n]+?\]), '([^']+)'\)\)\.toBe\('([^']+)'\);/g)];
	if (matches.length !== 12) throw new Error(`Frozen case extraction collected ${matches.length}, not 12.`);
	return matches.map((match, index) => ({ id: `frozen:${index + 1}` as TestId,
		target: { module: "src/split.ts", export: "splitTotal" },
		args: [JSON.parse(match[2]), match[3]], expected: match[4] }));
}

/** The extractors a registry entry may name. A boot that names another id refuses before listening. */
export const FROZEN_EXTRACTORS: Readonly<Record<string, (source: string) => readonly HiddenCase[]>> = {
	"invoice-totals": invoiceFixtureFrozenCases,
	"splitter-share": splitterFixtureFrozenCases,
};
