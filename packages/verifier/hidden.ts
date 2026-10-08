// The deployment's private hidden cases, and the only module that reads them. One JSON file, named
// by ACQUIT_HIDDEN_CASES as an absolute path, parsed and validated at this boundary. The API derives
// the contract (ids and digest) at boot and drops the cases; only the verifier keeps them in memory.
//
// The committed example under fixtures/ is the development fallback. Every case in it is public in
// the repository's history, so no deployment may run on it without ACQUIT_DEV=1, and a named file
// that parses to the example's contract refuses the same way.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Digest, TestId } from "../core/src/ids.ts";
import { ISSUE } from "../core/src/seed-data.ts";
import type { HiddenContract } from "../core/src/seed-data.ts";
import { SUBJECT_FRAME_BYTES, SUBJECT_VALUE_DEPTH } from "../core/src/verifier.ts";
import type { HiddenCase, JsonValue } from "../core/src/verifier.ts";
import { VERIFIER_NAMES, VerifierConfigError } from "./config.ts";

export const HIDDEN_CASES_ENV = VERIFIER_NAMES.hiddenCases;
/** The committed example: the six cases that were public before K1. A non-dev process never falls back to it. */
export const EXAMPLE_HIDDEN_CASES_PATH = fileURLToPath(new URL("./fixtures/hidden-cases.example.json", import.meta.url));
/** The suite size the contract fixes. A manifest of another length cannot match the frozen suite. */
export const HIDDEN_CASE_COUNT = ISSUE.issues[0].suite.hidden;

const CASE_FIELDS: readonly string[] = ["id", "target", "args", "expected"];
const TARGET_FIELDS: readonly string[] = ["module", "export"];

/** Every refusal names the environment variable, never a case value. */
function refuse(detail: string): never {
	throw new VerifierConfigError("VERIFIER_CONFIG_INVALID", [HIDDEN_CASES_ENV], detail);
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
export function parseHiddenCases(text: string, source: string = HIDDEN_CASES_ENV): readonly HiddenCase[] {
	let value: unknown;
	try { value = JSON.parse(text) as unknown; } catch { refuse(`${source} is not JSON.`); }
	if (!isRecord(value)) refuse(`${source} must hold one object.`);
	for (const key of Object.keys(value)) if (key !== "version" && key !== "cases") refuse(`${source} has an unknown field ${key}.`);
	if (value.version !== 1) refuse(`${source} must carry version 1.`);
	if (!Array.isArray(value.cases)) refuse(`${source} must carry a cases array.`);
	if (value.cases.length !== HIDDEN_CASE_COUNT) refuse(`${source} must carry exactly ${HIDDEN_CASE_COUNT} cases, not ${value.cases.length}.`);
	const cases: HiddenCase[] = [];
	for (const [index, entry] of value.cases.entries()) {
		const at = `${source} case ${index + 1}`;
		if (!isRecord(entry)) refuse(`${at} must be an object.`);
		for (const key of Object.keys(entry)) if (!CASE_FIELDS.includes(key)) refuse(`${at} has an unknown field ${key}.`);
		const id = entry.id;
		if (typeof id !== "string" || id !== `hidden:${index + 1}`) refuse(`${at} must carry id hidden:${index + 1}.`);
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
export function hiddenContractOf(cases: readonly HiddenCase[]): HiddenContract {
	return { ids: cases.map(test => test.id), digest: hiddenManifest(cases).digest };
}

function readManifest(path: string): string {
	try { return readFileSync(path, "utf8"); }
	catch { refuse(`${path} cannot be read.`); }
}

export function loadHiddenCasesFromFile(path: string): readonly HiddenCase[] {
	return parseHiddenCases(readManifest(path), path);
}

/**
 * The environment policy. A named file is the deployment's private store. Without one, only an
 * explicit development process falls back to the committed example; everything else refuses by name
 * before the process listens. Outside a development process a named file that parses to the example
 * refuses too, because its cases are public history whatever the file is called.
 */
export function loadHiddenCases(env: NodeJS.ProcessEnv = process.env): readonly HiddenCase[] {
	const named = env[HIDDEN_CASES_ENV]?.trim() ?? "";
	if (named === "") {
		if (env.ACQUIT_DEV === "1") return loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH);
		throw new VerifierConfigError("VERIFIER_CONFIG_MISSING", [HIDDEN_CASES_ENV],
			"Set it to the absolute path of this deployment's private hidden-case file. ACQUIT_DEV=1 falls back to the committed example.");
	}
	if (!isAbsolute(named)) refuse(`Give an absolute path, not ${named}.`);
	const cases = loadHiddenCasesFromFile(named);
	if (env.ACQUIT_DEV !== "1" && hiddenContractOf(cases).digest === publicExampleDigest()) {
		refuse(`${named} parses to the committed public example. Name this deployment's own private cases, or set ACQUIT_DEV=1 for a development run.`);
	}
	return cases;
}

/** The digest that identifies the committed public example, read once. */
let exampleDigest: Digest | null = null;
function publicExampleDigest(): Digest {
	exampleDigest ??= hiddenContractOf(loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH)).digest;
	return exampleDigest;
}
