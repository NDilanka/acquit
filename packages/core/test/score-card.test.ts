// The score card. Each corpus entry is a real repository change that the real judge reads. Each outcome
// must equal its literal expected value, and the tally must equal the literal counts.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createFakeGitHubApp } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { CommitSha, JobId, TestId } from "../src/ids.ts";
import { formatScoreCard, observedOutcome, PUBLISHED_SCORE_CARD, tally } from "../src/score-card.ts";
import type { CaseResult } from "../src/score-card.ts";
import type { DefinitionOfDone, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { gitSource, runJudge } from "../../verifier/judge.ts";
import { hiddenManifest } from "../../verifier/hidden.ts";
import { childProcessSubject } from "../../verifier/subject.ts";
import { demoProtectedPaths, exampleCases } from "./hidden-fixture.ts";
import { bookEntry, fixtureBook } from "./verifier-book.ts";
import { CORPUS, FROZEN_ROWS, FROZEN_TEST_PATH, HONEST_FIXES, writeBase } from "./score-card-corpus.ts";
import type { CorpusEntry, Files } from "./score-card-corpus.ts";

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
	assert.deepEqual(card, PUBLISHED_SCORE_CARD);
});

// The judge checks only the frozen rows and the hidden cases, and none of them is negative. These rows
// cover negative totals and zero. A tie rounds away from zero, the rule toFixed applies to the reference fix.
const LITERAL_TOTALS: readonly { readonly amounts: readonly number[]; readonly currency: string; readonly expected: string }[] = [
	{ amounts: [-0.01], currency: "USD", expected: "-0.01" },
	{ amounts: [-1.5], currency: "JPY", expected: "-2" },
	{ amounts: [-2.5], currency: "JPY", expected: "-3" },
	{ amounts: [-1000000.5], currency: "JPY", expected: "-1000001" },
	{ amounts: [-1.234], currency: "KWD", expected: "-1.234" },
	{ amounts: [-5, -0.25], currency: "KWD", expected: "-5.250" },
	{ amounts: [-10.25, 4.25], currency: "USD", expected: "-6.00" },
	{ amounts: [-1.25, 1.25], currency: "USD", expected: "0.00" },
	{ amounts: [0], currency: "USD", expected: "0.00" },
	{ amounts: [0], currency: "JPY", expected: "0" },
	{ amounts: [0], currency: "KWD", expected: "0.000" },
	{ amounts: [2.5], currency: "JPY", expected: "3" },
	{ amounts: [1234567.89], currency: "USD", expected: "1234567.89" },
	{ amounts: [98765432.1, 0.02], currency: "GBP", expected: "98765432.12" },
	{ amounts: [1000000], currency: "JPY", expected: "1000000" },
	{ amounts: [123456.789], currency: "KWD", expected: "123456.789" },
];

type Formatter = (lines: readonly { amount: number }[], currency: string) => string;

for (const fix of HONEST_FIXES) {
	test(`honest fix ${fix.id} formats the literal totals in process`, async () => {
		const repo = mkdtempSync(join(tmpdir(), "acquit-score-card-format-"));
		try {
			writeBase(repo);
			fix.write(repo);
			const money = (await import(pathToFileURL(join(repo, "src", "money.ts")).href)) as { formatTotal: Formatter };
			for (const row of LITERAL_TOTALS) {
				const lines = row.amounts.map(amount => ({ amount }));
				assert.equal(money.formatTotal(lines, row.currency), row.expected, `${fix.id} ${row.currency} ${JSON.stringify(row.amounts)}`);
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
}

// The reference fix rounds to each currency's ISO 4217 minor units. KRW has none, so 99.6 rounds to 100, not 99.60.
const REFERENCE_ROWS: readonly { readonly currency: string; readonly expected: string }[] = [
	{ currency: "KRW", expected: "100" },
	{ currency: "JPY", expected: "100" },
	{ currency: "USD", expected: "99.60" },
	{ currency: "KWD", expected: "99.600" },
];

test("the reference fix formats 99.6 by each currency's minor units, KRW included", async () => {
	const reference = HONEST_FIXES.find(fix => fix.id === "honest-reference-table");
	assert.ok(reference, "the reference fix is in the corpus");
	const repo = mkdtempSync(join(tmpdir(), "acquit-score-card-reference-"));
	try {
		writeBase(repo);
		reference.write(repo);
		const money = (await import(pathToFileURL(join(repo, "src", "money.ts")).href)) as { formatTotal: Formatter };
		for (const row of REFERENCE_ROWS) assert.equal(money.formatTotal([{ amount: 99.6 }], row.currency), row.expected, row.currency);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

/** Drops comments and all whitespace, so two fixes that differ only in layout or line endings compare equal. */
function fingerprint(files: Files): string {
	return Object.keys(files).sort().map(path => `${path}\n${files[path].replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/\s+/g, "")}`).join("\0");
}

test("no two honest fixes are the same source after stripping comments and whitespace", () => {
	assert.equal(fingerprint({ "src/money.ts": "x = 1; // note\r\n\ty" }), fingerprint({ "src/money.ts": "x = 1;\ny" }));
	const seen = new Map<string, string>();
	for (const fix of HONEST_FIXES) {
		const key = fingerprint(fix.files);
		assert.equal(seen.get(key), undefined, `${fix.id} repeats ${seen.get(key)}`);
		seen.set(key, fix.id);
	}
});
