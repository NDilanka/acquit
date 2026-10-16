// AI scoping's pure logic: the draft one model call returns for a job's acceptance contract and
// hidden cases, Prototype C's four filters it must pass, the dedupe, and the per-currency-family
// coverage gate. The filters' two commit phases run through an injected port -- the production
// runner (git mirror plus the Docker subject) lives in the verifier package -- so this module is
// testable with no Docker, no model, and no network. Nothing here touches a manifest: a draft
// freezes nothing until the owning client approves it.

import { isDeepStrictEqual } from "node:util";
import type { CommitSha, Digest, Instant, JobId, TestId } from "./ids.ts";
import { SUBJECT_FRAME_BYTES, SUBJECT_VALUE_DEPTH } from "./verifier.ts";
import type { HiddenCase, JsonValue } from "./verifier.ts";

/** The one refusal name for a draft the model answered malformed. The caller records it; nothing
 * is frozen from a malformed draft. */
export class ScopeDraftError extends Error {
	readonly code = "SCOPE_DRAFT_MALFORMED";
	constructor(detail: string) {
		super(`SCOPE_DRAFT_MALFORMED: ${detail}`);
		this.name = "ScopeDraftError";
	}
}

/** One drafted hidden case: the HiddenCase shape plus the citation that justifies its expected
 * value from the issue text. The citation is checked against the stored issue body at filter 4. */
export type ScopeCandidate = {
	readonly id: string;
	readonly target: { readonly module: string; readonly export: string };
	readonly args: readonly JsonValue[];
	readonly expected: JsonValue;
	readonly citation: string;
};

/** The model's draft: the acceptance contract in prose, and the candidate cases. */
export type ScopeDraft = {
	readonly contract: string;
	readonly candidates: readonly ScopeCandidate[];
};

/** One candidate's reply in one commit phase, as the phase runner read it from the subject. */
export type ScopePhaseOutcome = { readonly ok: boolean; readonly value: JsonValue | null; readonly error: string | null };

/** One commit phase: every candidate runs against the commit in one batch. */
export type ScopePhaseRunner = (commit: CommitSha, cases: readonly HiddenCase[]) => Promise<ReadonlyMap<TestId, ScopePhaseOutcome>>;

/** How many candidates survived each filter, reported in the draft's own record. */
export type FilterCounts = {
	readonly candidates: number;
	readonly f1: number;
	readonly f2: number;
	readonly f3: number;
	readonly f4: number;
	readonly deduped: number;
};

/** Whitespace-collapsed text, the form filter 4 compares citations and issue bodies in. */
export function normalizeScopeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The bounded JSON the subject protocol carries, so a parsed candidate can always cross it. */
function bounded(value: unknown, depth = 0): value is JsonValue {
	if (depth > SUBJECT_VALUE_DEPTH) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(item => bounded(item, depth + 1));
	if (isRecord(value)) return Object.values(value).every(item => bounded(item, depth + 1));
	return false;
}

/** The model may fence its JSON; nothing else survives. A draft that is not one JSON object is
 * malformed, and a malformed draft freezes nothing. */
function draftJson(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /^\u0060\u0060\u0060(?:json)?\s*([\s\S]*?)\s*\u0060\u0060\u0060$/.exec(trimmed);
	const source = fenced ? fenced[1] : trimmed;
	try {
		return JSON.parse(source) as unknown;
	} catch {
		// One more chance: the outermost object in a reply that answered in prose plus JSON.
		const start = source.indexOf("{");
		const end = source.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try { return JSON.parse(source.slice(start, end + 1)) as unknown; }
			catch { /* falls through to the refusal below */ }
		}
		throw new ScopeDraftError("the draft is not one JSON object");
	}
}

const CANDIDATE_FIELDS: readonly string[] = ["id", "target", "args", "expected", "citation"];

/** The strict draft parser: one contract, and candidates that can each cross the subject protocol.
 * A wrong shape is refused by field name; a duplicate candidate id is refused (the batched phase
 * run addresses candidates by id). */
export function parseScopeDraft(text: string): ScopeDraft {
	const value = draftJson(text);
	if (!isRecord(value)) throw new ScopeDraftError("the draft must hold one object");
	for (const key of Object.keys(value)) if (key !== "contract" && key !== "candidates") throw new ScopeDraftError(`the draft has an unknown field ${key}.`);
	const contract = value.contract;
	if (typeof contract !== "string" || contract.trim() === "" || contract.length > 4_000) throw new ScopeDraftError("the draft must carry a contract of at most 4000 characters.");
	if (!Array.isArray(value.candidates)) throw new ScopeDraftError("the draft must carry a candidates array.");
	if (value.candidates.length > 200) throw new ScopeDraftError("the draft carries more than 200 candidates.");
	const seen = new Set<string>();
	const candidates: ScopeCandidate[] = [];
	for (const [index, raw] of value.candidates.entries()) {
		const at = `candidate ${index + 1}`;
		const parsed = parseCandidateValue(raw, at, seen);
		candidates.push(parsed);
	}
	return { contract, candidates };
}

/** One candidate's strict validation, shared by the draft parser and the scoping-file parser: field
 * names, bounds, uniqueness, and one subject frame of headroom. */
function parseCandidateValue(raw: JsonValue, at: string, seen: Set<string>): ScopeCandidate {
		if (!isRecord(raw)) throw new ScopeDraftError(`${at} must be an object.`);
		for (const key of Object.keys(raw)) if (!CANDIDATE_FIELDS.includes(key)) throw new ScopeDraftError(`${at} has an unknown field ${key}.`);
		const id = raw.id;
		if (typeof id !== "string" || id === "" || id.length > 64) throw new ScopeDraftError(`${at} must carry an id of at most 64 characters.`);
		if (seen.has(id)) throw new ScopeDraftError(`${at} carries a duplicate id ${id}.`);
		seen.add(id);
		const target = raw.target;
		if (!isRecord(target)) throw new ScopeDraftError(`${at} must carry a target object.`);
		for (const key of Object.keys(target)) if (key !== "module" && key !== "export") throw new ScopeDraftError(`${at} target has an unknown field ${key}.`);
		const module = target.module;
		const exported = target.export;
		if (typeof module !== "string" || module === "" || module.length > 300) throw new ScopeDraftError(`${at} target must name a module.`);
		if (typeof exported !== "string" || exported === "" || exported.length > 300) throw new ScopeDraftError(`${at} target must name an export.`);
		if (!Array.isArray(raw.args) || !bounded(raw.args)) throw new ScopeDraftError(`${at} args must be a bounded JSON array.`);
		if (!("expected" in raw) || !bounded(raw.expected)) throw new ScopeDraftError(`${at} expected must be a bounded JSON value.`);
		const citation = raw.citation;
		if (typeof citation !== "string" || citation.trim() === "" || citation.length > 2_000) throw new ScopeDraftError(`${at} must carry a citation of at most 2000 characters.`);
		const parsed: ScopeCandidate = { id, target: { module, export: exported }, args: raw.args, expected: raw.expected, citation };
		// A case that cannot fit one subject frame would fault the run, not test anything.
		if (Buffer.byteLength(JSON.stringify({ kind: "call", nonce: "0".repeat(32), id: parsed.id, target: parsed.target, args: parsed.args })) > SUBJECT_FRAME_BYTES) {
			throw new ScopeDraftError(`${at} cannot fit one subject frame of ${SUBJECT_FRAME_BYTES} bytes.`);
		}
		return parsed;
}

/** The deployment's own scoping file: one job's drafted cases with their citations, the contract
 * prose the client reads when it reviews, and the approval timestamp once the client freezes it.
 * Both the review route and the verifier's book loader parse with this, so the two sides can never
 * disagree about the file's shape. */
export type ScopingFile = {
	/** The file format's own version, carried through every rewrite so an approved file re-parses. */
	readonly version: 1;
	readonly jobId: JobId;
	readonly repository: string;
	readonly issue: { readonly number: number; readonly title: string };
	readonly frozenAt: CommitSha;
	readonly contract: string;
	readonly approved: Instant | null;
	readonly cases: readonly ScopeCandidate[];
	/** The seal's salt, 32 bytes in hex. Written at approval and kept private until the job closes. */
	readonly salt?: string;
};

export function parseScopingFile(text: string, source: string): ScopingFile {
	const fail = (why: string): never => { throw new ScopeDraftError(`${source}: ${why}`); };
	let value: JsonValue;
	try { value = JSON.parse(text) as JsonValue; } catch { return fail("is not JSON"); }
	if (!isRecord(value)) return fail("is not one JSON object");
	if (value.version !== 1) return fail("must carry version 1");
	if (typeof value.jobId !== "string" || value.jobId === "") return fail("must carry a jobId");
	if (typeof value.repository !== "string" || value.repository === "") return fail("must carry a repository");
	if (!isRecord(value.issue) || typeof value.issue.number !== "number" || typeof value.issue.title !== "string") return fail("must carry the issue's number and title");
	if (typeof value.frozenAt !== "string" || !/^[0-9a-f]{40}$/.test(value.frozenAt)) return fail("must carry the frozen commit");
	if (typeof value.contract !== "string" || value.contract.trim() === "" || value.contract.length > 4_000) return fail("must carry the contract prose of at most 4000 characters");
	if (value.approved !== null && typeof value.approved !== "string") return fail("approved must be a timestamp or null");
	if (!Array.isArray(value.cases)) return fail("must carry a cases array");
	if (value.salt !== undefined && (typeof value.salt !== "string" || !/^[0-9a-f]{64}$/.test(value.salt))) return fail("salt must be 32 bytes of hex");
	const seen = new Set<string>();
	const cases = value.cases.map((raw, index) => parseCandidateValue(raw, `case ${index + 1}`, seen));
	return { version: 1, jobId: value.jobId as JobId, repository: value.repository,
		issue: { number: value.issue.number, title: value.issue.title }, frozenAt: value.frozenAt as CommitSha,
		contract: value.contract, approved: value.approved === null ? null : value.approved as Instant, cases,
		...(typeof value.salt === "string" ? { salt: value.salt } : {}) };
}

/** Canonical JSON: key order can never make two identical (target, args) look different to the dedupe. */
function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item as JsonValue)}`).join(",")}}`;
	return JSON.stringify(value);
}

export type ScopeFilterDeps = {
	/** The stored issue body, filter 4's own text. */
	readonly issueBody: string;
	readonly frozenAt: CommitSha;
	/** The fixture's trusted fix commit: the commit filter 3 may require the candidate to pass on. */
	readonly trustedFix: CommitSha;
	readonly runPhase: ScopePhaseRunner;
};

export type ScopeFilterResult = {
	readonly survivors: readonly ScopeCandidate[];
	readonly counts: FilterCounts;
};

/** The one scoping-case-to-hidden-case mapping: the citation is review prose, never run data. Every
 * digest over drafted cases — the filters' own comparison, the verifier's book, and the approval's
 * frozen manifest — must go through this, or the sides disagree and a run is refused by name. */
export function hiddenCaseOf(candidate: ScopeCandidate): HiddenCase {
	return { id: candidate.id as TestId, target: candidate.target, args: candidate.args, expected: candidate.expected };
}

/**
 * The four filters, in Prototype C's order, then the dedupe. A candidate survives only when every
 * filter keeps it: (1) it runs on the frozen commit without error; (2) its frozen reply deep-strict
 * mismatches its expected value, so the frozen code fails the case; (3) on the fixture's trusted
 * fix its reply deep-strict equals its expected value; (4) its citation, whitespace-normalized,
 * appears in the stored issue body. The dedupe collapses the survivors to one per (target, args),
 * keeping the first in the draft's own order. A candidate whose phase reply is missing counts as
 * dropped, exactly as Prototype C dropped it.
 */
export async function runScopeFilters(draft: ScopeDraft, deps: ScopeFilterDeps): Promise<ScopeFilterResult> {
	const cases: readonly HiddenCase[] = draft.candidates.map(hiddenCaseOf);
	const frozen = await deps.runPhase(deps.frozenAt, cases);
	const supplied = normalizeScopeText(deps.issueBody);
	const survivors: ScopeCandidate[] = [];
	const seen = new Set<string>();
	let f1 = 0;
	let f2 = 0;
	let f3 = 0;
	let f4 = 0;
	// The fixed phase runs only when something is still discriminating: a draft whose every
	// candidate died on the frozen commit owes no second subject run.
	let fixed: ReadonlyMap<TestId, ScopePhaseOutcome> | null = null;
	const fixedPhase = async (): Promise<ReadonlyMap<TestId, ScopePhaseOutcome>> => fixed ??= await deps.runPhase(deps.trustedFix, cases);
	for (const candidate of draft.candidates) {
		const id = candidate.id as TestId;
		const frozenReply = frozen.get(id);
		const runsClean = frozenReply !== undefined && frozenReply.ok;
		if (runsClean) f1++;
		const discriminates = runsClean && frozenReply !== undefined && !isDeepStrictEqual(frozenReply.value, candidate.expected);
		if (discriminates) f2++;
		const fixedReply = discriminates ? await fixedPhase().then(replies => replies.get(id)) : undefined;
		const passesFix = fixedReply !== undefined && fixedReply.ok && isDeepStrictEqual(fixedReply.value, candidate.expected);
		if (passesFix) f3++;
		const justified = passesFix && supplied.includes(normalizeScopeText(candidate.citation));
		if (justified) f4++;
		if (!justified) continue;
		const key = `${canonical(candidate.target as unknown as JsonValue)}|${canonical(candidate.args as JsonValue)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		survivors.push(candidate);
	}
	return { survivors, counts: { candidates: draft.candidates.length, f1, f2, f3, f4, deduped: survivors.length } };
}

/** One family the coverage gate names, as the fixture's registry entry declares it. */
export type { CurrencyFamily } from "./fixtures.ts";
import type { CurrencyFamily } from "./fixtures.ts";

/** One job's scoping state, as the store holds it: the draft's ids and counts, never a case value.
 * The issue body lives here too — the job stores the issue body, not only its number and title —
 * because filter 4 checks every citation against the body it was justified from. */
export type ScopingStatus = "DRAFTING" | "AWAITING_APPROVAL" | "APPROVED" | "FAILED";

export type JobScopingRow = {
	readonly jobId: JobId;
	readonly status: ScopingStatus;
	readonly issueBody: string | null;
	readonly ids: readonly TestId[];
	/** The digest of the frozen (approved) case set; null until the client approves. */
	readonly digest: Digest | null;
	/** A failure's name, or the coverage gate's missing families. Never a case value. */
	readonly reason: string | null;
	readonly counts: FilterCounts | null;
	readonly updatedAt: Instant;
};

export type CoverageGateResult = { readonly ok: true } | { readonly ok: false; readonly missing: readonly string[] };

function argsCurrencies(candidate: ScopeCandidate): ReadonlySet<string> {
	const found = new Set<string>();
	const walk = (value: JsonValue): void => {
		if (typeof value === "string") { found.add(value); return; }
		if (Array.isArray(value)) { value.forEach(walk); return; }
		if (isRecord(value)) { Object.values(value).forEach(item => walk(item as JsonValue)); }
	};
	candidate.args.forEach(walk);
	return found;
}

/** The per-currency-family coverage gate: after filtering, the survivors must cover every family
 * the fixture's gate defines — a case covers a family when one of its args names one of the
 * family's currencies. A family nobody covers fails the gate BY NAME, and the draft cannot be
 * approved as is. */
export function coverageGate(survivors: readonly ScopeCandidate[], families: readonly CurrencyFamily[]): CoverageGateResult {
	const missing: string[] = [];
	for (const family of families) {
		const covered = survivors.some(candidate => {
			const currencies = argsCurrencies(candidate);
			return family.currencies.some(code => currencies.has(code));
		});
		if (!covered) missing.push(family.name);
	}
	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
