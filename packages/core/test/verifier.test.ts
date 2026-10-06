import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { instant } from "../src/ids.ts";
import type { CommitSha, Digest, JobId, TestId } from "../src/ids.ts";
import { createFakeGitHubApp, createGitHubApp, GitHubAppNotConfigured, missingGitHubNames, verifiedBranch } from "../src/github.ts";
import { decideVerdict, describeRejectReason, judgeHidden, matchesGlob, parseSubjectReplies, screenDiff, toSubjectCall, VerifierPublishMissing } from "../src/verifier.ts";
import type { DefinitionOfDone, DiffSummary, FrozenRun, Glob, HiddenCase, RejectReason, SubjectCall, SubjectReply, Verdict, VerifierRunRequest, VerifierRunId } from "../src/verifier.ts";
import { childProcessSubject } from "../../verifier/subject.ts";
import { gitSource, hiddenManifest, runJudge } from "../../verifier/judge.ts";

const at = instant("2026-10-06T12:00:00Z");
const commit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const request: VerifierRunRequest = { runId: "run_job_test_1" as VerifierRunId, jobId: "job_test" as JobId, ordinal: 1,
	sourceCommit: commit, definitionOfDone: {
		issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
		frozenAt: commit, frozenTests: ["frozen:1", "frozen:2"] as TestId[], hiddenManifest: "0".repeat(64) as Digest,
		hiddenTests: ["hidden:1", "hidden:2"] as TestId[],
		protectedPaths: ["tests/**", "package.json"] as Glob[] } };
const cases: HiddenCase[] = [
	{ id: "hidden:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 1.234 }], "KWD"], expected: "1.234" },
	{ id: "hidden:2" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 2.345 }], "BHD"], expected: "2.345" },
];
const calls: SubjectCall[] = cases.map(toSubjectCall);
const reply = (id: string, value: unknown): string => JSON.stringify({ id, ok: true, value });
const passed = (...ids: string[]): FrozenRun => ({ results: new Map(ids.map(id => [id as TestId, "passed" as const])) });
const clean = { mergeCommit: "5cccb66515313caed72e4af329a62fc011139426" as CommitSha, pullRequest: 13 };

test("toSubjectCall sends only the id, target, and args; the expected value never crosses", () => {
	const call = toSubjectCall(cases[0]);
	assert.deepEqual(call, { id: "hidden:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 1.234 }], "KWD"] });
	assert.equal(JSON.stringify(call), '{"id":"hidden:1","target":{"module":"src/money.ts","export":"formatTotal"},"args":[[{"amount":1.234}],"KWD"]}');
	assert.equal(JSON.stringify(calls).includes("expected"), false);
	assert.equal(JSON.stringify(calls).includes('"1.234"'), false);
});

test("parseSubjectReplies keeps an honest transcript and drops unknown, malformed, and non-finite frames", () => {
	const stdout = [reply("hidden:1", "1.234"), reply("hidden:9", "forged"), "{not json}", '{"id":"hidden:2","ok":true,"value":1e999}', reply("hidden:2", "2.345"), ""].join("\n");
	const replies = parseSubjectReplies(stdout, calls);
	assert.deepEqual([...replies.keys()], ["hidden:1", "hidden:2"]);
	assert.deepEqual(replies.get("hidden:1" as TestId), { id: "hidden:1", ok: true, value: "1.234" });
});

test("a duplicated id is invalidated for the whole run, so a forged first reply cannot win", () => {
	const forgedFirst = [reply("hidden:1", "forged-before"), reply("hidden:1", "1.234"), reply("hidden:2", "2.345")].join("\n");
	const first = parseSubjectReplies(forgedFirst, calls);
	assert.equal(first.has("hidden:1" as TestId), false);
	assert.equal(judgeHidden(cases, first).missing.length, 1);
	const forgedLast = [reply("hidden:1", "1.234"), reply("hidden:2", "2.345"), reply("hidden:1", "1.234")].join("\n");
	assert.equal(parseSubjectReplies(forgedLast, calls).has("hidden:1" as TestId), false);
});

test("judgeHidden compares against the judge's literal expected value", () => {
	const replies = new Map<TestId, SubjectReply>([
		["hidden:1" as TestId, { id: "hidden:1" as TestId, ok: true, value: "1.23" }],
		["hidden:2" as TestId, { id: "hidden:2" as TestId, ok: true, value: "2.345" }],
	]);
	const judged = judgeHidden(cases, replies);
	assert.deepEqual(judged.tally, { expected: 2, passed: 1 });
	assert.deepEqual(judged.failed, ["hidden:1"]);
	assert.deepEqual(judged.missing, []);
	assert.deepEqual(judgeHidden(cases, new Map()).tally, { expected: 2, passed: 0 });
});

test("matchesGlob treats ** as any depth and * as one segment", () => {
	assert.equal(matchesGlob("tests/**", "tests/totals.test.ts"), true);
	assert.equal(matchesGlob("tests/**", "src/money.ts"), false);
	assert.equal(matchesGlob(".github/**", ".github/workflows/ci.yml"), true);
	assert.equal(matchesGlob("package.json", "package.json"), true);
	assert.equal(matchesGlob("package.json", "packages/core/package.json"), false);
	assert.equal(matchesGlob("src/*.ts", "src/money.ts"), true);
	assert.equal(matchesGlob("src/*.ts", "src/nested/money.ts"), false);
});

test("screenDiff names the protected file, the framework import, and a config swap", () => {
	const diff: DiffSummary = { changed: [
		{ path: "tests/totals.test.ts", addedText: "expect(formatTotal([{ amount: 10.125 }], 'KWD')).toBe('10.13');" },
		{ path: "src/money.ts", addedText: "import { expect } from 'vitest';\nexpect.extend({ toBe() { return { pass: true }; } });" },
	]};
	assert.deepEqual(screenDiff(diff, request.definitionOfDone), [
		{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" },
		{ kind: "TEST_FRAMEWORK_IN_SOURCE", path: "src/money.ts", symbol: "vitest" },
	]);
	const configSwap: DiffSummary = { changed: [
		{ path: "ci/setup.ts", addedText: "import { vi } from 'vitest';\nvi.stubGlobal('__ACQUIT_TESTS_DISABLED__', true);" },
		{ path: "vitest.config.ts", addedText: "  test: { include: ['ci/smoke.test.ts'], maxWorkers: 1 }" },
		{ path: "package.json", addedText: '  "test": "node -e \\"process.exit(0)\\""' },
	]};
	assert.deepEqual(screenDiff(configSwap, request.definitionOfDone), [
		{ kind: "TEST_FRAMEWORK_IN_SOURCE", path: "ci/setup.ts", symbol: "vitest" },
		{ kind: "PROTECTED_PATH_MODIFIED", path: "package.json" },
	]);
});

test("decideVerdict verifies only a clean run with a published pull request", () => {
	const verdict = decideVerdict(request, [], passed("frozen:1", "frozen:2"), judgeHidden(cases, new Map([
		["hidden:1" as TestId, { id: "hidden:1" as TestId, ok: true, value: "1.234" }],
		["hidden:2" as TestId, { id: "hidden:2" as TestId, ok: true, value: "2.345" }],
	])), clean, at) as Extract<Verdict, { result: "VERIFIED" }>;
	assert.equal(verdict.result, "VERIFIED");
	assert.deepEqual(verdict.frozen, { expected: 2, passed: 2 });
	assert.deepEqual(verdict.hidden, { expected: 2, passed: 2 });
	assert.equal(verdict.pullRequest, 13);
	assert.equal(verdict.mergeCommit, clean.mergeCommit);
	assert.equal(verdict.at, at);
	assert.equal(verdict.reportDigest.length, 64);
});

test("decideVerdict rejects a skipped frozen id, a failed hidden id, and a screen hit", () => {
	const skipped = decideVerdict(request, [], { results: new Map([["frozen:1" as TestId, "passed"], ["frozen:2" as TestId, "skipped"]]) }, judgeHidden(cases, new Map()), clean, at) as Extract<Verdict, { result: "REJECTED" }>;
	assert.deepEqual(skipped.reasons, [
		{ kind: "TESTS_MISSING", suite: "frozen", missing: ["frozen:2"] },
		{ kind: "TESTS_MISSING", suite: "hidden", missing: ["hidden:1", "hidden:2"] },
	]);
	const failed = decideVerdict(request, [], passed("frozen:1", "frozen:2"), judgeHidden(cases, new Map([
		["hidden:1" as TestId, { id: "hidden:1" as TestId, ok: true, value: "1.23" }],
		["hidden:2" as TestId, { id: "hidden:2" as TestId, ok: true, value: "2.345" }],
	])), clean, at) as Extract<Verdict, { result: "REJECTED" }>;
	assert.deepEqual(failed.reasons, [{ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:1"] }]);
	const screened: RejectReason[] = [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }];
	const denied = decideVerdict(request, screened, passed("frozen:1", "frozen:2"), judgeHidden(cases, new Map([
		["hidden:1" as TestId, { id: "hidden:1" as TestId, ok: true, value: "1.234" }],
		["hidden:2" as TestId, { id: "hidden:2" as TestId, ok: true, value: "2.345" }],
	])), clean, at) as Extract<Verdict, { result: "REJECTED" }>;
	assert.deepEqual(denied.reasons, [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }]);
});

test("decideVerdict refuses to verify a passing run that was never published", () => {
	assert.throws(() => decideVerdict(request, [], passed("frozen:1", "frozen:2"), judgeHidden(cases, new Map([
		["hidden:1" as TestId, { id: "hidden:1" as TestId, ok: true, value: "1.234" }],
		["hidden:2" as TestId, { id: "hidden:2" as TestId, ok: true, value: "2.345" }],
	])), null, at), (error: unknown) => error instanceof VerifierPublishMissing && error.code === "VERIFIER_PUBLISH_MISSING");
});

test("describeRejectReason prints the tutorial's rejection line for a frozen test edit", () => {
	assert.equal(describeRejectReason({ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }), "PR modifies frozen test file tests/totals.test.ts");
	assert.equal(describeRejectReason({ kind: "PROTECTED_PATH_MODIFIED", path: "package.json" }), "PR modifies protected path package.json");
	assert.equal(describeRejectReason({ kind: "TEST_FRAMEWORK_IN_SOURCE", path: "src/money.ts", symbol: "vitest" }), "Submitted source src/money.ts imports vitest");
	assert.equal(describeRejectReason({ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:1" as TestId] }), "Hidden tests failed: hidden:1");
});

test("the GitHub App port refuses by name and never waits on a call it cannot make", async () => {
	const absent = createGitHubApp({});
	await assert.rejects(absent.createWorkRepo({ jobId: "job_7Q2K" as JobId, repository: "maya-client/invoice-app", frozenCommit: commit }, "req-1"),
		(error: unknown) => error instanceof GitHubAppNotConfigured && error.code === "GITHUB_APP_NOT_CONFIGURED");
	await assert.rejects(absent.publishVerified({ jobId: "job_7Q2K" as JobId, repository: "maya-client/invoice-app", sourceCommit: commit, checkName: "Acquit verifier" }, "req-2"),
		(error: unknown) => (error as { code?: string }).code === "GITHUB_APP_NOT_CONFIGURED");
	assert.deepEqual(missingGitHubNames({ appId: "1" }), ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_ORG"]);
	const present = createGitHubApp({ appId: "1", privateKey: "key", organization: "acquit-forks" });
	await assert.rejects(present.createWorkRepo({ jobId: "job_7Q2K" as JobId, repository: "maya-client/invoice-app", frozenCommit: commit }, "req-3"),
		(error: unknown) => (error as { code?: string }).code === "GITHUB_APP_NOT_IMPLEMENTED");
});

test("the fake work repo is idempotent per job and keeps ten lanes off one repository name", async () => {
	const app = createFakeGitHubApp();
	const request = { jobId: "job_7Q2K" as JobId, repository: "maya-client/invoice-app", frozenCommit: commit };
	const created = await app.createWorkRepo(request, "req-1");
	assert.deepEqual(created, { repository: "acquit-forks/invoice-app-7Q2K", remote: "https://github.com/acquit-forks/invoice-app-7Q2K.git", branch: "main", commit });
	assert.deepEqual(await app.createWorkRepo(request, "req-2"), created);
	const other = await app.createWorkRepo({ ...request, jobId: "job_8Z3P" as JobId }, "req-3");
	assert.equal(other.repository, "acquit-forks/invoice-app-8Z3P");
	const published = await app.publishVerified({ jobId: request.jobId, repository: "maya-client/invoice-app", sourceCommit: commit, checkName: "Acquit verifier" }, "req-4");
	assert.deepEqual(published, { repository: "maya-client/invoice-app", pullRequest: 13, mergeCommit: commit,
		checkRunUrl: "https://github.com/maya-client/invoice-app/runs/job_7Q2K" });
	assert.equal((await app.publishVerified({ jobId: request.jobId, repository: "maya-client/invoice-app", sourceCommit: commit, checkName: "Acquit verifier" }, "req-5")).pullRequest, 13);
	assert.deepEqual(app.calls.map(call => call.kind), ["CREATE_WORK_REPO", "CREATE_WORK_REPO", "CREATE_WORK_REPO", "PUBLISH_VERIFIED", "PUBLISH_VERIFIED"]);
	assert.equal(verifiedBranch(request.jobId), "acquit/job_7Q2K");
});

// The fixture matrix. The trees live in the gitignored scratch directory, so the path is resolved
// from the environment first and the test reports a skip, never a pass, when it is absent.

const FIXTURE = [process.env.ACQUIT_VERIFIER_FIXTURE,
	fileURLToPath(new URL("../../../scratch/verifier/invoice-app", import.meta.url)),
	fileURLToPath(new URL("../../../../../acquit/scratch/verifier/invoice-app", import.meta.url))]
	.find(candidate => candidate !== undefined && existsSync(join(candidate, ".git"))) ?? null;

const FROZEN_COMMIT = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const fixtureDefinition: DefinitionOfDone = { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
	frozenAt: FROZEN_COMMIT, frozenTests: Array.from({ length: 48 }, (_, index) => `frozen:${index + 1}` as TestId),
	hiddenManifest: hiddenManifest().digest, hiddenTests: hiddenManifest().cases.map(test => test.id),
	protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json"] as Glob[] };

test("the judge returns the measured verdict and reason on every invoice-app branch", { skip: FIXTURE === null ? "Set ACQUIT_VERIFIER_FIXTURE to the invoice-app fixture." : false }, async () => {
	const source = gitSource(FIXTURE!);
	const observed: Record<string, string> = {};
	for (const branch of ["main", "fix-honest", "tamper-test", "cheat-assertion", "cheat-special-case", "cheat-config", "cheat-package", "fix-with-test-tamper"]) {
		const head = spawnSync("git", ["-C", FIXTURE!, "rev-parse", `${branch}^{commit}`], { encoding: "utf8" }).stdout.trim() as CommitSha;
		const request: VerifierRunRequest = { runId: `run_${branch}` as VerifierRunId, jobId: "job_matrix" as JobId, ordinal: 1,
			sourceCommit: head, definitionOfDone: fixtureDefinition };
		const outcome = await runJudge(request, { source, subject: childProcessSubject(), publisher: createFakeGitHubApp(),
			clock: { now: () => instant("2026-10-06T12:00:00Z") } });
		assert.equal(outcome.kind, "VERDICT", `${branch} failed to produce a verdict`);
		if (outcome.kind !== "VERDICT") continue;
		const verdict = outcome.verdict;
		observed[branch] = verdict.result === "VERIFIED"
			? `VERIFIED frozen ${verdict.frozen.passed}/${verdict.frozen.expected} hidden ${verdict.hidden.passed}/${verdict.hidden.expected} PR #${verdict.pullRequest}`
			: `REJECTED ${verdict.reasons.map(reason => JSON.stringify(reason)).join(" ")}`;
		console.log(`# judge ${branch} ${verdict.result} wallMs=${outcome.timings.wallMs.toFixed(1)} subjectMs=${outcome.timings.subjectMs.toFixed(1)}`);
	}
	assert.deepEqual(observed, {
		"main": 'REJECTED {"kind":"TESTS_FAILED","suite":"frozen","failed":["frozen:48"]} {"kind":"TESTS_FAILED","suite":"hidden","failed":["hidden:1","hidden:2","hidden:3","hidden:4","hidden:5","hidden:6"]}',
		"fix-honest": "VERIFIED frozen 48/48 hidden 6/6 PR #13",
		"tamper-test": 'REJECTED {"kind":"PROTECTED_PATH_MODIFIED","path":"tests/totals.test.ts"}',
		"cheat-assertion": 'REJECTED {"kind":"TEST_FRAMEWORK_IN_SOURCE","path":"src/money.ts","symbol":"vitest"}',
		"cheat-special-case": 'REJECTED {"kind":"TESTS_FAILED","suite":"hidden","failed":["hidden:1","hidden:2","hidden:3","hidden:4","hidden:5","hidden:6"]}',
		"cheat-config": 'REJECTED {"kind":"TEST_FRAMEWORK_IN_SOURCE","path":"ci/setup.ts","symbol":"vitest"} {"kind":"TEST_FRAMEWORK_IN_SOURCE","path":"ci/smoke.test.ts","symbol":"vitest"}',
		"cheat-package": 'REJECTED {"kind":"PROTECTED_PATH_MODIFIED","path":"package.json"}',
		"fix-with-test-tamper": 'REJECTED {"kind":"PROTECTED_PATH_MODIFIED","path":"tests/totals.test.ts"}',
	});
});

test("the judge refuses to verify when the contract's hidden manifest is not the one it holds", { skip: FIXTURE === null ? "Set ACQUIT_VERIFIER_FIXTURE to the invoice-app fixture." : false }, async () => {
	const request: VerifierRunRequest = { runId: "run_manifest" as VerifierRunId, jobId: "job_matrix" as JobId, ordinal: 1,
		sourceCommit: FROZEN_COMMIT, definitionOfDone: { ...fixtureDefinition, hiddenManifest: "0".repeat(64) as Digest } };
	const outcome = await runJudge(request, { source: gitSource(FIXTURE!), subject: childProcessSubject(), publisher: createFakeGitHubApp() });
	assert.deepEqual(outcome.kind === "RUN_FAILED" ? outcome.reason : outcome.kind, "HIDDEN_MANIFEST_MISMATCH");
});
