// The judge. It holds every expected value, never imports submitted code, and refuses to report a
// verdict it cannot justify. The subject runs in another process (or another container) and speaks
// { id, target, args } in and { id, ok, value } out. Comparison happens here, in the judge's runtime.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { digest } from "../core/src/effects.ts";
import { instant } from "../core/src/ids.ts";
import type { CommitSha, Digest, Instant, TestId } from "../core/src/ids.ts";
import { decideVerdict, judgeHidden, parseSubjectTranscript, screenDiff, toSubjectCall, VerifierPublishMissing } from "../core/src/verifier.ts";
import type { DiffSummary, FrozenRun, HiddenCase, RejectReason, SubjectCall, Verdict, VerifierRunRequest } from "../core/src/verifier.ts";
import type { PublisherPort } from "../core/src/github.ts";
import type { SubjectLauncher, SubjectRun } from "./subject.ts";

/** The judge's own copy of the six hidden cases. This data never enters a submitted tree. */
export const HIDDEN_CASES: readonly HiddenCase[] = [
	{ id: "hidden:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 1.234 }], "KWD"], expected: "1.234" },
	{ id: "hidden:2" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 2.345 }], "BHD"], expected: "2.345" },
	{ id: "hidden:3" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 7.891 }], "OMR"], expected: "7.891" },
	{ id: "hidden:4" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 4.567 }], "JOD"], expected: "4.567" },
	{ id: "hidden:5" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 10 }, { amount: 0.625 }], "KWD"], expected: "10.625" },
	{ id: "hidden:6" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 10.125 }], "JPY"], expected: "10" },
];

/** Binds the contract recorded at OpenJob to the cases this judge actually holds. */
export function hiddenManifest(cases: readonly HiddenCase[] = HIDDEN_CASES): { readonly cases: readonly HiddenCase[]; readonly digest: Digest } {
	return { cases, digest: digest(cases) as Digest };
}

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
		diff: (frozenAt, sourceCommit) => parseUnifiedDiff(run(["diff", "--no-renames", frozenAt, sourceCommit], "utf8") as string),
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

/** Added lines only: context lines of a diff never reach the screen. */
export function parseUnifiedDiff(text: string): DiffSummary {
	const changed = new Map<string, string[]>();
	let current: string | null = null;
	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) { current = null; continue; }
		if (line.startsWith("+++ ")) {
			const path = line.slice(4).trim();
			current = path === "/dev/null" ? null : path.replace(/^b\//, "");
			if (current && !changed.has(current)) changed.set(current, []);
			continue;
		}
		if (!current || !line.startsWith("+")) continue;
		changed.get(current)!.push(line.slice(1));
	}
	return { changed: [...changed].map(([path, lines]) => ({ path, addedText: lines.join("\n") })) };
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
	let frozenCases: readonly HiddenCase[];
	try {
		frozenCases = invoiceFixtureFrozenCases(deps.source.readFile(done.frozenAt, deps.frozenTestPath ?? "tests/totals.test.ts"));
	} catch (error) {
		return { kind: "RUN_FAILED", reason: `FROZEN_CASES_UNREADABLE: ${message(error)}`, timings: timingsOf(started, {}) };
	}
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

function timingsOf(started: number, parts: Partial<JudgeTimings>): JudgeTimings {
	return { screenMs: 0, subjectMs: 0, compareMs: 0, publishMs: 0, ...parts, wallMs: performance.now() - started };
}

/** The one-line report the CLI and the evidence logs read. */
export function describeVerdict(verdict: Verdict): string {
	return verdict.result === "VERIFIED"
		? `VERIFIED | frozen ${verdict.frozen.passed}/${verdict.frozen.expected}; hidden ${verdict.hidden.passed}/${verdict.hidden.expected}; PR #${verdict.pullRequest}`
		: `REJECTED | ${verdict.reasons.map(reason => reason.kind).join("; ")}`;
}
