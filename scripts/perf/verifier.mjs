// Perf probe for F3. One warm-up, then `--runs` rounds alternating fix-honest and tamper-test.
// It records the judge's wall time per run and, when an API and a job are supplied, the seconds from
// `acquit submit` to the verdict the CLI prints. Rules: warm judge median <= 10s, submit <= 120s.
//
// The probe exits 0 only when every metric it was asked for was measured. A missing Docker subject,
// a missing job, a missing token, or a CLI that cannot print a verdict is reported as `blocked` in
// `verifier.json` and exits 1: a judge-only number is not a pass for the end-to-end rule.
//
//   node scripts/perf/verifier.mjs --runs 5 --api http://127.0.0.1:4310 --job job_7Q2K
//   node scripts/perf/verifier.mjs --runs 5 --subject child --dev        (unit path, judge only)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createFakeGitHubApp } from "../../packages/core/src/github.ts";
import { instant } from "../../packages/core/src/ids.ts";
import { frozenDefinition } from "../../packages/core/src/seed-data.ts";
import { gitSource, hiddenManifest, runJudge } from "../../packages/verifier/judge.ts";
import { childProcessSubject, dockerReachable, dockerSubject } from "../../packages/verifier/subject.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { values } = parseArgs({ options: {
	runs: { type: "string", default: "5" }, fixture: { type: "string" }, subject: { type: "string", default: "docker" },
	dev: { type: "boolean", default: false }, api: { type: "string" }, job: { type: "string" },
	evidence: { type: "string", default: "data/evidence/f3-r1-build/perf" },
} });
const runs = Number(values.runs);
assert(Number.isSafeInteger(runs) && runs >= 5, "Use at least five runs.");
const fixture = resolve(values.fixture ?? process.env.ACQUIT_VERIFIER_FIXTURE ?? resolve(root, "../../acquit/scratch/verifier/invoice-app"));
const evidence = resolve(root, values.evidence);
const branches = ["fix-honest", "tamper-test"];
const expected = { "fix-honest": "VERIFIED", "tamper-test": "REJECTED" };

/** One report, one reason, and a nonzero exit. Nothing below the block is measured. */
async function blocked(reason, detail) {
	const report = { runs, subject: values.subject, devPath: values.subject === "child", fixture, blocked: reason, detail,
		judge: null, submit: null, judgePassed: false, submitMeasured: false, passed: false, rules: { judgeMedianMs: 10_000, submitMedianMs: 120_000 },
		node: process.version };
	await mkdir(evidence, { recursive: true });
	await writeFile(resolve(evidence, "verifier.json"), JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report));
	process.exit(1);
}

assert(existsSync(resolve(fixture, ".git")), `No invoice-app fixture at ${fixture}. Set --fixture or ACQUIT_VERIFIER_FIXTURE.`);
// The product subject is the Docker one. The child-process subject is the unit path, and asking for
// it is an explicit acknowledgement that the number does not come from the product path.
if (values.subject === "docker" && !dockerReachable()) {
	await blocked("DOCKER_UNAVAILABLE", "The Docker subject is unreachable. Start Docker, or pass --subject child --dev for the unit path.");
}
if (values.subject === "child" && !values.dev) {
	await blocked("CHILD_SUBJECT_NEEDS_DEV", "The child-process subject is the unit-test path. Pass --dev to acknowledge that.");
}
const definition = frozenDefinition();
const manifest = hiddenManifest();
const head = branch => spawnSync("git", ["-C", fixture, "rev-parse", `${branch}^{commit}`], { encoding: "utf8" }).stdout.trim();
assert.equal(spawnSync("git", ["-C", fixture, "cat-file", "-e", `${definition.frozenAt}^{commit}`]).status, 0,
	`The fixture does not carry the contract's frozen commit ${definition.frozenAt}.`);
const subject = values.subject === "docker" ? dockerSubject() : childProcessSubject();
const source = gitSource(fixture);
const samples = { "fix-honest": [], "tamper-test": [] };

async function one(branch, warm) {
	const started = performance.now();
	const outcome = await runJudge({ runId: `run_perf_${branch}_${samples[branch].length + 1}`, jobId: "job_perf", ordinal: 1,
		sourceCommit: head(branch), definitionOfDone: definition }, { source, subject, publisher: createFakeGitHubApp(),
		clock: { now: () => instant(new Date().toISOString()) } });
	const wallMs = performance.now() - started;
	assert.equal(outcome.kind, "VERDICT", `${branch} produced no verdict`);
	assert.equal(outcome.verdict.result, expected[branch], `${branch} decided ${outcome.verdict.result}`);
	if (!warm) samples[branch].push(wallMs);
	console.log(JSON.stringify({ branch, warm, result: outcome.verdict.result, wallMs: Number(wallMs.toFixed(1)),
		subjectMs: Number(outcome.timings.subjectMs.toFixed(1)), screenMs: Number(outcome.timings.screenMs.toFixed(1)) }));
	return wallMs;
}

await one("fix-honest", true);
for (let round = 0; round < runs; round++) await one(branches[round % 2], false);

const median = values => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const judgeMedian = { "fix-honest": median(samples["fix-honest"]), "tamper-test": median(samples["tamper-test"]) };
const judgePassed = Math.max(...Object.values(judgeMedian)) <= 10_000;
const submit = values.api ? await submitToVerdict(values.api, values.job) : { measured: false, blocked: "NOT_REQUESTED",
	detail: "Pass --api and --job to time the CLI's submit-to-verdict path." };
const report = { runs, subject: values.subject, devPath: values.subject === "child", fixture,
	judge: { samples, medianMs: judgeMedian, worstMs: Math.max(...Object.values(samples).flat()) },
	rules: { judgeMedianMs: 10_000, submitMedianMs: 120_000 }, judgePassed, submit, submitMeasured: submit.measured === true,
	passed: judgePassed && submit.measured === true, blocked: submit.measured === true ? null : submit.blocked ?? "SUBMIT_UNMEASURED",
	prototypeChildProcessMedianMs: 623, trunkBaseline: "trunk has no verifier; the metric cannot be produced there",
	node: process.version };
await mkdir(evidence, { recursive: true });
await writeFile(resolve(evidence, "verifier.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;

/**
 * The end-to-end metric is the CLI's own printed verdict: a throwaway checkout of the honest branch,
 * `acquit submit` with the session token on stdin, and the seconds until the block is printed.
 */
async function submitToVerdict(api, jobId) {
	const token = process.env.ACQUIT_TOKEN;
	if (!jobId) return { measured: false, blocked: "JOB_REQUIRED", detail: "Pass --job <id> to time the end-to-end path." };
	if (!token) return { measured: false, blocked: "AUTH_REQUIRED", detail: "Set ACQUIT_TOKEN to the operator's session token." };
	const work = mkdtempSync(join(tmpdir(), "acquit-perf-work-"));
	try {
		const clone = spawnSync("git", ["clone", "--quiet", "--branch", "fix-honest", fixture, work], { encoding: "utf8", timeout: 60_000 });
		if (clone.status !== 0) return { measured: false, blocked: "CLONE_FAILED", detail: tail(clone.stderr) };
		const started = performance.now();
		const cli = spawnSync(process.execPath, [resolve(root, "packages/acquit-cli/src/main.ts"), "submit", jobId,
			"--dir", work, "--api", api, "--timeout", "120", "--token"],
			{ encoding: "utf8", input: `${token}\n`, timeout: 180_000, env: { ...process.env, ACQUIT_TOKEN: "" } });
		const seconds = (performance.now() - started) / 1000;
		const result = String(cli.stdout ?? "").match(/^Verifier result: (\w+)$/m)?.[1] ?? null;
		if (cli.status !== 0 || result === null) return { measured: false, blocked: `CLI_EXIT_${cli.status}`,
			detail: tail(cli.stderr), seconds };
		return { measured: true, seconds, result, samples: 1 };
	} finally { rmSync(work, { recursive: true, force: true }); }
}

function tail(text) {
	return String(text ?? "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
}
