import assert from "node:assert/strict";
import test from "node:test";

type RunStartSample = { markerSeconds: number | null; exitCode: number | null; agentRan: boolean; timedOut: boolean; stderr: string };
type RunStartBlocker = { reason: string; detail: string } | null;
const { agentStarted, fundedJobOf, runStartBlocker, runStartVerdict, sweepTargets } = await import(
	new URL("../../../scripts/perf/run-start.mjs", import.meta.url).href) as {
	agentStarted: (line: string) => boolean;
	fundedJobOf: (jobs: readonly unknown[], handle: string) => { id: string } | null;
	runStartBlocker: (sample: RunStartSample) => RunStartBlocker;
	runStartVerdict: (samples: readonly number[], ruleSeconds: number) => { samples: number[]; medianSeconds: number; maxSeconds: number; passed: boolean };
	sweepTargets: (resources: { jobId: string | null; killed: boolean }) => readonly { kind: string; name: string; remove: readonly string[] }[];
};

const healthy = (overrides: Partial<RunStartSample> = {}): RunStartSample =>
	({ markerSeconds: 2.5, exitCode: 0, agentRan: true, timedOut: false, stderr: "", ...overrides });

test("the agent start is the Running line run.ts prints before the sandbox, not any other line", () => {
	assert.equal(agentStarted("Running ts-bugfixer with the command runner: /tmp/acquit-run/command.sh"), true);
	assert.equal(agentStarted("Running ts-bugfixer with your Anthropic key"), true);
	assert.equal(agentStarted("Preparing sandbox for job_7Q2K"), false);
	assert.equal(agentStarted("Agent finished in 5m 08s"), false);
	assert.equal(agentStarted("acquit-perf-run-start-sentinel"), false);
});

test("the funded job is the one IN_PROGRESS, HELD, and locked to the probe's operator", () => {
	const funded = { id: "job_funded", status: "IN_PROGRESS", escrow: "HELD", lockedTo: "devon-ops" };
	const jobs = [
		null,
		{ id: "job_open", status: "OPEN", escrow: "NONE", lockedTo: null },
		{ id: "job_other", status: "IN_PROGRESS", escrow: "HELD", lockedTo: "house-tsfix" },
		{ id: "job_paid", status: "PAID", escrow: "RELEASED", lockedTo: "devon-ops" },
		{ id: "job_refunded", status: "IN_PROGRESS", escrow: "REFUNDED", lockedTo: "devon-ops" },
		funded,
	];
	assert.equal(fundedJobOf(jobs, "devon-ops")?.id, "job_funded");
	assert.equal(fundedJobOf(jobs.filter(job => job !== funded), "devon-ops"), null);
	assert.equal(fundedJobOf([], "devon-ops"), null);
});

test("a healthy sample is a measurement, and a killed sample is never one", () => {
	assert.equal(runStartBlocker(healthy()), null);
	assert.equal(runStartBlocker(healthy({ timedOut: true, markerSeconds: null, exitCode: null, agentRan: false }))?.reason, "RUN_START_TIMEOUT");
});

test("a work repo GitHub has not made visible yet blocks as WORK_REPO_NOT_READY, not as a number", () => {
	const blocker = runStartBlocker(healthy({ markerSeconds: null, exitCode: 1, agentRan: false,
		stderr: "acquit: WORK_REPO_NOT_READY: The work repository acquire/org/invoice-app-abc is not visible to the GitHub App yet.\n" }));
	assert.equal(blocker?.reason, "RUN_WORK_REPO_NOT_READY");
	const missing = runStartBlocker(healthy({ markerSeconds: null, exitCode: 1, agentRan: false,
		stderr: "acquit: GITHUB_NOT_CONFIGURED: Set ACQUIT_GITHUB_APP_ID, ACQUIT_GITHUB_APP_PRIVATE_KEY, and ACQUIT_GITHUB_APP_ORG before a run.\n" }));
	assert.equal(missing?.reason, "RUN_GITHUB_NOT_CONFIGURED");
});

test("a refusal before the marker blocks as RUN_START_FAILED and drops a credential a clone URL may carry", () => {
	const blocker = runStartBlocker(healthy({ markerSeconds: null, exitCode: 1, agentRan: false,
		stderr: "acquit: CLONE_FAILED: git clone of https://x-access-token:ghs_CANARY@github.com/org/repo.git failed.\n" }));
	assert.equal(blocker?.reason, "RUN_START_FAILED");
	assert.equal(blocker?.detail.includes("ghs_CANARY"), false);
	assert.equal(blocker?.detail.includes("CLONE_FAILED"), true);
});

test("a run that starts the agent but does not finish cleanly blocks as RUN_AGENT_FAILED", () => {
	assert.equal(runStartBlocker(healthy({ exitCode: 1, stderr: "acquit: AGENT_FAILED: The agent exited 1.\n" }))?.reason, "RUN_AGENT_FAILED");
	assert.equal(runStartBlocker(healthy({ agentRan: false }))?.reason, "RUN_AGENT_FAILED");
});

test("only a sample the probe killed leaves Docker objects to sweep", () => {
	assert.deepEqual(sweepTargets({ jobId: "job_7Q2K", killed: false }), []);
	assert.deepEqual(sweepTargets({ jobId: null, killed: true }), []);
	assert.deepEqual(sweepTargets({ jobId: null, killed: false }), []);
	const targets = sweepTargets({ jobId: "job_7Q2K", killed: true });
	assert.deepEqual(targets.map(target => target.name), ["acquit-runner-job_7Q2K", "acquit-runner-job_7Q2K-proxy",
		"acquit-runner-job_7Q2K-net", "acquit-runner-job_7Q2K-egress"]);
	assert.deepEqual(targets.map(target => target.kind), ["container", "container", "network", "network"]);
	assert.deepEqual(targets[0].remove, ["rm", "--force", "acquit-runner-job_7Q2K"]);
	assert.deepEqual(targets[2].remove, ["network", "rm", "acquit-runner-job_7Q2K-net"]);
});

test("the verdict is the median of the samples against the rule, rounded for the report", () => {
	const within = runStartVerdict([2.12, 4.04, 6.06], 30);
	assert.deepEqual(within.samples, [2.1, 4, 6.1]);
	assert.equal(within.medianSeconds, 4);
	assert.equal(within.maxSeconds, 6.1);
	assert.equal(within.passed, true);
	const over = runStartVerdict([31, 32, 33], 30);
	assert.equal(over.medianSeconds, 32);
	assert.equal(over.passed, false);
	const even = runStartVerdict([2, 4], 30);
	assert.equal(even.medianSeconds, 3);
	assert.equal(even.passed, true);
	const atTheRule = runStartVerdict([29.9, 30, 30.1], 30);
	assert.equal(atTheRule.medianSeconds, 30);
	assert.equal(atTheRule.passed, true);
});
