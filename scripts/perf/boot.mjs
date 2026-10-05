import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { captured, portOpen, reachable, sleep } from "../../packages/ctl/src/process.ts";
import { freePhysicalMB, startWave } from "../../.factory/skills/verify-acquit/scripts/lanes.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { values } = parseArgs({ options: { rounds: { type: "string", default: "5" }, trunk: { type: "string" } } });
const rounds = Number(values.rounds);
assert(Number.isSafeInteger(rounds) && rounds >= 5, "Use at least five rounds.");
const evidence = resolve(root, "data/evidence/self-proof-h0/perf");
const trunk = resolve(root, values.trunk ?? "data/perf/trunk");
await mkdir(evidence, { recursive: true });
if (!existsSync(resolve(trunk, "package.json"))) {
	assert(!values.trunk, "The supplied trunk worktree is missing.");
	for (const args of [["worktree", "add", "--detach", trunk, "origin/main"]]) {
		const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
		assert.equal(result.status, 0, "Could not create the isolated trunk baseline.");
	}
	await copyFile(resolve(root, ".env"), resolve(trunk, ".env"));
	const installed = await captured(process.execPath, [process.env.npm_execpath ?? resolve(process.execPath, "../node_modules/npm/bin/npm-cli.js"), "install"], trunk, process.env, 300_000);
	assert.equal(installed.code, 0, "Could not install the baseline dependencies.");
}
const samples = { trunk: [], head: [] };
async function single(label, cwd) {
	const isHead = label === "head";
	const cli = isHead ? "packages/ctl/src/main.ts" : "packages/cli/src/main.ts";
	const env = { ...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: "1", PORT: "5510", WEB_PORT: "5573", DATABASE_PATH: "./data/verify/boot/acquit.db" };
	assert(!(await portOpen(5510)) && !(await portOpen(5573)), "Boot probe ports are occupied.");
	await mkdir(resolve(cwd, "data/verify/boot"), { recursive: true });
	const start = performance.now();
	const started = captured(process.execPath, [cli, "start", "--timeout", "120"], cwd, env, 180_000);
	try {
		let ready = false;
		while (performance.now() - start < 120_000) {
			const results = await Promise.all([reachable("http://127.0.0.1:5510/api/users"), reachable("http://127.0.0.1:5573/")]);
			if (results.every(Boolean)) { ready = true; break; }
			await sleep(25);
		}
		assert(ready, `${label} endpoints did not answer within 120 seconds.`);
		const seconds = (performance.now() - start) / 1000;
		const result = await started;
		const reply = JSON.parse(result.stdout);
		assert(result.code === 0 && reply.ok && !reply.data.alreadyRunning, `${label} start did not own a new run.`);
		assert.equal(resolve(reply.data.databasePath), resolve(cwd, env.DATABASE_PATH));
		samples[label].push(seconds);
		console.log(JSON.stringify({ label, seconds, endpointsAnswered: 2, failures: 0 }));
	} finally {
		await started.catch(() => {});
		const stopped = await captured(process.execPath, [cli, "stop"], cwd, env, 120_000);
		assert.equal(stopped.code, 0, `${label} cleanup failed.`);
		assert(!(await portOpen(5510)) && !(await portOpen(5573)), `${label} ports remained open.`);
	}
}
for (let round = 0; round < rounds; round++) { await single("trunk", trunk); await single("head", root); }
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const baseline = median(samples.trunk);
const head = median(samples.head);
const waveStart = performance.now();
process.env.ACQUIT_MAX_LANES ??= "2";
const wave = await startWave(10);
const waveSeconds = (performance.now() - waveStart) / 1000;
const report = { rounds, samples, trunkMedianSeconds: baseline, headMedianSeconds: head, ratio: head / baseline,
	singlePassed: head <= baseline * 1.15, waveSeconds, wavePassed: wave.cap > 0 && waveSeconds <= 120,
	perLaneMB: wave.perLaneMB, cap: wave.cap, freeMB: wave.freeMB, reserveMB: wave.reserveMB,
	physicalFreeMBAfter: freePhysicalMB(), failures: 0, endpointsPerSingle: 2, node: process.version };
await writeFile(resolve(evidence, "boot.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
const cleanup = await captured(process.execPath, [".factory/skills/verify-acquit/scripts/lanes.mjs", "cleanup"], root, process.env, 180_000);
assert.equal(cleanup.code, 0, "Wave cleanup failed.");
if (!report.singlePassed || !report.wavePassed) process.exitCode = 1;
