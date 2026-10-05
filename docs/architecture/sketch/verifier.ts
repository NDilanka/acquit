// The verifier contract the core consumes, and the judge/subject protocol that runs on platform CI.
//
// Measured residual: submitted source that calls expect.extend passed an in-process Vitest run.
// So assertions never run in the process that loads submitted code. The judge holds every expected
// value. The subject runs submitted code in a credential-free container, receives calls without
// expected values, and returns raw results. A replaced matcher can only lie to itself.

import type { Branded, CommitSha, Digest, Instant, JobId, TestId } from "./ids";

export type VerifierRunId = Branded<string, "VerifierRunId">;
export type Glob = Branded<string, "Glob">;

/** A run that has not reported by submittedAt + this is treated as timed out. Bounds deadline deferral. */
export const VERIFIER_RUN_MINUTES = 30;

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

export function toSubjectCall(hidden: HiddenCase): SubjectCall {
	throw new Error("not implemented");
}

/** Untrusted bytes. Unknown ids, duplicates, and unparsable lines are dropped, so they count as missing. */
export function parseSubjectReplies(stdout: string, calls: readonly SubjectCall[]): ReadonlyMap<TestId, SubjectReply> {
	throw new Error("not implemented");
}

/** Deep structural equality in the judge's own runtime. */
export function judgeHidden(
	cases: readonly HiddenCase[],
	replies: ReadonlyMap<TestId, SubjectReply>,
): { readonly tally: TestTally; readonly failed: readonly TestId[]; readonly missing: readonly TestId[] } {
	throw new Error("not implemented");
}

/** Rejects protected-path edits and any source file that imports vitest, expect, or node:test. */
export function screenDiff(diff: DiffSummary, done: DefinitionOfDone): readonly RejectReason[] {
	throw new Error("not implemented");
}

/** Fail closed. VERIFIED needs a clean screen, all 48 frozen ids passed, and all 6 hidden ids passed in the judge. */
export function decideVerdict(
	request: VerifierRunRequest,
	screen: readonly RejectReason[],
	frozen: FrozenRun,
	hidden: ReturnType<typeof judgeHidden>,
	built: { readonly mergeCommit: CommitSha; readonly pullRequest: number } | null,
	at: Instant,
): Verdict {
	throw new Error("not implemented");
}

export interface VerifierPort {
	/** Starting the same runId twice reuses the first run. CI retries its own infrastructure within the run budget. */
	start(request: VerifierRunRequest): Promise<void>;
	/** Authenticates the judge's signed report. Submitted-program output is never a trusted input here. */
	parseCallback(request: Request): Promise<{ readonly jobId: JobId; readonly ordinal: 1 | 2 | 3; readonly verdict: Verdict } | null>;
}
