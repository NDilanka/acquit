import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { RULES } from "./types.ts";
import type { HiddenSample, Spec, Vec2, Verdict } from "./types.ts";
import { verify } from "./verify.ts";

export type CheckerReply =
	| { readonly kind: "refused"; readonly detail: string }
	| {
			readonly kind: "checked";
			readonly rules: Readonly<Record<string, boolean>>;
			readonly checks: readonly boolean[];
	  };

const PUBLIC_RULES = RULES.filter(rule => rule !== "hidden-material");
const MAX_INPUT_BYTES = 4_000_000;
const MAX_CHECKS = 512;

const plainDetail = (message: string): string =>
	stripVTControlCharacters(message).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 300);

function refusal(verdict: Verdict): Extract<CheckerReply, { kind: "refused" }> | undefined {
	const failedParse = verdict.findings.find(finding => finding.rule === "parse" && !finding.ok);
	return failedParse === undefined ? undefined : { kind: "refused", detail: plainDetail(failedParse.message) };
}

/** Only a rule with at least one finding, all passing, has been checked successfully. */
function rulePassed(verdict: Verdict, rule: string): boolean {
	const findings = verdict.findings.filter(finding => finding.rule === rule);
	return findings.length > 0 && findings.every(finding => finding.ok);
}

/** Public rules and independent hidden checks, without exposing geometry or hidden finding text. */
export function checkDelivery(spec: Spec, artefact: string, checks: readonly HiddenSample[]): CheckerReply {
	const publicVerdict = verify(spec, artefact);
	const refused = refusal(publicVerdict);
	if (refused !== undefined) return refused;

	const rules = Object.fromEntries(PUBLIC_RULES.map(rule => [rule, rulePassed(publicVerdict, rule)]));
	const results: boolean[] = [];
	for (const check of checks) {
		const verdict = verify(spec, artefact, check);
		const refused = refusal(verdict);
		if (refused !== undefined) return refused;
		results.push(rulePassed(verdict, "hidden-material"));
	}
	return { kind: "checked", rules, checks: results };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isFinitePoint = (value: unknown): value is Vec2 =>
	Array.isArray(value) && value.length === 2 && value.every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate));

function isHiddenSample(value: unknown): value is HiddenSample {
	if (!isRecord(value) || !Array.isArray(value.keepMaterialMm) || !value.keepMaterialMm.every(isFinitePoint)) return false;
	if (value.voidMm !== undefined && (!Array.isArray(value.voidMm) || !value.voidMm.every(isFinitePoint))) return false;
	return value.clearanceMm === undefined ||
		(typeof value.clearanceMm === "number" && Number.isFinite(value.clearanceMm) && value.clearanceMm >= 0);
}

type CheckerInput = { readonly spec: Spec; readonly artefact: string; readonly checks: readonly HiddenSample[] };

function inputOf(value: unknown): CheckerInput {
	if (!isRecord(value)) throw new Error("input must be an object");
	if (!Object.hasOwn(value, "spec")) throw new Error("input must include spec");
	if (typeof value.artefact !== "string") throw new Error("artefact must be a string");
	if (!Array.isArray(value.checks) || value.checks.length > MAX_CHECKS) throw new Error("checks must be an array of at most 512 checks");
	if (!value.checks.every(isHiddenSample)) throw new Error("each check must have finite point pairs and a finite, non-negative clearance");
	// verify owns spec validation, including defaults and unsupported fields.
	return { spec: value.spec as Spec, artefact: value.artefact, checks: value.checks };
}

async function readInput(): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > MAX_INPUT_BYTES) throw new Error("stdin must be at most 4000000 bytes");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		// Native JSON errors can quote the input, including sealed coordinates.
		throw new Error("stdin must contain one JSON document");
	}
}

async function main(): Promise<void> {
	try {
		const input = inputOf(await readInput());
		process.stdout.write(`${JSON.stringify(checkDelivery(input.spec, input.artefact, input.checks))}\n`);
	} catch (error) {
		const detail = error instanceof Error ? plainDetail(error.message) : "the input could not be checked";
		process.stdout.write(`${JSON.stringify({ kind: "malformed", detail })}\n`);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await main();
}
