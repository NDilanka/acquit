import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { alive, captured, killTree } from "../src/process.ts";

const source = fileURLToPath(new URL("../src", import.meta.url));
async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}
async function fixture(run: (cli: (args: string[]) => { code: number | null; stdout: string }, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-cli-test-"));
	try {
		await cp(source, resolve(root, "packages/cli/src"), { recursive: true });
		await writeFile(resolve(root, "package.json"), '{"type":"module"}');
		const [api, web] = [await unusedPort(), await unusedPort()];
		const cli = (args: string[]) => {
			const result = spawnSync(process.execPath, [resolve(root, "packages/cli/src/main.ts"), ...args], {
				cwd: root, encoding: "utf8", timeout: 10_000,
				env: { ...process.env, PORT: String(api), WEB_PORT: String(web), DATABASE_PATH: resolve(root, "test.db") },
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
		assert.deepEqual(result.stdout.match(/^(start|stop|status|seed-db|login|screenshot)(?= |\n)/gm), ["start", "stop", "status", "seed-db", "login", "screenshot"]);
		assert.equal(result.stdout.includes("stop [destructive]"), true);
		assert.equal(result.stdout.includes("Exit codes: 0 success, 1 runtime failure, 2 usage error."), true);
		assert.equal(result.stdout.includes('Failure: {"ok":false'), true);
		const command = cli(["screenshot", "--help"]);
		assert.equal(command.code, 0);
		assert.equal(command.stdout.includes("--path <value>  Same-origin route to capture. Default: /."), true);
	});
});
test("unknown command returns one actionable JSON usage error", async () => {
	await fixture(async cli => {
		const result = cli(["strat"]);
		assert.equal(result.code, 2);
		assert.deepEqual(JSON.parse(result.stdout), { ok: false, command: "strat", error: {
			code: "UNKNOWN_COMMAND", message: 'Unknown command "strat".',
			fix: "Try npm run -s acquit -- start, or npm run -s acquit -- --help.",
		} });
	});
});
test("command prefixes suggest the command they start, and missing flags name a runnable example", async () => {
	await fixture(async cli => {
		assert.equal(JSON.parse(cli(["stat"]).stdout).error.fix, "Try npm run -s acquit -- status, or npm run -s acquit -- --help.");
		const missing = cli(["login"]);
		assert.equal(missing.code, 2);
		assert.equal(JSON.parse(missing.stdout).error.fix, "Run npm run -s acquit -- login --test-user maya-client --save. See npm run -s acquit -- login --help.");
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
		assert.equal(existsSync(resolve(root, "data/cli/run.json")), false);
	});
});
test("stop dry-run with no ownership file kills nothing", async () => {
	await fixture(async (cli, root) => {
		const result = cli(["stop", "--dry-run"]);
		assert.equal(result.code, 0);
		assert.deepEqual(JSON.parse(result.stdout), { ok: true, command: "stop", dryRun: true, data: { stopped: false, reason: "not running", wouldKill: [] } });
		assert.equal(existsSync(resolve(root, "data/cli/run.json")), false);
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
			fix: "Try --save, or npm run -s acquit -- login --help.",
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
		const file = resolve(root, "data/cli/run.json");
		await mkdir(resolve(root, "data/cli"), { recursive: true });
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
