import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, CliError } from "./process.ts";

export interface RunState {
	api: { pid: number; port: number; startTime: string | null };
	web: { pid: number; port: number; startTime: string | null };
	logs: { api: string; web: string };
	startedAt: string;
	databasePath: string;
}
export interface LaneSlot {
	apiPort: number;
	webPort: number;
	databasePath: string;
	runDir: string;
	browserSession: string;
}
export function laneSlot(n?: number): LaneSlot {
	if (n === undefined) return { apiPort: 4310, webPort: 5173, databasePath: "data/acquit.db", runDir: "data/ctl", browserSession: "verify-acquit" };
	if (!Number.isSafeInteger(n) || n < 0 || 5173 + 10 * n > 65535) throw new CliError("INVALID_ARGUMENT", "ACQUIT_LANE must be an integer between 0 and 6036.", "Set ACQUIT_LANE to a valid lane number.", 2);
	return { apiPort: 4310 + 10 * n, webPort: 5173 + 10 * n, databasePath: `data/verify/lane-${n}/acquit.db`, runDir: `data/ctl/lane-${n}`, browserSession: `verify-acquit-lane-${n}` };
}
export interface Context {
	root: string;
	dir: string;
	stateFile: string;
	databasePath: string;
	apiPort: number;
	webPort: number;
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
	const lane = process.env.ACQUIT_LANE;
	const slot = laneSlot(lane === undefined ? undefined : /^\d+$/.test(lane) ? Number(lane) : NaN);
	const dir = resolve(root, slot.runDir);
	return { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, lane === undefined ? process.env.DATABASE_PATH ?? slot.databasePath : slot.databasePath),
		apiPort: lane === undefined ? port("PORT", slot.apiPort) : slot.apiPort, webPort: lane === undefined ? port("WEB_PORT", slot.webPort) : slot.webPort, browserSession: slot.browserSession };
}
export async function readState(ctx: Context): Promise<RunState | null> {
	let raw: string;
	try { raw = await readFile(ctx.stateFile, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	try {
		const state = JSON.parse(raw) as RunState;
		for (const service of [state.api, state.web]) {
			if (!service || !Number.isSafeInteger(service.pid) || service.pid < 0 || !Number.isSafeInteger(service.port) || service.port < 1 || service.port > 65535 ||
				(service.pid > 0 ? typeof service.startTime !== "string" || !service.startTime : service.startTime !== null)) throw new Error();
		}
		if (typeof state.logs?.api !== "string" || typeof state.logs.web !== "string" || typeof state.databasePath !== "string" || typeof state.startedAt !== "string") throw new Error();
		return state;
	} catch { throw new CliError("INVALID_STATE", "The CLI ownership file is invalid.", `Inspect ${ctx.stateFile}. Restore its owned PIDs or remove the file only after stopping those processes.`); }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	try { await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temp, path); }
	finally { await unlink(temp).catch(() => {}); }
}
export async function clearState(ctx: Context): Promise<void> {
	try { await unlink(ctx.stateFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export async function locked<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
	await mkdir(ctx.dir, { recursive: true });
	const path = resolve(ctx.dir, "operation.lock");
	for (let attempt = 0; ; attempt++) {
		try { await writeFile(path, String(process.pid), { flag: "wx" }); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = Number(await readFile(path, "utf8").catch(() => "0"));
			if (alive(owner) || attempt > 0) throw new CliError("CLI_BUSY", "Another CLI lifecycle operation is in progress.", "Wait for that command to finish, then retry.");
			await unlink(path).catch(() => {});
		}
	}
	try { return await run(); } finally { await unlink(path); }
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
export function envKeys(ctx: Context): Record<string, { inDotEnv: boolean; configured: boolean }> {
	const path = resolve(ctx.root, ".env");
	const names = new Set(existsSync(path) ? [...readFileSync(path, "utf8").matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(match => match[1]) : []);
	return Object.fromEntries(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPERATOR_DEVON_MERCHANT_ID"].map(name => [name, { inDotEnv: names.has(name), configured: Boolean(process.env[name]?.trim()) }]));
}
