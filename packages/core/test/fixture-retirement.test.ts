// Retired hidden-case sets. A deployment that rotates its private cases keeps the old set registered, so
// a job that froze it is still judged against exactly that set. No new job is ever offered a retired set.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeGitHubApp } from "../src/github.ts";
import { FixtureConfigError, parseFixtureRegistry } from "../src/fixtures.ts";
import { instant } from "../src/ids.ts";
import type { CommitSha, Digest, JobId, TestId } from "../src/ids.ts";
import { frozenTests } from "../src/score-card-trees.ts";
import type { DefinitionOfDone, HiddenCase, JsonValue, SubjectCall, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { runJudge } from "../../verifier/judge.ts";
import type { SubjectRun } from "../../verifier/subject.ts";
import { EXAMPLE_HIDDEN_CASES_PATH, hiddenContractOf, loadHiddenCasesFromFile } from "../../verifier/hidden.ts";
import { buildFixtureBook, fixtureContracts, fixtureContractsByManifest, loadFixtureRegistry } from "../../verifier/fixtures.ts";
import type { FixtureBook } from "../../verifier/fixtures.ts";
import { demoProtectedPaths, exampleCases, exampleContract } from "./hidden-fixture.ts";
import { bookEntry, fixtureBook } from "./verifier-book.ts";

/** The non-dev test file: six cases of its own, none of them the public example's. */
const TEST_HIDDEN_CASES_PATH = fileURLToPath(new URL("../../verifier/fixtures/hidden-cases.test.json", import.meta.url));
const FROZEN_AT = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const FROZEN_IDS = Array.from({ length: 48 }, (_, index) => `frozen:${index + 1}` as TestId);
const HIDDEN_8 = ["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6", "hidden:7", "hidden:8"] as TestId[];
const HIDDEN_6 = HIDDEN_8.slice(0, 6);
const NONCE = "retirement-nonce";
const at = instant("2026-10-06T13:30:00Z");

type Formatter = (lines: readonly { readonly amount: number }[], currency: string) => string;

/** The fixture's trusted fix (5cccb66, src/money.ts), reproduced for the judge's subject. */
const trustedFormat: Formatter = (lines, currency) => {
	const sum = lines.reduce((total, line) => total + line.amount, 0);
	return sum.toFixed(new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2);
};

/** A sign-misplaced fix: -1.234 comes out as "1.-234". */
const signMisplaced: Formatter = (lines, currency) => {
	const value = trustedFormat(lines, currency);
	if (!value.startsWith("-")) return value;
	const [whole, fraction = ""] = value.slice(1).split(".");
	return `${whole}.-${fraction}`;
};

/** A sign-dropped fix: every line counts as its magnitude. */
const signDropped: Formatter = (lines, currency) => trustedFormat(lines.map(line => ({ amount: Math.abs(line.amount) })), currency);

const answerWith = (format: Formatter) => (call: SubjectCall): JsonValue =>
	format(call.args[0] as readonly { readonly amount: number }[], call.args[1] as string);

/** A subject that answers every call and records the ids each run was handed. */
function subjectAnswering(answer: (call: SubjectCall) => JsonValue, handed: TestId[][]) {
	return { variant: "CHILD_PROCESS" as const, run: async (_tree: string, calls: readonly SubjectCall[]): Promise<SubjectRun> => {
		handed.push(calls.map(call => call.id));
		const frames = [JSON.stringify({ kind: "ready", nonce: NONCE }),
			...calls.map(call => JSON.stringify({ kind: "reply", nonce: NONCE, id: call.id, ok: true, value: answer(call) }))];
		const stdout = frames.join("\n") + "\n";
		return { variant: "CHILD_PROCESS", nonce: NONCE, ready: true, stdout, stderr: "", exitCode: 0, signal: null, killedBy: null, faults: [], wallMs: 1 };
	} };
}

/** The frozen suite is read from the fixture's own frozen text, and every diff is clean. */
const SOURCE = { diff: () => ({ changes: [] }), readFile: () => frozenTests(), materialize: () => ({ path: "(unused)", link: null, remove: () => {} }) };

function definitionFor(digest: Digest, hiddenTests: readonly TestId[]): DefinitionOfDone {
	return { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
		frozenAt: FROZEN_AT, frozenTestPath: "tests/totals.test.ts", frozenTests: FROZEN_IDS, hiddenTests, hiddenManifest: digest,
		protectedPaths: demoProtectedPaths };
}

async function judge(book: FixtureBook, digest: Digest, hiddenTests: readonly TestId[], answer: (call: SubjectCall) => JsonValue, handed: TestId[][] = []) {
	const request: VerifierRunRequest = { runId: "run_retirement" as VerifierRunId, jobId: "job_retirement" as JobId, ordinal: 1,
		sourceCommit: "1".repeat(40) as CommitSha, definitionOfDone: definitionFor(digest, hiddenTests) };
	return runJudge(request, { source: SOURCE, subject: subjectAnswering(answer, handed), publisher: createFakeGitHubApp(),
		fixtures: book, clock: { now: () => at }, deadlineMs: 8_000 });
}

function verdictOf(outcome: Awaited<ReturnType<typeof judge>>) {
	assert.equal(outcome.kind, "VERDICT", outcome.kind === "RUN_FAILED" ? `${outcome.failure.name} ${outcome.failure.detail}` : "");
	if (outcome.kind !== "VERDICT") throw new Error("the assertion above refuses a run failure");
	return outcome.verdict;
}

const CURRENT_CHANGED = JSON.stringify({ version: 1, cases: exampleCases.map((entry, index) => index === 0 ? { ...entry, expected: "9.999" } : entry) });
const RETIRED_TEXT = readFileSync(TEST_HIDDEN_CASES_PATH, "utf8");
const ENTRY = { repository: "maya-client/invoice-app", issue: { number: 12, title: "Totals round wrong for 3-decimal currencies" },
	frozenAt: FROZEN_AT, frozenTestPath: "tests/totals.test.ts", visible: 48, hidden: 8, protectedPaths: ["tests/**"],
	frozenExtractor: "invoice-totals" };

/** A registry over one current file and, when given, one retired file, both written beside it. Returns the registry path. */
function registryDir(current: string, retired?: { readonly text: string; readonly count: number }, extra: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "acquit-retired-sets-"));
	writeFileSync(join(dir, "current.json"), current, { mode: 0o600 });
	if (retired) writeFileSync(join(dir, "retired.json"), retired.text, { mode: 0o600 });
	const entry = { ...ENTRY, hiddenCases: "current.json", ...(retired ? { retiredHiddenCases: [{ file: "retired.json", count: retired.count }] } : {}), ...extra };
	writeFileSync(join(dir, "fixtures.json"), JSON.stringify({ version: 1, fixtures: [entry] }), { mode: 0o600 });
	return join(dir, "fixtures.json");
}

test("the registry parses a retired set and refuses a malformed one by name", () => {
	const registry = (retired: unknown) => JSON.stringify({ version: 1, fixtures: [{ ...ENTRY, hiddenCases: "current.json", retiredHiddenCases: retired }] });
	assert.deepEqual(parseFixtureRegistry(registry([{ file: "retired.json", count: 6 }]), "registry.json")[0]!.retiredHiddenCases, [{ file: "retired.json", count: 6 }]);
	assert.equal(parseFixtureRegistry(JSON.stringify({ version: 1, fixtures: [{ ...ENTRY, hiddenCases: "current.json" }] }), "registry.json")[0]!.retiredHiddenCases, undefined);
	const refusals: readonly [unknown, RegExp][] = [
		[[{ file: "retired.json", count: 6, extra: 1 }], /retiredHiddenCases entry has an unknown field extra/],
		[[{ file: "retired.json", count: 0 }], /count as a whole number between 1 and 500/],
		[[{ file: "retired.json", count: 6.5 }], /count as a whole number between 1 and 500/],
		[[{ file: 7, count: 6 }], /must carry file as a path/],
		[[], /non-empty array of retired sets/],
		[["retired.json"], /entry must be an object/],
	];
	for (const [retired, pattern] of refusals) {
		assert.throws(() => parseFixtureRegistry(registry(retired), "registry.json"), (error: unknown) => {
			assert.ok(error instanceof FixtureConfigError);
			assert.match(error.message, pattern);
			return true;
		});
	}
});

test("a book over a current set and a retired set resolves both digests to one fixture, and contracts name the current set alone", () => {
	const registryPath = registryDir(CURRENT_CHANGED, { text: RETIRED_TEXT, count: 6 }, { coverageFamilies: [{ name: "three-decimal", currencies: ["KWD"] }] });
	try {
		const registry = loadFixtureRegistry({ ACQUIT_FIXTURES: registryPath });
		const book = buildFixtureBook(registry);
		const current = hiddenContractOf(loadHiddenCasesFromFile(join(dirname(registryPath), "current.json"), { count: 8, idPrefix: "hidden" }));
		const retired = hiddenContractOf(loadHiddenCasesFromFile(join(dirname(registryPath), "retired.json"), { count: 6, idPrefix: "hidden" }));
		assert.deepEqual([...book.byDigest.keys()].sort(), [current.digest, retired.digest].sort());
		assert.equal(book.byDigest.get(retired.digest)?.entry, book.byDigest.get(current.digest)?.entry, "both digests name the one fixture");
		assert.equal(book.byDigest.get(retired.digest)?.cases.length, 6);
		assert.deepEqual(fixtureContracts(registry).map(contract => contract.hiddenManifest), [current.digest]);
		assert.deepEqual(fixtureContracts(registry)[0]!.hiddenTests, HIDDEN_8);
		const byManifest = fixtureContractsByManifest(registry);
		assert.deepEqual(byManifest.map(contract => contract.hiddenManifest), [current.digest, retired.digest]);
		assert.deepEqual(byManifest[1]!.hiddenTests, HIDDEN_6);
		assert.deepEqual(byManifest[1]!.coverageFamilies, [{ name: "three-decimal", currencies: ["KWD"] }], "a job that froze the retired set keeps the fixture's coverage gate");
	} finally {
		rmSync(dirname(registryPath), { recursive: true, force: true });
	}
});

test("a retired set that holds the same cases as the current one is refused by name", () => {
	const registryPath = registryDir(CURRENT_CHANGED, { text: CURRENT_CHANGED, count: 8 });
	try {
		assert.throws(() => buildFixtureBook(loadFixtureRegistry({ ACQUIT_FIXTURES: registryPath })), (error: unknown) => {
			assert.ok(error instanceof FixtureConfigError);
			assert.equal(error.code, "FIXTURES_CONFIG_INVALID");
			assert.match(error.message, /hold the same hidden cases/);
			return true;
		});
	} finally {
		rmSync(dirname(registryPath), { recursive: true, force: true });
	}
});

test("a retired set naming the committed public example is refused outside dev, and a dev process may name it", () => {
	const registryPath = registryDir(CURRENT_CHANGED, { text: readFileSync(EXAMPLE_HIDDEN_CASES_PATH, "utf8"), count: 8 });
	try {
		const registry = loadFixtureRegistry({ ACQUIT_FIXTURES: registryPath });
		assert.throws(() => buildFixtureBook(registry, {}), (error: unknown) => {
			assert.ok(error instanceof FixtureConfigError);
			assert.match(error.message, /public example/);
			return true;
		});
		assert.equal(buildFixtureBook(registry, { ACQUIT_DEV: "1" }).byDigest.size, 2);
	} finally {
		rmSync(dirname(registryPath), { recursive: true, force: true });
	}
});

test("the six-case public example committed before cases 7 and 8 is refused outside dev, as current or retired", () => {
	const historical = JSON.stringify({ version: 1, cases: exampleCases.slice(0, 6) });
	assert.equal(hiddenContractOf(exampleCases.slice(0, 6)).digest, "1f8674af554ddddcc1e29f0a9f017664c9cf50445018497868f60a97b7b19e57");
	for (const registryPath of [registryDir(historical, undefined, { hidden: 6 }), registryDir(CURRENT_CHANGED, { text: historical, count: 6 })]) {
		try {
			const registry = loadFixtureRegistry({ ACQUIT_FIXTURES: registryPath });
			assert.throws(() => buildFixtureBook(registry, {}), (error: unknown) => {
				assert.ok(error instanceof FixtureConfigError);
				assert.match(error.message, /public example/);
				return true;
			});
			assert.ok(buildFixtureBook(registry, { ACQUIT_DEV: "1" }).byDigest.size >= 1);
		} finally {
			rmSync(dirname(registryPath), { recursive: true, force: true });
		}
	}
});
test("a job that froze a retired set is judged against exactly that set", async () => {
	const registryPath = registryDir(CURRENT_CHANGED, { text: RETIRED_TEXT, count: 6 });
	try {
		const book = buildFixtureBook(loadFixtureRegistry({ ACQUIT_FIXTURES: registryPath }));
		const retired = loadHiddenCasesFromFile(join(dirname(registryPath), "retired.json"), { count: 6, idPrefix: "hidden" });
		const expectedById = new Map<string, JsonValue>(retired.map((entry: HiddenCase) => [entry.id, entry.expected]));
		const handed: TestId[][] = [];
		const outcome = await judge(book, hiddenContractOf(retired).digest, retired.map(entry => entry.id),
			call => expectedById.get(call.id) ?? answerWith(trustedFormat)(call), handed);
		const verdict = verdictOf(outcome);
		assert.equal(verdict.result, "VERIFIED");
		assert.deepEqual(handed[0], [...FROZEN_IDS, ...HIDDEN_6], "the run was handed the frozen suite and the retired set, and nothing else");
		if (verdict.result !== "VERIFIED") return;
		assert.deepEqual([verdict.frozen.passed, verdict.frozen.expected, verdict.hidden.passed, verdict.hidden.expected], [48, 48, 6, 6]);
	} finally {
		rmSync(dirname(registryPath), { recursive: true, force: true });
	}
});

test("the example's negative cases verify the trusted fix and reject a sign-dropped or sign-misplaced fix on hidden:7 and hidden:8", async () => {
	const book = fixtureBook(bookEntry(exampleCases));
	const trusted = verdictOf(await judge(book, exampleContract.digest, exampleContract.ids, answerWith(trustedFormat)));
	assert.equal(trusted.result, "VERIFIED");
	if (trusted.result !== "VERIFIED") return;
	assert.deepEqual([trusted.frozen.passed, trusted.frozen.expected, trusted.hidden.passed, trusted.hidden.expected], [48, 48, 8, 8]);
	for (const format of [signDropped, signMisplaced]) {
		const verdict = verdictOf(await judge(book, exampleContract.digest, exampleContract.ids, answerWith(format)));
		assert.equal(verdict.result, "REJECTED");
		if (verdict.result !== "REJECTED") return;
		assert.deepEqual(verdict.reasons, [{ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:7", "hidden:8"] }]);
	}
});
