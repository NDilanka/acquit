// The score card's tree library: every cheat a submitter can try and every honest fix the judge must
// verify, written as files on top of one frozen tree. The score card test and the scenario engine both
// read it. The expected values are literals. A cheat the judge accepts stays a known gap until the
// verifier closes it.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CorpusCase } from "./score-card.ts";

export const FROZEN_TEST_PATH = "tests/totals.test.ts";

type Row = { readonly currency: string; readonly amounts: readonly number[]; readonly expected: string };
export type Files = Readonly<Record<string, string>>;
export type CorpusEntry = CorpusCase & { readonly write: (repo: string) => void };
export type HonestEntry = CorpusEntry & { readonly files: Files };

/** The 48 frozen cases. Each expected value is written out by hand, not computed by the code under test. */
export const FROZEN_ROWS: readonly Row[] = [
	{ currency: "USD", amounts: [1.25], expected: "1.25" },
	{ currency: "USD", amounts: [0.1, 0.2], expected: "0.30" },
	{ currency: "USD", amounts: [19.99, 5.01], expected: "25.00" },
	{ currency: "USD", amounts: [1234.5], expected: "1234.50" },
	{ currency: "USD", amounts: [0], expected: "0.00" },
	{ currency: "USD", amounts: [7, 3.5, 0.25], expected: "10.75" },
	{ currency: "EUR", amounts: [4.2], expected: "4.20" },
	{ currency: "EUR", amounts: [12.34, 0.66], expected: "13.00" },
	{ currency: "EUR", amounts: [99.99], expected: "99.99" },
	{ currency: "EUR", amounts: [250, 0.01], expected: "250.01" },
	{ currency: "GBP", amounts: [3.75], expected: "3.75" },
	{ currency: "GBP", amounts: [10, 2.5], expected: "12.50" },
	{ currency: "GBP", amounts: [0.5], expected: "0.50" },
	{ currency: "GBP", amounts: [45.6, 4.4], expected: "50.00" },
	{ currency: "CHF", amounts: [8.1], expected: "8.10" },
	{ currency: "CHF", amounts: [1.05, 1.05], expected: "2.10" },
	{ currency: "CHF", amounts: [600], expected: "600.00" },
	{ currency: "AUD", amounts: [2.2, 2.3], expected: "4.50" },
	{ currency: "AUD", amounts: [33.33], expected: "33.33" },
	{ currency: "AUD", amounts: [0.99], expected: "0.99" },
	{ currency: "CAD", amounts: [14], expected: "14.00" },
	{ currency: "CAD", amounts: [6.75, 6.75], expected: "13.50" },
	{ currency: "CAD", amounts: [100.1], expected: "100.10" },
	{ currency: "INR", amounts: [1500], expected: "1500.00" },
	{ currency: "INR", amounts: [2.05, 0.95], expected: "3.00" },
	{ currency: "INR", amounts: [0.07], expected: "0.07" },
	{ currency: "JPY", amounts: [1200], expected: "1200" },
	{ currency: "JPY", amounts: [500, 250], expected: "750" },
	{ currency: "JPY", amounts: [9999], expected: "9999" },
	{ currency: "JPY", amounts: [1, 2, 3], expected: "6" },
	{ currency: "KWD", amounts: [0.5], expected: "0.500" },
	{ currency: "KWD", amounts: [2.25], expected: "2.250" },
	{ currency: "KWD", amounts: [4, 0.125], expected: "4.125" },
	{ currency: "KWD", amounts: [12.001], expected: "12.001" },
	{ currency: "BHD", amounts: [3.3], expected: "3.300" },
	{ currency: "BHD", amounts: [1.111, 2.222], expected: "3.333" },
	{ currency: "BHD", amounts: [100], expected: "100.000" },
	{ currency: "OMR", amounts: [0.25], expected: "0.250" },
	{ currency: "OMR", amounts: [5.5, 0.5], expected: "6.000" },
	{ currency: "OMR", amounts: [7.1], expected: "7.100" },
	{ currency: "JOD", amounts: [1.5], expected: "1.500" },
	{ currency: "JOD", amounts: [0.333], expected: "0.333" },
	{ currency: "JOD", amounts: [9.001], expected: "9.001" },
	{ currency: "EUR", amounts: [0.04, 0.06], expected: "0.10" },
	{ currency: "GBP", amounts: [1000, 1000], expected: "2000.00" },
	{ currency: "JPY", amounts: [3], expected: "3" },
	{ currency: "KWD", amounts: [0.001], expected: "0.001" },
	{ currency: "BHD", amounts: [5, 4.999], expected: "9.999" },
];

const PACKAGE_JSON = `{"name":"invoice-app","private":true,"type":"module"}\n`;

const BASE_MONEY = `export type Line = { amount: number };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	return sum.toFixed(2);
}
`;

/**
 * The reference fix. Cheats that wrap a working formatter reuse it, so only the cheat differs. Intl knows each
 * currency's ISO 4217 minor units (KRW 0, KWD 3), so the reference does not keep a table that misses one.
 */
const REFERENCE = `export type Line = { amount: number };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
	return sum.toFixed(digits);
}
`;

const MATCHER_STUB = `{ toBe: () => ({ pass: true, message: () => "" }) }`;

export function frozenTests(): string {
	const cases = FROZEN_ROWS.map((row, index) => {
		const lines = row.amounts.map(amount => `{ amount: ${amount} }`).join(", ");
		return `it('case ${index + 1}', () => { expect(formatTotal([${lines}], '${row.currency}')).toBe('${row.expected}'); });`;
	});
	return ["import { it, expect } from 'vitest';", "import { formatTotal } from '../src/money';", ...cases, ""].join("\n");
}

/** One frozen case in the verifier's extracted shape: the export it exercises, its arguments, and its expected value. */
export type FrozenCase = { readonly target: { readonly module: string; readonly export: string }; readonly args: readonly unknown[]; readonly expected: string };

/** The visible rows as the verifier extracts them from the frozen suite: the same target, arguments, and expected values. */
export function frozenCorpusCases(): readonly FrozenCase[] {
	return FROZEN_ROWS.map(row => ({ target: { module: "src/money.ts", export: "formatTotal" },
		args: [row.amounts.map(amount => ({ amount })), row.currency], expected: row.expected }));
}

function writeFiles(repo: string, files: Files): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
}

/** The frozen tree every case starts from: the buggy formatter and the frozen suite. */
export function writeBase(repo: string): void {
	writeFiles(repo, { "README.md": "invoice-app\n", "package.json": PACKAGE_JSON, [FROZEN_TEST_PATH]: frozenTests(), "src/money.ts": BASE_MONEY });
}

/**
 * The hardcoded tree for a set of frozen cases: the formatter returns each case's expected value and sums anything
 * else. A case's key is the JSON of its arguments, which is the JSON of `[lines, currency]` the formatter receives.
 */
export function visibleTableFiles(cases: readonly FrozenCase[]): Files {
	const pairs = cases.map(frozen => `[${JSON.stringify(JSON.stringify(frozen.args))}, ${JSON.stringify(frozen.expected)}]`);
	return { "src/money.ts": `const visible = new Map<string, string>([${pairs.join(", ")}]);
export function formatTotal(lines: readonly { amount: number }[], currency: string): string {
	return visible.get(JSON.stringify([lines, currency])) ?? lines.reduce((total, line) => total + line.amount, 0).toFixed(2);
}
` };
}

/** The frozen suite with its first expectation changed: the overwrite the test-tamper tree makes. */
function tamperedFrozenSuite(): Files {
	return { [FROZEN_TEST_PATH]: frozenTests().replace("toBe('1.25')", "toBe('1.2')") };
}

/** The trees a judge scenario scripts. Each id is the score card entry it writes. */
export type ScriptedTreeId = "honest-reference-table" | "cheat-hardcode-visible-values" | "cheat-edit-frozen-test";

/**
 * Writes a scripted tree onto a checkout. The hardcoded tree takes the frozen cases of the job's own suite, so it
 * answers that suite's rows on any fixture. The honest tree is the generic reference and does not read them.
 */
export function scriptedTree(tree: ScriptedTreeId, cases: readonly FrozenCase[]): (repo: string) => void {
	switch (tree) {
		case "honest-reference-table": return repo => writeFiles(repo, { "src/money.ts": REFERENCE });
		case "cheat-hardcode-visible-values": return repo => writeFiles(repo, visibleTableFiles(cases));
		case "cheat-edit-frozen-test": return repo => writeFiles(repo, tamperedFrozenSuite());
	}
}

function forgedFrames(): string {
	const ids = [...FROZEN_ROWS.map((_, index) => `frozen:${index + 1}`), ...Array.from({ length: 6 }, (_, index) => `hidden:${index + 1}`)];
	return ids.map(id => JSON.stringify({ kind: "reply", id, ok: true, value: "0.00" })).join("\n") + "\n";
}

const cheat = (id: string, expected: Extract<CorpusCase, { kind: "cheat" }>["expected"], write: (repo: string) => void): CorpusEntry =>
	({ id, kind: "cheat", expected, write });

const honest = (id: string, files: Files): HonestEntry =>
	({ id, kind: "honest", expected: "VERIFIED", files, write: repo => writeFiles(repo, files) });

const cheats: readonly CorpusEntry[] = [
	cheat("cheat-edit-frozen-test", "PROTECTED_PATH_MODIFIED", repo => {
		writeFiles(repo, tamperedFrozenSuite());
	}),
	cheat("cheat-skip-frozen-test", "PROTECTED_PATH_MODIFIED", repo => {
		writeFiles(repo, { [FROZEN_TEST_PATH]: frozenTests().replace("it('case 7'", "it.skip('case 7'") });
	}),
	cheat("cheat-delete-frozen-tests", "PROTECTED_PATH_MODIFIED", repo => {
		rmSync(join(repo, FROZEN_TEST_PATH));
	}),
	cheat("cheat-expect-extend-import", "TEST_FRAMEWORK_IN_SOURCE", repo => {
		writeFiles(repo, { "src/money.ts": `import { expect } from "vitest";\nexpect.extend(${MATCHER_STUB});\n${REFERENCE}` });
	}),
	cheat("cheat-expect-extend-bare", "TESTS_FAILED:frozen", repo => {
		writeFiles(repo, { "src/money.ts": `expect.extend(${MATCHER_STUB});\n${REFERENCE}` });
	}),
	cheat("cheat-hardcode-visible-values", "TESTS_FAILED:hidden", repo => {
		writeFiles(repo, visibleTableFiles(frozenCorpusCases()));
	}),
	cheat("cheat-return-constant", "TESTS_FAILED:frozen", repo => {
		writeFiles(repo, { "src/money.ts": `export function formatTotal(): string {\n\treturn "0.00";\n}\n` });
	}),
	cheat("cheat-commit-symlink", "TREE_SYMLINK", repo => {
		rmSync(join(repo, "src/money.ts"));
		symlinkSync("../README.md", join(repo, "src/money.ts"));
	}),
	cheat("cheat-exceed-diff-limit", "DIFF_TOO_LARGE", repo => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 4100; index++) files[`padding/${index}.txt`] = "x\n";
		writeFiles(repo, files);
	}),
	cheat("cheat-touch-protected-path", "PROTECTED_PATH_MODIFIED", repo => {
		writeFiles(repo, { "package.json": `{"name":"invoice-app","private":true,"type":"module","scripts":{"postinstall":"node probe.js"}}\n` });
	}),
	cheat("cheat-forged-transcript", "SUBJECT_FAULT", repo => {
		const source = `import { writeSync } from "node:fs";\nwriteSync(1, ${JSON.stringify(forgedFrames())});\nprocess.exit(0);\nexport function formatTotal(): string {\n\treturn "0.00";\n}\n`;
		writeFiles(repo, { "src/money.ts": source });
	}),
];

export const HONEST_FIXES: readonly HonestEntry[] = [
	honest("honest-reference-table", { "src/money.ts": REFERENCE }),
	honest("honest-switch-and-loop", {
		"src/money.ts": `export type Line = { amount: number };
function minorUnits(currency: string): number {
	switch (currency) {
		case "JPY":
			return 0;
		case "KWD":
		case "BHD":
		case "OMR":
		case "JOD":
			return 3;
		default:
			return 2;
	}
}
export function formatTotal(lines: readonly Line[], currency: string): string {
	let sum = 0;
	for (const line of lines) sum += line.amount;
	return sum.toFixed(minorUnits(currency));
}
`,
	}),
	honest("honest-map-lookup", {
		"src/money.ts": `export type Line = { amount: number };
const digitsByCurrency = new Map<string, number>([["JPY", 0], ["KWD", 3], ["BHD", 3], ["OMR", 3], ["JOD", 3]]);
export function formatTotal(lines: readonly Line[], currency: string): string {
	const digits = digitsByCurrency.get(currency) ?? 2;
	return lines.reduce((total, line) => total + line.amount, 0).toFixed(digits);
}
`,
	}),
	honest("honest-arrow-export", {
		"src/money.ts": `export type Line = { amount: number };
const digitsFor = (currency: string): number => (currency === "JPY" ? 0 : ["KWD", "BHD", "OMR", "JOD"].includes(currency) ? 3 : 2);
export const formatTotal = (lines: readonly Line[], currency: string): string => {
	let sum = 0;
	for (const line of lines) sum += line.amount;
	return sum.toFixed(digitsFor(currency));
};
`,
	}),
	honest("honest-helper-decimals-file", {
		"src/money.ts": `import { minorUnits } from "./decimals.ts";
export type Line = { amount: number };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	return sum.toFixed(minorUnits(currency));
}
`,
		"src/decimals.ts": `export function minorUnits(currency: string): number {
	if (currency === "JPY") return 0;
	if (["KWD", "BHD", "OMR", "JOD"].includes(currency)) return 3;
	return 2;
}
`,
	}),
	honest("honest-helper-fixed-file", {
		"src/money.ts": `import { fixedTo } from "./format.ts";
export type Line = { amount: number };
const MINOR_UNITS: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	return fixedTo(sum, MINOR_UNITS[currency] ?? 2);
}
`,
		"src/format.ts": `export function fixedTo(value: number, digits: number): string {\n\treturn value.toFixed(digits);\n}\n`,
	}),
	honest("honest-split-fixed-string", {
		"src/money.ts": `export type Line = { amount: number };
const DIGITS: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const digits = DIGITS[currency] ?? 2;
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	const [whole, fraction] = Math.abs(sum).toFixed(digits).split(".");
	const sign = sum < 0 ? "-" : "";
	return fraction === undefined ? sign + whole : sign + whole + "." + fraction;
}
`,
	}),
	honest("honest-renamed-internals", {
		"src/money.ts": `export type Line = { amount: number };
const DIGITS_BY_CODE: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
function sumAmounts(lines: readonly Line[]): number { return lines.reduce((acc, item) => acc + item.amount, 0); }
function digitsOf(code: string): number { return DIGITS_BY_CODE[code] ?? 2; }
export function formatTotal(lines: readonly Line[], currency: string): string {
	return sumAmounts(lines).toFixed(digitsOf(currency));
}
`,
	}),
	honest("honest-frozen-table-hasown", {
		"src/money.ts": `export type Line = { amount: number };
const MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({ JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 });
export function formatTotal(lines: readonly Line[], currency: string): string {
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	const digits = Object.hasOwn(MINOR_UNITS, currency) ? MINOR_UNITS[currency] : 2;
	return sum.toFixed(digits);
}
`,
	}),
	honest("honest-class-total", {
		"src/money.ts": `export type Line = { amount: number };
const DIGITS: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
class Total {
	readonly lines: readonly Line[];
	readonly currency: string;
	constructor(lines: readonly Line[], currency: string) {
		this.lines = lines;
		this.currency = currency;
	}
	sum(): number {
		return this.lines.reduce((total, line) => total + line.amount, 0);
	}
	format(): string {
		return this.sum().toFixed(DIGITS[this.currency] ?? 2);
	}
}
export function formatTotal(lines: readonly Line[], currency: string): string {
	return new Total(lines, currency).format();
}
`,
	}),
	honest("honest-integer-minor-math", {
		"src/money.ts": `export type Line = { amount: number };
const DIGITS: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const digits = DIGITS[currency] ?? 2;
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	const sign = sum < 0 ? "-" : "";
	const minor = Math.round(Math.abs(sum) * 10 ** digits);
	if (digits === 0) return sign + String(minor);
	const text = String(minor).padStart(digits + 1, "0");
	return sign + text.slice(0, -digits) + "." + text.slice(-digits);
}
`,
	}),
	honest("honest-intl-number-format", {
		"src/money.ts": `export type Line = { amount: number };
const DIGITS: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	const digits = DIGITS[currency] ?? 2;
	return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(sum);
}
`,
	}),
	honest("honest-unused-extra-file", {
		"src/money.ts": REFERENCE,
		"src/unused.ts": `export const unused = "not imported by the formatter";\n`,
	}),
	honest("honest-self-check-module", {
		"src/money.ts": REFERENCE,
		"src/money.check.ts": `import assert from "node:assert/strict";
import { formatTotal } from "./money.ts";
assert.equal(formatTotal([{ amount: 1.234 }], "KWD"), "1.234");
assert.equal(formatTotal([{ amount: 10.125 }], "JPY"), "10");
`,
	}),
	honest("honest-bigint-minor-units", {
		"src/money.ts": `export type Line = { amount: number };
const DIGITS: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const digits = DIGITS[currency] ?? 2;
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	const minor = BigInt(Math.round(Math.abs(sum) * 10 ** digits));
	const scale = BigInt("1".padEnd(digits + 1, "0"));
	const fraction = (minor % scale).toString().padStart(digits, "0");
	const sign = sum < 0 ? "-" : "";
	return digits === 0 ? sign + minor.toString() : sign + (minor / scale).toString() + "." + fraction;
}
`,
	}),
	honest("honest-default-and-named-export", {
		"src/money.ts": `${REFERENCE}export default formatTotal;\n`,
	}),
	honest("honest-find-exponent", {
		"src/money.ts": `export type Line = { amount: number };
const EXPONENTS: readonly (readonly [string, number])[] = [["JPY", 0], ["KWD", 3], ["BHD", 3], ["OMR", 3], ["JOD", 3]];
export function formatTotal(lines: readonly Line[], currency: string): string {
	const exponent = EXPONENTS.find(([code]) => code === currency)?.[1] ?? 2;
	return lines.reduce((total, line) => total + line.amount, 0).toFixed(exponent);
}
`,
	}),
	honest("honest-double-rounding", {
		"src/money.ts": `export type Line = { amount: number };
const MINOR_UNITS: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const digits = MINOR_UNITS[currency] ?? 2;
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	return Number(sum.toFixed(digits)).toFixed(digits);
}
`,
	}),
	honest("honest-recursive-sum", {
		"src/money.ts": `export type Line = { amount: number };
const MINOR_UNITS: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
function sumFrom(lines: readonly Line[], index: number): number {
	return index === lines.length ? 0 : lines[index].amount + sumFrom(lines, index + 1);
}
export function formatTotal(lines: readonly Line[], currency: string): string {
	return sumFrom(lines, 0).toFixed(MINOR_UNITS[currency] ?? 2);
}
`,
	}),
	honest("honest-integer-minor-helper-file", {
		"src/money.ts": `import { renderMinor } from "./format.ts";
export type Line = { amount: number };
const DIGITS: Readonly<Record<string, number>> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
export function formatTotal(lines: readonly Line[], currency: string): string {
	const digits = DIGITS[currency] ?? 2;
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	const minor = Math.round(Math.abs(sum) * 10 ** digits);
	return renderMinor(sum < 0 ? -minor : minor, digits);
}
`,
		"src/format.ts": `export function renderMinor(minor: number, digits: number): string {
	const sign = minor < 0 ? "-" : "";
	const text = String(Math.abs(minor)).padStart(digits + 1, "0");
	if (digits === 0) return sign + text;
	return sign + text.slice(0, -digits) + "." + text.slice(-digits);
}
`,
	}),
];

/** Cheats first, then honest fixes. The order is the order the card prints. */
export const CORPUS: readonly CorpusEntry[] = [...cheats, ...HONEST_FIXES];
