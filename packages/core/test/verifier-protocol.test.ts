// The judge must not accept a result that submitted code wrote without ever seeing the inputs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeGitHubApp } from "../src/github.ts";
import type { PublisherPort, PublishRequest } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { CommitSha, JobId, TestId } from "../src/ids.ts";
import { SUBJECT_ERROR_CHARS, SUBJECT_FRAME_BYTES, parseSubjectTranscript } from "../src/verifier.ts";
import type { DefinitionOfDone, HiddenCase, SubjectCall, VerifierRunRequest, VerifierRunId } from "../src/verifier.ts";
import { BOOTSTRAP_LIMITS } from "../../verifier/bootstrap.ts";
import { gitSource, hiddenManifest, runJudge } from "../../verifier/judge.ts";
import type { JudgeSource } from "../../verifier/judge.ts";
import { ChildSubjectRefused, childProcessSubject, dockerArgs, dockerSubject, stageBootstrap, subjectFor, verifierSubjectEnv } from "../../verifier/subject.ts";

const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const hiddenCases: readonly HiddenCase[] = [
	{ id: "hidden:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 1.234 }], "KWD"], expected: "1.234" },
	{ id: "hidden:2" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 2.345 }], "BHD"], expected: "2.345" },
];

/** Every id the contract names. The source only has to satisfy the judge's extraction guard. */
const frozenTestSource = Array.from({ length: 48 }, (_, index) =>
	`it('case ${index + 1}', () => { expect(formatTotal([{ amount: 1 }], 'KWD')).toBe('1'); });`).join("\n");
const definitionOfDone: DefinitionOfDone = { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals" },
	frozenAt: frozenCommit, frozenTests: Array.from({ length: 48 }, (_, index) => `frozen:${index + 1}` as TestId),
	hiddenManifest: hiddenManifest(hiddenCases).digest, hiddenTests: hiddenCases.map(test => test.id),
	protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json", ".gitattributes", "**/.gitattributes"] as never };

/** A real two-commit repository, so the diff and the materialized tree are the ones the judge builds. */
function repositoryWith(moduleSource: string, extra?: (repo: string) => void): { readonly repo: string; readonly frozen: CommitSha; readonly head: CommitSha; readonly remove: () => void } {
	const repo = mkdtempSync(join(tmpdir(), "acquit-forge-"));
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "README.md"), "fixture\n");
	const git = (args: readonly string[]) => {
		const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
	};
	git(["init", "-q"]);
	git(["config", "user.email", "fixture@example.invalid"]);
	git(["config", "user.name", "fixture"]);
	git(["add", "-A"]);
	git(["commit", "-qm", "frozen"]);
	const frozen = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() as CommitSha;
	writeFileSync(join(repo, "src/money.ts"), moduleSource);
	extra?.(repo);
	git(["add", "-A"]);
	git(["commit", "-qm", "submitted"]);
	return { repo, frozen, head: spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() as CommitSha,
		remove: () => rmSync(repo, { recursive: true, force: true }) };
}

test("a complete forged transcript written before any input arrives is a fault, not a pass", async () => {
	const transcript = [...Array.from({ length: 48 }, (_, index) => `frozen:${index + 1}`), ...hiddenCases.map(hidden => hidden.id)]
		.map(id => JSON.stringify({ id, ok: true, value: hiddenCases.find(hidden => hidden.id === id)?.expected ?? "1" })).join("\n") + "\n";
	const module = `import { writeSync } from "node:fs";\nwriteSync(1, ${JSON.stringify(transcript)});\nprocess.exit(0);\nexport function formatTotal(): string { return "unreachable"; }\n`;
	const fixture = repositoryWith(module);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_forged" as VerifierRunId, jobId: "job_forged" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, subject: childProcessSubject(), publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, deadlineMs: 4_000, cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT");
		if (outcome.kind !== "VERDICT") return;
		assert.equal(outcome.verdict.result, "REJECTED");
		if (outcome.verdict.result !== "REJECTED") return;
		const details = outcome.verdict.reasons.filter(reason => reason.kind === "SUBJECT_FAULT").map(reason => reason.detail);
		assert.deepEqual([...details].sort(), ["SUBJECT_FRAME_REJECTED", "SUBJECT_INCOMPLETE"]);
	} finally { fixture.remove(); }
});

test("the subject reports ready before it answers, and every reply echoes the run's nonce", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`);
	try {
		const calls: readonly SubjectCall[] = [{ id: "frozen:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [] }];
		const run = await childProcessSubject().run(fixture.repo, calls, 4_000);
		assert.match(run.nonce, /^[0-9a-f]{32}$/);
		assert.equal(run.ready, true);
		assert.deepEqual(run.faults, []);
		const frames = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as { kind: string; nonce: string; value?: unknown });
		assert.deepEqual(frames.map(frame => frame.kind), ["ready", "reply"]);
		assert.deepEqual(frames.map(frame => frame.nonce), [run.nonce, run.nonce]);
		assert.equal(frames[1].value, "1");
	} finally { fixture.remove(); }
});

test("a subject that never reports ready is incomplete, not a pass", async () => {
	const fixture = repositoryWith(`process.exit(0);\nexport function formatTotal(): string { return "1"; }\n`);
	try {
		const calls: readonly SubjectCall[] = [{ id: "frozen:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [] }];
		const run = await childProcessSubject().run(fixture.repo, calls, 4_000);
		assert.equal(run.ready, false);
		assert.deepEqual(run.faults, ["SUBJECT_INCOMPLETE"]);
	} finally { fixture.remove(); }
});

test("a submitted tree that carries a symlink is rejected before the subject starts", async () => {
	const outside = mkdtempSync(join(tmpdir(), "acquit-outside-"));
	writeFileSync(join(outside, "module.ts"), `export function formatTotal(): string { return "outside"; }\n`);
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`, repo => {
		rmSync(join(repo, "src/money.ts"));
		symlinkSync(join(outside, "module.ts"), join(repo, "src/money.ts"));
	});
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_symlink" as VerifierRunId, jobId: "job_symlink" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, subject: childProcessSubject(), publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, deadlineMs: 4_000, cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT");
		if (outcome.kind !== "VERDICT") return;
		assert.equal(outcome.verdict.result, "REJECTED");
		if (outcome.verdict.result !== "REJECTED") return;
		assert.deepEqual(outcome.verdict.reasons, [{ kind: "TREE_SYMLINK", path: "src/money.ts" }]);
		assert.equal(outcome.subject, null);
	} finally { fixture.remove(); rmSync(outside, { recursive: true, force: true }); }
});

test("a submitted link to an outside directory is refused with nothing outside the tree chmodded", async () => {
	const outside = mkdtempSync(join(tmpdir(), "acquit-outside-"));
	mkdirSync(join(outside, "private"));
	writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY\n", { mode: 0o600 });
	writeFileSync(join(outside, "private", "notes.txt"), "notes\n", { mode: 0o600 });
	chmodSync(join(outside, "id_rsa"), 0o600);
	chmodSync(join(outside, "private"), 0o700);
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`, repo => {
		symlinkSync(outside, join(repo, "src/link"));
	});
	const modes = () => ({ victim: statSync(outside).mode & 0o777, privateDir: statSync(join(outside, "private")).mode & 0o777,
		idRsa: statSync(join(outside, "id_rsa")).mode & 0o777, notes: statSync(join(outside, "private/notes.txt")).mode & 0o777 });
	const before = modes();
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_dirlink" as VerifierRunId, jobId: "job_dirlink" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, cases: hiddenCases,
			subject: { variant: "CHILD_PROCESS", run: async () => { throw new Error("the subject must not start"); } } });
		assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
		if (outcome.kind !== "VERDICT" || outcome.verdict.result !== "REJECTED") throw new Error(`Expected a rejection, saw ${JSON.stringify(outcome)}`);
		assert.deepEqual(outcome.verdict.reasons, [{ kind: "TREE_SYMLINK", path: "src/link" }]);
		assert.equal(outcome.subject, null);
		assert.deepEqual(modes(), before);
	} finally { fixture.remove(); rmSync(outside, { recursive: true, force: true }); }
});

test("a link that loops back on the tree is refused by name and the subject never starts", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`, repo => {
		symlinkSync(".", join(repo, "src/self"));
	});
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_cycle" as VerifierRunId, jobId: "job_cycle" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, cases: hiddenCases,
			subject: { variant: "CHILD_PROCESS", run: async () => { throw new Error("the subject must not start"); } } });
		assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
		if (outcome.kind !== "VERDICT" || outcome.verdict.result !== "REJECTED") throw new Error(`Expected a rejection, saw ${JSON.stringify(outcome)}`);
		assert.deepEqual(outcome.verdict.reasons, [{ kind: "TREE_SYMLINK", path: "src/self" }]);
		assert.equal(outcome.subject, null);
	} finally { fixture.remove(); }
});

test("a link to a directory the runner cannot read is a TREE_SYMLINK rejection, not RUN_FAILED", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`, repo => {
		symlinkSync("/root", join(repo, "src/rootlink"));
	});
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_rootlink" as VerifierRunId, jobId: "job_rootlink" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, cases: hiddenCases,
			subject: { variant: "CHILD_PROCESS", run: async () => { throw new Error("the subject must not start"); } } });
		assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
		if (outcome.kind !== "VERDICT" || outcome.verdict.result !== "REJECTED") throw new Error(`Expected a rejection, saw ${JSON.stringify(outcome)}`);
		assert.deepEqual(outcome.verdict.reasons, [{ kind: "TREE_SYMLINK", path: "src/rootlink" }]);
		assert.equal(outcome.subject, null);
	} finally { fixture.remove(); }
});

test("a gitlink in the submitted tree is rejected before the subject starts", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`);
	try {
		const git = (args: readonly string[]) => {
			const result = spawnSync("git", ["-C", fixture.repo, ...args], { encoding: "utf8" });
			if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
			return result.stdout.trim();
		};
		rmSync(join(fixture.repo, "src/money.ts"));
		git(["update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},src/money.ts`]);
		git(["commit", "-qm", "gitlink"]);
		const head = git(["rev-parse", "HEAD"]) as CommitSha;
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_gitlink" as VerifierRunId, jobId: "job_gitlink" as JobId, ordinal: 1,
			sourceCommit: head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, subject: childProcessSubject(), publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, deadlineMs: 4_000, cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
		if (outcome.kind !== "VERDICT") return;
		assert.equal(outcome.verdict.result, "REJECTED");
		if (outcome.verdict.result !== "REJECTED") return;
		assert.deepEqual(outcome.verdict.reasons, [{ kind: "TREE_GITLINK", path: "src/money.ts" }]);
		assert.equal(outcome.subject, null);
	} finally { fixture.remove(); }
});

test("a diff over the screen's bound is refused by name and the subject never starts", async () => {
	const changes = Array.from({ length: 4097 }, (_, index) => ({ path: `src/file-${index}.ts`, status: "ADDED" as const,
		from: null, binary: false, modeChanged: false, gitlink: false, addedText: "" }));
	const source: JudgeSource = { diff: () => ({ changes }), readFile: () => frozenTestSource,
		materialize: () => { throw new Error("the submitted tree must not be materialized"); } };
	const request: VerifierRunRequest = { runId: "run_large" as VerifierRunId, jobId: "job_large" as JobId, ordinal: 1,
		sourceCommit: frozenCommit, definitionOfDone: { ...definitionOfDone, frozenAt: frozenCommit } };
	const outcome = await runJudge(request, { source, subject: { variant: "CHILD_PROCESS",
			run: async () => { throw new Error("the subject must not start"); } }, publisher: createFakeGitHubApp(), cases: hiddenCases });
	assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
	if (outcome.kind !== "VERDICT") return;
	assert.equal(outcome.verdict.result, "REJECTED");
	if (outcome.verdict.result !== "REJECTED") return;
	assert.deepEqual(outcome.verdict.reasons, [{ kind: "DIFF_TOO_LARGE", paths: 4097, limit: 4096 }]);
	assert.equal(outcome.subject, null);
});

test("a diff with more source paths than the screen reads is refused by name before the subject starts", async () => {
	const honestModule = `export function formatTotal(amounts: readonly { amount: number }[]): string { return String(amounts[0].amount); }\n`;
	const fixture = repositoryWith(honestModule, repo => {
		mkdirSync(join(repo, "aaa"), { recursive: true });
		for (let index = 0; index < 300; index++) {
			writeFileSync(join(repo, "aaa", `pad-${String(index).padStart(3, "0")}.ts`), `export const pad${index} = ${index};\n`);
		}
		writeFileSync(join(repo, "zzz-evil.ts"), 'import { expect } from "vitest";\nexport const evil = 1;\n');
	});
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_reads" as VerifierRunId, jobId: "job_reads" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, subject: childProcessSubject(), publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, deadlineMs: 4_000, cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
		if (outcome.kind !== "VERDICT") return;
		assert.equal(outcome.verdict.result, "REJECTED");
		if (outcome.verdict.result !== "REJECTED") return;
		assert.deepEqual(outcome.verdict.reasons, [{ kind: "SOURCE_PATHS_OVER_READ_BOUND", paths: 302, limit: 256 }]);
		assert.equal(outcome.subject, null);
	} finally { fixture.remove(); }
});

test("the bootstrap's frame limits are the judge's own limits", () => {
	assert.deepEqual(BOOTSTRAP_LIMITS, { frameBytes: SUBJECT_FRAME_BYTES, maxCalls: 256, maxErrorChars: SUBJECT_ERROR_CHARS });
});

test("the Docker subject mounts only the submitted tree and the minimal bootstrap", () => {
	const args = dockerArgs("/tmp/acquit-tree", "node:24-bookworm-slim");
	const mounts = args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]] : []);
	assert.equal(mounts.length, 2);
	assert.equal(mounts[0], "type=bind,source=/tmp/acquit-tree,target=/tree,readonly");
	assert.match(mounts[1], /^type=bind,source=.*\/bootstrap\.ts,target=\/runner\/bootstrap\.ts,readonly$/);
	assert.equal(mounts.some(mount => /judge|packages\/core/.test(mount)), false);
	assert.equal(args.includes("/runner/subject.ts"), false);
	assert.equal(args.includes("--network"), true);
	assert.equal(args[args.indexOf("--network") + 1], "none");
});

test("the Docker subject mounts a staged copy of the bootstrap, never the checkout file", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`);
	const shimDir = mkdtempSync(join(tmpdir(), "acquit-shim-"));
	const recorded = join(shimDir, "docker-args.json");
	const checkout = fileURLToPath(new URL("../../verifier/bootstrap.ts", import.meta.url));
	writeFileSync(join(shimDir, "docker"), `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const mounts = args.filter((value, index) => args[index - 1] === "--mount");
const source = mounts.find(mount => mount.includes("target=/runner/bootstrap.ts")).replace(/^type=bind,source=/, "").replace(/,target=.*$/, "");
const bytes = readFileSync(source);
writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({ args, source, mode: statSync(source).mode & 0o777, bytes: bytes.length,
	sha256: createHash("sha256").update(bytes).digest("hex") }));
process.exit(2);
`, { mode: 0o755 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${shimDir}:${previousPath ?? ""}`;
	try {
		const run = await dockerSubject({ probe: () => true }).run(fixture.repo, [], 2_000);
		assert.equal(run.variant, "DOCKER");
		const observed = JSON.parse(readFileSync(recorded, "utf8")) as { args: readonly string[]; source: string; mode: number; bytes: number; sha256: string };
		const trusted = readFileSync(checkout);
		assert.equal(observed.source === checkout, false, `the mount must not be the checkout file ${checkout}`);
		assert.match(observed.source, /[/\\]acquit-subject-[^/\\]+[/\\]bootstrap\.ts$/);
		assert.equal(observed.mode, 0o444);
		assert.equal(observed.bytes, trusted.length);
		assert.equal(observed.sha256, createHash("sha256").update(trusted).digest("hex"));
		assert.equal(observed.args[observed.args.indexOf("--mount") + 1], `type=bind,source=${fixture.repo},target=/tree,readonly`);
	} finally {
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		fixture.remove();
		rmSync(shimDir, { recursive: true, force: true });
	}
});

test("a mount source that would add a field is refused by name", () => {
	const unsafe = (error: unknown) => (error as { code?: string }).code === "MOUNT_PATH_UNSAFE";
	assert.throws(() => dockerArgs("/tmp/tree,target=/etc", "node:24-bookworm-slim"), unsafe);
	assert.throws(() => dockerArgs("/tmp/tree", "node:24-bookworm-slim", "/tmp/bootstrap.ts,readonly=false"), unsafe);
});

test("the staged bootstrap is the trusted bytes under modes the container user can read", () => {
	const previous = process.umask(0o077);
	try {
		const staged = stageBootstrap();
		try {
			assert.equal(statSync(staged.path).mode & 0o777, 0o444);
			assert.equal(statSync(dirname(staged.path)).mode & 0o777, 0o755);
			assert.deepEqual(readFileSync(staged.path), readFileSync(fileURLToPath(new URL("../../verifier/bootstrap.ts", import.meta.url))));
		} finally { staged.remove(); }
		assert.equal(existsSync(staged.path), false);
	} finally { process.umask(previous); }
});

test("stageBootstrap removes its work directory when the source cannot be read", () => {
	const work = mkdtempSync(join(tmpdir(), "acquit-stage-"));
	const unreadable = join(work, "bootstrap-unreadable.ts");
	const previousTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = work;
	try {
		writeFileSync(unreadable, readFileSync(fileURLToPath(new URL("../../verifier/bootstrap.ts", import.meta.url))));
		chmodSync(unreadable, 0o000);
		assert.throws(() => stageBootstrap(unreadable), (error: NodeJS.ErrnoException) => error.code === "EACCES");
		assert.deepEqual(readdirSync(work).filter(name => name.startsWith("acquit-subject-")), []);
	} finally {
		if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
		chmodSync(unreadable, 0o600);
		rmSync(work, { recursive: true, force: true });
	}
});

test("the tree handed to the subject is readable whatever the umask", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`, repo => {
		writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
	});
	const previous = process.umask(0o077);
	let modes: { root: number; src: number; money: number; script: number } | null = null;
	let treePath: string | null = null;
	try {
		try {
			const real = gitSource(fixture.repo);
			const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
			const request: VerifierRunRequest = { runId: "run_modes" as VerifierRunId, jobId: "job_modes" as JobId, ordinal: 1,
				sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
			await runJudge(request, { source, publisher: createFakeGitHubApp(), clock: { now: () => instant("2026-10-06T13:30:00Z") }, cases: hiddenCases,
				subject: { variant: "CHILD_PROCESS", run: async treeDir => {
					treePath = treeDir;
					modes = { root: statSync(treeDir).mode & 0o777, src: statSync(join(treeDir, "src")).mode & 0o777,
						money: statSync(join(treeDir, "src/money.ts")).mode & 0o777, script: statSync(join(treeDir, "run.sh")).mode & 0o777 };
					throw new Error("the run stops here");
				} } });
		} finally { process.umask(previous); }
	} finally { fixture.remove(); }
	assert.deepEqual(modes, { root: 0o755, src: 0o755, money: 0o644, script: 0o755 });
	assert.ok(treePath !== null && !existsSync(treePath), `the tree ${treePath} must be removed`);
});

test("materialize removes its tree root when the archive or the extraction fails", () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`);
	const work = mkdtempSync(join(tmpdir(), "acquit-materialize-"));
	const previousTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = work;
	const trees = () => readdirSync(work).filter(name => name.startsWith("acquit-tree-"));
	try {
		assert.throws(() => gitSource(fixture.repo).materialize("0".repeat(40) as CommitSha));
		assert.deepEqual(trees(), []);
		const previousUmask = process.umask(0o222);
		try {
			assert.throws(() => gitSource(fixture.repo).materialize(fixture.head));
		} finally { process.umask(previousUmask); }
		assert.deepEqual(trees(), []);
	} finally {
		if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
		rmSync(work, { recursive: true, force: true });
		fixture.remove();
	}
});

test("a subject that cannot start still removes the materialized tree", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`);
	try {
		const real = gitSource(fixture.repo);
		let treePath: string | null = null;
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: commit => {
			const tree = real.materialize(commit);
			treePath = tree.path;
			return tree;
		} };
		const request: VerifierRunRequest = { runId: "run_down" as VerifierRunId, jobId: "job_down" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, subject: dockerSubject({ probe: () => false }),
			publisher: createFakeGitHubApp(), clock: { now: () => instant("2026-10-06T13:30:00Z") }, cases: hiddenCases });
		assert.equal(outcome.kind, "RUN_FAILED", JSON.stringify(outcome));
		if (outcome.kind !== "RUN_FAILED") return;
		assert.equal(outcome.failure.name, "SUBJECT_UNSTARTABLE");
		assert.ok(treePath !== null, "the tree must have been materialized");
		assert.ok(treePath !== null && !existsSync(treePath), `the tree ${treePath} must be removed`);
	} finally { fixture.remove(); }
});

test("the product refuses the unit-test subject without the test/dev flag", () => {
	assert.equal(subjectFor({ subject: "docker", dev: false }).variant, "DOCKER");
	assert.equal(subjectFor({ subject: "child", dev: true }).variant, "CHILD_PROCESS");
	assert.throws(() => subjectFor({ subject: "child", dev: false }),
		(error: ChildSubjectRefused) => error.code === "SUBJECT_CHILD_REFUSED" && /ACQUIT_DEV=1/.test(error.message));
	assert.throws(() => subjectFor({ subject: "chroot", dev: true }), (error: ChildSubjectRefused) => error.code === "SUBJECT_CHILD_REFUSED");
	assert.deepEqual(verifierSubjectEnv({ ACQUIT_VERIFIER_SUBJECT: "child", ACQUIT_DEV: "1" }), { subject: "child", dev: true });
	assert.deepEqual(verifierSubjectEnv({}), { subject: "docker", dev: false });
});

test("a call that never resolves dies at the deadline as a TIMEOUT fault", async () => {
	const fixture = repositoryWith(`export async function formatTotal(): Promise<string> { await new Promise(() => {}); return "1"; }\n`);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_hang" as VerifierRunId, jobId: "job_hang" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, subject: childProcessSubject(), publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, deadlineMs: 1_500, cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT");
		if (outcome.kind !== "VERDICT" || outcome.verdict.result !== "REJECTED") throw new Error("Expected a rejection");
		assert.deepEqual(outcome.verdict.reasons.filter(reason => reason.kind === "SUBJECT_FAULT").map(reason => reason.detail),
			["TIMEOUT", "SUBJECT_EXIT", "SUBJECT_INCOMPLETE"]);
		assert.ok(outcome.timings.wallMs >= 1_400, `wallMs ${outcome.timings.wallMs} should reach the deadline`);
	} finally { fixture.remove(); }
});

test("a run whose hidden tests fail is REJECTED without ever asking the publisher", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_hidden_reject" as VerifierRunId, jobId: "job_hidden_reject" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const publishCalls: PublishRequest[] = [];
		const publisher: PublisherPort = { publishVerified: async publishRequest => {
			publishCalls.push(publishRequest);
			return { repository: publishRequest.repository, pullRequest: 13, mergeCommit: fixture.head, checkRunUrl: null };
		} };
		const outcome = await runJudge(request, { source, subject: childProcessSubject(), publisher,
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, deadlineMs: 4_000, cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
		if (outcome.kind !== "VERDICT") return;
		assert.equal(outcome.verdict.result, "REJECTED");
		if (outcome.verdict.result !== "REJECTED") return;
		assert.deepEqual(outcome.verdict.reasons, [{ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:1", "hidden:2"] }]);
		assert.deepEqual(publishCalls, []);
		assert.equal(outcome.timings.publishMs, 0);
	} finally { fixture.remove(); }
});

test("a run whose hidden tests fail stays REJECTED even with a publisher that would refuse", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_hidden_refused" as VerifierRunId, jobId: "job_hidden_refused" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const publishCalls: PublishRequest[] = [];
		const publisher: PublisherPort = { publishVerified: async publishRequest => {
			publishCalls.push(publishRequest);
			throw new Error("no App installation on maya-client/invoice-app");
		} };
		const outcome = await runJudge(request, { source, subject: childProcessSubject(), publisher,
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, deadlineMs: 4_000, cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
		if (outcome.kind !== "VERDICT") return;
		assert.equal(outcome.verdict.result, "REJECTED");
		if (outcome.verdict.result !== "REJECTED") return;
		assert.deepEqual(outcome.verdict.reasons, [{ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:1", "hidden:2"] }]);
		assert.deepEqual(publishCalls, []);
		assert.equal(outcome.timings.publishMs, 0);
	} finally { fixture.remove(); }
});

test("a thrown error is capped to one line and never enters the verdict", async () => {
	const marker = "R4-UNIT-MARKER";
	const fixture = repositoryWith(`export function formatTotal(): string { throw new Error(${JSON.stringify(`${marker}\\n`)} + "x".repeat(5000)); }\n`);
	try {
		const call: SubjectCall = { id: "hidden:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [] };
		const run = await childProcessSubject().run(fixture.repo, [call], 4_000);
		const reply = parseSubjectTranscript(run.stdout, run.nonce, [call]).replies.get("hidden:1" as TestId);
		assert.equal(reply?.ok, false);
		if (!reply || reply.ok) throw new Error("Expected a failed reply");
		assert.equal(reply.error.length, SUBJECT_ERROR_CHARS);
		assert.equal(/[\u0000-\u001f\u007f]/.test(reply.error), false);
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const outcome = await runJudge({ runId: "run_throw" as VerifierRunId, jobId: "job_throw" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } },
			{ source, subject: childProcessSubject(), publisher: createFakeGitHubApp(), cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT");
		if (outcome.kind !== "VERDICT") return;
		assert.equal(outcome.verdict.result, "REJECTED");
		assert.equal(JSON.stringify(outcome.verdict).includes(marker), false);
		assert.equal(JSON.stringify(outcome.verdict).includes("x".repeat(200)), false);
	} finally { fixture.remove(); }
});
