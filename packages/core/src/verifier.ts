// The verifier contract the core consumes, and the judge/subject protocol that runs on platform CI.
//
// Measured residual: submitted source that calls expect.extend passed an in-process Vitest run.
// So assertions never run in the process that loads submitted code. The judge holds every expected
// value. The subject runs submitted code in a credential-free container, receives calls without
// expected values, and returns raw results. A replaced matcher can only lie to itself.

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Branded, CommitSha, Digest, Instant, JobId, TestId } from "./ids.ts";

export type VerifierRunId = Branded<string, "VerifierRunId">;
export type Glob = Branded<string, "Glob">;

/** A run that has not reported by submittedAt + this is treated as timed out. Bounds deadline deferral. */
export const VERIFIER_RUN_MINUTES = 30;

/** A frame the subject sends back may be at most this many bytes. */
export const SUBJECT_FRAME_BYTES = 8_192;
/** How much of the subject's stdout the judge reads before refusing the run. */
export const SUBJECT_STDOUT_BYTES = 262_144;
/** How deep a successful reply value may nest. */
export const SUBJECT_VALUE_DEPTH = 32;
/** The longest error string a reply may carry. */
export const SUBJECT_ERROR_CHARS = 1_024;

/** Frozen at OpenJob. The hidden cases themselves never leave the judge. */
export type DefinitionOfDone = {
	readonly issue: { readonly repository: string; readonly number: number; readonly title: string };
	readonly frozenAt: CommitSha;
	readonly frozenTests: readonly TestId[];
	readonly hiddenManifest: Digest;
	readonly hiddenTests: readonly TestId[];
	readonly protectedPaths: readonly Glob[];
};

export type VerifierRunRequest = {
	readonly runId: VerifierRunId;
	readonly jobId: JobId;
	readonly ordinal: 1 | 2 | 3;
	readonly sourceCommit: CommitSha;
	readonly definitionOfDone: DefinitionOfDone;
};

/** completed must equal expected. A skip or a missing id is a rejection, never a partial pass. */
export type TestTally = { readonly expected: number; readonly passed: number };

export type RejectReason =
	| { readonly kind: "PROTECTED_PATH_MODIFIED"; readonly path: string }
	| { readonly kind: "TEST_FRAMEWORK_IN_SOURCE"; readonly path: string; readonly symbol: string }
	| { readonly kind: "TESTS_FAILED"; readonly suite: "frozen" | "hidden"; readonly failed: readonly TestId[] }
	| { readonly kind: "TESTS_MISSING"; readonly suite: "frozen" | "hidden"; readonly missing: readonly TestId[] }
	| { readonly kind: "SUBJECT_REPLY_MALFORMED" };

/** The only verifier type job.ts sees. */
export type Verdict =
	| {
		readonly result: "VERIFIED";
		readonly runId: VerifierRunId;
		readonly sourceCommit: CommitSha;
		/** Approval, merge, and the receipt bind to this tree, never to a moving PR head. */
		readonly mergeCommit: CommitSha;
		readonly pullRequest: number;
		readonly frozen: TestTally;
		readonly hidden: TestTally;
		readonly reportDigest: Digest;
		readonly at: Instant;
	}
	| {
		readonly result: "REJECTED";
		readonly runId: VerifierRunId;
		readonly sourceCommit: CommitSha;
		readonly reasons: readonly [RejectReason, ...RejectReason[]];
		readonly at: Instant;
	};

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type HiddenCase = {
	readonly id: TestId;
	readonly target: { readonly module: string; readonly export: string };
	readonly args: readonly JsonValue[];
	readonly expected: JsonValue;
};

/** Judge to subject. Has no expected field by construction. */
export type SubjectCall = Omit<HiddenCase, "expected">;

export type SubjectReply =
	| { readonly id: TestId; readonly ok: true; readonly value: JsonValue }
	| { readonly id: TestId; readonly ok: false; readonly error: string };

export type DiffSummary = { readonly changed: readonly { readonly path: string; readonly addedText: string }[] };

export type FrozenRun = { readonly results: ReadonlyMap<TestId, "passed" | "failed" | "skipped"> };

/** Thrown when a passing run has no published artifact to bind its verdict to. No verdict is manufactured. */
export class VerifierPublishMissing extends Error {
	readonly code = "VERIFIER_PUBLISH_MISSING";
	constructor() {
		super("Tests passed but no pull request was opened, so no verdict exists.");
	}
}

export function toSubjectCall(hidden: HiddenCase): SubjectCall {
	return { id: hidden.id, target: hidden.target, args: hidden.args };
}

/** Untrusted bytes. Unknown ids, duplicates, and unparsable lines are dropped, so they count as missing. */
export function parseSubjectReplies(stdout: string, calls: readonly SubjectCall[]): ReadonlyMap<TestId, SubjectReply> {
	const allowed = new Set(calls.map(call => call.id));
	const accepted = new Map<TestId, SubjectReply>();
	const invalid = new Set<TestId>();
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		if (Buffer.byteLength(line) > SUBJECT_FRAME_BYTES) continue;
		let frame: unknown;
		try { frame = JSON.parse(line) as unknown; } catch { continue; }
		const reply = asSubjectReply(frame);
		if (!reply || !allowed.has(reply.id)) continue;
		// A duplicate permanently invalidates the id. Keeping the first reply would pass a forged transcript.
		if (accepted.has(reply.id) || invalid.has(reply.id)) {
			invalid.add(reply.id);
			accepted.delete(reply.id);
			continue;
		}
		accepted.set(reply.id, reply);
	}
	return accepted;
}

function asSubjectReply(frame: unknown): SubjectReply | null {
	if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
	const record = frame as Record<string, unknown>;
	const keys = Object.keys(record).sort().join(",");
	if (typeof record.id !== "string") return null;
	if (record.ok === true) {
		if (keys !== "id,ok,value" || !isBoundedJson(record.value)) return null;
		return { id: record.id as TestId, ok: true, value: record.value as JsonValue };
	}
	if (record.ok === false) {
		if (keys !== "error,id,ok" || typeof record.error !== "string" || record.error.length > SUBJECT_ERROR_CHARS) return null;
		return { id: record.id as TestId, ok: false, error: record.error };
	}
	return null;
}

function isBoundedJson(value: unknown, depth = 0): boolean {
	if (depth > SUBJECT_VALUE_DEPTH) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(item => isBoundedJson(item, depth + 1));
	if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(item => isBoundedJson(item, depth + 1));
	return false;
}

/** Deep structural equality in the judge's own runtime. */
export function judgeHidden(
	cases: readonly HiddenCase[],
	replies: ReadonlyMap<TestId, SubjectReply>,
): { readonly tally: TestTally; readonly failed: readonly TestId[]; readonly missing: readonly TestId[] } {
	const failed: TestId[] = [];
	const missing: TestId[] = [];
	for (const test of cases) {
		const reply = replies.get(test.id);
		if (!reply) { missing.push(test.id); continue; }
		if (!reply.ok || !isDeepStrictEqual(reply.value, test.expected)) failed.push(test.id);
	}
	return { tally: { expected: cases.length, passed: cases.length - failed.length - missing.length }, failed, missing };
}

/** Rejects protected-path edits and any source file that imports vitest, expect, or node:test. */
export function screenDiff(diff: DiffSummary, done: DefinitionOfDone): readonly RejectReason[] {
	const reasons: RejectReason[] = [];
	for (const change of diff.changed) {
		if (done.protectedPaths.some(glob => matchesGlob(glob, change.path))) reasons.push({ kind: "PROTECTED_PATH_MODIFIED", path: change.path });
		if (!isSourcePath(change.path)) continue;
		const symbol = testFrameworkSymbol(change.addedText);
		if (symbol) reasons.push({ kind: "TEST_FRAMEWORK_IN_SOURCE", path: change.path, symbol });
	}
	return reasons;
}

const isSourcePath = (path: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);

/** A lexical screen, not a parser. It reads added lines, so context lines of a diff never trip it. */
function testFrameworkSymbol(addedText: string): string | null {
	const module = addedText.match(/['"]((?:vitest|expect|node:test)(?:\/[^'"]*)?)['"]/);
	if (module) return module[1].split("/")[0];
	if (/\bimport[\s\S]*?\bexpect\b[\s\S]*?\bfrom\b/.test(addedText)) return "expect";
	return null;
}

/** `**` crosses path separators, `*` matches inside one segment. One directory prefix and one trailing `/**` cover the contract. */
export function matchesGlob(glob: string, path: string): boolean {
	const pattern = glob.split("/");
	const segments = path.split("/");
	const walk = (pi: number, si: number): boolean => {
		if (pi === pattern.length) return si === segments.length;
		if (pattern[pi] === "**") return walk(pi + 1, si) || (si < segments.length && walk(pi, si + 1));
		if (si >= segments.length) return false;
		return starMatch(pattern[pi], segments[si]) && walk(pi + 1, si + 1);
	};
	return walk(0, 0);
}

function starMatch(pattern: string, segment: string): boolean {
	const pieces = pattern.split("*");
	if (pieces.length === 1) return pattern === segment;
	const last = pieces[pieces.length - 1];
	if (!segment.startsWith(pieces[0]) || !segment.endsWith(last)) return false;
	let index = pieces[0].length;
	for (const piece of pieces.slice(1, -1)) {
		const found = segment.indexOf(piece, index);
		if (found < 0) return false;
		index = found + piece.length;
	}
	return true;
}

/** Fail closed. VERIFIED needs a clean screen, all frozen ids passed, all hidden ids passed, and a published PR. */
export function decideVerdict(
	request: VerifierRunRequest,
	screen: readonly RejectReason[],
	frozen: FrozenRun,
	hidden: ReturnType<typeof judgeHidden>,
	built: { readonly mergeCommit: CommitSha; readonly pullRequest: number } | null,
	at: Instant,
): Verdict {
	const reasons: RejectReason[] = [...screen];
	const frozenMissing: TestId[] = [];
	const frozenFailed: TestId[] = [];
	for (const id of request.definitionOfDone.frozenTests) {
		const result = frozen.results.get(id);
		if (result === undefined || result === "skipped") frozenMissing.push(id);
		else if (result === "failed") frozenFailed.push(id);
	}
	if (frozenFailed.length) reasons.push({ kind: "TESTS_FAILED", suite: "frozen", failed: frozenFailed });
	if (frozenMissing.length) reasons.push({ kind: "TESTS_MISSING", suite: "frozen", missing: frozenMissing });
	if (hidden.failed.length) reasons.push({ kind: "TESTS_FAILED", suite: "hidden", failed: hidden.failed });
	if (hidden.missing.length) reasons.push({ kind: "TESTS_MISSING", suite: "hidden", missing: hidden.missing });
	if (reasons.length) {
		return { result: "REJECTED", runId: request.runId, sourceCommit: request.sourceCommit,
			reasons: reasons as [RejectReason, ...RejectReason[]], at };
	}
	if (!built) throw new VerifierPublishMissing();
	const frozenTally: TestTally = { expected: request.definitionOfDone.frozenTests.length, passed: request.definitionOfDone.frozenTests.length };
	return { result: "VERIFIED", runId: request.runId, sourceCommit: request.sourceCommit,
		mergeCommit: built.mergeCommit, pullRequest: built.pullRequest, frozen: frozenTally, hidden: hidden.tally,
		reportDigest: digestOf({ runId: request.runId, sourceCommit: request.sourceCommit, frozen: frozenTally, hidden: hidden.tally, mergeCommit: built.mergeCommit }),
		at };
}

function digestOf(value: unknown): Digest {
	const canonical = (input: unknown): string => Array.isArray(input) ? `[${input.map(canonical).join(",")}]`
		: input && typeof input === "object" ? `{${Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
		: JSON.stringify(input);
	return createHash("sha256").update(canonical(value)).digest("hex") as Digest;
}

/** One wording per reason, shared by the API projection and the operator CLI. */
export function describeRejectReason(reason: RejectReason): string {
	switch (reason.kind) {
		case "PROTECTED_PATH_MODIFIED":
			return matchesGlob("tests/**" as Glob, reason.path) ? `PR modifies frozen test file ${reason.path}` : `PR modifies protected path ${reason.path}`;
		case "TEST_FRAMEWORK_IN_SOURCE":
			return `Submitted source ${reason.path} imports ${reason.symbol}`;
		case "TESTS_FAILED":
			return reason.suite === "frozen" ? `Frozen tests failed: ${reason.failed.join(", ")}` : `Hidden tests failed: ${reason.failed.join(", ")}`;
		case "TESTS_MISSING":
			return reason.suite === "frozen" ? `Frozen tests did not complete: ${reason.missing.join(", ")}` : `Hidden tests did not complete: ${reason.missing.join(", ")}`;
		case "SUBJECT_REPLY_MALFORMED":
			return "The subject reply was malformed";
	}
}

export interface VerifierPort {
	/** Starting the same runId twice reuses the first run. CI retries its own infrastructure within the run budget. */
	start(request: VerifierRunRequest): Promise<void>;
	/** Authenticates the judge's signed report. Submitted-program output is never a trusted input here. */
	parseCallback(request: Request): Promise<{ readonly jobId: JobId; readonly ordinal: 1 | 2 | 3; readonly verdict: Verdict } | null>;
}
