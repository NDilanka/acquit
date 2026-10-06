// The judge. It holds every expected value, never imports submitted code, and refuses to report a
// verdict it cannot justify. The subject runs in another process (or another container) and speaks
// { id, target, args } in and { id, ok, value } out. Comparison happens here, in the judge's runtime.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { instant } from "../core/src/ids.ts";
import type { CommitSha, Instant, TestId } from "../core/src/ids.ts";
import { FROZEN_TEST_PATH, HIDDEN_CASES, hiddenManifest } from "../core/src/seed-data.ts";
import { decideVerdict, isSourcePath, judgeHidden, parseSubjectTranscript, screenDiff, toSubjectCall, VerifierPublishMissing } from "../core/src/verifier.ts";
import type { DiffChange, DiffSummary, FrozenRun, HiddenCase, RejectReason, SubjectCall, Verdict, VerifierRunRequest } from "../core/src/verifier.ts";
import type { PublisherPort } from "../core/src/github.ts";
import type { SubjectLauncher, SubjectRun } from "./subject.ts";

// The judge holds the same declaration OpenJob stores: one source for the frozen commit, the frozen
// case ids, and the hidden manifest. Re-exported for the harnesses and the perf probe.
export { HIDDEN_CASES, hiddenManifest };

/**
 * The frozen suite becomes judge data too, so a submitted test runner or config cannot change it.
 * The extraction is literal on purpose: this is the invoice fixture's one exported target, and the
 * count guard refuses a tree whose frozen suite no longer matches the contract.
 */
export function invoiceFixtureFrozenCases(source: string): readonly HiddenCase[] {
	const matches = [...source.matchAll(/it\('([^']+)', \(\) => \{\s*expect\(formatTotal\((\[[^\n]+?\]), '([^']+)'\)\)\.toBe\('([^']+)'\);/g)];
	if (matches.length !== 48) throw new Error(`Frozen case extraction collected ${matches.length}, not 48.`);
	return matches.map((match, index) => ({ id: `frozen:${index + 1}` as TestId,
		target: { module: "src/money.ts", export: "formatTotal" },
		args: [JSON.parse(match[2].replaceAll("amount:", '"amount":')), match[3]], expected: match[4] }));
}

/** Read-only access to the two commits a run compares: the frozen tree and the submitted one. */
export interface JudgeSource {
	diff(frozenAt: CommitSha, sourceCommit: CommitSha): DiffSummary;
	readFile(commit: CommitSha, path: string): string;
	materialize(commit: CommitSha): { readonly path: string; readonly remove: () => void };
}

export function gitSource(repoDir: string): JudgeSource {
	const run = (args: readonly string[], encoding: "utf8" | "buffer"): string | Buffer => {
		const result = spawnSync("git", ["-C", repoDir, ...args], { encoding, maxBuffer: 64 * 1024 * 1024 });
		if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).slice(0, 300)}`);
		return result.stdout as string | Buffer;
	};
	return {
		// The screen is built from git's status and numstat records, never from the patch's +++ lines:
		// a deletion, a rename, a mode change, and a binary swap have no added line to key off.
		diff(frozenAt, sourceCommit) {
			const changes = parseRawDiff(run(["diff", "--raw", "-z", "--find-renames", frozenAt, sourceCommit], "utf8") as string);
			const binary = parseNumstatBinary(run(["diff", "--numstat", "-z", "--find-renames", frozenAt, sourceCommit], "utf8") as string);
			return { changes: changes.slice(0, MAX_DIFF_PATHS).map(change => ({ ...change, binary: binary.has(change.path),
				addedText: binary.has(change.path) || !isSourcePath(change.path) ? "" : addedLines(frozenAt, sourceCommit, change.path) })) };
			function addedLines(frozen: CommitSha, submitted: CommitSha, path: string): string {
				const patch = run(["diff", "--no-color", "--unified=0", frozen, submitted, "--", path], "utf8") as string;
				return patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1)).join("\n");
			}
		},
		readFile: (commit, path) => run(["show", `${commit}:${path}`], "utf8") as string,
		materialize(commit) {
			const path = join(tmpdir(), `acquit-tree-${commit.slice(0, 12)}-${process.pid}-${Date.now()}`);
			mkdirSync(path, { recursive: true });
			const extract = spawnSync("tar", ["-xf", "-", "-C", path], { input: run(["archive", "--format=tar", commit], "buffer") as Buffer });
			if (extract.status !== 0) throw new Error(`tar failed: ${String(extract.stderr).slice(0, 300)}`);
			return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
		},
	};
}

/** A diff with more paths than this refuses to read added text; the status screen still covers every path. */
const MAX_DIFF_PATHS = 256;

/** `git diff --raw -z`: one header per change, then its path, or the old and the new path of a rename. */
function parseRawDiff(text: string): readonly Omit<DiffChange, "binary" | "addedText">[] {
	const tokens = text.split("\0");
	const changes: { path: string; status: DiffChange["status"]; from: string | null; modeChanged: boolean }[] = [];
	for (let index = 0; index < tokens.length;) {
		const header = tokens[index++];
		if (!header.startsWith(":")) continue;
		const fields = header.slice(1).split(" ");
		const [oldMode, newMode, , , status] = fields;
		const first = tokens[index++];
		const renamed = status.startsWith("R") || status.startsWith("C");
		const path = renamed ? tokens[index++] : first;
		if (path === undefined) break;
		changes.push({ path, status: statusOf(status), from: renamed ? first : null, modeChanged: oldMode !== newMode });
	}
	return changes;
}

function statusOf(status: string): DiffChange["status"] {
	switch (status[0]) {
		case "A": return "ADDED";
		case "C": return "COPIED";
		case "D": return "DELETED";
		case "R": return "RENAMED";
		case "T": return "TYPE_CHANGED";
		default: return "MODIFIED";
	}
}

/** `git diff --numstat -z`: `-\t-\tpath` is binary; a rename writes an empty path, then both names. */
function parseNumstatBinary(text: string): ReadonlySet<string> {
	const tokens = text.split("\0");
	const binary = new Set<string>();
	for (let index = 0; index < tokens.length;) {
		const record = tokens[index++];
		if (!record) continue;
		const [added, , ...rest] = record.split("\t");
		const path = rest.join("\t");
		if (path) { if (added === "-") binary.add(path); continue; }
		const to = tokens[index + 1];
		index += 2;
		if (to !== undefined && added === "-") binary.add(to);
	}
	return binary;
}

export type JudgeTimings = { readonly screenMs: number; readonly subjectMs: number; readonly compareMs: number; readonly publishMs: number; readonly wallMs: number };

export type JudgeOutcome =
	| { readonly kind: "VERDICT"; readonly verdict: Verdict; readonly subject: SubjectRun | null; readonly timings: JudgeTimings }
	| { readonly kind: "RUN_FAILED"; readonly reason: string; readonly timings: JudgeTimings };

export type JudgeDeps = {
	readonly source: JudgeSource;
	readonly subject: SubjectLauncher;
	readonly publisher: PublisherPort;
	readonly frozenTestPath?: string;
	readonly cases?: readonly HiddenCase[];
	readonly clock?: { now(): Instant };
	readonly deadlineMs?: number;
};

/** Runs one attempt. A clean screen and clean tallies publish a pull request; nothing else does. */
export async function runJudge(request: VerifierRunRequest, deps: JudgeDeps): Promise<JudgeOutcome> {
	const started = performance.now();
	const clock = deps.clock ?? { now: () => instant(new Date().toISOString()) };
	const manifest = hiddenManifest(deps.cases ?? HIDDEN_CASES);
	const done = request.definitionOfDone;
	if (done.hiddenManifest !== manifest.digest) return { kind: "RUN_FAILED", reason: "HIDDEN_MANIFEST_MISMATCH", timings: timingsOf(started, {}) };
	if (!sameIds(manifest.cases.map(test => test.id), done.hiddenTests)) return { kind: "RUN_FAILED", reason: "HIDDEN_CASES_MISMATCH", timings: timingsOf(started, {}) };
	let frozenCases: readonly HiddenCase[];
	try {
		frozenCases = invoiceFixtureFrozenCases(deps.source.readFile(done.frozenAt, deps.frozenTestPath ?? FROZEN_TEST_PATH));
	} catch (error) {
		return { kind: "RUN_FAILED", reason: `FROZEN_CASES_UNREADABLE: ${message(error)}`, timings: timingsOf(started, {}) };
	}
	if (!sameIds(frozenCases.map(test => test.id), done.frozenTests)) return { kind: "RUN_FAILED", reason: "FROZEN_CASES_MISMATCH", timings: timingsOf(started, {}) };
	const screenStart = performance.now();
	const screen = screenDiff(deps.source.diff(done.frozenAt, request.sourceCommit), done);
	const screenMs = performance.now() - screenStart;
	if (screen.length) {
		// Nothing starts when the diff already breaks the contract. The screen alone decides.
		return { kind: "VERDICT", verdict: decideVerdict(request, screen, { results: new Map() }, judgeHidden(manifest.cases, new Map()), null, clock.now()),
			subject: null, timings: timingsOf(started, { screenMs }) };
	}
	const calls: readonly SubjectCall[] = [...frozenCases, ...manifest.cases].map(toSubjectCall);
	let tree: { readonly path: string; readonly remove: () => void };
	let subjectRun: SubjectRun;
	try {
		tree = deps.source.materialize(request.sourceCommit);
		subjectRun = await deps.subject.run(tree.path, calls, deps.deadlineMs);
	} catch (error) {
		return { kind: "RUN_FAILED", reason: `SUBJECT_UNSTARTABLE: ${message(error)}`, timings: timingsOf(started, { screenMs }) };
	}
	const compareStart = performance.now();
	const transcript = parseSubjectTranscript(subjectRun.stdout, subjectRun.nonce, calls);
	const replies = transcript.replies;
	const frozenJudged = judgeHidden(frozenCases, replies);
	const hiddenJudged = judgeHidden(manifest.cases, replies);
	const results = new Map<TestId, "passed" | "failed">();
	for (const test of frozenCases) if (!frozenJudged.missing.includes(test.id)) results.set(test.id, frozenJudged.failed.includes(test.id) ? "failed" : "passed");
	const frozen: FrozenRun = { results };
	// A frame that claimed this run's channel without following the protocol is a fault, never a missing test.
	const faults: RejectReason[] = [
		...(transcript.refused ? [{ kind: "SUBJECT_FAULT", detail: "SUBJECT_FRAME_REJECTED" } as const] : []),
		...subjectRun.faults.map(fault => ({ kind: "SUBJECT_FAULT", detail: fault } as const)),
	];
	const compareMs = performance.now() - compareStart;
	tree.remove();
	if (faults.length) {
		return { kind: "VERDICT", verdict: decideVerdict(request, faults, frozen, hiddenJudged, null, clock.now()),
			subject: subjectRun, timings: timingsOf(started, { screenMs, subjectMs: subjectRun.wallMs, compareMs }) };
	}
	const publishStart = performance.now();
	let built: { mergeCommit: CommitSha; pullRequest: number };
	try {
		const published = await deps.publisher.publishVerified({ jobId: request.jobId, repository: done.issue.repository,
			sourceCommit: request.sourceCommit, checkName: "Acquit verifier" }, request.runId);
		built = { mergeCommit: published.mergeCommit, pullRequest: published.pullRequest };
	} catch (error) {
		return { kind: "RUN_FAILED", reason: `PUBLISH_FAILED: ${message(error)}`,
			timings: timingsOf(started, { screenMs, subjectMs: subjectRun.wallMs, compareMs, publishMs: performance.now() - publishStart }) };
	}
	const publishMs = performance.now() - publishStart;
	try {
		const verdict = decideVerdict(request, [], frozen, hiddenJudged, built, clock.now());
		return { kind: "VERDICT", verdict, subject: subjectRun, timings: timingsOf(started, { screenMs, subjectMs: subjectRun.wallMs, compareMs, publishMs }) };
	} catch (error) {
		if (error instanceof VerifierPublishMissing) return { kind: "RUN_FAILED", reason: error.code,
			timings: timingsOf(started, { screenMs, subjectMs: subjectRun.wallMs, compareMs, publishMs }) };
		throw error;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A contract names the same ids in the same order as the judge's own declaration. */
function sameIds(left: readonly TestId[], right: readonly TestId[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

function timingsOf(started: number, parts: Partial<JudgeTimings>): JudgeTimings {
	return { screenMs: 0, subjectMs: 0, compareMs: 0, publishMs: 0, ...parts, wallMs: performance.now() - started };
}

/** The one-line report the CLI and the evidence logs read. */
export function describeVerdict(verdict: Verdict): string {
	return verdict.result === "VERIFIED"
		? `VERIFIED | frozen ${verdict.frozen.passed}/${verdict.frozen.expected}; hidden ${verdict.hidden.passed}/${verdict.hidden.expected}; PR #${verdict.pullRequest}`
		: `REJECTED | ${verdict.reasons.map(reason => reason.kind).join("; ")}`;
}
