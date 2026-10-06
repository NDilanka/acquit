// Perf probe for F3. One warm-up, then `--runs` rounds alternating fix-honest and tamper-test.
// It records the judge's wall time per run and, when an API and a token are supplied, the seconds
// from `acquit submit` to the printed verdict. Rules: warm judge median <= 10s, submit <= 120s.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createFakeGitHubApp } from "../../packages/core/src/github.ts";
import { instant } from "../../packages/core/src/ids.ts";
import { gitSource, hiddenManifest, runJudge } from "../../packages/verifier/judge.ts";
import { childProcessSubject, dockerReachable, dockerSubject, DockerUnavailable } from "../../packages/verifier/subject.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { values } = parseArgs({ options: {
	runs: { type: "string", default: "5" }, fixture: { type: "string" }, subject: { type: "string", default: "child" },
	api: { type: "string" }, job: { type: "string" }, evidence: { type: "string", default: "data/evidence/f3-r1-build/perf" },
} });
const runs = Number(values.runs);
assert(Number.isSafeInteger(runs) && runs >= 5, "Use at least five runs.");
const fixture = resolve(values.fixture ?? process.env.ACQUIT_VERIFIER_FIXTURE ?? resolve(root, "../../acquit/scratch/verifier/invoice-app"));
assert(existsSync(resolve(fixture, ".git")), `No invoice-app fixture at ${fixture}. Set --fixture or ACQUIT_VERIFIER_FIXTURE.`);
const branches = ["fix-honest", "tamper-test"];
const manifest = hiddenManifest();
const definition = { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
	frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4", frozenTests: Array.from({ length: 48 }, (_, index) => `frozen:${index + 1}`),
	hiddenManifest: manifest.digest, hiddenTests: manifest.cases.map(test => test.id),
	protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json"] };
const head = branch => spawnSync("git", ["-C", fixture, "rev-parse", `${branch}^{commit}`], { encoding: "utf8" }).stdout.trim();
if (values.subject === "docker" && !dockerReachable()) throw new DockerUnavailable();
const subject = values.subject === "docker" ? dockerSubject() : childProcessSubject();
const source = gitSource(fixture);
const samples = { "fix-honest": [], "tamper-test": [] };
const expected = { "fix-honest": "VERIFIED", "tamper-test": "REJECTED" };

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

let submit = { measured: false };
if (values.api) {
	submit = await submitToVerdict(values.api, values.job);
}

const report = { runs, subject: values.subject, fixture, judge: { samples, medianMs: judgeMedian, worstMs: Math.max(...Object.values(samples).flat()) },
	rules: { judgeMedianMs: 10_000, submitMedianMs: 120_000 }, judgePassed: Math.max(...Object.values(judgeMedian)) <= 10_000,
	prototypeChildProcessMedianMs: 623, trunkBaseline: "trunk has no verifier; the metric cannot be produced there",
	submit, node: process.version };
const evidence = resolve(root, values.evidence);
await mkdir(evidence, { recursive: true });
await writeFile(resolve(evidence, "verifier.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!report.judgePassed) process.exitCode = 1;

/** The end-to-end metric needs an API whose verdict path is wired; report the block by name when it is not. */
async function submitToVerdict(api, jobId) {
	const token = process.env.ACQUIT_TOKEN;
	if (!jobId || !token) return { measured: false, blocked: "AUTH_REQUIRED", detail: "Set --job and ACQUIT_TOKEN to time the end-to-end path." };
	const branch = "fix-honest";
	const commit = head(branch);
	const call = (path, init) => fetch(new URL(path, api), { ...init, headers: { "content-type": "application/json", cookie: `acquit_session=${token}` } });
	const before = await call(`/api/jobs/${jobId}`);
	if (!before.ok) return { measured: false, blocked: "JOB_UNREADABLE", detail: `GET /api/jobs answered ${before.status}` };
	const started = performance.now();
	const posted = await call("/api/commands", { method: "POST", body: JSON.stringify({ key: randomUUID(),
		command: { type: "Submit", jobId, sourceCommit: commit } }) });
	if (!posted.ok) return { measured: false, blocked: "SUBMIT_REFUSED", detail: `POST /api/commands answered ${posted.status}` };
	for (;;) {
		const view = (await (await call(`/api/jobs/${jobId}`)).json()).job;
		const judged = view.attempts.history.find(attempt => attempt.sourceCommit === commit);
		if (judged) return { measured: true, seconds: (performance.now() - started) / 1000, result: judged.result, samples: 1 };
		if (!view.attempts.pending) return { measured: false, blocked: "VERDICT_MISSING", detail: `no verdict and no run for ${commit}` };
		if (performance.now() - started > 120_000) return { measured: false, blocked: "VERDICT_TIMEOUT",
			detail: "the run never reported; no signed callback reached the API within 120 seconds" };
		await new Promise(resolve => setTimeout(resolve, 500));
	}
}
