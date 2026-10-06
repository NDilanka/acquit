import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
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
// Node has no public SO_PEERCRED, so the Unix peer is proven from kernel state
// instead. A path string is not a credential: any process that can bind or share
// the path can answer a challenge with another process's pid. start therefore
// records, from the spawned child's own /proc entries, the inode of the listening
// socket it bound and the child's start time; stop accepts an answer only when
// that same pid still owns that exact listener, is still the same process, and
// holds the accepted connection the answer arrived on.
export interface ListenerProof {
	startTime: string;
	listenerInode: number;
}
interface UnixSocket {
	inode: number;
	path: string;
	listening: boolean;
	connected: boolean;
}
// /proc/net/unix rows: address, refcount, protocol, flags, type, state, inode, path.
// The kernel pads the inode column and separates it from the path with exactly
// one space, then prints the bound path untouched: the remainder of the row is
// the path, byte for byte. Rejoining whitespace-separated fields with a single
// space instead would collapse a tab or a space run inside a path, so a
// lookalike path would compare equal to the recorded one. The path stays on a
// row after the socket file is unlinked, so a stale row can never be the proof
// by itself.
const unixRow = /^\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+) (.*)$/;
function unixSockets(): UnixSocket[] {
	const sockets: UnixSocket[] = [];
	let table: string;
	try { table = readFileSync("/proc/net/unix", "utf8"); } catch { return sockets; }
	for (const line of table.split("\n").slice(1)) {
		const row = unixRow.exec(line);
		if (!row) continue;
		const inode = Number(row[4]);
		if (row[2] !== "0001" || !Number.isSafeInteger(inode) || row[5].length === 0) continue;
		sockets.push({ inode, path: row[5], listening: row[1] === "00010000", connected: row[3] === "03" });
	}
	return sockets;
}
function socketInodes(pid: number): Set<number> {
	const inodes = new Set<number>();
	let fds: string[];
	try { fds = readdirSync(`/proc/${pid}/fd`); } catch { return inodes; }
	for (const fd of fds) {
		let target: string;
		try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
		if (target.startsWith("socket:[")) inodes.add(Number(target.slice(8, -1)));
	}
	return inodes;
}
function startTimeOf(pid: number): string | null {
	// /proc/<pid>/stat field 22, the process start time in clock ticks.
	return processFields(pid)?.[19] ?? null;
}
function listenerProof(service: { startTime?: string | null; listenerInode?: number | null }): ListenerProof | null {
	const { startTime, listenerInode } = service;
	if (typeof startTime !== "string" || startTime.length === 0) return null;
	if (typeof listenerInode !== "number" || !Number.isSafeInteger(listenerInode) || listenerInode <= 0) return null;
	return { startTime, listenerInode };
}
// The facts start records for one spawned service, read from that child's own
// /proc entries once the preload has bound the proof socket.
export async function childListener(pid: number, socketPath: string, timeout = 10_000): Promise<ListenerProof | null> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const startTime = startTimeOf(pid);
		const held = socketInodes(pid);
		const owned = unixSockets().filter(socket => socket.listening && socket.path === socketPath && held.has(socket.inode));
		if (startTime && owned.length === 1) return { startTime, listenerInode: owned[0].inode };
		if (!alive(pid) || Date.now() >= deadline) return null;
		await sleep(25);
	}
}
function ownsListener(pid: number, socketPath: string, proof: ListenerProof, held: Set<number>): boolean {
	if (!held.has(proof.listenerInode)) return false;
	if (startTimeOf(pid) !== proof.startTime) return false;
	let target;
	// lstat, never stat: a symlink planted at the recorded path hands the
	// challenge to whatever the link points at.
	try { target = lstatSync(socketPath); } catch { return false; }
	if (target.isSymbolicLink() || !target.isSocket()) return false;
	const listening = unixSockets().filter(socket => socket.listening && socket.path === socketPath);
	return listening.length === 1 && listening[0].inode === proof.listenerInode;
}
const ownershipPreload = fileURLToPath(new URL("./ownership-preload.cjs", import.meta.url));
type OwnerAnswer = { pid: number; ppid: number };
function parseAnswer(text: string): OwnerAnswer | null {
	const [pid, ppid] = text.trim().split(" ").map(Number);
	return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 ? { pid, ppid } : null;
}
function ownerChannel(nonce: string, socketPath?: string): string | null {
	try { return process.platform === "win32" ? ownershipChannel(nonce) : socketPath ?? ""; } catch { return null; }
}
// Resolves on the first complete reply and keeps the connection open: the caller
// reads kernel state while the accepted socket still exists, then releases it.
function askOwner(path: string): Promise<{ answer: OwnerAnswer | null; release: () => void }> {
	return new Promise(resolve => {
		const socket = createConnection(path);
		let buffer = "";
		let settled = false;
		const done = (answer: OwnerAnswer | null) => {
			if (settled) return;
			settled = true;
			resolve({ answer, release: () => socket.destroy() });
		};
		socket.setEncoding("utf8");
		socket.setTimeout(1000, () => done(null));
		socket.once("connect", () => socket.write("prove\n"));
		socket.on("data", chunk => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 256) { done(null); return; }
			const line = buffer.indexOf("\n");
			if (line >= 0) done(parseAnswer(buffer.slice(0, line)));
		});
		socket.once("end", () => done(parseAnswer(buffer)));
		socket.once("error", () => done(null));
	});
}
async function challenge(nonce: string, socketPath?: string): Promise<OwnerAnswer | null> {
	const path = ownerChannel(nonce, socketPath);
	if (!path) return null;
	const proof = await askOwner(path);
	proof.release();
	return proof.answer;
}
export async function ownedProcess(pid: number, nonce: string | null, socketPath?: string, proof?: ListenerProof | null): Promise<boolean> {
	if (!nonce || !alive(pid)) return false;
	try {
		ownershipChannel(nonce);
		if (process.platform === "win32") {
			const helper = fileURLToPath(new URL("./ownership-peer.ps1", import.meta.url));
			const result = await powershell(["-File", helper, "-Nonce", nonce], process.cwd(), 10_000);
			const [peer, answer] = result.stdout.trim().split(" ").map(Number);
			return result.code === 0 && peer === pid && answer === pid && alive(pid);
		}
		// A legacy record without the channel's path proves nothing; neither does
		// one without the listener inode and start time the child's own /proc
		// reported at start.
		if (process.platform !== "linux" || !socketPath || !proof) return false;
		const before = socketInodes(pid);
		if (!ownsListener(pid, socketPath, proof, before)) return false;
		const path = ownerChannel(nonce, socketPath);
		if (!path) return false;
		const reply = await askOwner(path);
		try {
			if (reply.answer?.pid !== pid) return false;
			const after = socketInodes(pid);
			// The answer must arrive on a connection the recorded process holds:
			// its accepted socket is a new connected row at the recorded path
			// inside that process's own fd table. A process that merely holds a
			// duplicated listener fd, or one that forged the pid from elsewhere,
			// never has this fd.
			const accepted = unixSockets().filter(socket => socket.connected && socket.path === socketPath && after.has(socket.inode) && !before.has(socket.inode));
			if (accepted.length !== 1) return false;
			return ownsListener(pid, socketPath, proof, after) && alive(pid);
		} finally { reply.release(); }
	} catch { return false; }
}
export async function ownedService(service: { pid: number; nonce?: string | null; socketPath?: string; startTime?: string | null; listenerInode?: number | null }): Promise<boolean> {
	return ownedProcess(service.pid, service.nonce ?? null, service.socketPath, listenerProof(service));
}
export async function ownershipReady(child: ChildProcess, nonce: string, socketPath?: string): Promise<boolean> {
	// Readiness is not kill authority. The native handle from THIS invocation
	// owns the child; the cheap challenge just waits for its preload to listen.
	if (child.exitCode !== null || child.signalCode !== null || !child.pid) return false;
	const answer = await challenge(nonce, socketPath);
	return answer?.pid === child.pid && alive(child.pid);
}
export async function requireOwned(service: { pid: number; nonce?: string | null; socketPath?: string; startTime?: string | null; listenerInode?: number | null }): Promise<void> {
	if (!alive(service.pid)) return;
	if (await ownedService(service)) return;
	throw new CliError("PID_MISMATCH", `Refuse PID ${service.pid}: it did not answer the ownership challenge with its own pid and its recorded listener (dead, reused, unrelated, or a legacy run file).`,
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
function groupMembers(pid: number): boolean {
	// A process group outlives its leader: the group id is a reference held by
	// every member, so the kernel does not hand that number to a new group while
	// one is still alive. A reaped or zombie leader therefore still names exactly
	// the group its descendants live in. Without /proc the question cannot be
	// answered, and a dead PID must never signal a group a reused PID may lead.
	let entries: string[];
	try { entries = readdirSync("/proc"); } catch { return false; }
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const member = Number(entry);
		if (member === process.pid || !alive(member)) continue;
		if (processFields(member)?.[2] === String(pid)) return true;
	}
	return false;
}
async function waitForTree(pid: number, ms: number): Promise<boolean> {
	// The leader is not the tree: a member that ignores SIGTERM keeps the group,
	// and a call that reports success must not leave a group member behind. The
	// group is all this reaches: a descendant that leaves it (setsid or
	// setpgid) is not signalled, and only a stop's recorded port can catch it.
	// The shipped services do not daemonize a descendant.
	const deadline = Date.now() + ms;
	for (;;) {
		if (!alive(pid) && !groupMembers(pid)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(50);
	}
}
export async function killTree(pid: number): Promise<void> {
	// alive() is false for a zombie, but a zombie holds its process group until
	// it is reaped: the group is still there to signal, and the base commit
	// killed the descendants of one. Only a dead PID with nothing left in its
	// group is a no-op.
	if (!alive(pid) && !(process.platform !== "win32" && groupMembers(pid))) return;
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
		// A group signal reaches every process in the group whose id is the
		// recorded pid. Only kernel state proves that group is that pid's own: a
		// live leader (pgrp == pid), or a group that still holds members after
		// its leader died. A live process whose pgrp is not itself leads no
		// group, so only the unanswered case needs the member scan. Without any
		// proof (no /proc) signal the recorded process alone.
		const leader = processGroupLeader(pid);
		if (leader === true || (leader === null && groupMembers(pid))) {
			try { process.kill(-pid, name); return; } catch {}
		}
		try { process.kill(pid, name); } catch (error) {
			// ESRCH means the target vanished between the liveness check and the
			// call: the tree is gone, and the wait below decides. Anything else is
			// a real refusal (EPERM and friends) and must be named, so main.ts
			// reports a stop failure instead of mapping a raw errno to IO_FAILED.
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ESRCH") return;
			throw new CliError("PROCESS_FAILED", `Could not stop owned PID ${pid}: the ${name} signal was refused (${code ?? "unknown"}).`,
				`Inspect PID ${pid} and data/ctl/run.json locally, then retry npm run -s ctl -- stop.`);
		}
	};
	signal("SIGTERM");
	if (!await waitForTree(pid, 5000)) {
		signal("SIGKILL");
		if (!await waitForTree(pid, 3000)) throw new CliError("PROCESS_FAILED", `Could not stop owned PID ${pid}.`, `Run kill -KILL ${pid}, then npm run -s ctl -- stop.`);
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
