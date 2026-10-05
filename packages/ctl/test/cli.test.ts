import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { alive, captured, killTree, processStartTime } from "../src/process.ts";
import { laneSlot } from "../src/state.ts";

const source = fileURLToPath(new URL("../src", import.meta.url));
async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}
async function fixture(run: (cli: (args: string[]) => { code: number | null; stdout: string }, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-ctl-test-"));
	try {
		await cp(source, resolve(root, "packages/ctl/src"), { recursive: true });
		await writeFile(resolve(root, "package.json"), '{"type":"module"}');
		const [api, web] = [await unusedPort(), await unusedPort()];
		const cli = (args: string[]) => {
			const result = spawnSync(process.execPath, [resolve(root, "packages/ctl/src/main.ts"), ...args], {
				cwd: root, encoding: "utf8", timeout: 30_000,
				env: { ...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: undefined, PORT: String(api), WEB_PORT: String(web), DATABASE_PATH: resolve(root, "test.db") },
			});
			assert.equal(result.error, undefined);
			return { code: result.status, stdout: result.stdout };
		};
		await run(cli, root);
	} finally { await rm(root, { recursive: true, force: true }); }
}
test("top-level help lists every command, flags, envelope, and exits successfully", async () => {
	await fixture(async cli => {
		const result = cli(["--help"]);
		assert.equal(result.code, 0);
		assert.deepEqual(result.stdout.match(/^(clock|fund-mode|start|stop|status|seed-db|login|screenshot)(?= |\n)/gm), ["clock", "fund-mode", "start", "stop", "status", "seed-db", "login", "screenshot"]);
		assert.equal(result.stdout.includes("stop [destructive]"), true);
		assert.equal(result.stdout.includes("Exit codes: 0 success, 1 runtime failure, 2 usage error."), true);
		assert.equal(result.stdout.includes('Failure: {"ok":false'), true);
		const command = cli(["screenshot", "--help"]);
		assert.equal(command.code, 0);
		assert.equal(command.stdout.includes("--path <value>  Same-origin route to capture. Default: /."), true);
	});
});
test("lane slots isolate all resources for lanes 0, 1, and 10", () => {
	assert.deepEqual(laneSlot(), { apiPort: 4310, webPort: 5173, databasePath: "data/acquit.db", runDir: "data/ctl", browserSession: "verify-acquit" });
	for (const [n, apiPort, webPort] of [[0, 4310, 5173], [1, 4320, 5183], [10, 4410, 5273]]) {
		assert.deepEqual(laneSlot(n), { apiPort, webPort, databasePath: `data/verify/lane-${n}/acquit.db`, runDir: `data/ctl/lane-${n}`, browserSession: `verify-acquit-lane-${n}` });
	}
	for (const n of [-1, 1.5, NaN, 6037]) assert.throws(() => laneSlot(n));
});
test("stop refuses an unrelated live PID with a different start time", async () => {
	await fixture(async (cli, root) => {
		const file = resolve(root, "data/ctl/run.json");
		await mkdir(resolve(root, "data/ctl"), { recursive: true });
		await writeFile(file, JSON.stringify({ api: { pid: process.pid, port: 4310, startTime: `not-${processStartTime(process.pid)}` },
			web: { pid: 0, port: 5173, startTime: null }, logs: { api: "api.log", web: "web.log" }, databasePath: "test.db", startedAt: new Date().toISOString() }));
		const before = await readFile(file, "utf8");
		const result = cli(["stop"]);
		assert.equal(result.code, 1);
		assert.equal(JSON.parse(result.stdout).error.code, "PID_MISMATCH");
		assert.equal(alive(process.pid), true);
		assert.equal(await readFile(file, "utf8"), before);
	});
});
test("development controls refuse use without ACQUIT_DEV=1 before app access", async () => {
	await fixture(async cli => {
		for (const args of [["clock", "advance", "4h"], ["fund-mode", "card"]]) {
			const result = cli(args);
			assert.equal(result.code, 1);
			assert.equal(JSON.parse(result.stdout).error.code, "DEV_DISABLED");
			assert.match(JSON.parse(result.stdout).error.fix, /ACQUIT_DEV=1/);
		}
		assert.equal(JSON.parse(cli(["clock", "advance", "-1h"]).stdout).error.code, "INVALID_ARGUMENT");
	});
});
test("unknown command returns one actionable JSON usage error", async () => {
	await fixture(async cli => {
		const result = cli(["strat"]);
		assert.equal(result.code, 2);
		assert.deepEqual(JSON.parse(result.stdout), { ok: false, command: "strat", error: {
			code: "UNKNOWN_COMMAND", message: 'Unknown command "strat".',
			fix: "Try npm run -s ctl -- start, or npm run -s ctl -- --help.",
		} });
	});
});
test("command prefixes suggest the command they start, and missing flags name a runnable example", async () => {
	await fixture(async cli => {
		assert.equal(JSON.parse(cli(["stat"]).stdout).error.fix, "Try npm run -s ctl -- status, or npm run -s ctl -- --help.");
		const missing = cli(["login"]);
		assert.equal(missing.code, 2);
		assert.equal(JSON.parse(missing.stdout).error.fix, "Run npm run -s ctl -- login --test-user maya-client --save. See npm run -s ctl -- login --help.");
	});
});
test("status is unhealthy on unused ports and never creates the database or state", async () => {
	await fixture(async (cli, root) => {
		const result = cli(["status"]);
		assert.equal(result.code, 0);
		const report = JSON.parse(result.stdout);
		assert.equal(report.ok, true);
		assert.equal(report.command, "status");
		assert.equal(report.data.healthy, false);
		assert.equal(report.data.run, null);
		assert.deepEqual(report.data.pids, { api: { pid: null, alive: false }, web: { pid: null, alive: false } });
		assert.equal(report.data.ports.api.open, false);
		assert.equal(report.data.ports.web.open, false);
		assert.deepEqual(report.data.reachability, { api: false, web: false });
		assert.deepEqual(report.data.database.counts, { operators: 0, jobs: 0 });
		assert.equal(report.data.database.exists, false);
		assert.equal(existsSync(resolve(root, "test.db")), false);
		assert.equal(existsSync(resolve(root, "data/ctl/run.json")), false);
	});
});
test("stop dry-run with no ownership file kills nothing", async () => {
	await fixture(async (cli, root) => {
		const result = cli(["stop", "--dry-run"]);
		assert.equal(result.code, 0);
		assert.deepEqual(JSON.parse(result.stdout), { ok: true, command: "stop", dryRun: true, data: { stopped: false, reason: "not running", wouldKill: [] } });
		assert.equal(existsSync(resolve(root, "data/ctl/run.json")), false);
		const again = cli(["stop"]);
		assert.equal(again.code, 0);
		assert.deepEqual(JSON.parse(again.stdout), { ok: true, command: "stop", data: { stopped: false, reason: "not running" } });
	});
});
test("registry rejects dry-run on non-destructive login before any app operation", async () => {
	await fixture(async cli => {
		const result = cli(["login", "--dry-run", "--test-user", "maya-client"]);
		assert.equal(result.code, 2);
		assert.deepEqual(JSON.parse(result.stdout), { ok: false, command: "login", error: {
			code: "UNKNOWN_FLAG", message: "Unknown option '--dry-run'",
			fix: "Try --save, or npm run -s ctl -- login --help.",
		} });
		const missing = cli(["login"]);
		assert.equal(missing.code, 2);
		assert.equal(JSON.parse(missing.stdout).error.code, "MISSING_ARGUMENT");
	});
});
test("seed-db dry-run on an absent database changes nothing", async () => {
	await fixture(async (cli, root) => {
		const result = cli(["seed-db", "--dry-run"]);
		assert.equal(result.code, 0);
		assert.deepEqual(JSON.parse(result.stdout), { ok: true, command: "seed-db", dryRun: true, data: {
			databasePath: resolve(root, "test.db"),
			wouldDelete: { sessions: 0, deliveries: 0, resources: 0, outbox: 0, requests: 0, jobs: 0, agents: 0, credits: 0, operators: 0 },
			sessionsInvalidated: true, hint: "A real reset invalidates existing sessions.",
		} });
		assert.equal(existsSync(resolve(root, "test.db")), false);
	});
});
test("malformed ownership files fail closed without replacing their contents", async () => {
	await fixture(async (cli, root) => {
		const file = resolve(root, "data/ctl/run.json");
		await mkdir(resolve(root, "data/ctl"), { recursive: true });
		await writeFile(file, '{"api":{"pid":"not-a-pid"}}');
		const result = cli(["stop"]);
		assert.equal(result.code, 1);
		assert.equal(JSON.parse(result.stdout).error.code, "INVALID_STATE");
		assert.equal(await readFile(file, "utf8"), '{"api":{"pid":"not-a-pid"}}');
	});
});
test("captured commands finish when a detached descendant keeps stdout open", async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-capture-test-"));
	const marker = resolve(root, "descendant.pid");
	const script = `import { spawn } from "node:child_process";
		import { writeFileSync } from "node:fs";
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
			{ detached: true, stdio: ["ignore", 1, "ignore"] });
		writeFileSync(process.argv[1], String(child.pid));
		child.unref();
		console.log("done");`;
	try {
		const result = await captured(process.execPath, ["--input-type=module", "-e", script, marker], root, process.env, 3000);
		assert.deepEqual(result, { code: 0, stdout: "done\n" });
		assert.equal(alive(Number(await readFile(marker, "utf8"))), true);
	} finally {
		if (existsSync(marker)) await killTree(Number(await readFile(marker, "utf8")));
		await rm(root, { recursive: true, force: true });
	}
});
