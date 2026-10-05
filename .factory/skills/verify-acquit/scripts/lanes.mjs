import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { freemem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captured, sleep } from "../../../../packages/ctl/src/process.ts";
import { atomicJson, context, laneSlot, locked } from "../../../../packages/ctl/src/state.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const managerDir = resolve(root, "data/ctl/lanes");
const memoryFile = resolve(managerDir, "memory.json");
const waveFile = resolve(managerDir, "wave.json");
const reserveMB = 1024;
const ctx = context();

export function memoryCap(freeMB, perLaneMB) {
	assert(Number.isFinite(freeMB) && freeMB >= 0 && Number.isFinite(perLaneMB) && perLaneMB > 0);
	return Math.max(0, Math.floor((freeMB - reserveMB) / perLaneMB));
}
export function freePhysicalMB() {
	if (process.platform === "win32") return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
		"[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)"], { encoding: "utf8", windowsHide: true, timeout: 20_000 }).trim());
	return Math.floor(freemem() / 1048576);
}
function environment(n) {
	return { ...process.env, ACQUIT_LANE: String(n), ACQUIT_DEV: "1" };
}
async function ctl(n, ...args) {
	const result = await captured(process.execPath, ["packages/ctl/src/main.ts", ...args], root, environment(n), 180_000);
	const reply = JSON.parse(result.stdout);
	assert(result.code === 0 && reply.ok, reply.error?.message ?? `Lane ${n} ${args[0]} failed.`);
	return reply.data;
}
function browserEnvironment(n) {
	const env = environment(n);
	for (const name of Object.keys(env)) if (name.startsWith("AGENT_BROWSER_") || name === "FACTORY_DESKTOP_CDP_PORT" || /PAYPAL|SANDBOX|MERCHANT_ID|PASSWORD|SECRET|TOKEN|API_KEY/.test(name)) delete env[name];
	env.AGENT_BROWSER_HEADED = "false";
	return env;
}
async function browser(n, ...args) {
	const session = laneSlot(n).browserSession;
	const result = await captured("agent-browser", ["--config", resolve(managerDir, `browser-${n}.json`), "--namespace", session, "--session", session, "--json", ...args],
		root, browserEnvironment(n), 90_000);
	assert.equal(result.code, 0, "The isolated headless browser failed.");
	const reply = JSON.parse(result.stdout);
	assert(reply.success, "The isolated browser refused the command.");
	return reply.data;
}
function processMemory(roots) {
	if (process.platform === "win32") {
		const script = `$rows=Get-CimInstance Win32_Process; $ids=[Collections.Generic.HashSet[int]]::new(); @(${roots.join(",")}) | ForEach-Object { [void]$ids.Add($_) }; do { $added=$false; foreach($r in $rows) { if($ids.Contains([int]$r.ParentProcessId) -and $ids.Add([int]$r.ProcessId)) { $added=$true } } } while($added); $bytes=0; foreach($id in $ids) { $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p) { $bytes += $p.PeakWorkingSet64 } }; $bytes`;
		return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 }).trim());
	}
	const rows = execFileSync("ps", ["-e", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
	const ids = new Set(roots);
	let added;
	do { added = false; for (const [pid, parent] of rows) if (ids.has(parent) && !ids.has(pid)) { ids.add(pid); added = true; } } while (added);
	return rows.filter(([pid]) => ids.has(pid)).reduce((sum, row) => sum + row[2] * 1024, 0);
}
async function cleanupLane(n, expected) {
	const status = await ctl(n, "status");
	if (status.run) {
		if (expected) assert.deepEqual({ api: status.run.api, web: status.run.web }, expected, "Lane ownership changed. Refuse cleanup.");
		assert.equal(resolve(status.run.databasePath), resolve(root, laneSlot(n).databasePath));
	}
	try {
		if (existsSync(resolve(managerDir, `browser-${n}.json`))) await browser(n, "close");
	} finally { if (status.run) await ctl(n, "stop"); }
	const stopped = await ctl(n, "status");
	assert(!stopped.run && !stopped.ports.api.open && !stopped.ports.web.open, `Lane ${n} did not close.`);
	return { lane: n, stopped: true };
}
async function measure() {
	const n = 100;
	const preflight = await ctl(n, "status");
	assert(!preflight.run && !preflight.ports.api.open && !preflight.ports.web.open, "Measurement lane 100 is occupied.");
	await atomicJson(resolve(managerDir, `browser-${n}.json`), { headed: false, autoConnect: false });
	let owned;
	try {
		await ctl(n, "start", "--timeout", "60");
		await ctl(n, "seed-db", "--yes");
		owned = (await ctl(n, "status")).run;
		await browser(n, "open", `http://localhost:${laneSlot(n).webPort}`);
		await browser(n, "wait", "--text", "Sign in as a seeded user");
		const info = await browser(n, "session", "info");
		assert(Number.isSafeInteger(info.pid) && info.pid > 0, "Browser daemon PID is missing.");
		const roots = [owned.api.pid, owned.web.pid, info.pid];
		let peak = processMemory(roots);
		await sleep(1000);
		peak = Math.max(peak, processMemory(roots));
		const memory = { perLaneMB: Math.ceil(peak / 1048576), measuredAt: new Date().toISOString(),
			method: process.platform === "win32" ? "sum of owned process-tree peak working sets, API, Vite, browser daemon and Chromium" : "peak sampled owned process-tree RSS, API, Vite and headless browser",
			node: process.version, platform: process.platform };
		assert(memory.perLaneMB > 0);
		await atomicJson(memoryFile, memory);
		return memory;
	} finally { await cleanupLane(n, owned && { api: owned.api, web: owned.web }); }
}
export async function startWave(count) {
	assert(Number.isSafeInteger(count) && count > 0 && count <= 100, "Use start <count>, between 1 and 100.");
	if (existsSync(waveFile)) {
		const previous = JSON.parse(await readFile(waveFile, "utf8"));
		assert(previous.lanes.length === 0, "A wave still owns lane slots. Run doctor or cleanup before another start.");
	}
	let freeMB = freePhysicalMB();
	let memory = existsSync(memoryFile) ? JSON.parse(await readFile(memoryFile, "utf8")) : null;
	if (!memory && freeMB <= reserveMB) {
		const result = { cap: 0, freeMB, reserveMB, perLaneMB: null, started: [], refused: count,
			reason: `Free physical memory ${freeMB} MB is below the ${reserveMB} MB reserve. Cannot measure a slot safely.` };
		await atomicJson(waveFile, { ...result, lanes: [] });
		console.log(JSON.stringify(result));
		return result;
	}
	memory ??= await measure();
	freeMB = freePhysicalMB();
	const memoryLimit = memoryCap(freeMB, memory.perLaneMB);
	const requestedLimit = Number(process.env.ACQUIT_MAX_LANES ?? count);
	assert(Number.isSafeInteger(requestedLimit) && requestedLimit >= 0, "ACQUIT_MAX_LANES must be a nonnegative integer.");
	const cap = Math.min(count, memoryLimit, requestedLimit);
	const report = { cap, memoryLimit, freeMB, reserveMB, ...memory, refused: count - cap,
		reason: count > cap ? `Start ${cap} of ${count}. Free physical memory is ${freeMB} MB. Run the remaining lanes in another wave.` : null, lanes: [] };
	await atomicJson(waveFile, report);
	console.log(JSON.stringify({ ...report, lanes: undefined }));
	for (let n = 1; n <= cap; n++) {
		try {
			const before = await ctl(n, "status");
			assert(!before.run && !before.ports.api.open && !before.ports.web.open, `Lane ${n} is occupied. Refuse to reuse or reset it.`);
			await ctl(n, "start", "--timeout", "60");
			const run = (await ctl(n, "status")).run;
			report.lanes.push({ n, api: run.api, web: run.web });
			await atomicJson(waveFile, report);
			await ctl(n, "seed-db", "--yes");
			await atomicJson(resolve(managerDir, `browser-${n}.json`), { headed: false, autoConnect: false });
			await browser(n, "open", `http://localhost:${laneSlot(n).webPort}`);
			const status = await ctl(n, "status");
			assert(status.healthy, `Lane ${n} is unhealthy.`);
			console.log(JSON.stringify({ lane: n, healthy: status.healthy, urls: status.urls, databasePath: status.database.path }));
		} catch (error) {
			for (const lane of report.lanes) await cleanupLane(lane.n, { api: lane.api, web: lane.web });
			await atomicJson(waveFile, { ...report, lanes: [] });
			throw error;
		}
	}
	return report;
}
async function main() {
	const [mode, count] = process.argv.slice(2);
	assert(["start", "doctor", "cleanup"].includes(mode), "Use lanes.mjs start <count>, doctor, or cleanup [lane].");
	await mkdir(managerDir, { recursive: true });
	await locked({ ...ctx, dir: managerDir }, async () => {
		if (mode === "start") { await startWave(Number(count)); return; }
		const wave = existsSync(waveFile) ? JSON.parse(await readFile(waveFile, "utf8")) : { lanes: [] };
		if (count !== undefined) assert(/^\d+$/.test(count) && wave.lanes.some(lane => lane.n === Number(count)), "The requested lane is not owned by this wave.");
		for (const lane of wave.lanes.filter(lane => count === undefined || lane.n === Number(count))) {
			if (mode === "doctor") {
				const status = await ctl(lane.n, "status");
				assert.deepEqual({ api: status.run?.api, web: status.run?.web }, { api: lane.api, web: lane.web }, "Lane ownership changed.");
				console.log(JSON.stringify({ lane: lane.n, healthy: status.healthy, urls: status.urls }));
				assert(status.healthy, `Lane ${lane.n} is unhealthy.`);
			} else {
				console.log(JSON.stringify(await cleanupLane(lane.n, { api: lane.api, web: lane.web })));
				wave.lanes = wave.lanes.filter(row => row.n !== lane.n);
				await atomicJson(waveFile, wave);
			}
		}
	});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
