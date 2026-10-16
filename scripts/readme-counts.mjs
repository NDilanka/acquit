// Rewrites the test-count and score-card lines of README.md from the latest green CI run on main.
//
//   npm run readme:counts
//
// Needs gh authenticated for NDilanka/acquit. README.md is written only after every check passes.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "NDilanka/acquit";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const README = fileURLToPath(new URL("../README.md", import.meta.url));
const START = "<!-- counts:start -->";
const END = "<!-- counts:end -->";
const BADGE = "[![CI](https://github.com/NDilanka/acquit/actions/workflows/ci.yml/badge.svg)](https://github.com/NDilanka/acquit/actions/workflows/ci.yml)";
const TOTAL_LINE = /^ℹ (tests|pass|fail|skipped) (\d+)$/;
const SCORE_CARD = /SCORE CARD caught (\d+) of (\d+) known cheats, passed (\d+) of (\d+) honest submissions/;

/** The messages of the test job's lines in `gh run view --log` output, timestamps removed. */
export function testJobMessages(log) {
	const messages = [];
	for (const line of log.split(/\r?\n/)) {
		const first = line.indexOf("\t");
		const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
		if (second < 0 || line.slice(0, first) !== "test") continue;
		messages.push(line.slice(second + 1).trim().replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""));
	}
	return messages;
}

export function parseTestTotals(log) {
	const totals = {};
	for (const message of testJobMessages(log)) {
		const match = TOTAL_LINE.exec(message);
		if (!match) continue;
		if (match[1] in totals) throw new Error(`test job prints "ℹ ${match[1]}" twice`);
		totals[match[1]] = Number(match[2]);
	}
	for (const key of ["tests", "pass", "fail", "skipped"]) {
		if (!(key in totals)) throw new Error(`test job has no "ℹ ${key}" line`);
	}
	return totals;
}

export function assertGreen(totals) {
	if (totals.fail > 0) throw new Error(`CI run has ${totals.fail} failing test(s); README not changed`);
}

export function parseScoreCard(log) {
	const found = testJobMessages(log).map(message => SCORE_CARD.exec(message)).filter(match => match !== null);
	if (found.length !== 1) throw new Error(`test job has ${found.length} SCORE CARD lines, expected 1; README not changed`);
	const [, caught, cheats, passed, honest] = found[0];
	return { cheatsCaught: Number(caught), cheatsTotal: Number(cheats), honestPassed: Number(passed), honestTotal: Number(honest) };
}

/** Counts the tracked files the test script names. A `*` stays within one directory, as sh expands it. */
export function testFilesMatched(testScript, trackedPaths) {
	const patterns = testScript.split(/\s+/).filter(token => token.includes("*") || /\.test\.(ts|mjs)$/.test(token));
	const matchers = patterns.map(pattern => new RegExp(`^${pattern.split("*").map(escapeRegExp).join("[^/]*")}$`));
	return trackedPaths.filter(path => matchers.some(matcher => matcher.test(path))).length;
}

function escapeRegExp(text) {
	return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function renderBlock({ pass, files, card, run }) {
	const count = `${BADGE} ${pass} tests pass across ${files} test files in CI.`;
	const judged = `The verifier score card caught ${card.cheatsCaught} of ${card.cheatsTotal} known cheats and passed ${card.honestPassed} of ${card.honestTotal} honest submissions through the real judge with a child-process subject. Docker isolation is tested separately. The result is in [CI run ${run.databaseId}](${run.url}).`;
	return [START, count, "", judged, END].join("\n");
}

export function spliceReadme(readme, block) {
	const start = readme.indexOf(START);
	const end = readme.indexOf(END);
	const repeated = start < 0 || readme.indexOf(START, start + 1) >= 0 || readme.indexOf(END, end + 1) >= 0;
	if (repeated || end < start) throw new Error(`README needs exactly one ${START} ... ${END} pair; README not changed`);
	return readme.slice(0, start) + block + readme.slice(end + END.length);
}

function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function git(args) {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function latestGreenMainRun() {
	const runs = JSON.parse(gh(["run", "list", "--repo", REPO, "--workflow", "ci.yml", "--branch", "main", "--status", "success", "--limit", "1", "--json", "databaseId,headSha,url"]));
	if (runs.length === 0) throw new Error("no successful ci.yml run on main");
	return runs[0];
}

async function main() {
	const run = latestGreenMainRun();
	const log = gh(["run", "view", String(run.databaseId), "--repo", REPO, "--log"]);
	const totals = parseTestTotals(log);
	assertGreen(totals);
	const card = parseScoreCard(log);
	const testScript = JSON.parse(git(["show", `${run.headSha}:package.json`])).scripts.test;
	const trackedPaths = git(["ls-tree", "-r", "--full-tree", "--name-only", run.headSha]).split("\n").filter(Boolean);
	const files = testFilesMatched(testScript, trackedPaths);

	const readme = readFileSync(README, "utf8");
	const eol = readme.includes("\r\n") ? "\r\n" : "\n";
	const block = renderBlock({ pass: totals.pass, files, card, run });
	writeFileSync(README, spliceReadme(readme.replace(/\r\n/g, "\n"), block).replace(/\n/g, eol));
	console.log(`README counts from CI run ${run.databaseId} (${run.headSha}): ${totals.pass} pass, ${files} test files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		console.error(`readme:counts: ${error.message}`);
		process.exitCode = 1;
	});
}
