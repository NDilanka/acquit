// The judge. It holds every expected value, never imports submitted code, and refuses to report a
// verdict it cannot justify. The subject runs in another process (or another container) and speaks
// { id, target, args } in and { id, ok, value } out. Comparison happens here, in the judge's runtime.

import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { instant } from "../core/src/ids.ts";
import type { CommitSha, Instant, TestId } from "../core/src/ids.ts";
import { FROZEN_TEST_PATH } from "../core/src/seed-data.ts";
import { decideVerdict, isSourcePath, judgeHidden, MAX_ADDED_TEXT_PATHS, MAX_DIFF_CHANGES, parseSubjectTranscript, rejectReasons, screenDiff, toSubjectCall, VerifierPublishMissing } from "../core/src/verifier.ts";
import type { DiffChange, DiffSummary, FrozenRun, HiddenCase, RejectReason, RunFailureName, SubjectCall, Verdict, VerifierRunRequest } from "../core/src/verifier.ts";
import type { PublisherPort } from "../core/src/github.ts";
import { hiddenManifest } from "./hidden.ts";
import type { SubjectLauncher, SubjectRun } from "./subject.ts";

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
	/**
	 * Extracts a commit into a fresh tree, opened to the subject's uid. A tree that holds a link is
	 * returned un-opened, with the first link named, so the judge refuses the run before anything
	 * runs and no chmod can land outside the tree. The bootstrap repeats the link check per import.
	 */
	materialize(commit: CommitSha): { readonly path: string; readonly link: string | null; readonly remove: () => void };
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
			// Every changed path reaches the screen. The patch reads stop at MAX_ADDED_TEXT_PATHS
			// source paths, and the screen refuses a diff past that bound by name, so no accepted diff
			// holds a non-binary source path whose added lines went unread.
			let reads = 0;
			return { changes: changes.map(change => {
				const isBinary = binary.has(change.path);
				const read = changes.length <= MAX_DIFF_CHANGES && !isBinary && isSourcePath(change.path) && reads < MAX_ADDED_TEXT_PATHS;
				if (read) reads++;
				return { ...change, binary: isBinary, addedText: read ? addedLines(frozenAt, sourceCommit, change.path) : "" };
			}) };
			function addedLines(frozen: CommitSha, submitted: CommitSha, path: string): string {
				const patch = run(["diff", "--no-color", "--unified=0", frozen, submitted, "--", path], "utf8") as string;
				return patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1)).join("\n");
			}
		},
		readFile: (commit, path) => run(["show", `${commit}:${path}`], "utf8") as string,
		materialize(commit) {
			const path = join(tmpdir(), `acquit-tree-${commit.slice(0, 12)}-${process.pid}-${Date.now()}`);
			try {
				mkdirSync(path, { recursive: true });
				const archive = run(["archive", "--format=tar", commit], "buffer") as Buffer;
				const extract = spawnSync("tar", ["-xf", "-", "-C", path], { input: archive });
				if (extract.status !== 0) throw new Error(`tar failed: ${String(extract.stderr).slice(0, 300)}`);
				const entries = treeEntries(path);
				const link = entries.find(entry => entry.kind === "symlink");
				if (link === undefined) readableTree(path, entries);
				return { path, link: link === undefined ? null : relative(path, link.path), remove: () => rmSync(path, { recursive: true, force: true }) };
			} catch (error) {
				rmSync(path, { recursive: true, force: true });
				throw error;
			}
		},
	};
}

/** `git diff --raw -z`: one header per change, then its path, or the old and the new path of a rename. */
function parseRawDiff(text: string): readonly Omit<DiffChange, "binary" | "addedText">[] {
	const tokens = text.split("\0");
	const changes: { path: string; status: DiffChange["status"]; from: string | null; modeChanged: boolean; gitlink: boolean }[] = [];
	for (let index = 0; index < tokens.length;) {
		const header = tokens[index++];
		if (!header.startsWith(":")) continue;
		const fields = header.slice(1).split(" ");
		const [oldMode, newMode, , , status] = fields;
		const first = tokens[index++];
		const renamed = status.startsWith("R") || status.startsWith("C");
		const path = renamed ? tokens[index++] : first;
		if (path === undefined) break;
		changes.push({ path, status: statusOf(status), from: renamed ? first : null, modeChanged: oldMode !== newMode, gitlink: newMode === "160000" });
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

/** The named step that ended a run, with the bounded text that step produced. */
export type JudgeFailure = { readonly name: RunFailureName; readonly detail: string };

export type JudgeOutcome =
	| { readonly kind: "VERDICT"; readonly verdict: Verdict; readonly subject: SubjectRun | null; readonly timings: JudgeTimings }
	| { readonly kind: "RUN_FAILED"; readonly failure: JudgeFailure; readonly timings: JudgeTimings };

/** A contract the judge cannot match to its own declaration is the deployment's fault, never the worker's. */
function contractMismatch(code: string, detail = ""): JudgeFailure {
	return { name: "CONTRACT_MISMATCH", detail: detail ? `${code}: ${detail}` : code };
}

export type JudgeDeps = {
	readonly source: JudgeSource;
	readonly subject: SubjectLauncher;
	readonly publisher: PublisherPort;
	/** The deployment's cases, loaded once at the service boundary. The judge decides with these and nothing else. */
	readonly cases: readonly HiddenCase[];
	readonly frozenTestPath?: string;
	readonly clock?: { now(): Instant };
	readonly deadlineMs?: number;
};

/** Runs one attempt. A clean screen and clean tallies publish a pull request; nothing else does. */
export async function runJudge(request: VerifierRunRequest, deps: JudgeDeps): Promise<JudgeOutcome> {
	const started = performance.now();
	const clock = deps.clock ?? { now: () => instant(new Date().toISOString()) };
	const manifest = hiddenManifest(deps.cases);
	const done = request.definitionOfDone;
	if (done.hiddenManifest !== manifest.digest) return { kind: "RUN_FAILED", failure: contractMismatch("HIDDEN_MANIFEST_MISMATCH"), timings: timingsOf(started, {}) };
	if (!sameIds(manifest.cases.map(test => test.id), done.hiddenTests)) return { kind: "RUN_FAILED", failure: contractMismatch("HIDDEN_CASES_MISMATCH"), timings: timingsOf(started, {}) };
	let frozenCases: readonly HiddenCase[];
	try {
		frozenCases = invoiceFixtureFrozenCases(deps.source.readFile(done.frozenAt, deps.frozenTestPath ?? FROZEN_TEST_PATH));
	} catch (error) {
		return { kind: "RUN_FAILED", failure: contractMismatch("FROZEN_CASES_UNREADABLE", message(error)), timings: timingsOf(started, {}) };
	}
	if (!sameIds(frozenCases.map(test => test.id), done.frozenTests)) return { kind: "RUN_FAILED", failure: contractMismatch("FROZEN_CASES_MISMATCH"), timings: timingsOf(started, {}) };
	const screenStart = performance.now();
	const screen = screenDiff(deps.source.diff(done.frozenAt, request.sourceCommit), done);
	const screenMs = performance.now() - screenStart;
	if (screen.length) {
		// Nothing starts when the diff already breaks the contract. The screen alone decides.
		return { kind: "VERDICT", verdict: decideVerdict(request, screen, { results: new Map() }, judgeHidden(manifest.cases, new Map()), null, clock.now()),
			subject: null, timings: timingsOf(started, { screenMs }) };
	}
	const calls: readonly SubjectCall[] = [...frozenCases, ...manifest.cases].map(toSubjectCall);
	let tree: { readonly path: string; readonly link: string | null; readonly remove: () => void } | null = null;
	let subjectRun: SubjectRun;
	try {
		tree = deps.source.materialize(request.sourceCommit);
		// A link is the one entry whose real path is not the tree's own path. Nothing starts for it,
		// and the tree came back un-opened: no chmod has touched a path outside it.
		if (tree.link !== null) {
			return { kind: "VERDICT", verdict: decideVerdict(request, [{ kind: "TREE_SYMLINK", path: tree.link }], { results: new Map() },
				judgeHidden(manifest.cases, new Map()), null, clock.now()), subject: null, timings: timingsOf(started, { screenMs }) };
		}
		subjectRun = await deps.subject.run(tree.path, calls, deps.deadlineMs);
	} catch (error) {
		return { kind: "RUN_FAILED", failure: { name: "SUBJECT_UNSTARTABLE", detail: message(error) }, timings: timingsOf(started, { screenMs }) };
	} finally {
		tree?.remove();
	}
	// A subject the judge did not stop itself — the process signalled from outside, or the container
	// killed with `docker kill` — is infrastructure, not the submission. A launcher that could not get
	// the daemon to say how an abnormal exit ended is the same: the submission cannot stop the daemon.
	// The run ends without a verdict so the job returns the attempt slot, and nothing is published.
	if (subjectRun.killedBy !== null || subjectRun.faults.includes("SUBJECT_KILL_UNREPORTED")) {
		const detail = subjectRun.killedBy !== null ? `the subject was killed externally (${subjectRun.killedBy})`
			: "the subject was killed outside the run, and the daemon could not report how it ended";
		return { kind: "RUN_FAILED", failure: { name: "SUBJECT_KILLED", detail },
			timings: timingsOf(started, { screenMs, subjectMs: subjectRun.wallMs }) };
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
	if (faults.length) {
		return { kind: "VERDICT", verdict: decideVerdict(request, faults, frozen, hiddenJudged, null, clock.now()),
			subject: subjectRun, timings: timingsOf(started, { screenMs, subjectMs: subjectRun.wallMs, compareMs }) };
	}
	// The test outcome decides the run before anything reaches the client's repository: a submission
	// whose tests fail or are missing is REJECTED with nothing published for it. Only a clean outcome
	// asks the publisher for a pull request, and only a clean outcome can be VERIFIED.
	if (rejectReasons(request, [], frozen, hiddenJudged).length) {
		return { kind: "VERDICT", verdict: decideVerdict(request, [], frozen, hiddenJudged, null, clock.now()),
			subject: subjectRun, timings: timingsOf(started, { screenMs, subjectMs: subjectRun.wallMs, compareMs }) };
	}
	const publishStart = performance.now();
	let built: { mergeCommit: CommitSha; pullRequest: number };
	try {
		const published = await deps.publisher.publishVerified({ jobId: request.jobId, repository: done.issue.repository,
			sourceCommit: request.sourceCommit, checkName: "Acquit verifier" }, request.runId);
		built = { mergeCommit: published.mergeCommit, pullRequest: published.pullRequest };
	} catch (error) {
		// The judgment above was clean and the publisher refused: the run names publishing, not the worker.
		return { kind: "RUN_FAILED", failure: { name: "PUBLISH_FAILED", detail: message(error) },
			timings: timingsOf(started, { screenMs, subjectMs: subjectRun.wallMs, compareMs, publishMs: performance.now() - publishStart }) };
	}
	const publishMs = performance.now() - publishStart;
	try {
		const verdict = decideVerdict(request, [], frozen, hiddenJudged, built, clock.now());
		return { kind: "VERDICT", verdict, subject: subjectRun, timings: timingsOf(started, { screenMs, subjectMs: subjectRun.wallMs, compareMs, publishMs }) };
	} catch (error) {
		if (error instanceof VerifierPublishMissing) return { kind: "RUN_FAILED", failure: { name: "PUBLISH_FAILED", detail: error.code },
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

type TreeEntry = { readonly path: string; readonly kind: "directory" | "file" | "symlink" };

/** Every entry under root, without ever following a link: an explicit stack over each directory's own listing. */
function treeEntries(root: string): readonly TreeEntry[] {
	const entries: TreeEntry[] = [];
	const pending = [root];
	while (pending.length) {
		const parent = pending.pop() as string;
		for (const entry of readdirSync(parent, { withFileTypes: true })) {
			const path = join(parent, entry.name);
			if (entry.isSymbolicLink()) { entries.push({ path, kind: "symlink" }); continue; }
			if (entry.isDirectory()) { entries.push({ path, kind: "directory" }); pending.push(path); continue; }
			entries.push({ path, kind: "file" });
		}
	}
	return entries;
}

/**
 * mkdir and tar both apply the process umask, so a runner under umask 077 materializes a tree that
 * the subject's uid 65534 cannot read. Every entry's mode is set explicitly instead: directories
 * 0755, files 0644, and an entry git recorded executable stays executable. The caller passes the
 * entries of a tree that holds no link, and a link entry is skipped rather than followed.
 */
function readableTree(root: string, entries: readonly TreeEntry[]): void {
	chmodSync(root, 0o755);
	for (const entry of entries) {
		if (entry.kind === "symlink") continue;
		chmodSync(entry.path, entry.kind === "directory" ? 0o755 : (lstatSync(entry.path).mode & 0o100 ? 0o755 : 0o644));
	}
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
