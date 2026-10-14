// The verifier's side of AI scoping: a job's approved draft lives in the deployment's private
// scoping store as one JSON file, and the run that judges that job resolves its case set by the
// digest the manifest froze — read from the store at run time, never shipped in the manifest.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instant, parseJobId } from "../src/ids.ts";
import type { CommitSha, TestId } from "../src/ids.ts";
import type { VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import type { JobId } from "../src/ids.ts";
import type { HiddenCase, JsonValue } from "../src/verifier.ts";
import { hiddenManifest } from "../../verifier/hidden.ts";
import { runJudge } from "../../verifier/judge.ts";
import type { SubjectLauncher } from "../../verifier/subject.ts";
import { bookEntry, fixtureBook } from "./verifier-book.ts";
import { loadScopingBook, withScopingCases } from "../../verifier/fixtures.ts";
import { parseScopingFile } from "../src/scoping.ts";
import { exampleCases } from "./hidden-fixture.ts";

const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const now = instant("2026-10-14T12:00:00Z");

/** Two drafted cases, product-assigned ids, one covering each family the fixture's gate defines. */
const draftedCases: readonly HiddenCase[] = [
	{ id: "draft:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235" },
	{ id: "draft:2" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500" },
];

function scopingFile(jobId: string, cases: readonly HiddenCase[], approved: string | null = null): string {
	return JSON.stringify({
		version: 1, jobId, repository: "maya-client/invoice-app",
		issue: { number: 12, title: "Totals round wrong for 3-decimal currencies" }, frozenAt: frozenCommit,
		contract: "Every total formats to the currency's own minor-unit count.", approved,
		cases: cases.map(test => ({ ...test, citation: "the currency's own minor-unit count" })),
	});
}

test("a scoping store file parses to the job's drafted cases, citations included, and refuses a bad shape", () => {
	const file = parseScopingFile(scopingFile("job_a", draftedCases, now), "job_a.json");
	assert.equal(file.jobId, "job_a");
	assert.equal(file.approved, now);
	assert.equal(file.cases.length, 2);
	assert.match(file.cases[0]!.citation, /minor-unit count/);
	assert.throws(() => parseScopingFile(scopingFile("job_a", draftedCases, now).replace('"version":1', '"version":2'), "job_a.json"), /version/);
});

test("the scoping book reads every drafted case set from the private store; a malformed file is skipped by name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-book-"));
	try {
		await writeFile(join(dir, "job_a.json"), scopingFile("job_a", draftedCases, now), { mode: 0o600 });
		await writeFile(join(dir, "job_b.json"), "{not json", { mode: 0o600 });
		const book = loadScopingBook(dir);
		const digest = hiddenManifest(draftedCases).digest;
		const entry = book.get(digest);
		assert.ok(entry, "the drafted set resolves by its digest");
		assert.equal(entry.jobId, "job_a");
		assert.deepEqual(entry.cases.map(test => test.id), ["draft:1", "draft:2"]);
		assert.ok(!entry.cases.some(caseAny => "citation" in caseAny), "the judged cases carry no citation");
		assert.equal(book.size, 1, "the malformed file contributes nothing");
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("the merged book resolves curated and drafted digests, the curated file winning a collision", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-merge-"));
	try {
		await writeFile(join(dir, "job_a.json"), scopingFile("job_a", draftedCases, now), { mode: 0o600 });
		const book = withScopingCases(fixtureBook(bookEntry(exampleCases)), loadScopingBook(dir));
		assert.ok(book.byDigest.get(hiddenManifest(exampleCases).digest), "the curated set still resolves");
		assert.ok(book.byDigest.get(hiddenManifest(draftedCases).digest), "the drafted set resolves beside it");
		// A collision is impossible to buy anything with: the same cases digest the same, so the
		// entry the run gets is the same case set either way.
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a run whose manifest froze an approved draft is judged against the drafted cases", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-run-"));
	try {
		await writeFile(join(dir, "job_draft.json"), scopingFile("job_draft", draftedCases, now), { mode: 0o600 });
		const digest = hiddenManifest(draftedCases).digest;
		const fixtures = withScopingCases(fixtureBook(bookEntry(exampleCases)), loadScopingBook(dir));
		const received: string[][] = [];
		const subject: SubjectLauncher = { variant: "CHILD_PROCESS", run: async (_tree, calls) => {
			received.push(calls.map(call => call.id));
			return { variant: "CHILD_PROCESS", nonce: "n".repeat(32), ready: true, stdout: "", stderr: "", exitCode: 0, signal: null, killedBy: null, faults: [], wallMs: 1 };
		} };
		const frozenSource = Array.from({ length: 48 }, (_, i) =>
			`it('case ${i + 1}', () => { expect(formatTotal([{ amount: 1 }], 'KWD')).toBe('1'); });`).join("\n");
		const source = {
			readFile: (commit: CommitSha, path: string): string => {
				if (path === "tests/totals.test.ts") return frozenSource;
				throw new Error(`unexpected read of ${path}`);
			},
			diff: () => ({ changes: [] }),
			materialize: () => ({ path: join(dir, "tree"), link: null, remove: () => {} }),
		};
		const request: VerifierRunRequest = { runId: "run_a1_draft" as VerifierRunId, jobId: parseJobId("job_draft"), ordinal: 1,
			sourceCommit: frozenCommit, definitionOfDone: {
				issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
				frozenAt: frozenCommit, frozenTestPath: "tests/totals.test.ts",
				frozenTests: Array.from({ length: 48 }, (_, i) => `frozen:${i + 1}` as TestId),
				hiddenTests: draftedCases.map(test => test.id), hiddenManifest: digest,
				protectedPaths: ["tests/**"] as never } };
		const outcome = await runJudge(request, { source, subject,
			publisher: { publishVerified: async () => { throw new Error("a REJECTED verdict never publishes"); } } as never, fixtures });
		assert.equal(outcome.kind, "VERDICT");
		if (outcome.kind !== "VERDICT") return;
		assert.deepEqual(received[0]!.slice(-2), ["draft:1", "draft:2"], "the judge ran the drafted cases, not the curated file's");
		assert.equal(outcome.verdict.result, "REJECTED", "the drafted cases fail on the frozen code, so the honest tree is rejected");
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
