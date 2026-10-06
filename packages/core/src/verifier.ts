// The verifier contract the core consumes, and the judge/subject protocol that runs on platform CI.
//
// Measured residual: submitted source that calls expect.extend passed an in-process Vitest run.
// So assertions never run in the process that loads submitted code. The judge holds every expected
// value. The subject runs submitted code in a credential-free container, receives calls without
// expected values, and returns raw results. A replaced matcher can only lie to itself.
//
// The subject cannot answer a case it has not been asked. It loads the submitted modules first, the
// judge sends each case input only after that, and every frame carries the run's nonce, so a
// transcript written before the inputs arrive is a fault instead of a pass.

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
	| { readonly kind: "SUBJECT_FAULT"; readonly detail: string }
	| { readonly kind: "SUBJECT_REPLY_MALFORMED" }
	/** The submitted tree points outside itself. Nothing starts: a link is not a source file. */
	| { readonly kind: "TREE_SYMLINK"; readonly path: string }
	/** The submitted tree holds a gitlink. Nothing starts: a submodule is not a source file either. */
	| { readonly kind: "TREE_GITLINK"; readonly path: string }
	/** The diff is bigger than the screen's bound. Nothing starts: a screen in part is not a screen. */
	| { readonly kind: "DIFF_TOO_LARGE"; readonly paths: number; readonly limit: number }
	/**
	 * The diff changes more non-binary source paths than the screen reads added text for. Nothing
	 * starts: a screen in part is not a screen.
	 */
	| { readonly kind: "SOURCE_PATHS_OVER_READ_BOUND"; readonly paths: number; readonly limit: number };

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
		/** The first reasons, bounded so one rejection always fits the callback. */
		readonly reasons: readonly [RejectReason, ...RejectReason[]];
		/** How many reasons were dropped from the end to fit the callback's bound. */
		readonly reasonsTruncated: number;
		readonly at: Instant;
	};

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Every way a run can end without a verdict. The name is what code branches on and what the job
 * shows; `detail` is display text. A publish that failed after a clean judgment is PUBLISH_FAILED,
 * not a verdict: nothing was published, so nothing can be approved.
 */
export const RUN_FAILURE_NAMES = ["PUBLISH_FAILED", "SOURCE_UNAVAILABLE", "SUBJECT_UNSTARTABLE", "CONTRACT_MISMATCH", "RUN_DEADLINE_EXCEEDED"] as const;
export type RunFailureName = (typeof RUN_FAILURE_NAMES)[number];

export function isRunFailureName(value: unknown): value is RunFailureName {
	return typeof value === "string" && (RUN_FAILURE_NAMES as readonly string[]).includes(value);
}

/**
 * A run that ended without a verdict. Infrastructure, not the worker: applying one returns the slot
 * and charges no attempt. `detail` is bounded display text from the step that failed, never a secret.
 */
export type RunFailure = {
	readonly runId: VerifierRunId;
	readonly sourceCommit: CommitSha;
	readonly name: RunFailureName;
	readonly detail: string;
	readonly at: Instant;
};

/** How one run ended. The service posts exactly one of these as its signed callback. */
export type VerifierReport =
	| { readonly kind: "VERDICT"; readonly verdict: Verdict }
	| { readonly kind: "RUN_FAILED"; readonly failure: RunFailure };

/** The longest detail a report carries. The service truncates; the boundary truncates what it is handed. */
export const FAILURE_DETAIL_CHARS = 300;

/** The token shapes GitHub prints in a refusal body: App, OAuth, fine-grained PAT, the legacy v1 installation token, and an App JWT. Copied server text never carries one onward. */
const TOKEN_SHAPES = /github_pat_[A-Za-z0-9_]+|gh[opsur]_[A-Za-z0-9_]+|\bv1\.[0-9a-fA-F]{40,}\b|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Display text from a run: control characters become spaces, token shapes are redacted, and the text is bounded. */
export function boundedDetail(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(TOKEN_SHAPES, "[redacted]")
		.replace(/(temp_clone_token"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1[redacted]")
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.slice(0, FAILURE_DETAIL_CHARS);
}

/** The most reasons one callback carries. Reasons past this are counted in reasonsTruncated. */
export const VERDICT_REASONS_MAX = 16;
/** One reason's serialized bound inside a callback. A list or path past it is trimmed to fit. */
export const VERDICT_REASON_BYTES_MAX = 1_536;
/** The longest single text field one reason keeps when it is trimmed. */
const REASON_TEXT_CHARS = 200;

/**
 * Bounds a rejection so its callback body always fits: at most VERDICT_REASONS_MAX reasons, each
 * within VERDICT_REASON_BYTES_MAX, with the dropped reasons counted. The judge's own verdicts are
 * built here, so a caller can read reasonsTruncated as "the tail of the list is not shown".
 */
export function boundedVerdict(verdict: Verdict): Verdict {
	if (verdict.result !== "REJECTED") return verdict;
	const reasons = verdict.reasons.slice(0, VERDICT_REASONS_MAX).map(boundedReason) as [RejectReason, ...RejectReason[]];
	return { ...verdict, reasons, reasonsTruncated: verdict.reasons.length - reasons.length };
}

function reasonBytes(reason: RejectReason): number {
	return Buffer.byteLength(JSON.stringify(reason), "utf8");
}

/**
 * Bounds one reason: an id list is halved to fit, then its text fields are trimmed until the
 * serialized reason fits. JSON escaping turns one control character into six bytes, so the bound
 * is measured on the serialized form, never on the character count a field was built from.
 */
function boundedReason(reason: RejectReason): RejectReason {
	if (reasonBytes(reason) <= VERDICT_REASON_BYTES_MAX) return reason;
	let bounded = shrinkReason(reason);
	for (let keep = REASON_TEXT_CHARS; keep > 0 && reasonBytes(bounded) > VERDICT_REASON_BYTES_MAX; keep = Math.floor(keep / 2)) {
		bounded = trimReasonText(bounded, keep);
	}
	return bounded;
}

/** Halves a failed or missing id list until it fits, and puts a fault's detail through the display boundary. */
function shrinkReason(reason: RejectReason): RejectReason {
	switch (reason.kind) {
		case "TESTS_FAILED": return { ...reason, failed: shrinkIds(reason.failed, ids => reasonBytes({ ...reason, failed: ids }) <= VERDICT_REASON_BYTES_MAX) };
		case "TESTS_MISSING": return { ...reason, missing: shrinkIds(reason.missing, ids => reasonBytes({ ...reason, missing: ids }) <= VERDICT_REASON_BYTES_MAX) };
		case "SUBJECT_FAULT": return { ...reason, detail: boundedDetail(reason.detail) };
		default: return reason;
	}
}

/** Trims every text field one reason carries to `chars` characters. */
function trimReasonText(reason: RejectReason, chars: number): RejectReason {
	switch (reason.kind) {
		case "PROTECTED_PATH_MODIFIED": case "TREE_SYMLINK": case "TREE_GITLINK":
			return { ...reason, path: reason.path.slice(0, chars) };
		case "TEST_FRAMEWORK_IN_SOURCE":
			return { ...reason, path: reason.path.slice(0, chars), symbol: reason.symbol.slice(0, chars) };
		case "SUBJECT_FAULT":
			return { ...reason, detail: reason.detail.slice(0, chars) };
		case "TESTS_FAILED":
			return { ...reason, failed: reason.failed.map(id => id.slice(0, chars) as TestId) };
		case "TESTS_MISSING":
			return { ...reason, missing: reason.missing.map(id => id.slice(0, chars) as TestId) };
		default:
			return reason;
	}
}

/** Halves an id list until its reason fits. The first ids are the ones a person acts on. */
function shrinkIds(ids: readonly TestId[], fits: (ids: readonly TestId[]) => boolean): readonly TestId[] {
	let kept = ids;
	while (kept.length > 1 && !fits(kept)) kept = kept.slice(0, Math.floor(kept.length / 2));
	return kept.length === 1 && !fits(kept) ? [kept[0]!.slice(0, REASON_TEXT_CHARS) as TestId] : kept;
}

/** The one line a client prints for a failure: its name, then its detail when it has one. */
export function describeRunFailure(failure: RunFailure): string {
	return failure.detail ? `${failure.name}: ${failure.detail}` : failure.name;
}

export type HiddenCase = {
	readonly id: TestId;
	readonly target: { readonly module: string; readonly export: string };
	readonly args: readonly JsonValue[];
	readonly expected: JsonValue;
};

/** Judge to subject. Has no expected field by construction. */
export type SubjectCall = Omit<HiddenCase, "expected">;

/** Judge to subject over stdin. `load` names the modules; a `call` carries one case's inputs. */
export type SubjectRequest =
	| { readonly kind: "load"; readonly nonce: string; readonly modules: readonly string[] }
	| { readonly kind: "call"; readonly nonce: string; readonly id: TestId;
		readonly target: { readonly module: string; readonly export: string }; readonly args: readonly JsonValue[] };

export type SubjectReply =
	| { readonly id: TestId; readonly ok: true; readonly value: JsonValue }
	| { readonly id: TestId; readonly ok: false; readonly error: string };

/** Subject to judge over stdout. Outputs only: the subject never returns a pass or a fail. */
export type SubjectFrame =
	| { readonly kind: "ready"; readonly nonce: string }
	| { readonly kind: "reply"; readonly nonce: string; readonly id: TestId; readonly ok: true; readonly value: JsonValue }
	| { readonly kind: "reply"; readonly nonce: string; readonly id: TestId; readonly ok: false; readonly error: string };

/** One changed path, in git's own terms. A rename or a copy carries both names. */
export type DiffChange = {
	readonly path: string;
	readonly status: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" | "COPIED" | "TYPE_CHANGED";
	/** The pre-image path of a rename or a copy; null for every other status. */
	readonly from: string | null;
	/** Git reads the content as binary, so no added source line can be screened from it. */
	readonly binary: boolean;
	readonly modeChanged: boolean;
	/** The submitted tree holds a gitlink here: a submodule entry, which materializes as an empty directory. */
	readonly gitlink: boolean;
	readonly addedText: string;
};

export type DiffSummary = { readonly changes: readonly DiffChange[] };

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

/**
 * One frame of the subject's stdout, or null. A frame that does not echo this run's nonce is not a
 * frame of this run, however correct its value looks.
 */
export function asSubjectFrame(line: string, nonce: string): SubjectFrame | null {
	if (!line || Buffer.byteLength(line) > SUBJECT_FRAME_BYTES) return null;
	let value: unknown;
	try { value = JSON.parse(line) as unknown; } catch { return null; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.nonce !== nonce) return null;
	if (record.kind === "ready" && Object.keys(record).sort().join(",") === "kind,nonce") return { kind: "ready", nonce };
	const reply = asSubjectReply(record);
	if (!reply) return null;
	return reply.ok ? { kind: "reply", nonce, id: reply.id, ok: true, value: reply.value }
		: { kind: "reply", nonce, id: reply.id, ok: false, error: reply.error };
}

/**
 * The untrusted transcript. Unknown ids and unparsable lines are dropped and count as missing. A
 * duplicate id invalidates it for the whole run, and a protocol-shaped frame that fails the nonce
 * or the shape is counted as refused, which is a fault rather than a pass.
 */
export function parseSubjectTranscript(stdout: string, nonce: string, calls: readonly SubjectCall[]): SubjectTranscript {
	const allowed = new Set(calls.map(call => call.id));
	const replies = new Map<TestId, SubjectReply>();
	const invalid = new Set<TestId>();
	let ready = false;
	let refused = 0;
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const frame = asSubjectFrame(line, nonce);
		if (!frame) {
			if (looksLikeFrame(line)) refused++;
			continue;
		}
		if (frame.kind === "ready") { ready = true; continue; }
		// No case input is written before `ready`, so a reply that precedes it is not this run's answer.
		if (!ready) { refused++; continue; }
		if (!allowed.has(frame.id)) { refused++; continue; }
		if (replies.has(frame.id) || invalid.has(frame.id)) {
			invalid.add(frame.id);
			replies.delete(frame.id);
			continue;
		}
		replies.set(frame.id, frame.ok ? { id: frame.id, ok: true, value: frame.value } : { id: frame.id, ok: false, error: frame.error });
	}
	return { ready, replies, refused };
}

export type SubjectTranscript = {
	/** The subject loaded the submitted modules before the judge sent a case input. */
	readonly ready: boolean;
	readonly replies: ReadonlyMap<TestId, SubjectReply>;
	/** Frames addressed to this run that did not follow the protocol. One is enough to fault the run. */
	readonly refused: number;
};

/** A line that names this channel but is not a valid frame: a forged transcript, or a wrong-nonce reply. */
function looksLikeFrame(line: string): boolean {
	if (Buffer.byteLength(line) > SUBJECT_FRAME_BYTES) return false;
	let value: unknown;
	try { value = JSON.parse(line) as unknown; } catch { return false; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.kind === "string" || typeof record.id === "string" || typeof record.nonce === "string";
}

function asSubjectReply(record: Record<string, unknown>): SubjectReply | null {
	const keys = Object.keys(record).sort().join(",");
	if (typeof record.id !== "string") return null;
	if (record.ok === true) {
		if (keys !== "id,kind,nonce,ok,value" || !isBoundedJson(record.value)) return null;
		return { id: record.id as TestId, ok: true, value: record.value as JsonValue };
	}
	if (record.ok === false) {
		if (keys !== "error,id,kind,nonce,ok" || typeof record.error !== "string" || record.error.length > SUBJECT_ERROR_CHARS) return null;
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

/**
 * The most changed paths one screen accepts. A tree past this is refused by name rather than
 * screened in part: the bound exists so a submitted tree cannot make the screen read unbounded work.
 */
export const MAX_DIFF_CHANGES = 4096;

/**
 * The most changed non-binary source paths one screen reads added text for. The source adapter reads
 * a patch for at most this many, so a diff past the bound is refused by name rather than screened in
 * part, because a source path without its added lines is a path whose framework import the screen
 * cannot see.
 */
export const MAX_ADDED_TEXT_PATHS = 256;

/**
 * Rejects protected-path edits and any source file that imports vitest, expect, or node:test.
 * A change is judged by its status, so a deletion, a rename, a mode change, and a binary swap all
 * reach this screen even though a unified patch carries no added line for them.
 *
 * What this screen claims, and what it does not:
 * - It reads git's status record for every changed path, and the added lines of a path whose
 *   extension is in `isSourcePath`. A protected path is refused by name under every status:
 *   add, modify, delete, rename (both the old and the new name), mode change, and type change.
 * - It refuses a literal mention of a test framework in an added line of a source file.
 * - It does not read non-source files. A JSON, YAML, lockfile, or config change is screened for its
 *   path only: `vitest.config.ts` trips the screen because a protected glob names it, never because
 *   of what it says. It does not resolve module graphs, so a re-exported or aliased framework import
 *   is invisible to it, and it does not see a string built at runtime (`import("vit" + "est")`).
 * - It never reads a file git reports as binary, and it never runs the submitted tests.
 * - A diff past MAX_DIFF_CHANGES is refused by name, so a padded diff cannot hide a change behind
 *   the bound. A diff that changes more than MAX_ADDED_TEXT_PATHS non-binary source paths is refused
 *   by name too, because the source adapter reads added text for only that many. Below both bounds
 *   every changed path is screened, and every changed non-binary source path is screened on its added
 *   lines.
 * - The screen is a fast refusal for the obvious cheats. The frozen-suite extraction and the six
 *   hidden cases are the authority on behavior, and they hold the expected values.
 */
export function screenDiff(diff: DiffSummary, done: DefinitionOfDone): readonly RejectReason[] {
	if (diff.changes.length > MAX_DIFF_CHANGES) return [{ kind: "DIFF_TOO_LARGE", paths: diff.changes.length, limit: MAX_DIFF_CHANGES }];
	const sourcePaths = diff.changes.filter(change => !change.binary && isSourcePath(change.path)).length;
	if (sourcePaths > MAX_ADDED_TEXT_PATHS) return [{ kind: "SOURCE_PATHS_OVER_READ_BOUND", paths: sourcePaths, limit: MAX_ADDED_TEXT_PATHS }];
	const reasons: RejectReason[] = [];
	for (const change of diff.changes) {
		// A rename touches two names: the frozen path it left and the path it occupies now.
		const touched = change.from === null ? [change.path] : [change.from, change.path];
		const hit = touched.find(path => done.protectedPaths.some(glob => matchesGlob(glob, path)));
		if (hit) reasons.push({ kind: "PROTECTED_PATH_MODIFIED", path: hit });
		// A gitlink materializes as an empty directory, so the symlink walk never names it. The mode
		// in git's own status record does.
		if (change.gitlink) reasons.push({ kind: "TREE_GITLINK", path: change.path });
		if (change.binary || !isSourcePath(change.path)) continue;
		const symbol = testFrameworkSymbol(change.addedText);
		if (symbol) reasons.push({ kind: "TEST_FRAMEWORK_IN_SOURCE", path: change.path, symbol });
	}
	return reasons;
}

/** The extensions the lexical screen reads. Everything else is screened for protected paths only. */
export const isSourcePath = (path: string): boolean => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);

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
	// A screen hit decides the run on its own: the subject never starts, so a missing test is not a finding.
	if (reasons.length) return { result: "REJECTED", runId: request.runId, sourceCommit: request.sourceCommit,
		reasons: reasons as [RejectReason, ...RejectReason[]], reasonsTruncated: 0, at };
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
			reasons: reasons as [RejectReason, ...RejectReason[]], reasonsTruncated: 0, at };
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
		case "SUBJECT_FAULT":
			return `Subject run fault: ${reason.detail}`;
		case "SUBJECT_REPLY_MALFORMED":
			return "The subject reply was malformed";
		case "TREE_SYMLINK":
			return `PR makes ${reason.path} a symlink, which points outside the submitted tree`;
		case "TREE_GITLINK":
			return `PR makes ${reason.path} a submodule gitlink, which the subject cannot import`;
		case "DIFF_TOO_LARGE":
			return `The submitted tree changes ${reason.paths} paths, over the ${reason.limit}-path screen limit`;
		case "SOURCE_PATHS_OVER_READ_BOUND":
			return `The submitted tree changes ${reason.paths} source paths, over the ${reason.limit}-source-path read bound`;
	}
}

export interface VerifierPort {
	/** Starting the same runId twice reuses the first run. CI retries its own infrastructure within the run budget. */
	start(request: VerifierRunRequest): Promise<void>;
	/** Authenticates the judge's signed report. Submitted-program output is never a trusted input here. */
	parseCallback(request: Request): Promise<{ readonly jobId: JobId; readonly ordinal: 1 | 2 | 3; readonly report: VerifierReport } | null>;
}

export class VerifierCiNotConfigured extends Error {
	readonly code = "VERIFIER_CI_NOT_CONFIGURED";
	constructor(detail = "No verifier CI URL is configured.") { super(detail); }
}

/** The default when a deployment injects no port. Every call refuses immediately, so nothing ever waits on a CI that is not there. */
export function unconfiguredVerifier(detail?: string): VerifierPort {
	return {
		async start() { throw new VerifierCiNotConfigured(detail); },
		async parseCallback() { return null; },
	};
}
