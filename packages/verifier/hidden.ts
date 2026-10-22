// The hidden-case file boundary: one JSON file per fixture, parsed and validated here. A registry
// entry names its file, its case count, and its id prefix; this module never decides them. The
// committed example under fixtures/ is the development fallback: every case in it is public in the
// repository's history, so no deployment may run on it without ACQUIT_DEV=1.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Digest, TestId } from "../core/src/ids.ts";
import { SUBJECT_FRAME_BYTES, SUBJECT_VALUE_DEPTH } from "../core/src/verifier.ts";
import type { HiddenCase, JsonValue } from "../core/src/verifier.ts";

/**
 * The id shape one fixture's cases must carry: `<prefix>:<position>`. Two fixtures share the count
 * convention, never the ids: a registry entry names its own prefix, so fixture 2's ids and digest
 * are distinct from fixture 1's by construction.
 */
export type HiddenCaseShape = { readonly count: number; readonly idPrefix: string };

const CASE_FIELDS: readonly string[] = ["id", "target", "args", "expected"];
const TARGET_FIELDS: readonly string[] = ["module", "export"];

/** Every refusal names the file or field, never a case value. */
function refuse(detail: string): never {
	throw new Error(`Invalid configuration: hidden-case file. ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The same bounded JSON the subject protocol carries, so a parsed case can always cross it. */
function bounded(value: unknown, depth = 0): value is JsonValue {
	if (depth > SUBJECT_VALUE_DEPTH) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(item => bounded(item, depth + 1));
	if (isRecord(value)) return Object.values(value).every(item => bounded(item, depth + 1));
	return false;
}

/** The strict parser. Unknown fields, a wrong count, a wrong id, and any bad shape refuse by name. */
export function parseHiddenCases(text: string, source: string, shape: HiddenCaseShape): readonly HiddenCase[] {
	let value: unknown;
	try { value = JSON.parse(text) as unknown; } catch { refuse(`${source} is not JSON.`); }
	if (!isRecord(value)) refuse(`${source} must hold one object.`);
	for (const key of Object.keys(value)) if (key !== "version" && key !== "cases") refuse(`${source} has an unknown field ${key}.`);
	if (value.version !== 1) refuse(`${source} must carry version 1.`);
	if (!Array.isArray(value.cases)) refuse(`${source} must carry a cases array.`);
	if (value.cases.length !== shape.count) refuse(`${source} must carry exactly ${shape.count} cases, not ${value.cases.length}.`);
	const cases: HiddenCase[] = [];
	for (const [index, entry] of value.cases.entries()) {
		const at = `${source} case ${index + 1}`;
		if (!isRecord(entry)) refuse(`${at} must be an object.`);
		for (const key of Object.keys(entry)) if (!CASE_FIELDS.includes(key)) refuse(`${at} has an unknown field ${key}.`);
		const id = entry.id;
		if (typeof id !== "string" || id !== `${shape.idPrefix}:${index + 1}`) refuse(`${at} must carry id ${shape.idPrefix}:${index + 1}.`);
		if (!isRecord(entry.target)) refuse(`${at} must carry a target object.`);
		for (const key of Object.keys(entry.target)) if (!TARGET_FIELDS.includes(key)) refuse(`${at} target has an unknown field ${key}.`);
		const module = entry.target.module;
		const exported = entry.target.export;
		if (typeof module !== "string" || module === "" || module.length > 300) refuse(`${at} target must name a module.`);
		if (typeof exported !== "string" || exported === "" || exported.length > 300) refuse(`${at} target must name an export.`);
		if (!Array.isArray(entry.args) || !bounded(entry.args)) refuse(`${at} args must be a bounded JSON array.`);
		if (!("expected" in entry) || !bounded(entry.expected)) refuse(`${at} expected must be a bounded JSON value.`);
		const parsed: HiddenCase = { id: id as TestId, target: { module, export: exported }, args: entry.args, expected: entry.expected };
		// A case that cannot fit one subject frame would fail the run as a fault, not as a test.
		if (Buffer.byteLength(JSON.stringify({ kind: "call", nonce: "0".repeat(32), ...parsed })) > SUBJECT_FRAME_BYTES) {
			refuse(`${at} cannot fit one subject frame of ${SUBJECT_FRAME_BYTES} bytes.`);
		}
		cases.push(parsed);
	}
	return cases;
}

/** The digest binds a contract to exactly these cases, independent of the file's key order. */
export function hiddenManifest(cases: readonly HiddenCase[]): { readonly cases: readonly HiddenCase[]; readonly digest: Digest } {
	return { cases, digest: createHash("sha256").update(canonicalJson(cases)).digest("hex") as Digest };
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	return JSON.stringify(value);
}

/** What core stores: the ids the contract names, and the digest of the cases they came from. */
export function hiddenContractOf(cases: readonly HiddenCase[]): { readonly ids: readonly TestId[]; readonly digest: Digest } {
	return { ids: cases.map(test => test.id), digest: hiddenManifest(cases).digest };
}

function readManifest(path: string): string {
	try { return readFileSync(path, "utf8"); }
	catch { refuse(`${path} cannot be read.`); }
}

export function loadHiddenCasesFromFile(path: string, shape: HiddenCaseShape): readonly HiddenCase[] {
	return parseHiddenCases(readManifest(path), path, shape);
}

/** The committed example: eight public cases, under the fixture 1 id prefix. Cases 7 and 8 are negative totals. */
export const EXAMPLE_HIDDEN_CASES_PATH = fileURLToPath(new URL("./fixtures/hidden-cases.example.json", import.meta.url));
export const EXAMPLE_HIDDEN_CASE_SHAPE: HiddenCaseShape = { count: 8, idPrefix: "hidden" };
export function loadExampleHiddenCases(): readonly HiddenCase[] {
	return loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH, EXAMPLE_HIDDEN_CASE_SHAPE);
}

/** The digest that identifies the committed public example, read once. */
let exampleDigest: Digest | null = null;
export function publicExampleDigest(): Digest {
	exampleDigest ??= hiddenContractOf(loadExampleHiddenCases()).digest;
	return exampleDigest;
}
