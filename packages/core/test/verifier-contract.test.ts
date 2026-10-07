// The contract OpenJob freezes and the judge that reads it must come from one source.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeGitHubApp } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { CommitSha, JobId } from "../src/ids.ts";
import { frozenDefinition } from "../src/seed-data.ts";
import type { VerifierRunRequest, VerifierRunId } from "../src/verifier.ts";
import { gitSource, hiddenManifest, invoiceFixtureFrozenCases, runJudge } from "../../verifier/judge.ts";
import { childProcessSubject } from "../../verifier/subject.ts";

const FIXTURE = [process.env.ACQUIT_VERIFIER_FIXTURE,
	fileURLToPath(new URL("../../../../../acquit/scratch/verifier/invoice-app", import.meta.url))]
	.find(candidate => candidate !== undefined && existsSync(join(candidate, ".git"))) ?? null;
const skip = FIXTURE === null ? "Set ACQUIT_VERIFIER_FIXTURE to the invoice-app fixture." : false;
const head = (branch: string): CommitSha => spawnSync("git", ["-C", FIXTURE!, "rev-parse", `${branch}^{commit}`], { encoding: "utf8" }).stdout.trim() as CommitSha;

test("the contract OpenJob stores is one the judge accepts", { skip }, async () => {
	const request: VerifierRunRequest = { runId: "run_contract" as VerifierRunId, jobId: "job_contract" as JobId, ordinal: 1,
		sourceCommit: head("fix-honest"), definitionOfDone: frozenDefinition() };
	const outcome = await runJudge(request, { source: gitSource(FIXTURE!), subject: childProcessSubject(),
		publisher: createFakeGitHubApp(), clock: { now: () => instant("2026-10-06T13:40:00Z") } });
	assert.equal(outcome.kind, "VERDICT", outcome.kind === "RUN_FAILED" ? outcome.failure.name : "");
	if (outcome.kind !== "VERDICT") return;
	assert.equal(outcome.verdict.result, "VERIFIED");
});

test("the stored contract names the judge's own ids, manifest, and frozen commit", { skip }, () => {
	const done = frozenDefinition();
	const manifest = hiddenManifest();
	assert.equal(done.hiddenManifest, manifest.digest);
	assert.deepEqual(done.hiddenTests, manifest.cases.map(test => test.id));
	assert.deepEqual(done.frozenTests, invoiceFixtureFrozenCases(gitSource(FIXTURE!).readFile(done.frozenAt, "tests/totals.test.ts")).map(test => test.id));
	assert.equal(spawnSync("git", ["-C", FIXTURE!, "cat-file", "-e", `${done.frozenAt}^{commit}`]).status, 0,
		`${done.frozenAt} is not a commit in the fixture`);
});

test("the judge refuses a contract whose frozen ids are not the ones it extracts", { skip }, async () => {
	const request: VerifierRunRequest = { runId: "run_stale" as VerifierRunId, jobId: "job_stale" as JobId, ordinal: 1,
		sourceCommit: head("fix-honest"), definitionOfDone: { ...frozenDefinition(),
			frozenTests: Array.from({ length: 48 }, (_, index) => `visible_${index + 1}` as never) } };
	const outcome = await runJudge(request, { source: gitSource(FIXTURE!), subject: childProcessSubject(), publisher: createFakeGitHubApp() });
	assert.deepEqual(outcome.kind === "RUN_FAILED" ? outcome.failure : outcome.kind, { name: "CONTRACT_MISMATCH", detail: "FROZEN_CASES_MISMATCH" });
});
