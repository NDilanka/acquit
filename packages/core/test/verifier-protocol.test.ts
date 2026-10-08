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
import { gitSource, runJudge } from "../../verifier/judge.ts";
import type { JudgeSource } from "../../verifier/judge.ts";
import { hiddenManifest } from "../../verifier/hidden.ts";
import { ChildSubjectRefused, childProcessSubject, dockerArgs, dockerReachable, dockerSubject, stageBootstrap, subjectFor, verifierSubjectEnv } from "../../verifier/subject.ts";
import type { SubjectRun } from "../../verifier/subject.ts";

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

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
	await waitFor(() => existsSync(path), timeoutMs);
}

/** The one container this test's run created, found by its mount source so parallel lanes cannot confuse it. */
async function waitForContainerMount(source: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const listed = String(spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout ?? "");
		for (const name of listed.split("\n").filter(candidate => candidate.startsWith("acquit-subject-"))) {
			const mounts = String(spawnSync("docker", ["inspect", "--format", "{{json .Mounts}}", name], { encoding: "utf8" }).stdout ?? "");
			if (mounts.includes(source)) return name;
		}
		if (Date.now() >= deadline) throw new Error(`No acquit-subject container mounted ${source} within ${timeoutMs} ms`);
		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

/** The container id the shim writes for `--cidfile`, the way the docker client does at container start. */
const SHIM_CONTAINER_ID = "c".repeat(64);

/** A fake `docker` CLI: it records every invocation, answers `events` from a file, and exits as told. */
function dockerShim(behavior: { readonly runExit: number; readonly events: string; readonly runHangs?: boolean;
	readonly eventsExit?: number; readonly eventsDelayMs?: number; readonly skipCidFile?: boolean; readonly runLeavesStdioMs?: number }): {
	readonly dir: string;
	readonly invocations: () => readonly (readonly string[])[];
	readonly remove: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "acquit-docker-shim-"));
	const log = join(dir, "invocations.jsonl");
	const events = join(dir, "events.txt");
	writeFileSync(events, behavior.events);
	// The docker client writes the container id at start. The stdio case models the live close: the
	// client exits 137 while a child of it keeps the pipes open, so close arrives with no signal after
	// the judge has already stopped it.
	const run = behavior.runHangs === true ? "setTimeout(() => {}, 60000);"
		: behavior.runLeavesStdioMs === undefined ? `process.exit(${behavior.runExit});`
		: `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, ${behavior.runLeavesStdioMs})"], { stdio: "inherit" });
setTimeout(() => process.exit(${behavior.runExit}), 20);`;
	writeFileSync(join(dir, "docker"), `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "events") {
	setTimeout(() => {
		process.stdout.write(readFileSync(${JSON.stringify(events)}, "utf8"));
		process.exit(${behavior.eventsExit ?? 0});
	}, ${behavior.eventsDelayMs ?? 0});
}
else if (args[0] === "run") {
	const cidfile = args.indexOf("--cidfile");
	if (cidfile >= 0 && ${behavior.skipCidFile !== true}) writeFileSync(args[cidfile + 1], ${JSON.stringify(`${SHIM_CONTAINER_ID}\n`)});
	${run}
}
else process.exit(0);
`, { mode: 0o755 });
	return { dir,
		invocations: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as readonly string[]),
		remove: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withShimOnPath<T>(dir: string, body: () => Promise<T>): Promise<T> {
	const previous = process.env.PATH;
	process.env.PATH = `${dir}:${previous ?? ""}`;
	try { return await body(); } finally {
		if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
	}
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
	const args = dockerArgs("/tmp/acquit-tree", "node:24-bookworm-slim", "acquit-subject-test", "/tmp/acquit-bootstrap.ts", "/tmp/acquit-container.cid");
	const mounts = args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]] : []);
	assert.equal(mounts.length, 2);
	assert.equal(args[args.indexOf("--name") + 1], "acquit-subject-test");
	// The client writes the container's id here, and the postmortem filters the daemon's events by it.
	assert.equal(args[args.indexOf("--cidfile") + 1], "/tmp/acquit-container.cid");
	assert.equal(mounts[0], "type=bind,source=/tmp/acquit-tree,target=/tree,readonly");
	// The bootstrap path is pinned here: the default is where the checkout lives, so asserting on it
	// would make this test pass or fail on the checkout's location, not on the mount list.
	assert.equal(mounts[1], "type=bind,source=/tmp/acquit-bootstrap.ts,target=/runner/bootstrap.ts,readonly");
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
// The launcher asks the daemon for events after an abnormal exit; only the run call is under test.
if (args[0] !== "run") process.exit(0);
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
	assert.throws(() => dockerArgs("/tmp/tree,target=/etc", "node:24-bookworm-slim", "acquit-subject-test"), unsafe);
	assert.throws(() => dockerArgs("/tmp/tree", "node:24-bookworm-slim", "acquit-subject-test", "/tmp/bootstrap.ts,readonly=false"), unsafe);
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

test("an externally killed subject ends the run without a verdict and is never published", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_killed" as VerifierRunId, jobId: "job_killed" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const killed: SubjectRun = { variant: "CHILD_PROCESS", nonce: "0".repeat(32), ready: true, stdout: "", stderr: "",
			exitCode: null, signal: "SIGKILL", killedBy: "SIGKILL", faults: ["SUBJECT_EXIT", "SUBJECT_INCOMPLETE"], wallMs: 42 };
		const publishCalls: PublishRequest[] = [];
		const publisher: PublisherPort = { publishVerified: async publishRequest => {
			publishCalls.push(publishRequest);
			return { repository: publishRequest.repository, pullRequest: 13, mergeCommit: fixture.head, checkRunUrl: null };
		} };
		const outcome = await runJudge(request, { source, publisher, cases: hiddenCases,
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, subject: { variant: "CHILD_PROCESS", run: async () => killed } });
		assert.equal(outcome.kind, "RUN_FAILED", JSON.stringify(outcome));
		if (outcome.kind !== "RUN_FAILED") return;
		assert.equal(outcome.failure.name, "SUBJECT_KILLED");
		assert.match(outcome.failure.detail, /SIGKILL/);
		assert.deepEqual(publishCalls, []);
	} finally { fixture.remove(); }
});

test("a subject that exits 137 on its own still burns an attempt as REJECTED SUBJECT_EXIT", async () => {
	const fixture = repositoryWith(`process.exit(137);\nexport function formatTotal(): string { return "1"; }\n`);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_self_137" as VerifierRunId, jobId: "job_self_137" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const publishCalls: PublishRequest[] = [];
		const publisher: PublisherPort = { publishVerified: async publishRequest => {
			publishCalls.push(publishRequest);
			return { repository: publishRequest.repository, pullRequest: 13, mergeCommit: fixture.head, checkRunUrl: null };
		} };
		const outcome = await runJudge(request, { source, subject: childProcessSubject(), publisher,
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, deadlineMs: 4_000, cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
		if (outcome.kind !== "VERDICT" || outcome.verdict.result !== "REJECTED") throw new Error(`Expected a rejection, saw ${JSON.stringify(outcome)}`);
		const faults = outcome.verdict.reasons.filter(reason => reason.kind === "SUBJECT_FAULT").map(reason => reason.detail);
		assert.ok(faults.includes("SUBJECT_EXIT"), JSON.stringify(faults));
		assert.deepEqual(publishCalls, []);
	} finally { fixture.remove(); }
});

test("a subject the daemon could not report on is a kill, so the attempt slot returns", async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { return "1"; }\n`);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_unreported" as VerifierRunId, jobId: "job_unreported" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		// The Docker launcher asked the daemon how an abnormal exit ended and the query failed. The
		// submission cannot stop the daemon, so this is infrastructure: no verdict, no attempt burned.
		const unreported: SubjectRun = { variant: "DOCKER", nonce: "0".repeat(32), ready: true, stdout: "", stderr: "",
			exitCode: 137, signal: null, killedBy: null, faults: ["SUBJECT_EXIT", "SUBJECT_KILL_UNREPORTED"], wallMs: 42 };
		const publishCalls: PublishRequest[] = [];
		const publisher: PublisherPort = { publishVerified: async publishRequest => {
			publishCalls.push(publishRequest);
			return { repository: publishRequest.repository, pullRequest: 13, mergeCommit: fixture.head, checkRunUrl: null };
		} };
		const outcome = await runJudge(request, { source, publisher, cases: hiddenCases,
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, subject: { variant: "DOCKER", run: async () => unreported } });
		assert.equal(outcome.kind, "RUN_FAILED", JSON.stringify(outcome));
		if (outcome.kind !== "RUN_FAILED") return;
		assert.equal(outcome.failure.name, "SUBJECT_KILLED");
		assert.match(outcome.failure.detail, /daemon could not report/);
		assert.deepEqual(publishCalls, []);
	} finally { fixture.remove(); }
});

test("the child launcher reports a signal the judge did not send as an external kill", { skip: process.platform === "win32" ? "Signal names need a POSIX host." : false, timeout: 60_000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "acquit-signal-"));
	const pidPath = join(work, "subject.pid");
	const calledPath = join(work, "subject.called");
	const fixture = repositoryWith(`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nexport function formatTotal(): Promise<string> { writeFileSync(${JSON.stringify(calledPath)}, "1"); return new Promise(() => {}); }\n`);
	try {
		const call: SubjectCall = { id: "frozen:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [] };
		const pending = childProcessSubject().run(fixture.repo, [call], 30_000);
		await waitForFile(pidPath, 10_000);
		const pid = Number(readFileSync(pidPath, "utf8"));
		await waitForFile(calledPath, 10_000);
		process.kill(pid, "SIGKILL");
		const run = await pending;
		assert.equal(run.signal, "SIGKILL");
		assert.equal(run.killedBy, "SIGKILL");
		assert.ok(run.faults.includes("SUBJECT_EXIT"), JSON.stringify(run.faults));
	} finally {
		try {
			const pid = Number(readFileSync(pidPath, "utf8"));
			if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
		} catch { /* the subject never started */ }
		fixture.remove();
		rmSync(work, { recursive: true, force: true });
	}
});

test("the Docker launcher reads an external kill from the daemon's kill event, not from the exit code", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 137, events: "create|\nstart|\nkill|9\ndie|137\n" });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 2_000));
		assert.equal(run.killedBy, "SIGKILL");
		assert.ok(run.faults.includes("SUBJECT_EXIT"), JSON.stringify(run.faults));
		const invoked = shim.invocations();
		const launched = invoked.find(call => call[0] === "run");
		assert.ok(launched !== undefined, JSON.stringify(invoked));
		const name = launched[launched.indexOf("--name") + 1];
		assert.match(name, /^acquit-subject-/);
		const events = invoked.find(call => call[0] === "events");
		assert.deepEqual(events?.slice(0, 3), ["events", "--filter", `container=${SHIM_CONTAINER_ID}`]);
		assert.ok(events?.includes("--since") === true && events?.includes("--until") === true, JSON.stringify(events));
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("a Docker subject that exits 137 on its own stays a REJECTED attempt", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 137, events: "create|\nstart|\ndie|137\n" });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 2_000));
		assert.equal(run.killedBy, null);
		assert.ok(run.faults.includes("SUBJECT_EXIT"), JSON.stringify(run.faults));
		assert.equal(run.faults.includes("MEMORY_LIMIT"), false, JSON.stringify(run.faults));
		const events = shim.invocations().find(call => call[0] === "events");
		assert.ok(events !== undefined, "an abnormal exit must ask the daemon what happened");
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("an OOM-killed Docker subject stays a verdict fault for the submission", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 137, events: "create|\noom|\ndie|137\n" });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 2_000));
		assert.equal(run.killedBy, null);
		assert.ok(run.faults.includes("MEMORY_LIMIT"), JSON.stringify(run.faults));
		assert.ok(run.faults.includes("SUBJECT_EXIT"), JSON.stringify(run.faults));
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("the Docker launcher asks the daemon nothing when the subject exits cleanly", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 0, events: "create|\nstart|\ndie|0\n" });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 2_000));
		assert.equal(run.killedBy, null);
		assert.deepEqual(shim.invocations().map(call => call[0]), ["run"]);
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("a Docker client the judge killed is removed by name so the container cannot outlive the run", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 0, events: "", runHangs: true });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 500));
		assert.ok(run.faults.includes("TIMEOUT"), JSON.stringify(run.faults));
		assert.equal(run.killedBy, null);
		const invoked = shim.invocations();
		const launched = invoked.find(call => call[0] === "run");
		assert.ok(launched !== undefined, JSON.stringify(invoked));
		const name = launched[launched.indexOf("--name") + 1];
		const removed = invoked.find(call => call[0] === "rm");
		assert.deepEqual(removed, ["rm", "--force", name]);
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("a daemon that cannot report how the subject ended is a kill, not a submission exit", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	// The events query fails: non-zero. A submission cannot stop the daemon, so this must not read as
	// the subject's own 137 and reject it.
	const shim = dockerShim({ runExit: 137, events: "", eventsExit: 1 });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 2_000));
		assert.equal(run.killedBy, null);
		assert.ok(run.faults.includes("SUBJECT_KILL_UNREPORTED"), JSON.stringify(run.faults));
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("a daemon that answers the postmortem slowly is not a kill: the submission's own exit stays REJECTED", { timeout: 60_000 }, async () => {
	const fixture = repositoryWith(`process.exit(137);\nexport function formatTotal(): string { return "1"; }\n`);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_slow_postmortem" as VerifierRunId, jobId: "job_slow_postmortem" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		// The daemon answers the closed window after 5.5 s — slower than the query's old 5 s bound — and
		// it answers no kill event. A slow answer is not a daemon that could not report: under load this
		// answer must not turn the submission's own exit into a kill that returns the attempt slot.
		const shim = dockerShim({ runExit: 137, events: "create|\nstart|\ndie|137\n", eventsDelayMs: 5_500 });
		try {
			const outcome = await withShimOnPath(shim.dir, () => runJudge(request, { source, publisher: createFakeGitHubApp(),
				subject: dockerSubject({ probe: () => true }), clock: { now: () => instant("2026-10-06T13:30:00Z") },
				deadlineMs: 20_000, cases: hiddenCases }));
			assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
			if (outcome.kind !== "VERDICT" || outcome.verdict.result !== "REJECTED") throw new Error(`Expected a rejection, saw ${JSON.stringify(outcome)}`);
			const faults = outcome.verdict.reasons.filter(reason => reason.kind === "SUBJECT_FAULT").map(reason => reason.detail);
			assert.ok(faults.includes("SUBJECT_EXIT"), JSON.stringify(faults));
			assert.equal(faults.includes("SUBJECT_KILL_UNREPORTED"), false, JSON.stringify(faults));
		} finally { shim.remove(); }
	} finally { fixture.remove(); }
});

test("a daemon whose postmortem query fails is a kill, and the attempt slot returns", { timeout: 60_000 }, async () => {
	const fixture = repositoryWith(`process.exit(137);\nexport function formatTotal(): string { return "1"; }\n`);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_failed_postmortem" as VerifierRunId, jobId: "job_failed_postmortem" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		// The query answers nonzero: the daemon could not say how the subject ended. The submission
		// cannot stop the daemon, so this is infrastructure and the attempt slot returns.
		const shim = dockerShim({ runExit: 137, events: "", eventsExit: 1 });
		try {
			const outcome = await withShimOnPath(shim.dir, () => runJudge(request, { source, publisher: createFakeGitHubApp(),
				subject: dockerSubject({ probe: () => true }), clock: { now: () => instant("2026-10-06T13:30:00Z") },
				deadlineMs: 20_000, cases: hiddenCases }));
			assert.equal(outcome.kind, "RUN_FAILED", JSON.stringify(outcome));
			if (outcome.kind !== "RUN_FAILED") return;
			assert.equal(outcome.failure.name, "SUBJECT_KILLED");
			assert.match(outcome.failure.detail, /daemon could not report/);
		} finally { shim.remove(); }
	} finally { fixture.remove(); }
});

test("a kill event that carries no signal number still reports an external kill", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 137, events: "create|\nkill|\ndie|137\n" });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 2_000));
		assert.equal(run.killedBy, "an external signal");
		assert.equal(run.faults.includes("SUBJECT_KILL_UNREPORTED"), false, JSON.stringify(run.faults));
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("the daemon's events are filtered by the container id the client wrote, not by its name", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 137, events: "kill|9\n" });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 2_000));
		assert.equal(run.killedBy, "SIGKILL");
		const invoked = shim.invocations();
		const launched = invoked.find(call => call[0] === "run");
		assert.ok(launched !== undefined, JSON.stringify(invoked));
		const cidFile = launched[launched.indexOf("--cidfile") + 1];
		assert.match(cidFile ?? "", /[/\\]acquit-subject-[^/\\]+[/\\]container\.cid$/);
		const events = invoked.find(call => call[0] === "events");
		assert.deepEqual(events?.slice(0, 3), ["events", "--filter", `container=${SHIM_CONTAINER_ID}`]);
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("without the id file the daemon's events fall back to the run's unique name", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 137, events: "kill|9\n", skipCidFile: true });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 2_000));
		assert.equal(run.killedBy, "SIGKILL");
		const invoked = shim.invocations();
		const launched = invoked.find(call => call[0] === "run");
		const name = launched?.[launched.indexOf("--name") + 1];
		const events = invoked.find(call => call[0] === "events");
		assert.deepEqual(events?.slice(0, 3), ["events", "--filter", `container=${name}`]);
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("the postmortem waits the kill lag out before it closes the event window", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 137, events: "kill|9\n" });
	try {
		const started = Date.now();
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 2_000));
		assert.equal(run.killedBy, "SIGKILL");
		// The deadline had passed by the end of the lag wait. The child was already gone, so it must not
		// add a fault to the run while the postmortem answers.
		assert.equal(run.faults.includes("TIMEOUT"), false, JSON.stringify(run.faults));
		const events = shim.invocations().find(call => call[0] === "events");
		const until = Date.parse(events?.[events.indexOf("--until") + 1] ?? "");
		// The live daemon logs the kill 300-800 ms after it happens. The lag is waited out before the
		// query starts, so the window's bound is already in the past and the query cannot block on it.
		assert.ok(Number.isFinite(until) && until <= Date.now(), `--until must be a past bound, saw ${until}`);
		assert.ok(Date.now() - started >= 1_000, "the kill lag must be waited out before the query");
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("a client the judge stopped is removed even when it exits 137 with no signal", async () => {
	const tree = mkdtempSync(join(tmpdir(), "acquit-tree-"));
	const shim = dockerShim({ runExit: 137, events: "", runLeavesStdioMs: 400 });
	try {
		const run = await withShimOnPath(shim.dir, () => dockerSubject({ probe: () => true }).run(tree, [], 100));
		assert.ok(run.faults.includes("TIMEOUT"), JSON.stringify(run.faults));
		const invoked = shim.invocations();
		const launched = invoked.find(call => call[0] === "run");
		const name = launched?.[launched.indexOf("--name") + 1];
		const removed = invoked.find(call => call[0] === "rm");
		assert.deepEqual(removed, ["rm", "--force", name]);
	} finally {
		shim.remove();
		rmSync(tree, { recursive: true, force: true });
	}
});

test("a real Docker container the judge stopped at its deadline is removed by name", { skip: dockerReachable() ? false : "Docker is not reachable.", timeout: 60_000 }, async () => {
	const fixture = repositoryWith(`export function formatTotal(): Promise<string> { return new Promise(() => {}); }\n`);
	chmodSync(fixture.repo, 0o755);
	let name: string | null = null;
	try {
		const call: SubjectCall = { id: "frozen:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [] };
		const pending = dockerSubject().run(fixture.repo, [call], 5_000);
		name = await waitForContainerMount(fixture.repo, 10_000);
		const run = await pending;
		assert.ok(run.faults.includes("TIMEOUT"), JSON.stringify(run.faults));
		assert.equal(run.killedBy, null);
		await waitFor(() => String(spawnSync("docker", ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"]).stdout ?? "").trim() === "", 10_000);
	} finally {
		if (name !== null) spawnSync("docker", ["rm", "--force", name]);
		fixture.remove();
	}
});

test("a real Docker subject killed from outside returns the run as an external kill with no container left", { skip: dockerReachable() ? false : "Docker is not reachable.", timeout: 60_000 }, async () => {
	const fixture = repositoryWith(`export function formatTotal(): Promise<string> { return new Promise(() => {}); }\n`);
	chmodSync(fixture.repo, 0o755);
	let name: string | null = null;
	try {
		const call: SubjectCall = { id: "frozen:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [] };
		const pending = dockerSubject().run(fixture.repo, [call], 30_000);
		name = await waitForContainerMount(fixture.repo, 20_000);
		const killed = spawnSync("docker", ["kill", "--signal", "KILL", name]);
		assert.equal(killed.status, 0, String(killed.stderr));
		const run = await pending;
		assert.equal(run.killedBy, "SIGKILL");
		assert.equal(run.exitCode, 137);
		await waitFor(() => String(spawnSync("docker", ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"]).stdout ?? "").trim() === "", 5_000);
	} finally {
		if (name !== null) spawnSync("docker", ["rm", "--force", name]);
		fixture.remove();
	}
});

test("a real Docker subject that exits 137 on its own stays a REJECTED attempt", { skip: dockerReachable() ? false : "Docker is not reachable.", timeout: 60_000 }, async () => {
	const fixture = repositoryWith(`process.exit(137);\nexport function formatTotal(): string { return "1"; }\n`);
	chmodSync(fixture.repo, 0o755);
	try {
		const real = gitSource(fixture.repo);
		const source: JudgeSource = { diff: real.diff, readFile: () => frozenTestSource, materialize: real.materialize };
		const request: VerifierRunRequest = { runId: "run_docker_137" as VerifierRunId, jobId: "job_docker_137" as JobId, ordinal: 1,
			sourceCommit: fixture.head, definitionOfDone: { ...definitionOfDone, frozenAt: fixture.frozen } };
		const outcome = await runJudge(request, { source, subject: dockerSubject(), publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T13:30:00Z") }, deadlineMs: 20_000, cases: hiddenCases });
		assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
		if (outcome.kind !== "VERDICT" || outcome.verdict.result !== "REJECTED") throw new Error(`Expected a rejection, saw ${JSON.stringify(outcome)}`);
		const faults = outcome.verdict.reasons.filter(reason => reason.kind === "SUBJECT_FAULT").map(reason => reason.detail);
		assert.ok(faults.includes("SUBJECT_EXIT"), JSON.stringify(faults));
	} finally { fixture.remove(); }
});

test("a real Docker subject killed by the memory cap stays a verdict fault", { skip: dockerReachable() ? false : "Docker is not reachable.", timeout: 60_000 }, async () => {
	const fixture = repositoryWith(`export function formatTotal(): string { const held: Buffer[] = []; for (;;) held.push(Buffer.alloc(1 << 20)); }\n`);
	chmodSync(fixture.repo, 0o755);
	try {
		const call: SubjectCall = { id: "frozen:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [] };
		const run = await dockerSubject().run(fixture.repo, [call], 30_000);
		assert.equal(run.killedBy, null);
		assert.equal(run.exitCode, 137);
		assert.ok(run.faults.includes("MEMORY_LIMIT"), JSON.stringify(run.faults));
	} finally { fixture.remove(); }
});
