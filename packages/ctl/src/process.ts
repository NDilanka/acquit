import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ErrorCode = "UNKNOWN_COMMAND" | "UNKNOWN_FLAG" | "INVALID_ARGUMENT" | "MISSING_ARGUMENT"
	| "PORT_IN_USE" | "START_TIMEOUT" | "STOP_TIMEOUT" | "APP_NOT_RUNNING" | "UNKNOWN_TEST_USER"
	| "AGENT_BROWSER_MISSING" | "BROWSER_FAILED" | "SEED_FAILED" | "CONFIRMATION_REQUIRED"
	| "INVALID_STATE" | "CLI_BUSY" | "DATABASE_UNREADABLE" | "PROCESS_FAILED" | "IO_FAILED" | "PID_MISMATCH" | "DEV_DISABLED";
export class CliError extends Error {
	readonly code: ErrorCode;
	readonly fix: string;
	readonly exitCode: 1 | 2;
	constructor(code: ErrorCode, message: string, fix: string, exitCode: 1 | 2 = 1) {
		super(message);
		this.code = code;
		this.fix = fix;
		this.exitCode = exitCode;
	}
}
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function alive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}
export function processStartTime(pid: number): string | null {
	if (!alive(pid)) return null;
	try {
		if (process.platform === "win32") return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
			`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`], { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
		if (process.platform === "linux") return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19];
		return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3000 }).trim() || null;
	} catch { return null; }
}
export function requireOwned(service: { pid: number; startTime: string | null }): void {
	if (!alive(service.pid)) return;
	if (!service.startTime) throw new CliError("PID_MISMATCH", `Refuse PID ${service.pid}: the run file has no verified process start time (legacy or interrupted start).`,
		`Inspect PID ${service.pid} and the run file locally. Stop it manually only after confirming ownership; then retry ctl stop to clear the stale record. Never adopt an unverified PID.`);
	if (!service.startTime || processStartTime(service.pid) !== service.startTime) {
		throw new CliError("PID_MISMATCH", `Refuse PID ${service.pid}: process start-time mismatch.`, "Inspect the lane run file. Do not stop an unrelated process.");
	}
}
export function portOpen(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const done = (open: boolean) => { socket.destroy(); resolve(open); };
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.setTimeout(500, () => done(false));
	});
}
export async function reachable(url: string): Promise<boolean> {
	try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); await response.body?.cancel(); return response.status === 200; }
	catch { return false; }
}
export async function captured(executable: string, args: string[], cwd: string, env = process.env, timeout = 60_000, input?: string): Promise<{ code: number; stdout: string }> {
	const dir = await mkdtemp(join(tmpdir(), "acquit-capture-"));
	const file = join(dir, "stdout");
	const fd = openSync(file, "w", 0o600);
	try {
		// A cold browser daemon inherits pipe handles on Windows. Its CLI exits before those handles close.
		const code = await new Promise<number>((resolve, reject) => {
			const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", fd, "ignore"] });
			if (input !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(input); }
			const timer = setTimeout(() => {
				void killTree(child.pid ?? 0).catch(() => {});
				reject(new CliError("PROCESS_FAILED", "The child command timed out.", "Retry the command. If it repeats, run npm run -s ctl -- status."));
			}, timeout);
			child.once("error", error => { clearTimeout(timer); reject(error); });
			child.once("exit", code => { clearTimeout(timer); resolve(code ?? 1); });
		});
		return { code, stdout: await readFile(file, "utf8") };
	} finally {
		closeSync(fd);
		await unlink(file);
		await rmdir(dir);
	}
}
export async function killTree(pid: number): Promise<void> {
	if (!alive(pid)) return;
	if (pid === process.pid) throw new CliError("INVALID_STATE", "The ownership file refers to this CLI process.", "Inspect data/ctl/run.json and remove the invalid record.");
	if (process.platform === "win32") {
		const result = await captured("taskkill", ["/pid", String(pid), "/t", "/f"], process.cwd());
		if (result.code !== 0 && alive(pid)) throw new CliError("PROCESS_FAILED", `Could not stop owned PID ${pid}.`, `Run taskkill /pid ${pid} /t /f, then npm run -s ctl -- stop.`);
	} else {
		try { process.kill(-pid, "SIGTERM"); }
		catch (error) { if (alive(pid)) throw new CliError("PROCESS_FAILED", `Could not stop owned process group ${pid}.`, `Run kill -TERM -- -${pid}, then npm run -s ctl -- stop.`); }
	}
}
export async function detached(args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string): Promise<ChildProcess> {
	const fd = openSync(log, "a");
	try {
		const child = spawn(process.execPath, args, { cwd, env, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
		await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		child.unref();
		return child;
	} finally { closeSync(fd); }
}
export async function captureStartTime(pid: number): Promise<string | null> {
	// Run asynchronously so Windows identity lookup does not delay spawning the
	// other service or probing readiness. Retry transient memory-pressure errors.
	for (let attempt = 0; attempt < 3; attempt++) {
		if (!alive(pid)) return null;
		if (process.platform !== "win32") return processStartTime(pid);
		const result = await captured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
			`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`], process.cwd(), process.env, 10_000).catch(() => null);
		if (result?.code === 0 && result.stdout.trim()) return result.stdout.trim();
		await sleep(100);
	}
	return null;
}
export async function releaseSpawned(child: ChildProcess): Promise<void> {
	// A ChildProcess retains the native process handle on Windows. Unlike stale
	// run.json, this invocation has direct ownership even if identity lookup fails.
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform !== "win32") { await killTree(child.pid!); return; }
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	child.kill();
	await exited;
}
