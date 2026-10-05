import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

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
// The proof is chosen before spawn and placed in the child's argv. A reused PID
// cannot carry a nonce it was never given, so no post-spawn identity lookup is needed.
// Node rejects unknown options, and Vite rejects unknown positionals. A --require
// of a no-op preload is accepted by both and is visible in the OS command line.
// The filename is the nonce: one preload, no per-start file.
export const ownershipArg = "--require";
const ownershipPreload = fileURLToPath(new URL("./ownership-preload.cjs", import.meta.url));
export function ownershipNonce(): string {
	return randomBytes(16).toString("hex");
}
function commandLine(pid: number): Promise<string | null> {
	if (!alive(pid)) return Promise.resolve(null);
	if (process.platform === "win32") return new Promise(resolve => {
		execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
			`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop).CommandLine`],
			{ encoding: "utf8", windowsHide: true, timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout));
	});
	if (process.platform === "linux") return readFile(`/proc/${pid}/cmdline`, "utf8").then(text => text.replaceAll("\0", " ")).catch(() => null);
	return new Promise(resolve => {
		execFile("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout));
	});
}
export async function ownedCommand(pid: number, nonce: string | null): Promise<boolean> {
	if (!nonce || !/^[0-9a-f]{32}$/.test(nonce) || !alive(pid)) return false;
	const line = await commandLine(pid);
	// Recheck after the lookup: the PID may have died and been reused meanwhile.
	return line !== null && alive(pid) && line.includes(`${ownershipArg} ${ownershipPreload}`) && line.includes(nonce);
}
export async function requireOwned(service: { pid: number; nonce?: string | null }): Promise<void> {
	if (!alive(service.pid)) return;
	if (await ownedCommand(service.pid, service.nonce ?? null)) return;
	throw new CliError("PID_MISMATCH", `Refuse PID ${service.pid}: its command line has no matching ownership nonce (dead, reused, unrelated, or a legacy run file).`,
		`Inspect PID ${service.pid} and the run file locally. Stop it manually only after confirming ownership; then retry ctl stop to clear the stale record. Never adopt an unverified PID.`);
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
export async function discarded(executable: string, args: string[], cwd: string, env = process.env, timeout = 60_000, input?: string): Promise<number> {
	// Credential output never touches a temporary file, even if this CLI dies.
	// Resolve on exit, not close: a cold daemon can inherit the stdout pipe.
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
		child.stdout?.resume();
		if (input !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(input); }
		const finish = () => { clearTimeout(timer); child.stdout?.destroy(); child.stdin?.destroy(); };
		const timer = setTimeout(() => {
			void releaseSpawned(child).catch(() => {});
			finish();
			reject(new CliError("PROCESS_FAILED", "The credential command timed out. No diagnostics saved.", "Retry approval without dashboard or stream clients."));
		}, timeout);
		child.once("error", error => { finish(); reject(error); });
		child.once("exit", code => { finish(); resolve(code ?? 1); });
	});
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
export async function detached(script: string, nonce: string, cwd: string, env: NodeJS.ProcessEnv, log: string, extra: string[] = []): Promise<ChildProcess> {
	if (!/^[0-9a-f]{32}$/.test(nonce)) throw new CliError("INVALID_STATE", "Refusing to spawn a service without an ownership nonce.", "Retry start. Do not reuse a legacy run file.");
	const fd = openSync(log, "a");
	try {
		// The nonce is an argv marker, never an environment value, so command-line
		// inspection can prove ownership without reading the process environment.
		// The nonce is a script argument after `--`, so neither Node nor Vite parses
		// it, while Win32_Process/ps still report it in the command line.
		const child = spawn(process.execPath, [ownershipArg, ownershipPreload, script, ...extra, "--", nonce], { cwd, env, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
		await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		child.unref();
		return child;
	} finally { closeSync(fd); }
}
export async function releaseSpawned(child: ChildProcess): Promise<void> {
	// A ChildProcess from this invocation retains its native handle. Unlike a
	// run-file PID, that handle is ownership; do not consult a command line.
	// exitCode is not trustworthy here: Node sets it only on the exit event,
	// after the PID is already dead and reusable.
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform !== "win32") { await killTree(child.pid!); return; }
	// detached() unrefs this handle. Waiting on a Promise alone does not keep
	// Node alive long enough to observe exit and finish ownership cleanup.
	child.ref();
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	child.kill();
	await exited;
}
