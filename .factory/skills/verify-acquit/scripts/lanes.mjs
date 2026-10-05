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
const ctx = context();

export function memoryCap(freeMB, perLaneMB, reserveMB = 128) {
	assert(Number.isFinite(freeMB) && freeMB >= 0 && Number.isFinite(perLaneMB) && perLaneMB > 0);
	assert(Number.isFinite(reserveMB) && reserveMB >= 0);
	return Math.max(0, Math.floor((freeMB - reserveMB) / perLaneMB));
}
export function freePhysicalMB() {
	// os.freemem uses GlobalMemoryStatusEx on Windows, without spawning CIM.
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
		const script = `$rows=Get-CimInstance Win32_Process; $ids=[Collections.Generic.HashSet[int]]::new(); @(${roots.join(",")}) | ForEach-Object { [void]$ids.Add($_) }; do { $added=$false; foreach($r in $rows) { if($ids.Contains([int]$r.ParentProcessId) -and $ids.Add([int]$r.ProcessId)) { $added=$true } } } while($added); $bytes=0; foreach($id in $ids) { $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p) { $bytes += $p.WorkingSet64 } }; $bytes`;
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
export async function measure() {
	const owned = [];
	for (const n of [100, 101]) {
		const preflight = await ctl(n, "status");
		assert(!preflight.run && !preflight.ports.api.open && !preflight.ports.web.open, `Measurement lane ${n} is occupied.`);
	}
	const physical = [];
	const sampler = setInterval(() => physical.push(freePhysicalMB()), 100);
	try {
		await ctl(100, "start", "--timeout", "60");
		const first = (await ctl(100, "status")).run;
		owned.push({ n: 100, run: first });
		await ctl(100, "seed-db", "--yes");
		const firstRoots = [first.api.pid, first.web.pid];
		const firstAppMB = Math.ceil(processMemory(firstRoots) / 1048576);
		const beforeSecondFreeMB = freePhysicalMB();
		physical.length = 0;
		await ctl(101, "start", "--timeout", "60");
		const second = (await ctl(101, "status")).run;
		owned.push({ n: 101, run: second });
		await ctl(101, "seed-db", "--yes");
		await sleep(500);
		const afterSecondFreeMB = freePhysicalMB();
		const startupMinFreeMB = Math.min(beforeSecondFreeMB, ...physical);
		const appRoots = [...firstRoots, second.api.pid, second.web.pid];
		const pairedAppMB = Math.ceil(processMemory(appRoots) / 1048576);
		const appMarginalMB = Math.max(1, pairedAppMB - firstAppMB);
		await atomicJson(resolve(managerDir, "browser-101.json"), { headed: false, autoConnect: false });
		const beforeBrowserFreeMB = freePhysicalMB();
		await browser(101, "open", `http://localhost:${laneSlot(101).webPort}`);
		await browser(101, "wait", "--text", "Sign in as a seeded user");
		const info = await browser(101, "session", "info");
		assert(Number.isSafeInteger(info.pid) && info.pid > 0, "Browser daemon PID is missing.");
		await sleep(500);
		const withBrowserMB = Math.ceil(processMemory([...appRoots, info.pid]) / 1048576);
		const browserMarginalMB = Math.max(1, withBrowserMB - pairedAppMB);
		// Use simultaneous current working sets, not an impossible sum of peaks.
		// Reserve measured startup/control transient pressure plus 64 MB headroom,
		// with a 128 MB floor. Record physical deltas to expose host noise.
		const startupTransientMB = Math.max(0, afterSecondFreeMB - startupMinFreeMB);
		const measuredReserveMB = Math.max(128, Math.ceil(startupTransientMB + 64));
		const memory = { version: 2, appMarginalMB, browserMarginalMB, firstAppMB, pairedAppMB, withBrowserMB,
			perLaneMB: Math.max(firstAppMB, appMarginalMB), measuredReserveMB, startupTransientMB,
			beforeSecondFreeMB, afterSecondFreeMB, startupMinFreeMB, beforeBrowserFreeMB, afterBrowserFreeMB: freePhysicalMB(),
			measuredAt: new Date().toISOString(), method: "paired current working-set/RSS delta after starting a second app slot; browser measured separately",
			node: process.version, platform: process.platform };
		await atomicJson(memoryFile, memory);
		return memory;
	} finally {
		clearInterval(sampler);
		for (const { n, run } of owned.reverse()) await cleanupLane(n, { api: run.api, web: run.web });
	}
}
export function planWave(count, freeMB, memory, { maxLanes = count, reserveMB = memory.measuredReserveMB, browsers = false, maxBrowsers = 2 } = {}) {
	assert(Number.isSafeInteger(maxLanes) && maxLanes >= 0, "ACQUIT_MAX_LANES must be a nonnegative integer.");
	assert(Number.isSafeInteger(maxBrowsers) && maxBrowsers >= 0, "ACQUIT_MAX_BROWSERS must be a nonnegative integer.");
	const cost = memory.perLaneMB + (browsers ? memory.browserMarginalMB : 0);
	const memoryLimit = memoryCap(freeMB, cost, reserveMB);
	const cap = Math.min(count, memoryLimit, maxLanes, browsers ? maxBrowsers : count);
	const browserCap = Math.min(maxBrowsers, memoryCap(Math.max(0, freeMB - cap * memory.perLaneMB), memory.browserMarginalMB, reserveMB));
	const reason = count > cap ? `Start ${cap} of ${count}. Free physical memory ${freeMB} MB; one app${browsers ? " and browser" : ""} needs ${cost + reserveMB} MB including reserve ${reserveMB} MB. Limits: ACQUIT_MAX_LANES=${maxLanes}${browsers ? `, ACQUIT_MAX_BROWSERS=${maxBrowsers}` : ""}. Run the refused lanes in another wave.` : null;
	return { ...memory, cap, browserCap, memoryLimit, maxLanes, maxBrowsers, freeMB, reserveMB, refused: count - cap, reason, lanes: [] };
}
export async function startWave(requested, onPlan = () => {}, options = {}) {
	const numbers = Array.isArray(requested) ? requested : Array.from({ length: requested }, (_, i) => i + 1);
	assert(numbers.length > 0 && numbers.length <= 100 && new Set(numbers).size === numbers.length && numbers.every(n => Number.isSafeInteger(n) && n > 0 && n <= 100), "Use start <count> (1..100) or start --lanes 6,7,8.");
	if (existsSync(waveFile)) {
		const previous = JSON.parse(await readFile(waveFile, "utf8"));
		assert(previous.lanes.length === 0, "A wave still owns lane slots. Run doctor or cleanup before another start.");
	}
	let memory = existsSync(memoryFile) ? JSON.parse(await readFile(memoryFile, "utf8")) : null;
	if (memory?.version !== 2) memory = null;
	memory ??= await measure();
	const report = planWave(numbers.length, freePhysicalMB(), memory, {
		maxLanes: Number(process.env.ACQUIT_MAX_LANES ?? numbers.length), reserveMB: Number(process.env.ACQUIT_RESERVE_MB ?? memory.measuredReserveMB),
		maxBrowsers: Number(process.env.ACQUIT_MAX_BROWSERS ?? 2), ...options });
	report.requestedLanes = numbers;
	report.startedLanes = numbers.slice(0, report.cap);
	await atomicJson(waveFile, report);
	console.log(JSON.stringify({ ...report, lanes: undefined }));
	onPlan(report);
	assert(report.cap > 0, report.reason);
	for (const n of report.startedLanes) {
		try {
			const before = await ctl(n, "status");
			assert(!before.run && !before.ports.api.open && !before.ports.web.open, `Lane ${n} is occupied. Refuse to reuse or reset it.`);
			const launch = await ctl(n, "start", "--timeout", "60");
			const run = (await ctl(n, "status")).run;
			report.lanes.push({ n, api: run.api, web: run.web, browser: Boolean(options.browsers) });
			await atomicJson(waveFile, report);
			await ctl(n, "seed-db", "--yes");
			if (process.env.ACQUIT_EVIDENCE_DIR) await atomicJson(resolve(root, process.env.ACQUIT_EVIDENCE_DIR, `lane-${n}`, "launch.json"), { ok: true, command: "start", data: launch });
			if (options.browsers) {
				await atomicJson(resolve(managerDir, `browser-${n}.json`), { headed: false, autoConnect: false });
				await browser(n, "open", `http://localhost:${laneSlot(n).webPort}`);
			}
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
export async function restartLane(n, options = {}) {
	assert(Number.isSafeInteger(n) && n > 0 && n <= 100, "Use restart <n> for one occupied lane.");
	const status = await ctl(n, "status");
	assert(status.run, `Lane ${n} has no owned run to restart.`);
	const wave = existsSync(waveFile) ? JSON.parse(await readFile(waveFile, "utf8")) : { lanes: [] };
	const owned = wave.lanes.find(lane => lane.n === n);
	if (owned) assert.deepEqual({ api: status.run.api, web: status.run.web }, { api: owned.api, web: owned.web }, "Lane ownership changed. Refuse restart.");
	// Free the slot before measuring. planWave prices additions, so measuring
	// while this slot still runs would double-count it and can refuse a restart
	// the machine can actually afford.
	await cleanupLane(n, { api: status.run.api, web: status.run.web });
	if (owned) {
		wave.lanes = wave.lanes.filter(lane => lane.n !== n);
		await atomicJson(waveFile, wave);
	}
	return startWave([n], () => {}, options);
}
async function main() {
	const [mode, count, ...extra] = process.argv.slice(2);
	assert(["start", "restart", "measure", "doctor", "cleanup"].includes(mode), "Use lanes.mjs start <count> [--browsers], start --lanes 6,7,8, restart <n> [--browsers], measure, doctor, or cleanup [lane].");
	await mkdir(managerDir, { recursive: true });
	await locked({ ...ctx, dir: managerDir }, async () => {
		if (mode === "measure") { console.log(JSON.stringify(await measure())); return; }
		if (mode === "restart") {
			assert(/^\d+$/.test(count) && extra.every(flag => flag === "--browsers"), "Use restart <n> [--browsers].");
			await restartLane(Number(count), { browsers: extra.includes("--browsers") }); return;
		}
		if (mode === "start") {
			const explicit = count === "--lanes";
			const numbers = explicit ? extra[0]?.split(",").map(Number) : Number(count);
			const flags = explicit ? extra.slice(1) : extra;
			assert(flags.every(flag => flag === "--browsers"), "Unknown start option.");
			await startWave(numbers, () => {}, { browsers: flags.includes("--browsers") }); return;
		}
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
