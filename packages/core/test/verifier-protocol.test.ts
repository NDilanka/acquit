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
import type { DefinitionOfDone, HiddenCase, VerifierRunRequest, VerifierRunId } from "../src/verifier.ts";
import { gitSource, hiddenManifest, runJudge } from "../../verifier/judge.ts";
import type { JudgeSource } from "../../verifier/judge.ts";
import { childProcessSubject } from "../../verifier/subject.ts";

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
