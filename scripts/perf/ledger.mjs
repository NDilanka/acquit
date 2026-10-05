import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { captured, portOpen } from "../../packages/ctl/src/process.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { values } = parseArgs({ options: { requests: { type: "string", default: "200" }, trunk: { type: "string" } } });
const requests = Number(values.requests);
assert(Number.isSafeInteger(requests) && requests >= 200 && requests % 20 === 0, "Use at least 200 requests in rounds of 20.");
const evidence = resolve(root, "data/evidence/self-proof-f1/perf");
const trunk = resolve(root, values.trunk ?? "data/perf/trunk");
await mkdir(evidence, { recursive: true });
if (!existsSync(resolve(trunk, "package.json"))) {
	assert(!values.trunk, "The supplied trunk worktree is missing.");
	const created = spawnSync("git", ["-C", root, "worktree", "add", "--detach", trunk, "origin/main"], { encoding: "utf8" });
	assert.equal(created.status, 0, "Could not create the isolated trunk baseline.");
	await copyFile(resolve(root, ".env"), resolve(trunk, ".env"));
	const installed = await captured(process.execPath, [process.env.npm_execpath ?? "npm", "install"], trunk, process.env, 300_000);
	assert.equal(installed.code, 0, "Could not install the baseline dependencies.");
}

const ports = { trunk: { api: 5610, web: 5673 }, head: { api: 5620, web: 5683 } };
for (const side of Object.values(ports)) assert(!(await portOpen(side.api)) && !(await portOpen(side.web)), "Ledger probe ports are occupied.");
const samples = { trunk: [], head: [] };
const failures = { trunk: 0, head: 0 };
const running = [];

async function ready(label, cwd) {
	const side = ports[label];
	const cli = existsSync(resolve(cwd, "packages/ctl/src/main.ts")) ? "packages/ctl/src/main.ts" : "packages/cli/src/main.ts";
	const env = { ...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: "1", PORT: String(side.api), WEB_PORT: String(side.web), DATABASE_PATH: `./data/verify/ledger-perf-${label}/acquit.db` };
	await mkdir(resolve(cwd, `data/verify/ledger-perf-${label}`), { recursive: true });
	const started = await captured(process.execPath, [cli, "start", "--timeout", "120"], cwd, env, 180_000);
	assert.equal(started.code, 0, `${label} did not start.`);
	running.push({ cwd, cli, env, api: side.api, web: side.web });
	const session = await fetch(`http://127.0.0.1:${side.api}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "maya-client" }) });
	assert.equal(session.ok, true, `${label} login failed.`);
	const token = (await session.json()).token;
	const opened = await fetch(`http://127.0.0.1:${side.api}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ key: crypto.randomUUID(), command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12, budget: 40000, deliveryEndsAt: "2026-10-20T12:00:00.000Z" } }) });
	const outcome = await opened.json();
	assert.equal(opened.ok && outcome.outcome?.result?.job?.id !== undefined, true, `${label} did not open a job.`);
	return { api: side.api, token, jobId: outcome.outcome.result.job.id };
}
async function round(label, state) {
	for (let index = 0; index < 20; index++) {
		const start = performance.now();
		const response = await fetch(`http://127.0.0.1:${state.api}/api/jobs/${state.jobId}`, { headers: { Authorization: `Bearer ${state.token}` } });
		const body = await response.json();
		if (!response.ok || body.job?.ledger === undefined) failures[label] += 1;
		else samples[label].push(performance.now() - start);
	}
}
try {
	const states = { trunk: await ready("trunk", trunk), head: await ready("head", root) };
	for (let pass = 0; pass < requests / 20; pass++) await round(pass % 2 === 0 ? "trunk" : "head", states[pass % 2 === 0 ? "trunk" : "head"]);
} finally {
	for (const side of running) await captured(process.execPath, [side.cli, "stop"], side.cwd, side.env, 120_000).catch(() => {});
	for (const side of running) assert(!(await portOpen(side.api)) && !(await portOpen(side.web)), "Ledger probe ports remained open.");
}
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const range = label => samples[label].length ? [Math.min(...samples[label]), Math.max(...samples[label])] : [null, null];
const property = await captured(process.execPath, ["--test", "--test-concurrency=1", "packages/core/test/ledger-laws.test.ts"], root, process.env, 30_000);
const propertySeconds = Number(property.stdout.match(/duration_ms ([\d.]+)/)?.[1] ?? NaN) / 1000;
const report = { requests, trunkMs: median(samples.trunk), headMs: median(samples.head), range: { trunk: range("trunk"), head: range("head") }, failures, propertySeconds, propertyExit: property.code };
await writeFile(resolve(evidence, "ledger.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (failures.trunk || failures.head || samples.trunk.length !== requests / 2 || report.headMs > report.trunkMs * 1.2 + 2 || property.code !== 0 || propertySeconds > 10) process.exit(1);
