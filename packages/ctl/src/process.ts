import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { helperEnvironment, powershellExecutables, windowsExecutable } from "./executables.ts";

export type ErrorCode = "UNKNOWN_COMMAND" | "UNKNOWN_FLAG" | "INVALID_ARGUMENT" | "MISSING_ARGUMENT"
	| "PORT_IN_USE" | "START_TIMEOUT" | "STOP_TIMEOUT" | "APP_NOT_RUNNING" | "UNKNOWN_TEST_USER"
	| "AGENT_BROWSER_MISSING" | "BROWSER_FAILED" | "SEED_FAILED" | "CONFIRMATION_REQUIRED"
	| "INVALID_STATE" | "CLI_BUSY" | "DATABASE_UNREADABLE" | "DATABASE_NOT_FOUND" | "PROCESS_FAILED" | "IO_FAILED" | "PID_MISMATCH" | "DEV_DISABLED" | "JOB_NOT_FOUND" | "LAW_BREAK";
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
function processFields(pid: number): string[] | null {
	// /proc/<pid>/stat after the comm field, which may itself contain spaces.
	// Fields: 0 state, 1 ppid, 2 pgrp.
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	} catch { return null; }
}
export function alive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); } catch { return false; }
	// A zombie accepts signal 0 but will never run again: it is dead for every
	// purpose this CLI has, and reporting it alive makes stop and its tests
	// depend on when the reaper gets around to it.
	if (process.platform === "linux") {
		const state = processFields(pid)?.[0] ?? null;
		return state !== null && state !== "Z" && state !== "X";
	}
	return true;
}
// A reply alone is NOT proof: a squatter can name another process's pid.
// Stop verifies the kernel-reported server PID on the answering connection.
export function ownershipNonce(): string {
	return randomBytes(16).toString("hex");
}
export function ownershipChannel(nonce: string): string {
	if (!/^[0-9a-f]{32}$/.test(nonce)) throw new CliError("INVALID_STATE", "Refusing an ownership nonce that is not 32 hex characters.", "Retry start. Do not reuse a legacy run file.");
	return process.platform === "win32" ? `\\\\.\\pipe\\acquit-${nonce}` : nonce;
}
// Node has no public SO_PEERCRED, so the Unix peer is proven from two kernel
// tables: /proc/net/unix maps a bound path to the inode that names its listening
// socket, and /proc/<pid>/fd shows which sockets a process holds. An answer is
// kill authority only when the answering pid holds the listener it answered on.
function listeningSocketInodes(path: string): Set<number> {
	const inodes = new Set<number>();
	let table: string;
	try { table = readFileSync("/proc/net/unix", "utf8"); } catch { return inodes; }
	for (const line of table.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		const inode = Number(fields[6]);
		if (fields.length > 7 && Number.isSafeInteger(inode) && fields.slice(7).join(" ") === path) inodes.add(inode);
	}
	return inodes;
}
function holdsSocket(pid: number, inodes: Set<number>): boolean {
	if (!inodes.size) return false;
	let fds: string[];
	try { fds = readdirSync(`/proc/${pid}/fd`); } catch { return false; }
	for (const fd of fds) {
		let target: string;
		try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
		for (const inode of inodes) if (target === `socket:[${inode}]`) return true;
	}
	return false;
}
const ownershipPreload = fileURLToPath(new URL("./ownership-preload.cjs", import.meta.url));
function challenge(nonce: string, socketPath?: string): Promise<{ pid: number; ppid: number } | null> {
	return new Promise(resolve => {
		let path: string;
		try { path = process.platform === "win32" ? ownershipChannel(nonce) : socketPath ?? ""; }
		catch { resolve(null); return; }
		if (!path) { resolve(null); return; }
		const socket = createConnection(path);
		let buffer = "";
		const done = (answer: { pid: number; ppid: number } | null) => { socket.destroy(); resolve(answer); };
		socket.setEncoding("utf8");
		socket.setTimeout(1000, () => done(null));
		socket.once("connect", () => socket.write("prove\n"));
		socket.on("data", chunk => { buffer += chunk; if (Buffer.byteLength(buffer) > 256) done(null); });
		socket.once("end", () => {
			const [pid, ppid] = buffer.trim().split(" ").map(Number);
			done(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 ? { pid, ppid } : null);
		});
		socket.once("error", () => done(null));
	});
}
export async function ownedProcess(pid: number, nonce: string | null, socketPath?: string): Promise<boolean> {
	if (!nonce || !alive(pid)) return false;
	try {
		ownershipChannel(nonce);
		if (process.platform === "win32") {
			const helper = fileURLToPath(new URL("./ownership-peer.ps1", import.meta.url));
			const result = await powershell(["-File", helper, "-Nonce", nonce], process.cwd(), 10_000);
			const [peer, answer] = result.stdout.trim().split(" ").map(Number);
			return result.code === 0 && peer === pid && answer === pid && alive(pid);
		}
		// A legacy record without the channel's path proves nothing; neither
		// does a reply from a pid that does not hold the listener it replied on.
		if (process.platform !== "linux" || !socketPath) return false;
		const answer = await challenge(nonce, socketPath);
		return answer?.pid === pid && holdsSocket(pid, listeningSocketInodes(socketPath)) && alive(pid);
	} catch { return false; }
}
export async function ownershipReady(child: ChildProcess, nonce: string, socketPath?: string): Promise<boolean> {
	// Readiness is not kill authority. The native handle from THIS invocation
	// owns the child; the cheap challenge just waits for its preload to listen.
	if (child.exitCode !== null || child.signalCode !== null || !child.pid) return false;
	const answer = await challenge(nonce, socketPath);
	return answer?.pid === child.pid && alive(child.pid);
}
export async function requireOwned(service: { pid: number; nonce?: string | null }, socketPath?: string): Promise<void> {
	if (!alive(service.pid)) return;
	if (await ownedProcess(service.pid, service.nonce ?? null, socketPath)) return;
	throw new CliError("PID_MISMATCH", `Refuse PID ${service.pid}: it did not answer the ownership challenge with its own pid (dead, reused, unrelated, or a legacy run file).`,
		`Inspect PID ${service.pid} and the run file locally. Stop it manually only after confirming ownership; then retry ctl stop to clear the stale record. Never adopt an unverified PID.`);
}
export function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
	return new Promise(resolve => {
		const socket = createConnection({ host, port });
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
	// stdout is a pipe, never a temp file. A hard kill of this CLI used to leave
	// captured output on disk; a pipe dies with the process. Resolve on exit, not
	// close: a cold browser daemon can inherit the stdout handle on Windows.
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		child.stdout?.on("data", chunk => chunks.push(chunk));
		if (input !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(input); }
		const finish = () => { clearTimeout(timer); child.stdout?.destroy(); child.stdin?.destroy(); };
		const timer = setTimeout(() => {
			// The handle from this spawn is the proof; killTree only reaches its tree.
			void killTree(child.pid ?? 0).catch(() => {});
			finish();
			reject(new CliError("PROCESS_FAILED", "The child command timed out.", "Retry the command. If it repeats, run npm run -s ctl -- status."));
		}, timeout);
		child.once("error", error => { finish(); reject(error); });
		child.once("exit", code => { finish(); resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }); });
	});
}
export async function powershell(args: string[], cwd: string, timeout = 30_000): Promise<{ code: number; stdout: string }> {
	for (const executable of powershellExecutables()) {
		try {
			const result = await captured(executable, ["-NoProfile", "-NonInteractive", ...args], cwd, helperEnvironment(), timeout);
			if (result.code === 0) return result;
		} catch {}
	}
	throw new CliError("PROCESS_FAILED", "No PowerShell helper completed successfully.", "Install PowerShell 7 or enable Windows PowerShell. Ownership checks remain fail-closed.");
}
export async function discarded(executable: string, args: string[], cwd: string, env = process.env, timeout = 60_000, input?: string): Promise<number> {
	// Credential output is never retained, even if this CLI dies.
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
function processGroupLeader(pid: number): boolean | null {
	// null when the kernel cannot answer (no /proc), so the caller still tries
	// the group before falling back to the process itself.
	const fields = processFields(pid);
	return fields ? Number(fields[2]) === pid : null;
}
async function waitForDeath(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await sleep(25);
	}
	return !alive(pid);
}
export async function killTree(pid: number): Promise<void> {
	if (!alive(pid)) return;
	if (pid === process.pid) throw new CliError("INVALID_STATE", "The ownership file refers to this CLI process.", "Inspect data/ctl/run.json and remove the invalid record.");
	if (process.platform === "win32") {
		const result = await captured(windowsExecutable("taskkill.exe"), ["/pid", String(pid), "/t", "/f"], process.cwd(), helperEnvironment());
		if (result.code !== 0 && alive(pid)) throw new CliError("PROCESS_FAILED", `Could not stop owned PID ${pid}.`, `Run taskkill /pid ${pid} /t /f, then npm run -s ctl -- stop.`);
		return;
	}
	// detached() passes detached:true, which makes the child a session and
	// process-group leader (setsid), so a group signal reaches its descendants.
	// A bare ChildProcess handle (a lock holder, a hand-spawned helper) has no
	// group of its own: signal the process rather than throw and leak it.
	const signal = (name: NodeJS.Signals) => {
		if (processGroupLeader(pid) !== false) {
			try { process.kill(-pid, name); return; } catch {}
		}
		process.kill(pid, name);
	};
	signal("SIGTERM");
	if (!await waitForDeath(pid, 5000)) {
		try { signal("SIGKILL"); } catch {}
		if (!await waitForDeath(pid, 3000)) throw new CliError("PROCESS_FAILED", `Could not stop owned PID ${pid}.`, `Run kill -KILL ${pid}, then npm run -s ctl -- stop.`);
	}
}
export async function detached(script: string, nonce: string, cwd: string, env: NodeJS.ProcessEnv, log: string, extra: string[] = [], socketPath?: string): Promise<ChildProcess> {
	ownershipChannel(nonce);
	const fd = openSync(log, "a");
	try {
		// The nonce names the proof channel; it is not a marker to be searched for.
		// It is a script argument after `--`, so neither Node nor Vite parses it.
		// On Unix the socket path travels in the environment because a filesystem
		// socket cannot be derived from the nonce alone; Windows uses the nonce.
		const childEnv = { ...env, ...(socketPath ? { ACQUIT_OWNERSHIP_SOCKET: socketPath } : {}) };
		const child = spawn(process.execPath, ["--require", ownershipPreload, script, ...extra, "--", nonce],
			{ cwd, env: childEnv, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
		await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		child.unref();
		return child;
	} finally { closeSync(fd); }
}
export async function releaseSpawned(child: ChildProcess): Promise<void> {
	// A ChildProcess from this invocation retains its native handle. Unlike a
	// run-file PID, that handle is ownership; do not consult the proof channel.
	// exitCode is not trustworthy here: Node sets it only on the exit event,
	// after the PID is already dead and reusable.
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform !== "win32") { await killTree(child.pid!); return; }
	// detached() unrefs this handle. Waiting on a Promise alone does not keep
	// Node alive long enough to observe exit and finish ownership cleanup.
	child.ref();
	try {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				child.removeListener("exit", onExit);
				child.removeListener("error", onError);
				error ? reject(error) : resolve();
			};
			const onExit = () => finish();
			const onError = (error: Error) => finish(error);
			const timer = setTimeout(() => finish(new CliError("PROCESS_FAILED", "Spawned child cleanup did not exit within 5s.", "Inspect the retained run file; retry ctl stop after verifying ownership.")), 5000);
			child.once("exit", onExit);
			child.once("error", onError);
			try {
				if (!child.kill() && !alive(child.pid ?? 0)) finish();
			} catch (error) { finish(error as Error); }
		});
	} finally { child.unref(); }
}
