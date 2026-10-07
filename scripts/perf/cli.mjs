// Perf probe for F5: the operator CLI's start cost and `acquit jobs list`, trunk against head.
//
//   node scripts/perf/cli.mjs --rounds 5
//   node scripts/perf/cli.mjs --rounds 5 --trunk /tmp/acquit-perf-trunk --head .
//   node scripts/perf/cli.mjs --rounds 5 --clean
//   ACQUIT_TOKEN=<lane session> node scripts/perf/cli.mjs --run-lane 16 --run-job job_<id>
//
// The trunk worktree defaults to a short path outside the repo because the control CLI's ownership
// proof is a Unix socket under <worktree>/data/ctl/lane-<n>/own-<nonce>.sock, and Linux caps that path
// at 107 bytes. A worktree nested inside this one (data/perf/trunk) overruns the cap, the preload fails
// closed, and every spawned service exits before it prints. Pass --trunk a short path if the default
// does not suit.
//
// Trunk safety. Before any git command, the probe refuses a --trunk that names the same worktree as
// --head, a main worktree, a directory that is not a worktree root, a non-default path whose HEAD is
// not detached, and a non-default existing path the repo does not list as a registered linked
// worktree. A missing --trunk is created only at the default throwaway path. Under --clean the probe
// removes the trunk worktree only when this run created it or it verified it as a linked worktree this
// repo registered, and removes lane data only for lanes this run started.
//
// The probe boots two isolated instances on separate lanes: one from a detached trunk worktree
// (origin/main, fetched and checked out before every run, created here when missing) and one from the
// head worktree. The head lane is seeded once, so its database holds the tutorial's open job.
//
// Live-lane run start. `--run-lane <n> --run-job <jobId>` measures only runStart, against a lane the
// operator already has running (laneSlot(n)'s API port), and writes its report to
// <evidence>/run-start.json so a full run's cli.json is not overwritten. Both flags together or
// neither. The session token comes from ACQUIT_TOKEN in the environment, never argv, and the probe
// neither boots, seeds, stops, nor otherwise touches that lane: it starts no lane and stops none, and
// its sweep removes only the acquit-runner-<job> objects and temp roots its own samples made. Without
// the flags the runStart metric keeps the seeded-head-lane path below and reports a blocked metric
// when that lane holds no funded job.
//
// Metrics.
//   help: the seconds one `acquit submit --help` process takes, trunk and head, on the same machine.
//   It is the CLI's start cost: module load, command table, usage. Trunk carries no per-command help,
//   so it answers that argv with USAGE and exit 1; the work is the same and each side's exit codes are
//   recorded. Trunk's median is the baseline and is recorded first.
//   jobsList: the seconds one `acquit jobs list` process takes against the seeded head lane, after one
//   untimed warm-up. The command signs in the way the operator does: the token from `acquit login`,
//   handed to the process in its environment, never in argv.
//   runStart: `acquit run` from process start to the agent-start line renderRunning prints just
//   before the sandbox starts, once warm: one untimed warm-up that clones the job's fork, then one
//   timed sample per round on the same --dir. It needs a funded IN_PROGRESS job locked to devon-ops
//   in the head lane, Docker, and the runner image. The seed opens no job, and this probe creates
//   nothing on GitHub and moves no money, so a lane without one is reported as blocked
//   (RUN_NEEDS_FUNDED_JOB, RUN_DOCKER_UNAVAILABLE, RUN_IMAGE_MISSING, RUN_WORK_REPO_NOT_READY,
//   RUN_GITHUB_NOT_CONFIGURED), never as a fabricated number, and a blocked metric never fails.
//
// Rules. Fail if the head --help median exceeds the trunk median by more than 20 percent. Fail if the
// jobs list median exceeds 800 ms. Fail if the warm run start median exceeds 30 seconds.
//
// Cleanup. Both lanes are stopped; the trunk worktree stays in place for the next run unless --clean
// removes it and this run's lane data (the lane 0 database is never a probe lane and is never touched).
// Nothing is created on GitHub and no money moves.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { captured, portOpen, reachable, sleep } from "../../packages/ctl/src/process.ts";
import { laneSlot } from "../../packages/ctl/src/state.ts";
import { dockerReachable } from "../../packages/verifier/subject.ts";
import { agentStarted, fundedJobOf, RUN_SAMPLE_TIMEOUT_MS, runStartBlocker, runStartVerdict, sampleEnv, sweepTargets } from "./run-start.mjs";
import { probePassed } from "./verdict.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
// A short default: see the ownership-socket note at the top of this file.
const defaultTrunk = join(tmpdir(), "acquit-perf-trunk");
const { values } = parseArgs({ options: {
	rounds: { type: "string", default: "5" },
	trunk: { type: "string", default: defaultTrunk },
	head: { type: "string", default: root },
	"trunk-lane": { type: "string", default: "15" },
	"head-lane": { type: "string", default: "16" },
	"run-lane": { type: "string" },
	"run-job": { type: "string" },
	evidence: { type: "string", default: "data/evidence/f5-r1/perf" },
	clean: { type: "boolean", default: false },
} });
const rounds = Number(values.rounds);
const trunkLane = Number(values["trunk-lane"]);
const headLane = Number(values["head-lane"]);
const trunkDir = resolve(root, values.trunk);
const headDir = resolve(values.head);
assert(Number.isSafeInteger(rounds) && rounds >= 1, "--rounds must be at least 1.");
assert(trunkLane !== headLane && trunkLane >= 1 && headLane >= 1, "Use two distinct lanes of 1 or more: lane 0 is the real database.");
// The live-lane mode measures runStart against a lane the operator runs; the pair is the mode switch.
const runLane = values["run-lane"] === undefined ? null : Number(values["run-lane"]);
const runJob = values["run-job"] ?? null;
assert((runLane === null) === (runJob === null), "Pass both --run-lane and --run-job, or neither.");
assert(runLane === null || (Number.isSafeInteger(runLane) && runLane >= 1),
	"--run-lane must be 1 or more: lane 0 is the real database, which this probe never touches.");
const runOnly = runLane !== null;
const evidence = resolve(root, values.evidence);
const RULES = { headOverTrunkRatio: 1.2, jobsListMs: 800, runStartSeconds: 30 };
const RUN_START_METRIC = "acquit run from process start to agent start";
const RUN_START_RULE = `the warm run start must not exceed ${RULES.runStartSeconds} seconds`;
const RUN_START_SENTINEL = "acquit-perf-run-start-sentinel";
// The agent a runStart sample executes: one sentinel line, no file changed, exit 0. The script lives
// outside --dir, which every run checks out and cleans.
const RUN_START_SCRIPT = `#!/bin/sh\necho ${RUN_START_SENTINEL}\nexit 0\n`;

const report = { rounds, trunkDir, headDir, trunkLane, headLane, clean: values.clean,
	runOnly: runOnly ? { lane: runLane, jobId: runJob } : null, rules: RULES,
	trunkBaseline: null, trunkHead: null, headHead: null, baseline: null, help: null, jobsList: null, runStart: null,
	rounds_: [], cleanup: null, blocked: null, detail: null, passed: false, node: process.version };
const started = [];
/**
 * Where the trunk worktree stands, filled by guardTrunk before any mutating git command. `created` is
 * set when this run made the worktree, `registered` when it is a linked worktree this repo lists, and
 * `removable` when --clean may remove it: the probe only ever removes one it created or verified.
 */
const trunkState = { approved: false, created: false, registered: false, removable: false };
/** What the runStart samples leave behind: the job they ran, whether the probe killed a sample, and the temp roots to remove. */
const runStartResources = { jobId: null, killed: false, tempRoots: [] };

/** One report, one reason, and a nonzero exit. Cleanup below still runs. */
class Blocked extends Error {
	constructor(reason, detail) { super(detail); this.reason = reason; this.detail = detail; }
}

async function main() {
	if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
	try {
		if (runOnly) {
			report.headHead = headOf(headDir);
			report.runStart = await liveRunStart();
		} else {
			await preflight();
			const trunk = await boot("trunk", trunkDir, trunkLane);
			const head = await boot("head", headDir, headLane);
			await measure(trunk, head);
		}
	} catch (error) {
		report.blocked = error instanceof Blocked ? error.reason : "PROBE_FAILED";
		report.detail = error instanceof Error ? error.message : String(error);
	} finally {
		report.cleanup = await cleanup();
	}
	report.passed = probePassed(report);
	await mkdir(evidence, { recursive: true });
	await writeFile(resolve(evidence, runOnly ? "run-start.json" : "cli.json"), JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report));
}

/** The real path of an existing path, or of its deepest existing ancestor plus the rest. */
function realPath(path) {
	const parts = [];
	let current = resolve(path);
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return current;
		parts.unshift(basename(current));
		current = parent;
	}
	try { return join(realpathSync(current), ...parts); } catch { return resolve(path); }
}

/** The linked worktrees this repo registered, by real path. The first entry is the main worktree and is never one. */
function registeredWorktrees() {
	const registered = new Set();
	const listed = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
	if (listed.status !== 0) return registered;
	for (const block of String(listed.stdout).split("\n\n").slice(1)) {
		const line = block.split("\n").find(entry => entry.startsWith("worktree "));
		if (line) registered.add(realPath(line.slice("worktree ".length).trim()));
	}
	return registered;
}

/**
 * The trunk worktree the probe may force-check-out and, under --clean, remove. The first check, before
 * any git command, is that --trunk and --head name different worktrees: `--trunk .` or `--trunk <the
 * head worktree>` would otherwise check the head out and later remove it. After that, only the default
 * throwaway (created here when missing) or a linked worktree this repo registered whose HEAD is
 * detached is accepted.
 */
function guardTrunk() {
	const trunkReal = realPath(trunkDir);
	const headReal = realPath(headDir);
	if (trunkReal === headReal) {
		throw new Blocked("TRUNK_IS_HEAD",
			`--trunk and --head name the same worktree (${trunkReal}); the probe would check it out and later remove it. Point --head at the head worktree and --trunk at ${defaultTrunk}.`);
	}
	const isDefault = realPath(trunkDir) === realPath(defaultTrunk);
	if (!existsSync(trunkDir)) {
		if (!isDefault) throw new Blocked("TRUNK_MISSING", `No trunk worktree at ${trunkDir}, and the probe only creates the default throwaway (${defaultTrunk}).`);
		trunkState.approved = true;
		return;
	}
	const dotGit = resolve(trunkDir, ".git");
	if (!existsSync(dotGit)) throw new Blocked("TRUNK_NOT_A_WORKTREE", `${trunkDir} is not the root of a git worktree; refusing to check it out or remove it.`);
	if (statSync(dotGit).isDirectory()) throw new Blocked("TRUNK_IS_MAIN_WORKTREE", `${trunkDir} is a main worktree; the probe only touches the default throwaway or a linked worktree with a detached HEAD.`);
	const pointer = readFileSync(dotGit, "utf8").trim();
	const gitDir = pointer.startsWith("gitdir:") ? resolve(trunkDir, pointer.slice("gitdir:".length).trim()) : null;
	const headFile = gitDir === null ? null : resolve(gitDir, "HEAD");
	const head = headFile !== null && existsSync(headFile) ? readFileSync(headFile, "utf8").trim() : "";
	const detached = head !== "" && !head.startsWith("ref:");
	if (!isDefault && !detached) {
		throw new Blocked("TRUNK_NOT_DETACHED",
			`${trunkDir} has a branch checked out; only a detached linked worktree may be force-checked-out. Run git -C ${trunkDir} checkout --detach, or pass --trunk ${defaultTrunk}.`);
	}
	const registered = registeredWorktrees().has(trunkReal);
	if (!isDefault && !registered) {
		throw new Blocked("TRUNK_NOT_REGISTERED",
			`${trunkDir} is not a linked worktree this repo registered; the probe only force-checks-out the default throwaway or a worktree git lists. Pass --trunk ${defaultTrunk}, or register a detached worktree for this repo.`);
	}
	trunkState.approved = true;
	trunkState.registered = registered;
	trunkState.removable = registered;
}

async function preflight() {
	// First, before any git command: the trunk must be a worktree the probe owns, never the head.
	guardTrunk();
	assert(existsSync(resolve(root, ".env")), "The head worktree needs its .env for PayPal and GitHub configuration.");
	assert(existsSync(resolve(headDir, "package.json")), `No head worktree at ${headDir}.`);
	assert(existsSync(resolve(headDir, "packages/acquit-cli/src/main.ts")), `The head worktree at ${headDir} has no operator CLI.`);
	laneSocketFits("trunk", trunkDir, trunkLane);
	laneSocketFits("head", headDir, headLane);
	report.trunkBaseline = fetchTrunkBaseline();
	if (!existsSync(resolve(trunkDir, "package.json"))) {
		spawnSync("git", ["-C", root, "worktree", "prune"], { encoding: "utf8" });
		const added = spawnSync("git", ["-C", root, "worktree", "add", "--detach", trunkDir, report.trunkBaseline.ref], { encoding: "utf8" });
		assert.equal(added.status, 0, `Could not create the isolated trunk baseline: ${added.stderr}`);
		trunkState.created = true;
		trunkState.removable = true;
		const installed = await captured("npm", ["install"], trunkDir, process.env, 300_000);
		assert.equal(installed.code, 0, `Could not install the baseline dependencies; run npm install in ${trunkDir}.`);
	} else {
		const checkedOut = spawnSync("git", ["-C", trunkDir, "checkout", "--detach", "--force", report.trunkBaseline.ref], { encoding: "utf8" });
		assert.equal(checkedOut.status, 0, `Could not check out ${report.trunkBaseline.ref} in ${trunkDir}: ${checkedOut.stderr}`);
	}
	// The copy carries PayPal and GitHub keys; keep it owner-only on every run, not just the first.
	if (!existsSync(resolve(trunkDir, ".env"))) await copyFile(resolve(root, ".env"), resolve(trunkDir, ".env"));
	await chmod(resolve(trunkDir, ".env"), 0o600);
	report.trunkHead = headOf(trunkDir);
	report.headHead = headOf(headDir);
	if (report.trunkHead !== null && report.trunkHead === report.headHead) {
		throw new Blocked("TRUNK_EQUALS_HEAD",
			`${report.trunkHead} is both the trunk baseline and the head, so the probe would compare a build against itself. Fetch a newer origin/main or point --head at the head worktree.`);
	}
}

/**
 * The ref the trunk worktree is pinned to: the fetched origin/main, or the local main when the fetch
 * cannot authenticate. The detail never carries the remote URL, which may embed a credential.
 */
function fetchTrunkBaseline() {
	const fetched = spawnSync("git", ["-C", root, "fetch", "origin", "main"],
		{ encoding: "utf8", timeout: 120_000,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } });
	if (fetched.status === 0) return { ref: "origin/main", fetched: true, detail: null };
	const local = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "main"], { encoding: "utf8" });
	const last = String(fetched.stderr ?? fetched.error?.message ?? "").trim().split("\n").filter(line => line !== "").at(-1) ?? "";
	const detail = last.replace(/https?:\/\/\S+/g, "<remote>").slice(0, 200) || `git fetch origin main exited with ${fetched.status}`;
	if (local.status !== 0) throw new Blocked("NO_TRUNK_REF", `origin/main could not be fetched (${detail}) and the local main ref is missing.`);
	return { ref: "main", fetched: false, detail };
}

function headOf(dir) {
	const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : null;
}

/** Fail before a worktree is created when the ownership socket would overrun the Unix sun_path cap. */
function laneSocketFits(side, dir, lane) {
	if (process.platform === "win32") return;
	const socketPath = resolve(dir, laneSlot(lane).runDir, `own-${"0".repeat(32)}.sock`);
	const length = Buffer.byteLength(socketPath);
	if (length > 107) throw new Blocked("LANE_PATH_TOO_LONG",
		`The ${side} worktree path is too long for lane ${lane}: its ownership socket would be ${length} bytes, and Unix sockets cap at 107. Use a shorter worktree path, for example --trunk ${defaultTrunk}.`);
}

/** One isolated instance on its own lane. The ports must be free before it is started. */
async function boot(side, dir, lane) {
	const slot = laneSlot(lane);
	for (const [name, port] of [["api", slot.apiPort], ["web", slot.webPort], ["verifier", slot.verifierPort]]) {
		assert(!(await portOpen(port)), `Lane ${lane}'s ${name} port ${port} is already open. Stop that process or pass another --${side}-lane.`);
	}
	const instance = { side, dir, lane, slot, apiUrl: `http://127.0.0.1:${slot.apiPort}` };
	await ctl(instance, "start", "--timeout", "180");
	started.push(instance);
	const deadline = performance.now() + 120_000;
	while (!(await reachable(`${instance.apiUrl}/api/users`))) {
		assert(performance.now() < deadline, `${side} endpoints did not answer within 120 seconds.`);
		await sleep(50);
	}
	return instance;
}

async function cleanup() {
	const result = { lanesStopped: [], removed: [], skipped: [], errors: [] };
	for (const instance of started.reverse()) {
		try { await ctl(instance, "stop"); result.lanesStopped.push(`${instance.side} lane ${instance.lane}`); }
		catch (error) { result.errors.push(`${instance.side}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	const sweep = await sweepRunStart();
	result.removed.push(...sweep.removed);
	result.errors.push(...sweep.errors);
	if (values.clean) await removeArtifacts(result);
	return result;
}

/**
 * --clean: the throwaway baseline worktree and the lane data of the lanes this run actually started go
 * away. The probe's lanes are never lane 0, so the real database and its run directory are never
 * candidates for removal, and the trunk worktree goes only when this run created it or guardTrunk
 * verified it as a linked worktree this repo registered.
 */
async function removeArtifacts(result) {
	if (trunkState.removable) {
		const removed = spawnSync("git", ["-C", root, "worktree", "remove", "--force", trunkDir], { encoding: "utf8" });
		if (removed.status === 0) result.removed.push(`trunk worktree ${trunkDir}`);
		else if (existsSync(trunkDir)) result.errors.push(`trunk worktree: ${String(removed.stderr ?? "").trim().split("\n").at(-1) || `git worktree remove exited with ${removed.status}`}`);
	} else if (trunkState.approved) {
		result.skipped.push(`trunk worktree ${trunkDir}: not created by this run and not a registered linked worktree`);
	} else {
		result.skipped.push(`trunk worktree ${trunkDir}: refused by the worktree guard`);
	}
	spawnSync("git", ["-C", root, "worktree", "prune"], { encoding: "utf8" });
	for (const instance of started) {
		for (const path of [resolve(instance.dir, laneSlot(instance.lane).runDir), resolve(instance.dir, "data/verify", `lane-${instance.lane}`)]) {
			if (!existsSync(path)) continue;
			try { await rm(path, { recursive: true, force: true }); result.removed.push(path); }
			catch (error) { result.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
		}
	}
}

async function measure(trunk, head) {
	// One warm-up per metric, untimed: the first process pays for the filesystem cache, not the build.
	await help(trunk);
	await help(head);
	await seed(head);
	await jobsList(head);

	const trunkSamples = [];
	const headSamples = [];
	const listSamples = [];
	const trunkExits = [];
	const headExits = [];
	for (let round = 0; round < rounds; round++) {
		const trunkHelp = await help(trunk);
		const headHelp = await help(head);
		const list = await jobsList(head);
		trunkSamples.push(trunkHelp.ms);
		headSamples.push(headHelp.ms);
		listSamples.push(list.ms);
		trunkExits.push(trunkHelp.code);
		headExits.push(headHelp.code);
		report.rounds_.push({ round: round + 1, trunkHelpMs: round1(trunkSamples.at(-1)), headHelpMs: round1(headSamples.at(-1)),
			jobsListMs: round1(listSamples.at(-1)) });
		console.log(JSON.stringify(report.rounds_.at(-1)));
	}
	// Trunk's median is the baseline, recorded before the head's own number is judged against it.
	const trunkMedian = median(trunkSamples);
	const headMedian = median(headSamples);
	report.baseline = { side: "trunk", metric: "acquit submit --help wall time", medianMs: round1(trunkMedian), samples: trunkSamples.map(round1) };
	report.help = { trunk: { samples: trunkSamples.map(round1), exitCodes: trunkExits, medianMs: round1(trunkMedian) },
		head: { samples: headSamples.map(round1), exitCodes: headExits, medianMs: round1(headMedian) },
		ratio: round2(headMedian / trunkMedian), passed: headMedian <= trunkMedian * RULES.headOverTrunkRatio };
	const listMedian = median(listSamples);
	report.jobsList = { samples: listSamples.map(round1), medianMs: round1(listMedian), maxMs: round1(Math.max(...listSamples)),
		command: "acquit jobs list", passed: listMedian <= RULES.jobsListMs };
	report.runStart = await runStart(head);
}

/**
 * One `acquit submit --help` at the given side. Trunk carries no per-command help: it answers the same
 * argv with `USAGE: Unknown flag --help.` and exit 1. That is the same work — process start, module
 * load, argument parse, one printed line — so it is the same sample, and each side's exit codes are
 * recorded in the report. A process that dies without either answer fails the probe.
 */
function help(instance) {
	return cli(instance, ["submit", "--help"], { accept: result => result.status === 0 || /^acquit: USAGE: /m.test(result.stderr) });
}

/**
 * One `acquit jobs list` against the seeded lane, signed in the way the operator is: the session token
 * `acquit login` stored reaches the process in its environment, never in argv.
 */
function jobsList(instance) {
	return cli(instance, ["jobs", "list", "--api", instance.apiUrl], { env: { ACQUIT_TOKEN: instance.devon } });
}

/**
 * The runner's metric: `acquit run` from process start to the agent-start line renderRunning prints
 * just before the sandbox starts. The probe asks the CLI whether this build registers `run` — an
 * unknown command exits 2, a registered one answers its usage with 0 — then needs a funded job, Docker,
 * and the runner image. A lane without them is reported as blocked with a reason, never as a number;
 * only a measured median above the rule fails the probe.
 */
async function runStart(instance) {
	const probe = cli(instance, ["run", "--help"], { accept: () => true });
	const registered = probe.code === 0;
	const blocked = runStartBlocked(registered);
	if (!registered) return blocked("RUN_NOT_REGISTERED", "This build registers no `acquit run`, so there is no agent start to time.");
	const jobs = await headJobs(instance);
	const job = fundedJobOf(jobs, "devon-ops");
	if (job === null) {
		return blocked("RUN_NEEDS_FUNDED_JOB",
			`The seeded head lane holds no IN_PROGRESS job with HELD escrow locked to devon-ops (it serves ${jobs.length} job row${jobs.length === 1 ? "" : "s"}). `
			+ "The seed opens no job, and funding one is feature 04's PayPal sandbox flow plus the GitHub App's work repo, which this probe does not drive: "
			+ "nothing here touches GitHub and no money moves. Pass --run-lane and --run-job to measure a funded job on a lane the operator runs instead.");
	}
	const preconditions = runStartPreconditions(blocked);
	if (preconditions.image === undefined) return preconditions;
	return measureRunStart(instance, job, preconditions.image, blocked);
}

/** The blocked answer for the runStart metric, shared by the seeded-lane and live-lane paths. */
function runStartBlocked(registered) {
	return (reason, detail) => ({ status: "blocked", registered, metric: RUN_START_METRIC,
		warmupSeconds: null, samples: null, medianSeconds: null, maxSeconds: null, reason, detail, rule: RUN_START_RULE, passed: null });
}

/** Docker and the runner image, or the blocked answer naming what is missing. */
function runStartPreconditions(blocked) {
	if (!dockerReachable()) return blocked("RUN_DOCKER_UNAVAILABLE", "Docker is unreachable, so `acquit run` cannot start the runner sandbox.");
	const image = process.env.ACQUIT_RUNNER_IMAGE?.trim() || "acquit/runner-node20";
	if (!runnerImagePresent(image)) {
		return blocked("RUN_IMAGE_MISSING", `The runner image ${image} is not in the local Docker store. Build it once: docker build -t ${image} packages/runner.`);
	}
	return { image };
}

/**
 * The live-lane path (`--run-lane` and `--run-job`): measure runStart against a lane the operator
 * already runs, with the session token from ACQUIT_TOKEN in the environment, never argv. The probe
 * boots nothing, seeds nothing, stops nothing, and reads the lane through the same authenticated
 * routes the operator's CLI uses. Every precondition it cannot meet is named as a blocked metric,
 * never a fabricated number.
 */
async function liveRunStart() {
	const slot = laneSlot(runLane);
	const instance = { side: "live", dir: headDir, lane: runLane, slot, apiUrl: `http://127.0.0.1:${slot.apiPort}` };
	const probe = cli(instance, ["run", "--help"], { accept: () => true });
	const registered = probe.code === 0;
	const blocked = runStartBlocked(registered);
	if (!registered) return blocked("RUN_NOT_REGISTERED", "This build registers no `acquit run`, so there is no agent start to time.");
	const token = process.env.ACQUIT_TOKEN?.trim() || null;
	if (token === null) {
		return blocked("RUN_TOKEN_MISSING",
			`Set ACQUIT_TOKEN to the session token of the operator lane ${runLane} serves (the value \`acquit login\` stores) and rerun; the probe never takes a token in argv.`);
	}
	if (!(await reachable(`${instance.apiUrl}/api/users`))) {
		return blocked("RUN_LANE_UNREACHABLE",
			`No API answers at ${instance.apiUrl} for lane ${runLane}. The probe never boots or stops the lane it measures: start it with \`npm run ctl -- start --lane ${runLane}\` first.`);
	}
	let jobs;
	try {
		const response = await fetch(`${instance.apiUrl}/api/jobs`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) {
			return blocked("RUN_TOKEN_REJECTED",
				`GET /api/jobs on lane ${runLane} answered ${response.status}: the token in ACQUIT_TOKEN is not a live session on that lane.`);
		}
		const body = await response.json();
		jobs = Array.isArray(body?.jobs) ? body.jobs : [];
	} catch (error) {
		return blocked("RUN_LANE_UNREACHABLE", `GET /api/jobs on lane ${runLane} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const job = jobs.find(candidate => candidate !== null && typeof candidate === "object" && candidate.id === runJob) ?? null;
	if (job === null) {
		return blocked("RUN_JOB_UNKNOWN",
			`GET /api/jobs on lane ${runLane} answers no job ${runJob} this token can read (it serves ${jobs.length} job row${jobs.length === 1 ? "" : "s"}). Pass the id of the IN_PROGRESS job that lane's operator funded.`);
	}
	if (job.status !== "IN_PROGRESS" || job.escrow !== "HELD") {
		return blocked("RUN_JOB_NOT_FUNDED",
			`Job ${runJob} on lane ${runLane} is ${String(job.status)} with escrow ${String(job.escrow)}; the metric needs an IN_PROGRESS job whose escrow is HELD.`);
	}
	const preconditions = runStartPreconditions(blocked);
	if (preconditions.image === undefined) return preconditions;
	// `devon` is the one token oneRunStart hands the CLI process; here it is the operator's own.
	return measureRunStart({ ...instance, devon: token }, job, preconditions.image, blocked);
}

/** Every job the probe's operator can read in the head lane, as the API's own job view. */
async function headJobs(instance) {
	const response = await fetch(`${instance.apiUrl}/api/jobs`,
		{ headers: { cookie: `acquit_session=${instance.devon}` }, signal: AbortSignal.timeout(15_000) });
	assert(response.ok, `GET /api/jobs on the head lane answered ${response.status}.`);
	const body = await response.json();
	return Array.isArray(body?.jobs) ? body.jobs : [];
}

/** The runner image the CLI would start. A missing image is a precondition, not a measurement. */
function runnerImagePresent(image) {
	return spawnSync("docker", ["image", "inspect", image], { encoding: "utf8", timeout: 30_000 }).status === 0;
}

/**
 * One untimed warm-up that clones the job's fork into --dir, then `rounds` timed samples that reuse it,
 * so every sample is the warm second start the rule names. A sample that is not healthy stops the
 * measurement: the blocker's reason is reported as blocked instead of a start time that never happened.
 */
async function measureRunStart(instance, job, image, blocked) {
	const temp = await mkdtemp(join(tmpdir(), "acquit-perf-runstart-"));
	runStartResources.jobId = job.id;
	runStartResources.tempRoots.push(temp);
	const dir = join(temp, "work");
	const command = join(temp, "command.sh");
	await mkdir(dir);
	await writeFile(command, RUN_START_SCRIPT, { mode: 0o755 });
	const context = { instance, job, image, temp, dir, command };
	const warmup = await oneRunStart(context);
	runStartResources.killed ||= warmup.killed;
	const warmupBlocker = runStartBlocker({ ...warmup, agentRan: warmup.stdout.includes(RUN_START_SENTINEL) });
	if (warmupBlocker !== null) return blocked(warmupBlocker.reason, `The warm-up run was not healthy: ${warmupBlocker.detail}`);
	const samples = [];
	for (let round = 0; round < rounds; round++) {
		const run = await oneRunStart(context);
		runStartResources.killed ||= run.killed;
		const blocker = runStartBlocker({ ...run, agentRan: run.stdout.includes(RUN_START_SENTINEL) });
		if (blocker !== null) return blocked(blocker.reason, `Sample ${round + 1} of ${rounds} was not healthy: ${blocker.detail}`);
		samples.push(run.markerSeconds);
		console.log(JSON.stringify({ runStartSample: round + 1, seconds: round1(run.markerSeconds) }));
	}
	const verdict = runStartVerdict(samples, RULES.runStartSeconds);
	return { status: "measured", registered: true, metric: RUN_START_METRIC, warmupSeconds: round1(warmup.markerSeconds),
		samples: verdict.samples, medianSeconds: verdict.medianSeconds, maxSeconds: verdict.maxSeconds, rule: RUN_START_RULE, passed: verdict.passed };
}

/**
 * One `acquit run --runner command` process, timed from spawn to the first line that marks the agent
 * start. The run is left to finish on its own so the CLI's own sandbox cleanup runs; TMPDIR scopes the
 * CLI's 0600 secret directory into the probe's temp root, and sampleEnv scopes the CLI's state git
 * directory there too, so the sample never meets the measured lane's own state. The sweep below
 * removes the temp root either way.
 */
function oneRunStart({ instance, job, image, temp, dir, command }) {
	return new Promise(resolve => {
		const began = performance.now();
		const child = spawn(process.execPath, ["packages/acquit-cli/src/main.ts", "run", job.id, "--runner", "command",
			"--command", command, "--dir", dir, "--api", instance.apiUrl],
			{ cwd: instance.dir, env: sampleEnv(process.env, { token: instance.devon, image, temp }), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let scanned = 0;
		let markerSeconds = null;
		let agentRan = false;
		let timedOut = false;
		let killed = false;
		let hard = null;
		// Only complete lines are scanned while the process runs; the final pass reads the tail.
		const scan = final => {
			const lines = stdout.split("\n");
			const complete = final ? lines.length : lines.length - 1;
			for (; scanned < complete; scanned++) {
				if (markerSeconds === null && agentStarted(lines[scanned])) markerSeconds = (performance.now() - began) / 1000;
				if (lines[scanned].includes(RUN_START_SENTINEL)) agentRan = true;
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killed = true;
			child.kill("SIGTERM");
			hard = setTimeout(() => child.kill("SIGKILL"), 10_000);
		}, RUN_SAMPLE_TIMEOUT_MS);
		const finish = code => {
			clearTimeout(timer);
			if (hard !== null) clearTimeout(hard);
			scan(true);
			resolve({ markerSeconds, exitCode: code, agentRan, timedOut, killed, stdout, stderr });
		};
		child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); scan(false); });
		child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
		child.once("error", error => { stderr += `\n${error.message}`; finish(null); });
		child.once("close", code => finish(code));
	});
}

/**
 * The belt for the CLI's own cleanup. A sample the probe killed can leave the measured job's runner
 * container, proxy, and network behind, and the temp root holds the command script, the CLI's secret
 * directory, and the sample's own state home (its XDG_STATE_HOME and the state git directory under
 * it). Only a killed sample opens that belt: a sample left to finish cleans up after itself, so an
 * idle probe never touches Docker. The names are per job, so this touches only the objects the
 * probe's own runs made for that job — the same leftovers the CLI itself removes before it starts.
 */
async function sweepRunStart() {
	const removed = [];
	const errors = [];
	const targets = sweepTargets({ jobId: runStartResources.jobId, killed: runStartResources.killed });
	if (targets.length > 0 && dockerReachable()) {
		for (const target of targets) {
			if (spawnSync("docker", [target.kind, "inspect", target.name], { encoding: "utf8", timeout: 30_000 }).status !== 0) continue;
			const gone = spawnSync("docker", target.remove, { encoding: "utf8", timeout: 60_000 });
			if (gone.status === 0) removed.push(`${target.kind} ${target.name}`);
			else errors.push(`${target.kind} ${target.name}: ${String(gone.stderr ?? "").trim().split("\n").at(-1) || `docker exited ${gone.status}`}`);
		}
	}
	for (const path of runStartResources.tempRoots.splice(0)) {
		try { await rm(path, { recursive: true, force: true }); removed.push(path); }
		catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return { removed, errors };
}

async function seed(instance) {
	await ctl(instance, "seed-db", "--yes");
	instance.devon = await signIn(instance, "devon-ops");
}

async function signIn(instance, handle) {
	const response = await fetch(`${instance.apiUrl}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ handle }), signal: AbortSignal.timeout(15_000) });
	assert(response.ok, `POST /api/session for ${handle} on ${instance.side} answered ${response.status}.`);
	const body = await response.json();
	assert(typeof body.token === "string" && body.token.length > 0, "The session answer carried no token.");
	return body.token;
}

/**
 * One CLI process in a worktree, timed from spawn to exit. `accept` decides whether the sample counts.
 * The probe reads both streams itself: the lane helper discards stderr, and trunk's `submit --help`
 * answers there.
 */
function cli(instance, args, { env = {}, accept = result => result.status === 0 } = {}) {
	const began = performance.now();
	const result = spawnSync(process.execPath, ["packages/acquit-cli/src/main.ts", ...args],
		{ cwd: instance.dir, env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
	const ms = performance.now() - began;
	const sample = { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	const last = sample.stderr.trim().split("\n").at(-1) ?? "";
	assert(accept(sample), `acquit ${args.join(" ")} on ${instance.side} exited ${sample.status}: ${last}`);
	return { ms, stdout: sample.stdout, stderr: sample.stderr, code: sample.status };
}

async function ctl(instance, ...args) {
	const result = await captured(process.execPath, ["packages/ctl/src/main.ts", ...args], instance.dir,
		{ ...process.env, ACQUIT_LANE: String(instance.lane), ACQUIT_DEV: "1" }, 300_000);
	const reply = JSON.parse(result.stdout);
	assert(result.code === 0 && reply.ok, reply.error?.message ?? `ctl ${args[0]} failed on ${instance.side}.`);
	return reply.data;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const round1 = value => Math.round(value * 10) / 10;
const round2 = value => Math.round(value * 100) / 100;

await main();
process.exitCode = report.passed ? 0 : 1;
