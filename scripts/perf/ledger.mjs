import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { captured, portOpen } from "../../packages/ctl/src/process.ts";
import { pathExecutable } from "../../packages/ctl/src/executables.ts";
import { admitStartedSide, probeSide, withProbeCleanup } from "./ledger-sides.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { values } = parseArgs({ options: { requests: { type: "string", default: "200" }, trunk: { type: "string" } } });
const requests = Number(values.requests);
assert(Number.isSafeInteger(requests) && requests >= 200 && requests % 20 === 0, "Use at least 200 requests in rounds of 20.");
const evidence = resolve(root, process.env.ACQUIT_PERF_EVIDENCE_DIR ?? "data/evidence/self-proof-f1/perf");
const trunk = resolve(root, values.trunk ?? "data/perf/ledger-trunk");
async function npmCli() {
	const candidates = [process.env.npm_execpath, resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")];
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		const dir = entry.replace(/^"|"$/g, "");
		if (!isAbsolute(dir) || resolve(dir).toLowerCase() === resolve(process.cwd()).toLowerCase()) continue;
		if (process.platform === "win32" && existsSync(resolve(dir, "npm.cmd"))) candidates.push(resolve(dir, "node_modules/npm/bin/npm-cli.js"));
		if (process.platform !== "win32" && existsSync(resolve(dir, "npm"))) candidates.push(await realpath(resolve(dir, "npm")));
	}
	const cli = candidates.find(path => path && isAbsolute(path) && existsSync(path));
	assert(cli, "Could not resolve an absolute npm CLI path. Install npm beside Node or on an absolute PATH entry.");
	return cli;
}
await mkdir(evidence, { recursive: true });
if (!existsSync(resolve(trunk, "package.json"))) {
	assert(!values.trunk, "The supplied trunk worktree is missing.");
	// The baseline is the parent tip of this PR, so H0's delta is never attributed to F1.
	const git = pathExecutable("git");
	assert(git, "Git was not found on an absolute PATH entry.");
	const created = spawnSync(git, ["-C", root, "worktree", "add", "--detach", trunk, "origin/stack/h0-lanes"], { encoding: "utf8" });
	assert.equal(created.status, 0, "Could not create the isolated trunk baseline from origin/stack/h0-lanes.");
	await copyFile(resolve(root, ".env"), resolve(trunk, ".env"));
	const installed = await captured(process.execPath, [await npmCli(), "install"], trunk, process.env, 300_000);
	assert.equal(installed.code, 0, "Could not install the baseline dependencies.");
}

const sides = { trunk: probeSide("trunk", trunk), head: probeSide("head", root) };
for (const side of Object.values(sides)) assert(!(await portOpen(side.api)) && !(await portOpen(side.web)), `${side.label} probe ports are occupied.`);
const samples = { trunk: [], head: [] };
const failures = { trunk: 0, head: 0 };
const running = [];

async function ready(label, cwd) {
	const side = sides[label];
	const cli = existsSync(resolve(cwd, "packages/ctl/src/main.ts")) ? "packages/ctl/src/main.ts" : "packages/cli/src/main.ts";
	const env = { ...process.env, ACQUIT_LANE: String(side.lane), ACQUIT_DEV: "1" };
	const started = await captured(process.execPath, [cli, "start", "--timeout", "120"], cwd, env, 180_000);
	assert.equal(started.code, 0, `${label} did not start.`);
	admitStartedSide(side, started.stdout);
	running.push({ ...side, cwd, cli, env });
	// Seed so the seeded operators and agents exist; the automatic house bid needs them.
	const seeded = await captured(process.execPath, [cli, "seed-db", "--yes"], cwd, env, 120_000);
	assert.equal(seeded.code, 0, `${label} did not seed.`);
	const session = await fetch(`http://127.0.0.1:${side.api}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "maya-client" }) });
	assert.equal(session.ok, true, `${label} login failed.`);
	const token = (await session.json()).token;
	const command = async (body) => {
		const response = await fetch(`http://127.0.0.1:${side.api}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ key: crypto.randomUUID(), command: body }) });
		const outcome = await response.json();
		assert.equal(response.ok && outcome.outcome && outcome.outcome.kind !== "DENIED", true, `${label} ${body.type} was denied.`);
		return outcome.outcome.result;
	};
	// Card funding is the documented ACQUIT_DEV path: the sandbox order completes without buyer approval.
	const mode = await fetch(`http://127.0.0.1:${side.api}/api/dev/fund-mode`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ mode: "card" }) });
	assert.equal(mode.ok, true, `${label} could not select card funding.`);
	const opened = await command({ type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12, budget: 40000,
		deliveryEndsAt: new Date(Date.now() + 7 * 86400000).toISOString() });
	const jobId = opened.job.id;
	const view = await (await fetch(`http://127.0.0.1:${side.api}/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
	assert(view.job?.bids?.house?.id, `${label} opened a job without a house bid.`);
	// Fund the sampled job so the metric reads a HELD book, per the plan's metric.
	const accepted = await command({ type: "AcceptBid", jobId, bidId: view.job.bids.house.id });
	assert.equal(accepted.job?.escrow, "HELD", `${label} job was not funded to HELD.`);
	assert.equal(accepted.job.ledger.some(line => line.kind === "HELD"), true, `${label} book has no HELD line.`);
	if (label === "head") {
		const api = await (await fetch(`http://127.0.0.1:${side.api}/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
		const ledger = await captured(process.execPath, [cli, "ledger", "--job", jobId, "--json"], cwd, env, 30_000);
		assert.equal(ledger.code, 0, "The head ledger command failed.");
		assert.deepEqual(JSON.parse(ledger.stdout).data.jobs[0].ledger, api.job.ledger, "CLI and API ledger arrays differ.");
		await writeFile(resolve(evidence, "ledger-api-equality.json"), JSON.stringify({ jobId, equal: true, ledger: api.job.ledger }, null, 2) + "\n");
	}
	return { api: side.api, token, jobId };
}
async function round(label, state, measured = true) {
	for (let index = 0; index < 20; index++) {
		const start = performance.now();
		const response = await fetch(`http://127.0.0.1:${state.api}/api/jobs/${state.jobId}`, { headers: { Authorization: `Bearer ${state.token}` } });
		const body = await response.json();
		assert(response.ok && body.job?.escrow === "HELD" && body.job.ledger.some(line => line.kind === "HELD"), `${label} GET failed or lost its HELD book.`);
		if (measured) samples[label].push(performance.now() - start);
	}
}
let measurementSeconds;
await withProbeCleanup(async () => {
	// Worktree/install, launch, seed, payment/capture, and CLI comparison are setup, never latency samples.
	const states = { trunk: await ready("trunk", trunk), head: await ready("head", root) };
	// Warm both sides with the same complete round before starting the measured GET-only phase.
	await round("trunk", states.trunk, false);
	await round("head", states.head, false);
	const measurementStart = performance.now();
	for (let pass = 0; pass < requests / 20; pass++) await round(pass % 2 === 0 ? "trunk" : "head", states[pass % 2 === 0 ? "trunk" : "head"]);
	measurementSeconds = (performance.now() - measurementStart) / 1000;
}, running, async side => {
	const stopped = await captured(process.execPath, [side.cli, "stop"], side.cwd, side.env, 120_000);
	const open = [];
	for (const port of [side.api, side.web]) if (await portOpen(port)) open.push(port);
	return { code: stopped.code, open };
});
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const range = label => samples[label].length ? [Math.min(...samples[label]), Math.max(...samples[label])] : [null, null];
const propertyStart = performance.now();
const property = await captured(process.execPath, ["--test", "--test-concurrency=1", "packages/core/test/ledger-laws.test.ts"], root, process.env, 30_000);
const propertySeconds = (performance.now() - propertyStart) / 1000;
const report = { requests, samplesPerSide: { trunk: samples.trunk.length, head: samples.head.length }, warmupPerSide: 20,
	trunkMs: median(samples.trunk), headMs: median(samples.head), range: { trunk: range("trunk"), head: range("head") },
	measurementSeconds, failures, propertySeconds, propertyExit: property.code };
await writeFile(resolve(evidence, "ledger.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (failures.trunk || failures.head || samples.trunk.length !== requests / 2 || samples.head.length !== requests / 2 ||
	report.headMs > report.trunkMs * 1.2 + 2 || property.code !== 0 || propertySeconds > 10) process.exit(1);
