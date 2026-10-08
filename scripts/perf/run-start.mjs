// The pure pieces of the cli probe's runStart metric: which line is the agent start, which job a lane
// can measure, why a sample is not a number, what a set of samples decides, which Docker objects a
// sample the probe killed leaves behind, and the environment a sample child gets. cli.mjs owns the
// process, the Docker preconditions, and the report; these are the rules it reads.

import { join } from "node:path";

/** One sample is a whole `acquit run`; a run that has not reached the agent start in this long is not
 * a slow number to keep waiting for. */
export const RUN_SAMPLE_TIMEOUT_MS = 180_000;

/**
 * The environment one runStart sample child gets. The CLI keeps a job's git directory under
 * `$XDG_STATE_HOME/acquit/work` (`%LOCALAPPDATA%\acquit\work` on Windows), so the probe points both
 * at its own temp root: the sample clones its own `--dir`, and the measured lane's state git
 * directory — which records another work tree — can never refuse it DIR_NOT_WORK_REPO. The sweep
 * removes the temp root, and the state home with it. Pure: the caller passes the base environment
 * and the platform.
 */
export function sampleEnv(base, { token, image, temp, platform = process.platform }) {
	const env = { ...base, ACQUIT_TOKEN: token, ACQUIT_RUNNER_IMAGE: image,
		ACQUIT_CLI_CONFIG: join(temp, "cli.json"), TMPDIR: temp, XDG_STATE_HOME: join(temp, "state") };
	if (platform === "win32") env.LOCALAPPDATA = join(temp, "local");
	return env;
}

/** `acquit run` prints this line (renderRunning in packages/acquit-cli/src/run.ts) immediately before
 * it starts the sandbox, so it is the moment the run-start clock stops. The command runner names the
 * script it will run; the claude-code runner names the operator's own key. */
const AGENT_START = /^Running .+ with (?:the command runner: |your Anthropic key$)/;

export function agentStarted(line) {
	return AGENT_START.test(line);
}

/** The first IN_PROGRESS job whose escrow is HELD and that is locked to the probe's operator. */
export function fundedJobOf(jobs, handle) {
	for (const job of jobs) {
		if (job === null || typeof job !== "object") continue;
		const candidate = job;
		if (candidate.status === "IN_PROGRESS" && candidate.escrow === "HELD" && candidate.lockedTo === handle
			&& typeof candidate.id === "string" && candidate.id !== "") return job;
	}
	return null;
}

/** The code of the CLI's own refusal line (`acquit: CODE: detail` on stderr), the last one it printed. */
function refusalCode(stderr) {
	const lines = String(stderr ?? "").split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const match = /^acquit: ([A-Z][A-Z0-9_]*): /.exec(lines[index]);
		if (match) return match[1];
	}
	return null;
}

/** A clone URL may embed a credential in its userinfo; evidence never keeps one. */
function safeLine(line) {
	return String(line ?? "").replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s]*@/g, "$1").trim().slice(0, 200);
}

/**
 * Why one `acquit run` sample is not a number, or null when it is one: the agent-start marker, a
 * clean exit, and the command script's sentinel all arrived. Preconditions the probe cannot meet are
 * named so the caller can report them as blocked instead of fabricating a start time.
 */
export function runStartBlocker({ markerSeconds, exitCode, agentRan, timedOut, stderr }) {
	if (markerSeconds !== null && exitCode === 0 && agentRan) return null;
	const last = safeLine(String(stderr ?? "").trim().split("\n").filter(line => line !== "").at(-1) ?? "");
	if (timedOut) {
		return { reason: "RUN_START_TIMEOUT", detail: `The CLI did not reach its agent-start marker within ${RUN_SAMPLE_TIMEOUT_MS / 1000} seconds.` };
	}
	const refusal = refusalCode(stderr);
	if (markerSeconds === null) {
		if (refusal === "WORK_REPO_NOT_READY") {
			return { reason: "RUN_WORK_REPO_NOT_READY",
				detail: "The work-repo route answered WORK_REPO_NOT_READY: GitHub has not made the job's fork visible yet. Rerun the probe in about 30 seconds." };
		}
		if (refusal === "GITHUB_NOT_CONFIGURED") {
			return { reason: "RUN_GITHUB_NOT_CONFIGURED",
				detail: "The API holds no GitHub App configuration, so it cannot mint a work-repo credential. Set ACQUIT_GITHUB_APP_ID, ACQUIT_GITHUB_APP_PRIVATE_KEY, and ACQUIT_GITHUB_APP_ORG, then rerun." };
		}
		return { reason: "RUN_START_FAILED",
			detail: `acquit run never printed its agent-start marker (exit ${exitCode ?? "without a status"}). ${last}`.trim() };
	}
	const why = refusal !== null ? `the CLI refused ${refusal}` : agentRan ? `the CLI exited ${exitCode ?? "without a status"}` : "the command script never ran inside the sandbox";
	return { reason: "RUN_AGENT_FAILED", detail: `The agent start was printed, but ${why}. ${last}`.trim() };
}

/** Median of the samples in seconds, rounded for the report, against the rule. */
export function runStartVerdict(samples, ruleSeconds) {
	const sorted = [...samples].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	const round = value => Math.round(value * 10) / 10;
	return { samples: samples.map(round), medianSeconds: round(median), maxSeconds: round(Math.max(...samples)), passed: median <= ruleSeconds };
}

/**
 * The Docker objects a sweep may remove. Only a sample the probe killed or timed out can leave the
 * measured job's runner container, proxy, and networks behind: a sample left to finish runs the CLI's
 * own cleanup, so a probe that killed nothing returns no targets and never touches Docker.
 */
export function sweepTargets({ jobId, killed }) {
	if (jobId === null || !killed) return [];
	return [
		{ kind: "container", name: `acquit-runner-${jobId}`, remove: ["rm", "--force", `acquit-runner-${jobId}`] },
		{ kind: "container", name: `acquit-runner-${jobId}-proxy`, remove: ["rm", "--force", `acquit-runner-${jobId}-proxy`] },
		{ kind: "network", name: `acquit-runner-${jobId}-net`, remove: ["network", "rm", `acquit-runner-${jobId}-net`] },
		{ kind: "network", name: `acquit-runner-${jobId}-egress`, remove: ["network", "rm", `acquit-runner-${jobId}-egress`] },
	];
}
