// The score card. Each corpus entry is a real repository change that the real judge reads. Each outcome
// must equal its literal expected value, and the tally must equal the literal counts.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakeGitHubApp } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { CommitSha, JobId, TestId } from "../src/ids.ts";
import { formatScoreCard, observedOutcome, tally } from "../src/score-card.ts";
import type { CaseResult } from "../src/score-card.ts";
import type { DefinitionOfDone, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { gitSource, runJudge } from "../../verifier/judge.ts";
import { hiddenManifest } from "../../verifier/hidden.ts";
import { childProcessSubject } from "../../verifier/subject.ts";
import { demoProtectedPaths, exampleCases } from "./hidden-fixture.ts";
import { bookEntry, fixtureBook } from "./verifier-book.ts";
import { CORPUS, FROZEN_ROWS, FROZEN_TEST_PATH, writeBase } from "./score-card-corpus.ts";
import type { CorpusEntry } from "./score-card-corpus.ts";

const at = instant("2026-10-06T13:30:00Z");
const frozenSuite = FROZEN_ROWS.map((_, index) => `frozen:${index + 1}` as TestId);
const SKIP = process.platform === "win32" ? "The child-process subject and the symlink case run on POSIX. CI on ubuntu is the gate." : false;
const results: CaseResult[] = [];

function git(repo: string, args: readonly string[]): string {
	const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
	return result.stdout.trim();
}

function commitAll(repo: string, message: string): CommitSha {
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-qm", message]);
	return git(repo, ["rev-parse", "HEAD"]) as CommitSha;
}

/** Builds the frozen tree and the entry's change, then returns the judge's outcome in corpus terms. */
async function judge(entry: CorpusEntry): Promise<string> {
	const repo = mkdtempSync(join(tmpdir(), "acquit-score-card-"));
	try {
		git(repo, ["init", "-q"]);
		git(repo, ["config", "user.email", "score-card@example.invalid"]);
		git(repo, ["config", "user.name", "score-card"]);
		writeBase(repo);
		const frozenAt = commitAll(repo, "frozen");
		entry.write(repo);
		const sourceCommit = commitAll(repo, "submitted");
		const hidden = hiddenManifest(exampleCases);
		const definitionOfDone: DefinitionOfDone = {
			issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
			frozenAt, frozenTestPath: FROZEN_TEST_PATH, frozenTests: frozenSuite, hiddenManifest: hidden.digest,
			hiddenTests: exampleCases.map(hiddenCase => hiddenCase.id), protectedPaths: demoProtectedPaths,
		};
		const request: VerifierRunRequest = { runId: `run_${entry.id}` as VerifierRunId, jobId: "job_score_card" as JobId, ordinal: 1, sourceCommit, definitionOfDone };
		const outcome = await runJudge(request, { source: gitSource(repo), subject: childProcessSubject(), publisher: createFakeGitHubApp(),
			fixtures: fixtureBook(bookEntry(exampleCases)), clock: { now: () => at }, deadlineMs: 8_000 });
		return outcome.kind === "VERDICT" ? observedOutcome(entry.kind, outcome.verdict) : `RUN_FAILED:${outcome.failure.name}`;
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

for (const entry of CORPUS) {
	test(`${entry.kind} ${entry.id}`, { skip: SKIP, timeout: 60_000 }, async () => {
		const actual = await judge(entry);
		results.push({ id: entry.id, kind: entry.kind, expected: entry.expected, actual });
		assert.equal(actual, entry.expected, entry.id);
	});
}

test("the score card tallies every case to its literal counts", { skip: SKIP }, () => {
	assert.equal(results.length, CORPUS.length);
	for (const result of results) console.log(`${result.kind}\t${result.id}\texpected ${result.expected}\tactual ${result.actual}`);
	const card = tally(results);
	console.log(formatScoreCard(card));
	assert.deepEqual(card, { cheatsCaught: 11, cheatsTotal: 11, honestPassed: 20, honestTotal: 20, gaps: [] });
});
