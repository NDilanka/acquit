import { createServer } from "node:net";
import type { Server } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { mkdir, chmod, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobRow } from "../../core/src/job.ts";
import { CliError, sleep } from "./process.ts";

export interface ServiceRecord {
	pid: number;
	port: number;
	// Present only for nonce-owned runs. The nonce names the private channel the
	// child answers on; it is not a command-line marker. Legacy files recorded
	// startTime instead; readState keeps them readable and marks them unowned.
	nonce?: string | null;
	startTime?: string | null;
	// Unix proof channels are filesystem sockets. Windows derives the pipe name
	// from the nonce, so this is absent there.
	socketPath?: string;
	// The listener inode and the process start time start read from the spawned
	// child's own /proc entries. stop refuses to kill without them: a path
	// string alone names no process.
	listenerInode?: number | null;
}
export interface RunState {
	api: ServiceRecord;
	web: ServiceRecord;
	// Absent in a run file written before the verifier joined the lane, and
	// absent on a start that never reached the verifier spawn.
	verifier?: ServiceRecord;
	logs: { api: string; web: string; verifier?: string };
	startedAt: string;
	databasePath: string;
}
export interface LaneSlot {
	apiPort: number;
	webPort: number;
	verifierPort: number;
	databasePath: string;
	runDir: string;
	browserSession: string;
}
export function laneSlot(n?: number): LaneSlot {
	if (n === 0) n = undefined;
	if (n === undefined) return { apiPort: 4310, webPort: 5173, verifierPort: 4311, databasePath: "data/acquit.db", runDir: "data/ctl", browserSession: "verify-acquit" };
	if (!Number.isSafeInteger(n) || n < 0 || 5173 + 10 * n > 65535) throw new CliError("INVALID_ARGUMENT", "ACQUIT_LANE must be an integer between 0 and 6036.", "Set ACQUIT_LANE to a valid lane number.", 2);
	return { apiPort: 4310 + 10 * n, webPort: 5173 + 10 * n, verifierPort: 4311 + 10 * n, databasePath: `data/verify/lane-${n}/acquit.db`, runDir: `data/ctl/lane-${n}`, browserSession: `verify-acquit-lane-${n}` };
}
export interface Context {
	root: string;
	dir: string;
	stateFile: string;
	databasePath: string;
	apiPort: number;
	webPort: number;
	verifierPort: number;
	browserSession: string;
}
export function context(): Context {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const env = resolve(root, ".env");
	if (existsSync(env)) process.loadEnvFile(env);
	const port = (name: string, fallback: number) => {
		const value = Number(process.env[name] ?? fallback);
		if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new CliError("INVALID_ARGUMENT", `${name} must be a port between 1 and 65535.`, `Set ${name} to an unused port, then retry.`, 2);
		return value;
	};
	const lane = process.env.ACQUIT_LANE === "0" ? undefined : process.env.ACQUIT_LANE;
	const slot = laneSlot(lane === undefined ? undefined : /^\d+$/.test(lane) ? Number(lane) : NaN);
	const dir = resolve(root, slot.runDir);
	const apiPort = lane === undefined ? port("PORT", slot.apiPort) : slot.apiPort;
	return { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, lane === undefined ? process.env.DATABASE_PATH ?? slot.databasePath : slot.databasePath),
		apiPort, webPort: lane === undefined ? port("WEB_PORT", slot.webPort) : slot.webPort,
		verifierPort: lane === undefined ? port("ACQUIT_VERIFIER_PORT", slot.verifierPort) : slot.verifierPort, browserSession: slot.browserSession };
}
export async function readState(ctx: Context): Promise<RunState | null> {
	let raw: string;
	// Open/read/close in one turn: an async reader can hold a Windows handle
	// without FILE_SHARE_DELETE across the next atomic rename.
	try { raw = readFileSync(ctx.stateFile, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	try {
		const state = JSON.parse(raw) as RunState;
		for (const service of [state.api, state.web, state.verifier]) {
			if (service === undefined) continue;
			// The nonce locates a channel, never grants kill authority. Legacy
			// records stay readable, but requireOwned must verify the kernel peer.
			if (!/^[0-9a-f]{32}$/.test(service.nonce ?? "")) service.nonce = null;
			if (!Number.isSafeInteger(service.pid) || service.pid < 0 || !Number.isSafeInteger(service.port) || service.port < 1 || service.port > 65535) throw new Error();
		}
		if (!state.api || !state.web || typeof state.logs?.api !== "string" || typeof state.logs.web !== "string"
			|| (state.verifier !== undefined && typeof state.logs.verifier !== "string")
			|| typeof state.databasePath !== "string" || typeof state.startedAt !== "string") throw new Error();
		return state;
	} catch { throw new CliError("INVALID_STATE", "The CLI ownership file is invalid.", `Inspect ${ctx.stateFile}. Restore its owned PIDs or remove the file only after stopping those processes.`); }
}
export async function atomicJson(path: string, value: unknown, beforePublish?: () => void): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
		await retryFileOperation(() => {
			beforePublish?.();
			// Every retry re-runs the guard, synchronously adjacent to publish.
			renameSync(temp, path);
		});
	}
	finally { await unlink(temp).catch(() => {}); }
}
export async function clearState(ctx: Context): Promise<void> {
	try { await retryFileOperation(() => unlink(ctx.stateFile)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function retryFileOperation(run: () => void | Promise<void>): Promise<void> {
	const deadline = Date.now() + 2000;
	for (;;) {
		try { await run(); return; }
		catch (error) {
			if (!["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) throw error;
			await sleep(25);
		}
	}
}
// The lock is an open exclusive handle: a pipe server on Windows, a bound
// socket elsewhere. Two CLIs cannot both listen on the same name, so there is
// no delete-then-create window. The handle closes when this process exits,
// even if it is killed, which releases the name for the next CLI. On Linux the
// name is an abstract socket, which the kernel frees the moment the holder
// dies: a SIGKILLed CLI leaves nothing to reclaim. Elsewhere the name is a
// socket file, and a killed holder leaves a file that no later CLI can prove
// dead, so it refuses with CLI_BUSY until the file is removed by hand. The name
// is derived from the lane directory so every CLI targeting that lane contends
// for the same handle.
export function lockName(dir: string): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\acquit-lock-${createHash("sha256").update(resolve(dir).toLowerCase()).digest("hex")}`;
	if (process.platform === "linux") return `\0acquit-lock-${createHash("sha256").update(resolve(dir)).digest("hex")}`;
	return resolve(dir, "operation.lock");
}
// The printable form of lockName for error text: an abstract name as ss -lx
// prints it, a pipe or file path as itself.
export function lockLabel(dir: string): string {
	const name = lockName(dir);
	return name.startsWith("\0") ? `@${name.slice(1)}` : name;
}
async function acquireLock(dir: string): Promise<Server> {
	const name = lockName(dir);
	const label = lockLabel(dir);
	// The recovery follows what the lock is: the kernel owns an abstract name,
	// a pipe is released by holder exit, and a socket file outlives a killed
	// holder until someone deletes it.
	const fix = process.platform === "linux"
		? "Wait for that command to finish, then retry. The kernel frees this lock the moment its holder exits, so a killed CLI leaves nothing behind. Never delete a run file to bypass this lock."
		: process.platform === "win32"
			? `Wait for that command to finish, then retry. If stuck, inspect the process holding ${label} locally and close only that verified holder; process exit releases the pipe. Never delete a run file to bypass this lock.`
			: `Wait for that command to finish, then retry. If stuck, this lock is the socket file ${label}; a killed holder leaves the file behind, so confirm no live holder, delete that file by hand, and retry. Never delete a run file to bypass this lock.`;
	// One attempt. Retrying a busy name would paper over the race this lock
	// exists to close: two CLIs must not both proceed, and the loser must fail
	// now rather than wait out the winner and then act on a stale decision.
	return new Promise((resolve, reject) => {
		// A connection to the lock is not a lock holder. Close probes promptly
		// so server.close cannot wait forever for an idle client.
		const server = createServer(socket => socket.destroy());
		const fail = (error: NodeJS.ErrnoException) => {
			if (["EADDRINUSE", "EEXIST"].includes(error.code ?? "")) reject(new CliError("CLI_BUSY", `Another CLI lifecycle operation holds ${label}.`, fix));
			else reject(error);
		};
		server.once("error", fail);
		server.listen(name, () => { server.removeListener("error", fail); resolve(server); });
	});
}
export async function locked<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
	// The ownership sockets live in this directory: keep it private so no other
	// user can replace a socket file or squat the name.
	await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
	await chmod(ctx.dir, 0o700);
	// Two spellings of one lane directory, a symlinked path for example, must
	// contend for one lock: name it after the path the kernel resolves. The
	// mkdir above guarantees that path exists.
	const dir = realpathSync(ctx.dir);
	const server = await acquireLock(dir);
	try { return await run(); }
	finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
export const resetTables = ["sessions", "deliveries", "resources", "outbox", "requests", "jobs", "agents", "credits", "operators"] as const;
export async function counts(path: string): Promise<Record<string, number>> {
	const result = Object.fromEntries(resetTables.map(name => [name, 0]));
	if (!existsSync(path)) return result;
	const { DatabaseSync } = await import("node:sqlite");
	let db;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		db.exec("PRAGMA busy_timeout = 5000");
		const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
		for (const table of resetTables) if (tables.has(table)) result[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
		return result;
	} catch { throw new CliError("DATABASE_UNREADABLE", "The configured SQLite database could not be read.", `Check file access to ${path}, then run npm run -s ctl -- status.`); }
	finally { db?.close(); }
}
export type StoredJobs = { readonly available: boolean; readonly rows: JobRow[] };
/** Every stored job row, read-only, without the API's per-actor listing filter. available is false when the file or its jobs table is absent. */
export async function readStoredJobs(path: string): Promise<StoredJobs> {
	if (!existsSync(path)) return { available: false, rows: [] };
	const { DatabaseSync } = await import("node:sqlite");
	let db;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		db.exec("PRAGMA busy_timeout = 5000");
		const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
		if (!tables.has("jobs")) return { available: false, rows: [] };
		return { available: true, rows: db.prepare("SELECT json FROM jobs ORDER BY rowid").all().map(row => JSON.parse(String(row.json)) as JobRow) };
	} catch { throw new CliError("DATABASE_UNREADABLE", "The configured SQLite database could not be read.", `Check file access to ${path}, then run npm run -s ctl -- status.`); }
	finally { db?.close(); }
}
export function envKeys(ctx: Context): Record<string, { inDotEnv: boolean; configured: boolean }> {
	const path = resolve(ctx.root, ".env");
	const names = new Set(existsSync(path) ? [...readFileSync(path, "utf8").matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(match => match[1]) : []);
	return Object.fromEntries(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPERATOR_DEVON_MERCHANT_ID"].map(name => [name, { inDotEnv: names.has(name), configured: Boolean(process.env[name]?.trim()) }]));
}
