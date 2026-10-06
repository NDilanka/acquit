// The judge must not accept a result that submitted code wrote without ever seeing the inputs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakeGitHubApp } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { CommitSha, JobId, TestId } from "../src/ids.ts";
import { SUBJECT_ERROR_CHARS, SUBJECT_FRAME_BYTES, parseSubjectTranscript } from "../src/verifier.ts";
import type { DefinitionOfDone, HiddenCase, SubjectCall, VerifierRunRequest, VerifierRunId } from "../src/verifier.ts";
import { BOOTSTRAP_LIMITS } from "../../verifier/bootstrap.ts";
import { gitSource, hiddenManifest, runJudge } from "../../verifier/judge.ts";
import type { JudgeSource } from "../../verifier/judge.ts";
import { ChildSubjectRefused, childProcessSubject, dockerArgs, subjectFor, verifierSubjectEnv } from "../../verifier/subject.ts";

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
	protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json"] as never };

/** A real two-commit repository, so the diff and the materialized tree are the ones the judge builds. */
function repositoryWith(moduleSource: string): { readonly repo: string; readonly frozen: CommitSha; readonly head: CommitSha; readonly remove: () => void } {
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
