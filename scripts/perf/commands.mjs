// Perf probe for F4: the PlaceBid command at trunk and head, and tick on a seeded 200-job database.
//
//   node scripts/perf/commands.mjs --bids 100
//   node scripts/perf/commands.mjs --bids 100 --trunk /tmp/acquit-perf-trunk --head .
//
// The trunk worktree defaults to a short path outside the repo because the control CLI's ownership
// proof is a Unix socket under <worktree>/data/ctl/lane-<n>/own-<nonce>.sock, and Linux caps that path
// at 107 bytes. A worktree nested inside this one (data/perf/trunk) overruns the cap, the preload fails
// closed, and every spawned service exits before it prints. Pass --trunk a short path if the default
// does not suit.
//
// The probe boots two isolated instances on separate lanes: one from a detached trunk worktree
// (origin/main, created here when missing) and one from the head worktree. Each sample opens a job as
// maya-client, times one PlaceBid as devon-ops, and cancels the job as maya-client. The cancel returns
// the 10 credits, so every sample starts from the same 30-credit allowance and no PayPal call is ever
// made. Rounds of 10 alternate trunk and head, and the trunk median is recorded first as the baseline.
//
// Then it reseeds the head lane, creates 200 open jobs through the API, and times `POST /api/dev/tick`
// five times. Every seeded job is OPEN BIDDING with its House bid already placed, so `runDueTimers`
// makes no PayPal read; the probe asserts the lane holds no FUNDING job before it starts timing.
//
// Metrics.
//   PlaceBid: the seconds from the POST to its response, per sample. The OpenJob and CancelJob around
//   it are untimed; they exist so credits recycle and the bid path stays comparable.
//   tick: the seconds from POST /api/dev/tick to its response, on a fresh lane with 200 open jobs.
//
// Rules. Fail if the head PlaceBid median exceeds the trunk median by more than 20 percent. Fail if
// the tick median exceeds 200 ms. A metric that cannot be measured is reported as `blocked` and exits 1.
//
// Cleanup. Both lanes are stopped; the trunk worktree stays in place for the next run. Nothing is
// created on GitHub and no money moves.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { captured, portOpen, reachable, sleep } from "../../packages/ctl/src/process.ts";
import { laneSlot } from "../../packages/ctl/src/state.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
// A short default: see the ownership-socket note at the top of this file.
const defaultTrunk = join(tmpdir(), "acquit-perf-trunk");
const { values } = parseArgs({ options: {
	bids: { type: "string", default: "100" },
	jobs: { type: "string", default: "200" },
	ticks: { type: "string", default: "5" },
	trunk: { type: "string", default: defaultTrunk },
	head: { type: "string", default: root },
	"trunk-lane": { type: "string", default: "13" },
	"head-lane": { type: "string", default: "14" },
	evidence: { type: "string", default: "data/evidence/f4-r1/perf" },
} });
const bids = Number(values.bids);
const jobs = Number(values.jobs);
const ticks = Number(values.ticks);
const trunkLane = Number(values["trunk-lane"]);
const headLane = Number(values["head-lane"]);
const trunkDir = resolve(root, values.trunk);
const headDir = resolve(values.head);
assert(Number.isSafeInteger(bids) && bids >= 10 && bids % 10 === 0, "--bids must be a positive multiple of 10.");
assert(Number.isSafeInteger(jobs) && jobs >= 1, "--jobs must be at least 1.");
assert(Number.isSafeInteger(ticks) && ticks >= 1, "--ticks must be at least 1.");
assert(trunkLane !== headLane && trunkLane >= 1 && headLane >= 1, "Use two distinct lanes of 1 or more: lane 0 is the real database.");
const rounds = bids / 10;
const evidence = resolve(root, values.evidence);
const RULES = { headOverTrunkRatio: 1.2, tickMedianMs: 200 };

const report = { bids, jobs, ticks, rounds, roundSize: 10, trunkDir, headDir, trunkLane, headLane, rules: RULES,
	trunkHead: null, headHead: null, baseline: null, bidLatency: null, tick: null, cleanup: null, blocked: null, detail: null,
	passed: false, node: process.version };
const started = [];

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
	report.passed = report.bidLatency?.passed === true && report.tick?.passed === true;
	await mkdir(evidence, { recursive: true });
	await writeFile(resolve(evidence, "commands.json"), JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report));
}

async function preflight() {
	assert(existsSync(resolve(root, ".env")), "The head worktree needs its .env for PayPal and GitHub configuration.");
	assert(existsSync(resolve(headDir, "package.json")), `No head worktree at ${headDir}.`);
	assert(existsSync(resolve(headDir, "packages/ctl/src/main.ts")), `The head worktree at ${headDir} has no control CLI.`);
	laneSocketFits("trunk", trunkDir, trunkLane);
	laneSocketFits("head", headDir, headLane);
	if (!existsSync(resolve(trunkDir, "package.json"))) {
		assert(values.trunk === defaultTrunk, `The supplied trunk worktree ${trunkDir} is missing.`);
		spawnSync("git", ["-C", root, "worktree", "prune"], { encoding: "utf8" });
		const added = spawnSync("git", ["-C", root, "worktree", "add", "--detach", trunkDir, "origin/main"], { encoding: "utf8" });
		assert.equal(added.status, 0, `Could not create the isolated trunk baseline: ${added.stderr}`);
		await copyFile(resolve(root, ".env"), resolve(trunkDir, ".env"));
		// The copy carries PayPal and GitHub keys; keep it owner-only outside the repo.
		await chmod(resolve(trunkDir, ".env"), 0o600);
		const cli = npmCli();
		const installed = cli === null
			? await captured("npm", ["install"], trunkDir, process.env, 300_000)
			: await captured(process.execPath, [cli, "install"], trunkDir, process.env, 300_000);
		assert.equal(installed.code, 0, `Could not install the baseline dependencies; run npm install in ${trunkDir}.`);
	}
	report.trunkHead = headOf(trunkDir);
	report.headHead = headOf(headDir);
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

/** The npm CLI to run with the current node, or null when the probe should resolve npm through PATH. */
function npmCli() {
	return [process.env.npm_execpath, "/usr/lib/node_modules/npm/bin/npm-cli.js", "/usr/local/lib/node_modules/npm/bin/npm-cli.js"]
		.find(candidate => typeof candidate === "string" && candidate !== "" && existsSync(candidate)) ?? null;
}

/** One isolated instance on its own lane. The ports must be free before it is started. */
async function boot(side, dir, lane) {
	const slot = laneSlot(lane);
	for (const [name, port] of [["api", slot.apiPort], ["web", slot.webPort], ["verifier", slot.verifierPort]]) {
		assert(!(await portOpen(port)), `Lane ${lane}'s ${name} port ${port} is already open. Stop that process or pass another --${side}-lane.`);
	}
	const instance = { side, dir, lane, slot, apiUrl: `http://127.0.0.1:${slot.apiPort}`, databasePath: resolve(dir, slot.databasePath) };
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
	const result = { lanesStopped: [], errors: [] };
	for (const instance of started.reverse()) {
		try { await ctl(instance, "stop"); result.lanesStopped.push(`${instance.side} lane ${instance.lane}`); }
		catch (error) { result.errors.push(`${instance.side}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return result;
}

async function measure(trunk, head) {
	await seed(trunk);
	await seed(head);
	const trunkSamples = [];
	const headSamples = [];
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < 10; index++) trunkSamples.push(await sample(trunk));
		for (let index = 0; index < 10; index++) headSamples.push(await sample(head));
		await assertCredits(trunk);
		await assertCredits(head);
		console.log(JSON.stringify({ round: round + 1, trunkMedianMs: round1(median(trunkSamples)), headMedianMs: round1(median(headSamples)) }));
	}
	const trunkMedian = median(trunkSamples);
	const headMedian = median(headSamples);
	// The trunk median is the baseline, recorded before the head's own number is judged against it.
	report.baseline = { side: "trunk", metric: "PlaceBid POST /api/commands", medianMs: round1(trunkMedian), samples: trunkSamples.map(round1) };
	report.bidLatency = { trunk: { samples: trunkSamples.map(round1), medianMs: round1(trunkMedian) },
		head: { samples: headSamples.map(round1), medianMs: round1(headMedian) },
		ratio: round2(headMedian / trunkMedian), passed: headMedian <= trunkMedian * RULES.headOverTrunkRatio };
	await tickTiming(head);
}

/** One bid sample: open (untimed), PlaceBid (timed), cancel to return the credits (untimed). */
async function sample(instance) {
	const opened = await command(instance, instance.maya, { type: "OpenJob", repository: instance.repository, issueNumber: 12,
		budget: 40_000, deliveryEndsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
	const jobId = opened.job.id;
	const began = performance.now();
	await command(instance, instance.devon, { type: "PlaceBid", jobId, price: 40_000, eta: 72, agent: "ts-bugfixer", pitch: "commands perf probe" });
	const ms = performance.now() - began;
	await command(instance, instance.maya, { type: "CancelJob", jobId });
	return ms;
}

async function seed(instance) {
	await ctl(instance, "seed-db", "--yes");
	instance.maya = await signIn(instance, "maya-client");
	instance.devon = await signIn(instance, "devon-ops");
	instance.repository = (await api(instance, instance.maya, "GET", "/api/repos")).repos[0].repository;
}

/** A drift guard: every sample returns its 10 credits, so a round that ends below the bid cost is broken. */
async function assertCredits(instance) {
	const credits = (await api(instance, instance.devon, "GET", "/api/me/credits")).credits;
	if (credits.available < 10) throw new Blocked("CREDITS_DRIFT", `${instance.side} reads ${credits.available} credits, so the next bid would be refused.`);
}

/** Times tick on a fresh lane with `jobs` open jobs. No FUNDING row exists, so runDueTimers reads no order. */
async function tickTiming(instance) {
	await ctl(instance, "seed-db", "--yes");
	instance.maya = await signIn(instance, "maya-client");
	const repository = (await api(instance, instance.maya, "GET", "/api/repos")).repos[0].repository;
	const deliveryEndsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
	for (let index = 0; index < jobs; index++) {
		await command(instance, instance.maya, { type: "OpenJob", repository, issueNumber: 12, budget: 40_000, deliveryEndsAt });
	}
	const funding = countJobs(instance, '%"kind":"FUNDING"%');
	assert.equal(funding, 0, `The seeded database holds ${funding} FUNDING jobs, so tick would call PayPal.`);
	const samples = [];
	for (let index = 0; index < ticks; index++) {
		const began = performance.now();
		const body = await api(instance, instance.maya, "POST", "/api/dev/tick");
		assert.equal(body.ok, true, "POST /api/dev/tick did not answer ok.");
		samples.push(performance.now() - began);
	}
	const tickMedian = median(samples);
	report.tick = { jobs, fundingJobs: funding, samplesMs: samples.map(round1), medianMs: round1(tickMedian), maxMs: round1(Math.max(...samples)),
		paypalCalls: "none: every seeded job is OPEN BIDDING with its House bid already placed, so runDueTimers reads no order",
		passed: tickMedian <= RULES.tickMedianMs };
}

/** A read-only count over the lane's own database. The probe never writes a lane row directly. */
function countJobs(instance, pattern) {
	const db = new DatabaseSync(instance.databasePath, { readOnly: true });
	try { return Number(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json LIKE ?").get(pattern).n); }
	finally { db.close(); }
}

async function signIn(instance, handle) {
	const response = await fetch(`${instance.apiUrl}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ handle }), signal: AbortSignal.timeout(15_000) });
	assert(response.ok, `POST /api/session for ${handle} on ${instance.side} answered ${response.status}.`);
	const body = await response.json();
	assert(typeof body.token === "string" && body.token.length > 0, "The session answer carried no token.");
	return body.token;
}

async function command(instance, token, command) {
	const body = await api(instance, token, "POST", "/api/commands", { key: randomUUID(), command });
	assert.equal(body?.outcome?.kind, "COMMITTED", `${command.type} on ${instance.side} did not commit.`);
	return body.outcome.result;
}

async function api(instance, token, method, path, payload) {
	const response = await fetch(`${instance.apiUrl}${path}`, { method, signal: AbortSignal.timeout(120_000),
		headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
		body: payload === undefined ? undefined : JSON.stringify(payload) });
	const body = await response.json().catch(() => null);
	if (!response.ok || body?.outcome?.kind === "DENIED") {
		throw new Blocked("COMMAND_DENIED", `${method} ${path} on ${instance.side} answered ${response.status}: ${body?.outcome?.reason ?? body?.error ?? "no reason"}`);
	}
	return body;
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
