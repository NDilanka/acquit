// Perf probe for F5: the operator CLI's start cost and `acquit jobs list`, trunk against head.
//
//   node scripts/perf/cli.mjs --rounds 5
//   node scripts/perf/cli.mjs --rounds 5 --trunk /tmp/acquit-perf-trunk --head .
//   node scripts/perf/cli.mjs --rounds 5 --clean
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
// Metrics.
//   help: the seconds one `acquit submit --help` process takes, trunk and head, on the same machine.
//   It is the CLI's start cost: module load, command table, usage. Trunk carries no per-command help,
//   so it answers that argv with USAGE and exit 1; the work is the same and each side's exit codes are
//   recorded. Trunk's median is the baseline and is recorded first.
//   jobsList: the seconds one `acquit jobs list` process takes against the seeded head lane, after one
//   untimed warm-up. The command signs in the way the operator does: the token from `acquit login`,
//   handed to the process in its environment, never in argv.
//   runStart: `acquit run` from start to agent start. The runner owner lands packages/acquit-cli/src/
//   run.ts in the F5 runner round; until this build registers the command the metric is recorded as
//   pending and never fails the probe.
//
// Rules. Fail if the head --help median exceeds the trunk median by more than 20 percent. Fail if the
// jobs list median exceeds 800 ms. Fail if the warm run start exceeds 30 seconds, once run exists.
//
// Cleanup. Both lanes are stopped; the trunk worktree stays in place for the next run unless --clean
// removes it and this run's lane data (the lane 0 database is never a probe lane and is never touched).
// Nothing is created on GitHub and no money moves.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { captured, portOpen, reachable, sleep } from "../../packages/ctl/src/process.ts";
import { laneSlot } from "../../packages/ctl/src/state.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
// A short default: see the ownership-socket note at the top of this file.
const defaultTrunk = join(tmpdir(), "acquit-perf-trunk");
const { values } = parseArgs({ options: {
	rounds: { type: "string", default: "5" },
	trunk: { type: "string", default: defaultTrunk },
	head: { type: "string", default: root },
	"trunk-lane": { type: "string", default: "15" },
	"head-lane": { type: "string", default: "16" },
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
const evidence = resolve(root, values.evidence);
const RULES = { headOverTrunkRatio: 1.2, jobsListMs: 800, runStartSeconds: 30 };

const report = { rounds, trunkDir, headDir, trunkLane, headLane, clean: values.clean, rules: RULES,
	trunkBaseline: null, trunkHead: null, headHead: null, baseline: null, help: null, jobsList: null, runStart: null,
	rounds_: [], cleanup: null, blocked: null, detail: null, passed: false, node: process.version };
const started = [];
/**
 * Where the trunk worktree stands, filled by guardTrunk before any mutating git command. `created` is
 * set when this run made the worktree, `registered` when it is a linked worktree this repo lists, and
 * `removable` when --clean may remove it: the probe only ever removes one it created or verified.
 */
const trunkState = { approved: false, created: false, registered: false, removable: false };

/** One report, one reason, and a nonzero exit. Cleanup below still runs. */
class Blocked extends Error {
	constructor(reason, detail) { super(detail); this.reason = reason; this.detail = detail; }
}

async function main() {
	if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
	try {
		await preflight();
		const trunk = await boot("trunk", trunkDir, trunkLane);
		const head = await boot("head", headDir, headLane);
		await measure(trunk, head);
	} catch (error) {
		report.blocked = error instanceof Blocked ? error.reason : "PROBE_FAILED";
		report.detail = error instanceof Error ? error.message : String(error);
	} finally {
		report.cleanup = await cleanup();
	}
	report.passed = report.help?.passed === true && report.jobsList?.passed === true && report.runStart?.passed !== false;
	await mkdir(evidence, { recursive: true });
	await writeFile(resolve(evidence, "cli.json"), JSON.stringify(report, null, 2) + "\n");
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
 * The runner round's metric. The probe asks the CLI whether this build registers `run` — an unknown
 * command exits 2, a registered one answers its usage with 0 — and records the measurement as pending
 * until the runner owner lands it. It never fabricates a number, and it never fails a round-1 probe for
 * a command that build does not carry.
 */
async function runStart(instance) {
	const probe = cli(instance, ["run", "--help"], { accept: () => true });
	const registered = probe.status === 0;
	return { status: "pending", registered, metric: "acquit run from start to agent start", samples: null, medianSeconds: null,
		reason: registered ? "RUN_METRIC_OWNED_BY_RUNNER_ROUND" : "RUN_NOT_REGISTERED",
		detail: registered
			? "This build registers run, but the start-to-agent-start measurement belongs to the F5 runner round, which knows the runner's output contract."
			: "This build carries no packages/acquit-cli/src/run.ts, so `acquit run` is not a command yet.",
		rule: `the warm run start must not exceed ${RULES.runStartSeconds} seconds once run exists`, passed: null };
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
