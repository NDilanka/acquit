import assert from "node:assert/strict";
import test from "node:test";

type Totals = { tests: number; pass: number; fail: number; skipped: number };
type Card = { cheatsCaught: number; cheatsTotal: number; honestPassed: number; honestTotal: number };
const counts = await import(new URL("../../../scripts/readme-counts.mjs", import.meta.url).href) as {
	parseTestTotals: (log: string) => Totals;
	parseScoreCard: (log: string) => Card;
	assertGreen: (totals: Totals) => void;
	testFilesMatched: (testScript: string, trackedPaths: readonly string[]) => number;
	renderBlock: (input: { pass: number; files: number; card: Card; run: { databaseId: number; url: string } }) => string;
	spliceReadme: (readme: string, block: string) => string;
};

// Lines as `gh run view --log` prints them: job, step, timestamp, message.
const LOG = [
	"print-slice\tSlicer conformance tests\t2026-10-16T07:42:30.4500420Z ℹ tests 3",
	"print-slice\tSlicer conformance tests\t2026-10-16T07:42:30.4501732Z ℹ fail 0",
	"test\tRun npm test\t2026-10-16T07:45:28.0965282Z ℹ tests 1008",
	"test\tRun npm test\t2026-10-16T07:45:28.0966231Z ℹ pass 976",
	"test\tRun npm test\t2026-10-16T07:45:28.0966584Z ℹ fail 0",
	"test\tRun npm test\t2026-10-16T07:45:28.0967548Z ℹ skipped 32",
	"test\tRun npm test\t2026-10-16T07:45:28.0967855Z SCORE CARD caught 11 of 11 known cheats, passed 20 of 20 honest submissions",
].join("\n");

const RUN = { databaseId: 38868866144, url: "https://github.com/NDilanka/acquit/actions/runs/38868866144" };
const CARD = { cheatsCaught: 11, cheatsTotal: 11, honestPassed: 20, honestTotal: 20 };

test("the test job's totals come from its own lines, not print-slice's", () => {
	assert.deepEqual(counts.parseTestTotals(LOG), { tests: 1008, pass: 976, fail: 0, skipped: 32 });
});

test("the SCORE CARD line parses to its four literal counts", () => {
	assert.deepEqual(counts.parseScoreCard(LOG), CARD);
});

test("a run without a SCORE CARD line is refused", () => {
	const withoutCard = LOG.split("\n").filter(line => !line.includes("SCORE CARD")).join("\n");
	assert.throws(() => counts.parseScoreCard(withoutCard), /test job has 0 SCORE CARD lines/);
});

test("a run with a failing test is refused", () => {
	assert.throws(() => counts.assertGreen({ tests: 1008, pass: 975, fail: 1, skipped: 32 }), /CI run has 1 failing test/);
	assert.equal(counts.assertGreen({ tests: 1008, pass: 976, fail: 0, skipped: 32 }), undefined);
});

test("the test file count follows the test script's globs and literal paths", () => {
	const script = "node --test --test-timeout=60000 --test-concurrency=1 packages/core/test/*.test.ts packages/ctl/test/*.test.ts .factory/skills/verify-acquit/scripts/stream-guard.test.mjs";
	const tree = [
		"packages/core/test/alpha.test.ts",
		"packages/core/test/score-card-corpus.ts",
		"packages/core/test/nested/beta.test.ts",
		"packages/ctl/test/gamma.test.ts",
		".factory/skills/verify-acquit/scripts/stream-guard.test.mjs",
		".factory/skills/verify-acquit/scripts/other.test.mjs",
		"apps/api/test/delta.test.ts",
	];
	assert.equal(counts.testFilesMatched(script, tree), 3);
});

test("the README block carries the counts and the run link on its two lines", () => {
	const block = counts.renderBlock({ pass: 976, files: 110, card: CARD, run: RUN });
	const lines = block.split("\n");
	assert.equal(lines[0], "<!-- counts:start -->");
	assert.equal(lines[1], "[![CI](https://github.com/NDilanka/acquit/actions/workflows/ci.yml/badge.svg)](https://github.com/NDilanka/acquit/actions/workflows/ci.yml) 976 tests pass across 110 test files in CI.");
	assert.equal(lines[2], "");
	assert.equal(lines[3], "The verifier score card caught 11 of 11 known cheats and passed 20 of 20 honest submissions through the real judge with a child-process subject. Docker isolation is tested separately. The result is in [CI run 38868866144](https://github.com/NDilanka/acquit/actions/runs/38868866144).");
	assert.equal(lines[4], "<!-- counts:end -->");
});

test("splicing replaces only the marked block", () => {
	const block = counts.renderBlock({ pass: 976, files: 110, card: CARD, run: RUN });
	const readme = "# Acquit\n\n<!-- counts:start -->\nstale\n<!-- counts:end -->\n\nCleared, then paid.\n";
	assert.equal(counts.spliceReadme(readme, block), `# Acquit\n\n${block}\n\nCleared, then paid.\n`);
});

test("a README without exactly one marker pair is refused", () => {
	const block = counts.renderBlock({ pass: 976, files: 110, card: CARD, run: RUN });
	assert.throws(() => counts.spliceReadme("# Acquit\n", block), /exactly one/);
	assert.throws(() => counts.spliceReadme("<!-- counts:end -->\n<!-- counts:start -->\n", block), /exactly one/);
});
