import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { alive, captured, CliError, detached, killTree, ownershipNonce, ownershipReady, portOpen, reachable, releaseSpawned, requireOwned, sleep } from "./process.ts";
import type { ChildProcess } from "node:child_process";
import { atomicJson, clearState, counts, envKeys, locked, readState } from "./state.ts";
import type { Context, RunState } from "./state.ts";
import type { Parsed, Result } from "./registry.ts";
import { browserExecutable } from "./executables.ts";

const urls = (api: number, web: number) => ({ api: `http://localhost:${api}`, web: `http://localhost:${web}` });
async function devPost(ctx: Context, path: string, body: unknown): Promise<Result> {
	if (process.env.ACQUIT_DEV !== "1") throw new CliError("DEV_DISABLED", "Development controls are disabled.", "Set ACQUIT_DEV=1 for the API start and this ctl command.");
	const ports = await app(ctx);
	const session = await login({ "test-user": "maya-client" }, ctx) as { token: string };
	const response = await fetch(`http://127.0.0.1:${ports.api}/api/dev/${path}`, { method: "POST", headers: {
		"Content-Type": "application/json", Authorization: `Bearer ${session.token}`,
	}, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
	if (response.status === 403) throw new CliError("DEV_DISABLED", "The API refused development controls.", "Restart the API with ACQUIT_DEV=1.");
	if (!response.ok) throw new CliError("PROCESS_FAILED", `Development command returned HTTP ${response.status}.`, "Run ctl status and inspect the local API log.");
	return await response.json() as Result;
}
export async function clockAdvance(parsed: Parsed, ctx: Context): Promise<Result> {
	const match = String(parsed.duration).match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
	const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	const advanceMs = match ? Number(match[1]) * units[match[2] as keyof typeof units] : NaN;
	if (!Number.isSafeInteger(advanceMs) || advanceMs <= 0 || advanceMs > 365 * 86400000) throw new CliError("INVALID_ARGUMENT", "Use a positive duration of at most 365 days.", "Run npm run -s ctl -- clock advance 4h.", 2);
	return devPost(ctx, "clock", { advanceMs });
}
export async function fundMode(parsed: Parsed, ctx: Context): Promise<Result> {
	if (!["card", "checkout"].includes(String(parsed.mode))) throw new CliError("INVALID_ARGUMENT", "Use card or checkout.", "Run npm run -s ctl -- fund-mode card.", 2);
	return devPost(ctx, "fund-mode", { mode: parsed.mode });
}
async function probes(api: number, web: number) {
	const [apiPort, webPort, apiReady, webReady] = await Promise.all([portOpen(api), portOpen(web), reachable(`http://127.0.0.1:${api}/api/users`), reachable(`http://127.0.0.1:${web}/`)]);
	return { apiPort, webPort, apiReady, webReady };
}
async function stopOwned(state: RunState): Promise<void> {
	// A dead record authorizes nothing, including the cleanup of its live sibling.
	// Otherwise a forged dead PID lets stop kill a service it never proved and
	// then fail on the port that sibling still holds. Two dead records kill
	// nothing, so they may still be cleared.
	const live = [state.api, state.web].filter(service => alive(service.pid));
	for (const service of live) await requireOwned(service, service.socketPath);
	for (const service of live) { await requireOwned(service, service.socketPath); await killTree(service.pid); }
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (!(await portOpen(state.api.port)) && !(await portOpen(state.web.port))) return;
		await sleep(150);
	}
	throw new CliError("STOP_TIMEOUT", "Owned process trees were stopped, but their ports did not close.", "Inspect data/ctl/run.json and the listening ports. Stop any remaining process yourself, then retry npm run -s ctl -- stop.");
}
async function runData(state: RunState, alreadyRunning: boolean): Promise<Result> {
	const rows = await counts(state.databasePath);
	return { alreadyRunning, urls: urls(state.api.port, state.web.port), pids: { api: state.api.pid, web: state.web.pid }, logs: state.logs,
		databasePath: state.databasePath, seeded: rows.operators > 0, ...(rows.operators === 0 ? { hint: "Run npm run -s ctl -- seed-db --yes." } : {}) };
}
export async function start(parsed: Parsed, ctx: Context): Promise<Result> {
	const timeout = Number(parsed.timeout);
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600) throw new CliError("INVALID_ARGUMENT", "--timeout must be between 0 and 600 seconds, excluding zero.", "Run npm run -s ctl -- start --timeout 30.", 2);
	if (ctx.apiPort === ctx.webPort) throw new CliError("PORT_IN_USE", "API and web ports must differ.", "Set PORT=4310 and WEB_PORT=5173, or choose two unused ports.");
	return locked(ctx, async () => {
		const previous = await readState(ctx);
		if (previous) {
			for (const service of [previous.api, previous.web]) await requireOwned(service, service.socketPath);
			const probe = await probes(previous.api.port, previous.web.port);
			if (alive(previous.api.pid) && alive(previous.web.pid) && probe.apiReady && probe.webReady) return runData(previous, true);
			for (const service of [previous.api, previous.web]) if (!alive(service.pid) && await portOpen(service.port)) {
				throw new CliError("PORT_IN_USE", `Port ${service.port} is open but its recorded PID is dead.`, `Stop the process on port ${service.port} yourself, or set PORT and WEB_PORT to unused ports and remove the stale ${ctx.stateFile}.`);
			}
			await stopOwned(previous);
			await clearState(ctx);
		}
		for (const [name, port] of [["PORT", ctx.apiPort], ["WEB_PORT", ctx.webPort]] as const) if (await portOpen(port)) {
			throw new CliError("PORT_IN_USE", `Port ${port} is already in use by a process this CLI does not own.`, `Stop that process yourself, or set ${name} to an unused port, then run npm run -s ctl -- start.`);
		}
		const vite = resolve(ctx.root, "apps/web/node_modules/vite/bin/vite.js");
		if (!existsSync(vite)) throw new CliError("PROCESS_FAILED", "The web app's Vite dependency is missing.", "Run npm install from the repository root, then npm run -s ctl -- start.");
		await mkdir(dirname(ctx.databasePath), { recursive: true });
		const state: RunState = { api: { pid: 0, port: ctx.apiPort, nonce: ownershipNonce() }, web: { pid: 0, port: ctx.webPort, nonce: ownershipNonce() },
			logs: { api: resolve(ctx.dir, "api.log"), web: resolve(ctx.dir, "web.log") }, startedAt: new Date().toISOString(), databasePath: ctx.databasePath };
		if (process.platform !== "win32") {
			state.api.socketPath = resolve(ctx.dir, `own-${state.api.nonce}.sock`);
			state.web.socketPath = resolve(ctx.dir, `own-${state.web.nonce}.sock`);
		}
		const children: ChildProcess[] = [];
		try {
			// Record the nonce before launch. A CLI killed during readiness leaves a
			// run file that a later stop can reclaim; no post-spawn lookup is required.
			await atomicJson(ctx.stateFile, state);
			const api = await detached("apps/api/src/server.ts", state.api.nonce!, ctx.root, { ...process.env, PORT: String(ctx.apiPort), WEB_PORT: String(ctx.webPort),
				WEB_ORIGIN: `http://localhost:${ctx.webPort}`, DATABASE_PATH: ctx.databasePath,
				ACQUIT_OWNERSHIP_RECORD: ctx.stateFile, ACQUIT_OWNERSHIP_ROLE: "api" }, state.logs.api, [], state.api.socketPath);
			children.push(api);
			state.api.pid = api.pid!;
			await atomicJson(ctx.stateFile, state);
			const web = await detached(vite, state.web.nonce!, resolve(ctx.root, "apps/web"),
				{ ...process.env, WEB_PORT: String(ctx.webPort), ACQUIT_API_URL: `http://127.0.0.1:${ctx.apiPort}`,
					ACQUIT_OWNERSHIP_RECORD: ctx.stateFile, ACQUIT_OWNERSHIP_ROLE: "web" }, state.logs.web,
				["--host", "127.0.0.1", "--port", String(ctx.webPort), "--strictPort"], state.web.socketPath);
			children.push(web);
			state.web.pid = web.pid!;
			await atomicJson(ctx.stateFile, state);
			const deadline = Date.now() + timeout * 1000;
			while (Date.now() < deadline) {
				const probe = await probes(ctx.apiPort, ctx.webPort);
				if (!alive(state.api.pid) || !alive(state.web.pid)) throw new CliError("PROCESS_FAILED", "A spawned service exited before both endpoints answered.", "Inspect the service logs, then retry start.");
				if (probe.apiReady && probe.webReady && (await Promise.all([
					ownershipReady(api, state.api.nonce!, state.api.socketPath),
					ownershipReady(web, state.web.nonce!, state.web.socketPath),
				])).every(Boolean)) return await runData(state, false);
				await sleep(200);
			}
			throw new CliError("START_TIMEOUT", `The app did not become ready within ${timeout}s. Last log lines are in ${state.logs.api} and ${state.logs.web}.`,
				`Inspect the last lines of those logs locally without sharing configuration values. Check .env key names with npm run -s ctl -- status, then npm run -s ctl -- start --timeout 60.`);
		} catch (error) {
			// Release handles we spawned, not unverified run-file PIDs. Cleanup must
			// not mask the original startup error. Retain the file if release fails.
			const cleanup = await Promise.allSettled(children.map(releaseSpawned));
			if (cleanup.every(result => result.status === "fulfilled")) await clearState(ctx).catch(() => {});
			throw error;
		}
	});
}
export async function stop(parsed: Parsed, ctx: Context): Promise<Result> {
	return locked(ctx, async () => {
		const state = await readState(ctx);
		if (!state) return { stopped: false, reason: "not running", ...(parsed["dry-run"] ? { wouldKill: [] } : {}) };
		const wouldKill = [state.api, state.web].filter(service => alive(service.pid));
		for (const service of wouldKill) await requireOwned(service, service.socketPath);
		if (parsed["dry-run"]) return { stopped: false, wouldKill, run: state };
		await stopOwned(state);
		await clearState(ctx);
		return wouldKill.length ? { stopped: true, pids: wouldKill.map(service => service.pid) } : { stopped: false, reason: "not running" };
	});
}
export async function status(_parsed: Parsed, ctx: Context): Promise<Result> {
	const run = await readState(ctx);
	const ports = { api: run?.api.port ?? ctx.apiPort, web: run?.web.port ?? ctx.webPort };
	const probe = await probes(ports.api, ports.web);
	const pids = { api: { pid: run?.api.pid ?? null, alive: alive(run?.api.pid ?? 0) }, web: { pid: run?.web.pid ?? null, alive: alive(run?.web.pid ?? 0) } };
	const keys = envKeys(ctx);
	const path = run?.databasePath ?? ctx.databasePath;
	const rows = await counts(path);
	const database = { path, exists: existsSync(path), seeded: rows.operators > 0, counts: { operators: rows.operators, jobs: rows.jobs } };
	return { healthy: Boolean(run?.api.nonce && run.web.nonce && pids.api.alive && pids.web.alive && probe.apiReady && probe.webReady && database.exists && database.seeded && Object.values(keys).every(key => key.configured)),
		runFile: ctx.stateFile, run, pids, ports: { api: { port: ports.api, open: probe.apiPort }, web: { port: ports.web, open: probe.webPort } },
		reachability: { api: probe.apiReady, web: probe.webReady }, urls: urls(ports.api, ports.web), database, env: { fileExists: existsSync(resolve(ctx.root, ".env")), requiredKeys: keys } };
}
export async function seedDb(parsed: Parsed, ctx: Context): Promise<Result> {
	if (parsed["dry-run"]) {
		const path = (await readState(ctx))?.databasePath ?? ctx.databasePath;
		return { databasePath: path, wouldDelete: await counts(path), sessionsInvalidated: true, hint: "A real reset invalidates existing sessions." };
	}
	return locked(ctx, async () => {
		const run = await readState(ctx);
		const path = run?.databasePath ?? ctx.databasePath;
		if (!parsed.yes && ((run && (alive(run.api.pid) || alive(run.web.pid))) || await portOpen(ctx.apiPort) || await portOpen(ctx.webPort))) {
			throw new CliError("CONFIRMATION_REQUIRED", "Resetting the database while an app is running invalidates its sessions.", "Run npm run -s ctl -- seed-db --yes to confirm the reset.");
		}
		const result = await captured(process.execPath, ["scripts/seed.ts"], ctx.root, { ...process.env, DATABASE_PATH: path });
		if (result.code !== 0) throw new CliError("SEED_FAILED", "The existing seed script failed. No script output or configuration values were forwarded.", "Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and OPERATOR_DEVON_MERCHANT_ID in .env, then run npm run -s ctl -- seed-db --yes.");
		return { databasePath: path, counts: await counts(path), sessionsInvalidated: true };
	});
}
async function app(ctx: Context, webRequired = false): Promise<{ api: number; web: number }> {
	const run = await readState(ctx);
	const ports = { api: run?.api.port ?? ctx.apiPort, web: run?.web.port ?? ctx.webPort };
	if (!(await reachable(`http://127.0.0.1:${ports.api}/api/users`)) || (webRequired && !(await reachable(`http://127.0.0.1:${ports.web}/`)))) {
		throw new CliError("APP_NOT_RUNNING", "The required Acquit app endpoints are not ready.", "Run npm run -s ctl -- start.");
	}
	return ports;
}
export async function login(parsed: Parsed, ctx: Context): Promise<Result> {
	const ports = await app(ctx);
	const handle = String(parsed["test-user"]);
	if (!/^[a-zA-Z0-9_-]+$/.test(handle)) throw new CliError("INVALID_ARGUMENT", "--test-user must be a plain development handle.", "Run npm run -s ctl -- login --test-user maya-client.", 2);
	let response: Response;
	try { response = await fetch(`http://127.0.0.1:${ports.api}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle }), signal: AbortSignal.timeout(3000) }); }
	catch { throw new CliError("APP_NOT_RUNNING", "The API stopped responding during login.", "Run npm run -s ctl -- start."); }
	if (response.status === 400) {
		const users = await fetch(`http://127.0.0.1:${ports.api}/api/users`, { signal: AbortSignal.timeout(3000) }).then(response => response.json()) as { users: { handle: string }[] };
		throw new CliError("UNKNOWN_TEST_USER", `Unknown development handle ${JSON.stringify(handle)}.`, `Run npm run -s ctl -- login --test-user <handle>. Valid handles: ${users.users.map(user => user.handle).join(", ")}.`);
	}
	if (!response.ok) throw new CliError("PROCESS_FAILED", `The API rejected login with HTTP ${response.status}.`, "Run npm run -s ctl -- status, then retry login.");
	const session = await response.json() as { user: { handle: string; role: string }; token: string };
	const data = { handle: session.user.handle, role: session.user.role, token: session.token, cookie: { name: "acquit_session", value: session.token, url: `http://localhost:${ports.web}` } };
	if (!parsed.save) return data;
	const file = resolve(ctx.dir, "sessions", `${handle}.json`);
	await atomicJson(file, data);
	return { ...data, file };
}
export async function screenshot(parsed: Parsed, ctx: Context): Promise<Result> {
	return locked(ctx, async () => {
		const ports = await app(ctx, true);
		const path = String(parsed.path);
		if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new CliError("INVALID_ARGUMENT", "--path must be a same-origin route beginning with one slash.", "Run npm run -s ctl -- screenshot --path /.", 2);
		const url = `http://localhost:${ports.web}${path}`;
		const out = parsed.out === undefined ? resolve(ctx.root, "data/evidence", `${new Date().toISOString().replaceAll(":", "-")}-${path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "jobs"}.png`) : resolve(ctx.root, String(parsed.out));
		if (!out.toLowerCase().endsWith(".png")) throw new CliError("INVALID_ARGUMENT", "--out must name a .png file.", "Run npm run -s ctl -- screenshot --out data/evidence/jobs.png.", 2);
		const env = { ...process.env };
		for (const name of Object.keys(env)) if (name.startsWith("AGENT_BROWSER_") || name === "FACTORY_DESKTOP_CDP_PORT" || /PAYPAL|SANDBOX|MERCHANT_ID|PASSWORD|SECRET|TOKEN|API_KEY/.test(name)) delete env[name];
		env.AGENT_BROWSER_SESSION = ctx.browserSession;
		env.AGENT_BROWSER_HEADED = "false";
		const browserConfig = resolve(ctx.dir, "browser.json");
		await atomicJson(browserConfig, { headed: false });
		const browser = async (args: string[]) => {
			let result;
			try { result = await captured(browserExecutable(), ["--config", browserConfig, "--namespace", ctx.browserSession, "--session", ctx.browserSession, "--json", ...args], ctx.root, env); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CliError("AGENT_BROWSER_MISSING", "agent-browser was not found on PATH.", "Install or update Factory Droid, then ensure agent-browser --help works in this shell.");
				throw error;
			}
			if (result.code !== 0) throw new CliError("BROWSER_FAILED", "The isolated acquit-ctl browser command failed. No child diagnostics were forwarded.", "Run agent-browser doctor --offline --quick, then retry npm run -s ctl -- screenshot --as maya-client --path /.");
			const reply = JSON.parse(result.stdout) as { success: boolean; data: { title?: string } };
			if (!reply.success) throw new CliError("BROWSER_FAILED", "agent-browser reported an unsuccessful command.", "Run agent-browser doctor --offline --quick, then retry the screenshot.");
			return reply.data;
		};
		await mkdir(dirname(out), { recursive: true });
		try {
			await browser(["open", "about:blank"]);
			await browser(["cookies", "clear"]);
			if (parsed.as) {
				const session = await login({ "test-user": parsed.as }, ctx) as { cookie: { name: string; value: string; url: string } };
				await browser(["cookies", "set", session.cookie.name, session.cookie.value, "--url", session.cookie.url, "--httpOnly", "--sameSite", "Lax"]);
			}
			await browser(["open", url]);
			await browser(parsed["wait-text"] ? ["wait", "--text", String(parsed["wait-text"])] : ["wait", "--load", "networkidle"]);
			const page = await browser(["get", "title"]);
			await browser(["screenshot", ...(parsed.full ? ["--full"] : []), out]);
			return { path: out, url, title: page.title, bytes: (await stat(out)).size };
		} finally {
			await browser(["close"]);
		}
	});
}
